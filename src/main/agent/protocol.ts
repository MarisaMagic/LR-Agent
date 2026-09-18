/**
 * Agent 运行时（utilityProcess）与主进程之间的消息协议。
 *
 * 设计要点：
 * - **对称 RPC**：两侧都可以发起请求、都可以提供服务。运行时需要主进程的能力
 *   （nativeImage 图像处理、文件写入、标注文档读写等），主进程也需要运行时
 *   （后续阶段的生命周期管理）。
 * - id 带侧别前缀（`h` / `r`），使两侧各自维护的 pending 表互不干扰，日志也可读。
 * - 除 RPC 外只有三类控制消息：`ready` / `log` / `shutdown`。
 *
 * 该协议是**内部协议**，与面向渲染层的 SSE 契约无关。渲染层契约见
 * `docs/agent-protocol.md`。
 */

/** webpack entry 名，产物为 `dist/main/agentRuntime.js`。 */
export const AGENT_RUNTIME_ENTRY = 'agentRuntime';

/** 通过 env 注入运行时的 token 环境变量名（与 Python 版保持一致）。 */
export const AGENT_TOKEN_ENV = 'LR_AGENT_LOCAL_TOKEN';

/** 通过 env 覆盖运行时日志开关。 */
export const AGENT_DEBUG_ENV = 'LR_AGENT_AGENT_DEBUG';

export type AgentLogLevel = 'info' | 'warn' | 'error';

export interface RpcRequestMessage {
  type: 'rpc:request';
  /** 形如 `h12`（主进程发起）或 `r12`（运行时发起）。 */
  id: string;
  channel: string;
  payload: unknown;
}

export interface RpcResponseOkMessage {
  type: 'rpc:response';
  id: string;
  ok: true;
  result: unknown;
}

export interface RpcResponseErrMessage {
  type: 'rpc:response';
  id: string;
  ok: false;
  error: string;
}

export type RpcResponseMessage = RpcResponseOkMessage | RpcResponseErrMessage;

/** 运行时的 HTTP 服务已就绪，回报实际监听端口（绑定 0 由系统分配）。 */
export interface ReadyMessage {
  type: 'ready';
  port: number;
}

export interface LogMessage {
  type: 'log';
  level: AgentLogLevel;
  message: string;
}

export interface ShutdownMessage {
  type: 'shutdown';
}

export type AgentMessage =
  | RpcRequestMessage
  | RpcResponseMessage
  | ReadyMessage
  | LogMessage
  | ShutdownMessage;

/**
 * 主进程侧暴露给运行时的能力通道。
 *
 * 命名与渲染层 IPC 保持一致的语义（如 `workspace:writeTextFile`），便于对照排查。
 * 后续阶段会逐步补充图像、标注、记忆、skills、终端等通道。
 */
export const AGENT_CHANNELS = {
  /** 连通性探针。 */
  ping: 'ping',
  workspaceWriteTextFile: 'workspace:writeTextFile',
  workspaceReadTextFile: 'workspace:readTextFile',
  workspaceDeleteTextFile: 'workspace:deleteTextFile',
  workspaceMoveTextFile: 'workspace:moveTextFile',
  /** 读图片尺寸与格式（替代 Pillow 的 Image.open(...).size / .format）。 */
  imageProbe: 'image:probe',
  /** 等比缩放并编码为 JPEG data URL（替代 Pillow 的 resize + JPEG 编码）。 */
  imageDataUrl: 'image:dataUrl',
  /** 批量裁剪 + 缩放 + 编码（替代视觉映射的逐框裁剪）。 */
  imageCropBatch: 'image:cropBatch',
  /** 读取项目内某文件的标注文档（.lr-agent/annotations/files/<sha256>.json）。 */
  annotationReadDoc: 'annotation:readFileDoc',
} as const;

export type AgentChannel = (typeof AGENT_CHANNELS)[keyof typeof AGENT_CHANNELS];

/** 判断是否为合法的运行时消息（防御 parentPort 上的脏数据）。 */
export function isAgentMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== 'object') return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === 'rpc:request' ||
    type === 'rpc:response' ||
    type === 'ready' ||
    type === 'log' ||
    type === 'shutdown'
  );
}
