/**
 * Agent 运行时（utilityProcess）入口。
 *
 * 该文件由 webpack 单独打包为 `dist/main/agentRuntime.js`，由主进程经
 * `utilityProcess.fork` 启动（见 `host.ts`）。它是**独立于主进程的 Node 进程**，
 * 因此可以承载长时间运行的 Agent 循环而不阻塞 UI，且崩溃不会带走整个应用。
 *
 * 两种运行模式：
 *   1. **Electron 模式**：存在 `process.parentPort`，经桥与主进程通信，端口绑定 0
 *      后把实际端口通过 `ready` 消息回报。
 *   2. **独立模式**：直接 `node agentRuntime.js` 运行（无 parentPort）。端口与 token
 *      从环境变量读取，便于在不启动 Electron 的情况下用
 *      `scripts/agent-baseline/captureSse.mjs` 做协议对拍。
 *
 * 阶段 1 只提供服务骨架（`/health` + 501 路由）。Agent 循环在阶段 2 接入。
 */

import { createBridge, type Bridge, type MessageEndpoint } from './bridge';
import { startAgentServer, type AgentServer } from './server';
import { buildImplementedRoutes } from './handlers';
import { createDefaultDeps } from './handlers/deps';
import { createImageService } from './services/imageService';
import {
  AGENT_CHANNELS,
  AGENT_DEBUG_ENV,
  AGENT_TOKEN_ENV,
  isAgentMessage,
  type AgentLogLevel,
} from './protocol';

/** 默认 CORS 来源，与 Python 版 `cors_origins` 一致（Vite dev server）。 */
const DEFAULT_CORS_ORIGINS = ['http://localhost:1212'];

const HOST = '127.0.0.1';

/** Electron utilityProcess 的 parentPort 结构（仅取用到的部分）。 */
interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

function getParentPort(): ParentPortLike | null {
  const port = (process as unknown as { parentPort?: ParentPortLike })
    .parentPort;
  return port ?? null;
}

function makeLog(forward: (level: AgentLogLevel, message: string) => void) {
  return (level: AgentLogLevel, message: string): void => {
    const line = `[agentRuntime] ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    forward(level, message);
  };
}

async function main(): Promise<void> {
  const parentPort = getParentPort();
  const debug = process.env[AGENT_DEBUG_ENV] === '1';

  let bridge: Bridge | null = null;

  // 日志：始终打到 stdout（主进程会捕获），Electron 模式下另外转发给主进程
  const log = makeLog((level, message) => {
    if (!parentPort) return;
    parentPort.postMessage({ type: 'log', level, message });
  });

  if (parentPort) {
    const endpoint: MessageEndpoint = {
      postMessage: (message) => parentPort.postMessage(message),
      onMessage: (handler) => {
        const listener = (event: { data: unknown }): void => {
          if (isAgentMessage(event.data)) handler(event.data);
        };
        parentPort.on('message', listener);
        return () => {
          /* parentPort 无 off，进程退出即回收 */
        };
      },
    };
    bridge = createBridge({
      endpoint,
      side: 'r',
      // 存活探针：让主进程能区分「HTTP 端口在监听」与「运行时真正可响应 RPC」。
      // 桥是双向的，两侧都应答 ping，主进程可据此确认通道健康。
      handlers: {
        [AGENT_CHANNELS.ping]: () => ({
          ok: true,
          side: 'runtime',
          ts: Date.now(),
        }),
      },
      onLog: (level, message) => log(level, `bridge: ${message}`),
    });
  }

  // ── token 与端口 ───────────────────────────────────────────
  const token = process.env[AGENT_TOKEN_ENV] ?? '';
  if (!token) {
    // 与 Python 版一致：token 未配置时失败关闭，不启动服务
    log(
      'error',
      `${AGENT_TOKEN_ENV} 未设置，拒绝启动（token 未配置时不得对外提供服务）`,
    );
    process.exitCode = 1;
    return;
  }

  const desiredPort = Number(process.env.LR_AGENT_LOCAL_PORT ?? '0') || 0;

  // ── HTTP 服务 ──────────────────────────────────────────────
  let server: AgentServer;
  try {
    server = await startAgentServer({
      host: HOST,
      port: desiredPort,
      token,
      corsOrigins: DEFAULT_CORS_ORIGINS,
      routes: buildImplementedRoutes({
        ...createDefaultDeps(),
        // utilityProcess 模式下注入经 RPC 的图像服务（具备 nativeImage 编码能力）；
        // 独立模式 bridge 为 null，退化为仅能探测尺寸/格式
        imageService: createImageService(bridge),
      }),
      onLog: (level, message) => log(level, message),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log('error', `HTTP 服务启动失败: ${message}`);
    parentPort?.postMessage({ type: 'log', level: 'error', message });
    process.exitCode = 1;
    return;
  }

  log('info', `就绪，baseUrl=http://${HOST}:${server.port}/api/v1`);
  if (debug)
    log('info', `模式=${parentPort ? 'utilityProcess' : 'standalone'}`);

  // 独立模式下把端口打到 stdout，便于脚本解析
  if (!parentPort) {
    console.log(`[agentRuntime] PORT=${server.port}`);
  } else {
    parentPort.postMessage({ type: 'ready', port: server.port });
  }

  // ── 优雅退出 ───────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', `开始关闭（${reason}）`);
    bridge?.dispose('runtime shutting down');
    await server.close().catch(() => {
      /* 关闭失败不阻断退出 */
    });
    log('info', '已关闭');
  };

  if (parentPort) {
    // 主进程经消息触发关闭
    const endpointOnMessage = (event: { data: unknown }): void => {
      const { data } = event;
      if (isAgentMessage(data) && data.type === 'shutdown') {
        void shutdown('shutdown message').then(() => process.exit(0));
      }
    };
    parentPort.on('message', endpointOnMessage);
  } else {
    process.on('SIGINT', () => {
      void shutdown('SIGINT').then(() => process.exit(0));
    });
    process.on('SIGTERM', () => {
      void shutdown('SIGTERM').then(() => process.exit(0));
    });
  }

  // 兜底：任何未捕获异常都上报并退出，避免进程静默挂死
  process.on('uncaughtException', (err) => {
    log('error', `未捕获异常: ${err.stack ?? err.message}`);
    void shutdown('uncaughtException').then(() => process.exit(1));
  });
  process.on('unhandledRejection', (reason) => {
    log('error', `未处理的 Promise 拒绝: ${String(reason)}`);
  });
}

void main();
