/**
 * 主进程 ↔ Agent 运行时之间的对称 RPC 桥。
 *
 * 两侧各自持有一个 Bridge 实例，底层是一条双向消息通道（主进程侧是
 * `utilityProcess` 的 `postMessage`/`message` 事件，运行时侧是 `process.parentPort`）。
 *
 * 职责：
 * - 把本地 `call(channel, payload)` 编码成 `rpc:request`，并等待配对的 `rpc:response`
 * - 收到对端 `rpc:request` 时分派到本地注册的 handler，并把结果编码成 `rpc:response`
 * - 请求超时、未知通道、handler 抛异常都转成**结构化错误**，不让异常穿过消息边界
 * - 进程退出时拒绝全部 pending，避免调用方永久挂起
 */

import {
  AGENT_CHANNELS,
  type AgentLogLevel,
  type AgentMessage,
} from './protocol';

/** 底层双向通道的抽象，屏蔽 utilityProcess 与 parentPort 的 API 差异。 */
export interface MessageEndpoint {
  postMessage(message: unknown): void;
  /** 注册消息处理器，返回取消订阅函数。 */
  onMessage(handler: (message: unknown) => void): () => void;
}

export type RpcHandler = (payload: any) => unknown | Promise<unknown>;
export type RpcHandlers = Record<string, RpcHandler>;

export interface BridgeOptions {
  endpoint: MessageEndpoint;
  /** 本侧 id 前缀，主进程用 `h`，运行时用 `r`。 */
  side: 'h' | 'r';
  /** 初始 handler 表；后续可用 `handle()` 增补。 */
  handlers?: RpcHandlers;
  /** 单次 RPC 超时（毫秒）。默认 30s。 */
  timeoutMs?: number;
  onLog?: (level: AgentLogLevel, message: string) => void;
}

export interface Bridge {
  call<T = unknown>(channel: string, payload?: unknown): Promise<T>;
  /** 注册（或覆盖）一个通道的处理器。 */
  handle(channel: string, handler: RpcHandler): void;
  /** 批量注册，已存在的同名通道会被覆盖。 */
  handleAll(handlers: RpcHandlers): void;
  /** 主动断开：拒绝全部 pending 并停止处理后续消息。 */
  dispose(reason?: string): void;
  /** 是否有未完成的调用（用于优雅退出前等待）。 */
  readonly pendingCount: number;
}

interface PendingCall {
  channel: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RpcError extends Error {
  readonly channel: string;

  constructor(channel: string, message: string) {
    super(`[rpc:${channel}] ${message}`);
    this.name = 'RpcError';
    this.channel = channel;
  }
}

export function createBridge(options: BridgeOptions): Bridge {
  const { endpoint, side, timeoutMs = 30_000 } = options;
  const handlers: RpcHandlers = { ...(options.handlers ?? {}) };
  const pending = new Map<string, PendingCall>();
  let nextId = 1;
  let disposed = false;

  const log = (level: AgentLogLevel, message: string): void => {
    options.onLog?.(level, message);
  };

  const unsubscribe = endpoint.onMessage((raw) => {
    if (disposed) return;
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as AgentMessage;

    if (msg.type === 'rpc:response') {
      const entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) {
        entry.resolve(msg.result);
      } else {
        entry.reject(new RpcError(entry.channel, msg.error));
      }
      return;
    }

    if (msg.type === 'rpc:request') {
      void dispatchRequest(msg.id, msg.channel, msg.payload);
    }
  });

  async function dispatchRequest(
    id: string,
    channel: string,
    payload: unknown,
  ): Promise<void> {
    const handler = handlers[channel];
    if (!handler) {
      log('warn', `未注册的 RPC 通道: ${channel}`);
      reply(id, false, undefined, `unknown channel: ${channel}`);
      return;
    }
    try {
      const result = await handler(payload);
      reply(id, true, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('warn', `RPC 通道 ${channel} 处理失败: ${message}`);
      reply(id, false, undefined, message);
    }
  }

  function reply(
    id: string,
    ok: boolean,
    result?: unknown,
    error?: string,
  ): void {
    if (disposed) return;
    const msg: AgentMessage = ok
      ? { type: 'rpc:response', id, ok: true, result }
      : { type: 'rpc:response', id, ok: false, error: error ?? 'unknown error' };
    endpoint.postMessage(msg);
  }

  function call<T>(channel: string, payload?: unknown): Promise<T> {
    if (disposed) {
      return Promise.reject(new RpcError(channel, 'bridge disposed'));
    }
    const id = `${side}${nextId}`;
    nextId += 1;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new RpcError(channel, `timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      pending.set(id, {
        channel,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      const msg: AgentMessage = { type: 'rpc:request', id, channel, payload };
      endpoint.postMessage(msg);
    });
  }

  function dispose(reason = 'bridge disposed'): void {
    if (disposed) return;
    disposed = true;
    unsubscribe();
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new RpcError(entry.channel, reason));
      pending.delete(id);
    }
  }

  return {
    call,
    handle(channel: string, handler: RpcHandler): void {
      handlers[channel] = handler;
    },
    handleAll(next: RpcHandlers): void {
      Object.assign(handlers, next);
    },
    dispose,
    get pendingCount(): number {
      return pending.size;
    },
  };
}

/** 便捷封装：`ping` 探针，用于冒烟验证桥连通性。 */
export async function pingBridge(bridge: Bridge): Promise<boolean> {
  const result = await bridge.call<{ ok?: boolean }>(AGENT_CHANNELS.ping, {});
  return result?.ok === true;
}
