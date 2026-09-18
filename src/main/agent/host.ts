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

interface RuntimeRefs {
  child: UtilityProcess;
  bridge: Bridge;
  port: number;
  token: string;
}

let refs: RuntimeRefs | null = null;
let starting: Promise<string> | null = null;
let stopping = false;

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

  starting = (async () => {
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

      child.on('exit', (code) => {
        const wasStopping = stopping;
        stopping = false;
        bridge.dispose('runtime exited');
        if (refs?.child === child) refs = null;
        pushStatus({
          state: 'stopped',
          baseUrl: null,
          message: wasStopping ? undefined : `Agent 运行时已退出 (code ${code})`,
        });
      });

      const baseUrl = `http://127.0.0.1:${port}/api/v1`;
      console.log(`[agentRuntime] 已启动于 ${baseUrl}`);
      pushStatus({ state: 'running', baseUrl });
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
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
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
  if (!refs) return;
  stopping = true;
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
