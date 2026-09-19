/**
 * Agent 运行时的主进程宿主。
 *
 * 职责（与 `localAgent/serverProcess.ts` 的 Python 版语义对齐，便于原地替换）：
 *   - `utilityProcess.fork` 启动 `agentRuntime.js`（必须在 `app.ready` 之后）
 *   - 生成随机 token、绑定随机端口、等待 `ready` 消息
 *   - 通过 `localAgent:status` 向渲染层推送 starting/running/stopped/error
 *   - 桥接运行时的 RPC 请求到主进程能力（nativeImage、文件写入等）
 *   - 崩溃隔离：运行时退出只导致自身进程消失，主进程存活并给出状态提示
 *   - `before-quit` 时显式关闭
 *
 * 与 Python 版的关键差异：
 *   - 不再需要 health 轮询（`ready` 消息即就绪信号），也无解释器发现
 *   - 但仍保留随机端口 + Bearer token，使渲染层契约不变
 */

import { randomBytes } from 'crypto';
import path from 'path';
import { app, BrowserWindow, utilityProcess } from 'electron';
import type { UtilityProcess } from 'electron';
import type { LocalAgentServiceStatus } from '../../shared/envTypes';
import { createBridge, type Bridge, type MessageEndpoint } from './bridge';
import { createMainRpcHandlers } from './ipcSurface';
import {
  AGENT_DEBUG_ENV,
  AGENT_TOKEN_ENV,
  isAgentMessage,
  type AgentLogLevel,
} from './protocol';

/** 等待运行时上报 ready 的超时。 */
const READY_TIMEOUT_MS = 20_000;

/**
 * 意外退出后的自动重启策略：指数退避 + 次数上限。
 *
 * 为什么需要：渲染层会缓存 baseUrl/token（`src/renderer/config.ts`），
 * 运行时退出后若无人重启，后续请求会全部打向已死的端口——表现为
 * 「用着用着突然 network error 且不再恢复」。
 * 自动重启会**换上新端口**并推送 `running` 状态，渲染层据此失效缓存。
 */
const RESTART_BASE_DELAY_MS = 500;
const RESTART_MAX_DELAY_MS = 10_000;
const RESTART_MAX_ATTEMPTS = 5;
/** 稳定运行超过该时长即认为本次重启成功，重置退避计数。 */
const RESTART_STABLE_MS = 30_000;

/** 第 `attempt`（从 1 起）次重启的等待时长：500ms → 1s → 2s → 4s → 8s（封顶 10s）。 */
export function computeRestartDelayMs(attempt: number): number {
  if (attempt <= 1) return RESTART_BASE_DELAY_MS;
  return Math.min(
    RESTART_BASE_DELAY_MS * 2 ** (attempt - 1),
    RESTART_MAX_DELAY_MS,
  );
}

/** 是否已耗尽重启预算。 */
export function shouldGiveUpRestart(attempt: number): boolean {
  return attempt >= RESTART_MAX_ATTEMPTS;
}

interface RuntimeRefs {
  child: UtilityProcess;
  bridge: Bridge;
  port: number;
  token: string;
}

let refs: RuntimeRefs | null = null;
let starting: Promise<string> | null = null;
/** 主进程/用户主动要求停止：置位后意外退出不再触发自动重启。 */
let intentionalStop = false;
/** 连续重启计数（稳定运行 RESTART_STABLE_MS 后归零）。 */
let restartAttempt = 0;
/** 待触发的重启定时器。 */
let restartTimer: ReturnType<typeof setTimeout> | null = null;
/** 「稳定运行」计时器。 */
let stableTimer: ReturnType<typeof setTimeout> | null = null;

function cancelRestartTimer(): void {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function clearStableTimer(): void {
  if (stableTimer) {
    clearTimeout(stableTimer);
    stableTimer = null;
  }
}

function pushStatus(status: LocalAgentServiceStatus): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('localAgent:status', status);
  }
}

/**
 * 解析运行时产物路径。
 *
 * 开发模式下主 bundle 为 `main.bundle.dev.js`，运行时 bundle 同名后缀；
 * 生产模式为 `main.js` / `agentRuntime.js`。webpack 配置里 `__dirname` 保持
 * 运行时的真实值（`node: { __dirname: false }`），因此可直接用其定位同目录产物。
 */
export function resolveRuntimeEntry(): string {
  const mainFile = path.basename(__filename);
  const suffix = mainFile.startsWith('main') ? mainFile.slice('main'.length) : '.js';
  return path.join(__dirname, `agentRuntime${suffix}`);
}

function forwardStream(
  stream: NodeJS.ReadableStream | null,
  level: AgentLogLevel,
): void {
  if (!stream) return;
  let buffer = '';
  stream.setEncoding?.('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      if (level === 'error') console.error(trimmed);
      else console.log(trimmed);
    }
  });
}

/** 启动 Agent 运行时，返回 API base URL（含 /api/v1）。 */
export async function startAgentRuntime(): Promise<string> {
  if (refs) return `http://127.0.0.1:${refs.port}/api/v1`;
  if (starting) return starting;

  // 主动启动：清除「已停止」意图并取消待触发的重启，避免与计时器互抢
  intentionalStop = false;
  cancelRestartTimer();

  starting = spawnRuntime();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

/**
 * 拉起一次运行时并等待就绪。
 *
 * 失败时**不自行重试**（是否重试由 `scheduleRestart` 决定），但会把状态推成
 * `error`，让渲染层及时得到反馈。
 */
async function spawnRuntime(): Promise<string> {
  const entry = resolveRuntimeEntry();
  const token = randomBytes(32).toString('hex');

  pushStatus({ state: 'starting', baseUrl: null });

  const child = utilityProcess.fork(entry, [], {
    serviceName: 'lr-agent-runtime',
    stdio: 'pipe',
    env: {
      ...process.env,
      [AGENT_TOKEN_ENV]: token,
      // 端口 0：由系统分配，运行时把实际端口回报，避免主进程预分配时的竞态
      LR_AGENT_LOCAL_PORT: '0',
      [AGENT_DEBUG_ENV]: app.isPackaged ? '0' : '1',
    },
  });

  forwardStream(child.stdout, 'info');
  forwardStream(child.stderr, 'error');

  const bridge = createBridge({
    endpoint: makeEndpoint(child),
    side: 'h',
    handlers: createMainRpcHandlers(),
    onLog: (level, message) => {
      if (level === 'error') console.error('[agentRuntime/rpc]', message);
      else console.warn('[agentRuntime/rpc]', message);
    },
  });

  try {
    const port = await waitForReady(child, READY_TIMEOUT_MS);
    refs = { child, bridge, port, token };

    // 退出处理：主动停止推 stopped，意外退出触发自动重启
    child.on('exit', (code) => handleRuntimeExit(child, code));

    const baseUrl = `http://127.0.0.1:${port}/api/v1`;
    console.log(`[agentRuntime] 已启动于 ${baseUrl}`);
    pushStatus({ state: 'running', baseUrl });
    scheduleStableReset();
    return baseUrl;
  } catch (err) {
    bridge.dispose('startup failed');
    child.kill();
    pushStatus({
      state: 'error',
      baseUrl: null,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/** 运行时进程退出：区分「主动停止」与「意外崩溃」。 */
function handleRuntimeExit(child: UtilityProcess, code: number): void {
  const wasIntentional = intentionalStop;
  const bridge = refs?.bridge;
  if (refs?.child === child) refs = null;
  bridge?.dispose('runtime exited');
  clearStableTimer();

  if (wasIntentional) {
    pushStatus({ state: 'stopped', baseUrl: null });
    return;
  }

  scheduleRestart(code);
}

/** 稳定运行 RESTART_STABLE_MS 后清零退避计数（说明本次重启是成功的）。 */
function scheduleStableReset(): void {
  clearStableTimer();
  stableTimer = setTimeout(() => {
    stableTimer = null;
    if (restartAttempt > 0) {
      console.log(
        `[agentRuntime] 已稳定运行 ${RESTART_STABLE_MS}ms，清零重启计数（此前 ${restartAttempt} 次）`,
      );
      restartAttempt = 0;
    }
  }, RESTART_STABLE_MS);
  stableTimer.unref?.();
}

/**
 * 意外退出后的自动重启（指数退避 + 上限）。
 *
 * @param code 退出码；传 `null` 表示上一次重启在**启动阶段**就失败（没有退出码）
 */
function scheduleRestart(code: number | null): void {
  restartAttempt += 1;
  const exitLabel = code === null ? '启动失败' : `code ${code}`;

  if (shouldGiveUpRestart(restartAttempt)) {
    console.error(
      `[agentRuntime] 连续 ${restartAttempt} 次异常退出（最后 ${exitLabel}），放弃自动重启`,
    );
    pushStatus({
      state: 'error',
      baseUrl: null,
      message:
        `Agent 运行时连续 ${restartAttempt} 次异常退出（最后 ${exitLabel}），` +
        '已停止自动重启，请重启应用。',
    });
    restartAttempt = 0;
    return;
  }

  const delay = computeRestartDelayMs(restartAttempt);
  console.warn(
    `[agentRuntime] ${exitLabel}，${delay}ms 后发起第 ${restartAttempt} 次重启`,
  );
  pushStatus({
    state: 'starting',
    baseUrl: null,
    message: `Agent 运行时已退出（${exitLabel}），正在第 ${restartAttempt} 次重启…`,
  });

  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (intentionalStop) return;
    // 复用 startAgentRuntime：若这次也失败（spawn 失败 / 就绪超时），
    // 同样计入退避预算并继续重试
    void startAgentRuntime().catch((err) => {
      console.error('[agentRuntime] 自动重启失败:', err);
      if (intentionalStop) return;
      scheduleRestart(null);
    });
  }, delay);
  restartTimer.unref?.();
}

function makeEndpoint(child: UtilityProcess): MessageEndpoint {
  // 运行时的 `shutdown` 是「先优雅关闭、超时再 kill」，期间仍可能有 RPC 回包。
  // 用显式标志而不是探测方法存在性来判断通道是否还可用。
  let closed = false;
  child.once('exit', () => {
    closed = true;
  });

  return {
    postMessage: (message) => {
      if (closed) return;
      try {
        child.postMessage(message);
      } catch {
        // 进程可能刚好退出，静默丢弃：调用方由 RPC 超时兜底
        closed = true;
      }
    },
    onMessage: (handler) => {
      const listener = (message: unknown): void => {
        if (isAgentMessage(message)) handler(message);
      };
      child.on('message', listener);
      return () => {
        child.off('message', listener);
      };
    },
  };
}

function waitForReady(child: UtilityProcess, timeoutMs: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Agent 运行时启动超时（${timeoutMs}ms）`));
    }, timeoutMs);

    const onMessage = (message: unknown): void => {
      if (!isAgentMessage(message)) return;
      if (message.type === 'ready') {
        cleanup();
        resolve(message.port);
      }
    };

    const onExit = (code: number): void => {
      cleanup();
      reject(new Error(`Agent 运行时启动期间退出 (code ${code})`));
    };

    function cleanup(): void {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
    }

    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

/** 停止运行时。幂等。 */
export function stopAgentRuntime(): void {
  // 先置「主动停止」意图并取消待触发的重启，否则退出会被当成崩溃而重新拉起
  intentionalStop = true;
  cancelRestartTimer();
  clearStableTimer();
  restartAttempt = 0;

  if (!refs) return;
  const { child, bridge } = refs;
  refs = null;
  try {
    child.postMessage({ type: 'shutdown' });
  } catch {
    /* 通道可能已断 */
  }
  bridge.dispose('stopping');
  // 给运行时 1.5s 优雅关闭，超时强杀
  const target = child;
  setTimeout(() => {
    try {
      target.kill();
    } catch {
      /* 已退出 */
    }
  }, 1500).unref?.();
}

/** 当前 base URL；未启动返回 null。 */
export function getAgentRuntimeBaseUrl(): string | null {
  return refs ? `http://127.0.0.1:${refs.port}/api/v1` : null;
}

/** 当前访问 token；未启动返回 null。 */
export function getAgentRuntimeToken(): string | null {
  return refs?.token ?? null;
}

/** 供自检使用：桥是否已连通。 */
export function getAgentRuntimeBridge(): Bridge | null {
  return refs?.bridge ?? null;
}
