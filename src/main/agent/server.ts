/**
 * Agent 运行时的回环 HTTP 服务。
 *
 * 阶段 1 只提供：
 *   - `GET /health`（免鉴权，供主进程探活）
 *   - 全部业务路由的骨架（统一返回 501 not_implemented），使路由表与鉴权/CORS
 *     中间件在阶段 2 接入真实实现前就已被验证
 *
 * 之所以在阶段 1 就保留回环 HTTP 外壳：让 `src/renderer/**` **零改动**，
 * 并且可以拿 Node 运行时与 Python 服务做 A/B 对照（阶段 0 的 golden diff）。
 * 阶段 9 会移除这一层，改为直连 IPC。
 *
 * 安全约束：
 *   - 仅监听 127.0.0.1（由调用方决定 host）
 *   - 除 `/health` 外全部路由要求 `Authorization: Bearer <token>`
 *   - CORS 允许来源显式列白，禁止通配符（`allow_credentials` 与 `*` 组合会
 *     让任意站点携带凭据访问）
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

/** 单请求体上限：需容纳 base64 图片兜底路径，故给到 32MB。 */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

export interface RouteRequest {
  method: string;
  /** 不含 query，形如 `/api/v1/agent/chat/stream`。 */
  path: string;
  query: URLSearchParams;
  headers: http.IncomingHttpHeaders;
  /** 原始请求体文本（已按上限截断保护）。 */
  rawBody: string;
}

export type RouteResult =
  | { kind: 'json'; status?: number; body: unknown }
  /** SSE 流：由服务设置响应头后逐帧写入，帧内容由调用方编码。 */
  | { kind: 'sse'; frames: AsyncGenerator<string> }
  | { kind: 'not_implemented' }
  | { kind: 'method_not_allowed' };

export type RouteHandler = (req: RouteRequest) => Promise<RouteResult> | RouteResult;

export interface AgentServerOptions {
  host: string;
  /** 绑定的端口，0 表示由系统分配。 */
  port: number;
  /** 访问 token；除 /health 外全部路由校验。 */
  token: string;
  /** 允许的 CORS 来源，禁止包含 `*`。 */
  corsOrigins: string[];
  /** 路由表：`"<METHOD> <path>"` → handler。 */
  routes: Record<string, RouteHandler>;
  onLog?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface AgentServer {
  /** 实际监听端口。 */
  readonly port: number;
  close(): Promise<void>;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过上限 ${MAX_BODY_BYTES} 字节`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function resolveCorsOrigin(
  requestOrigin: string | undefined,
  allowed: string[],
): string | null {
  if (!requestOrigin) return null;
  return allowed.includes(requestOrigin) ? requestOrigin : null;
}

/**
 * 校验 CORS 配置。`allow_credentials` 与通配符组合会让任意站点携带凭据访问，
 * 直接拒绝启动（与 Python 版行为一致）。
 */
export function assertCorsConfig(origins: string[]): void {
  if (origins.some((o) => o.trim() === '*')) {
    throw new Error("corsOrigins 不能包含 '*': 凭证模式下禁止通配符");
  }
}

export async function startAgentServer(
  options: AgentServerOptions,
): Promise<AgentServer> {
  assertCorsConfig(options.corsOrigins);

  const log = options.onLog ?? (() => {});
  const sockets = new Set<import('node:net').Socket>();

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    // ── CORS ──────────────────────────────────────────────
    const origin = resolveCorsOrigin(
      req.headers.origin,
      options.corsOrigins,
    );
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.statusCode = 200;
      res.end();
      return;
    }

    // ── 健康检查（免鉴权） ────────────────────────────────
    if (path === '/health') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    // ── 鉴权 ──────────────────────────────────────────────
    const auth = req.headers.authorization ?? '';
    const expected = `Bearer ${options.token}`;
    if (!constantTimeEqual(auth, expected)) {
      sendJson(res, 401, { detail: 'invalid_local_token' });
      return;
    }

    const route = options.routes[`${method} ${path}`];
    if (!route) {
      // 路径存在但方法不符时给出 405，便于排查
      const pathExists = Object.keys(options.routes).some(
        (key) => key.slice(key.indexOf(' ') + 1) === path,
      );
      sendJson(
        res,
        pathExists ? 405 : 404,
        { detail: pathExists ? 'method_not_allowed' : 'not_found', path },
      );
      return;
    }

    let rawBody = '';
    try {
      rawBody = await readBody(req);
    } catch (err) {
      sendJson(res, 413, {
        detail: err instanceof Error ? err.message : 'body_read_failed',
      });
      return;
    }

    let result: RouteResult;
    try {
      result = await route({
        method,
        path,
        query: url.searchParams,
        headers: req.headers,
        rawBody,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log('error', `路由 ${method} ${path} 抛出异常: ${message}`);
      sendJson(res, 500, { detail: 'internal_error', message });
      return;
    }

    if (result.kind === 'not_implemented') {
      sendJson(res, 501, { detail: 'not_implemented', path });
      return;
    }
    if (result.kind === 'method_not_allowed') {
      sendJson(res, 405, { detail: 'method_not_allowed' });
      return;
    }
    if (result.kind === 'sse') {
      await pipeSse(res, result.frames);
      return;
    }
    sendJson(res, result.status ?? 200, result.body);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  log('info', `Agent 运行时 HTTP 服务已监听 ${options.host}:${address.port}`);

  return {
    port: address.port,
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

/**
 * 以 SSE 逐帧写出。
 *
 * 客户端断开（`res` 被销毁）时停止拉取，避免生成器继续空转。
 * 不设置 Content-Length；使用 chunked 传输。
 */
async function pipeSse(
  res: http.ServerResponse,
  frames: AsyncGenerator<string>,
): Promise<void> {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // 关闭 Nagle 以降低小帧延迟
  res.socket?.setNoDelay(true);

  let closed = false;
  const onClose = (): void => {
    closed = true;
  };
  res.on('close', onClose);

  try {
    for await (const frame of frames) {
      if (closed) break;
      res.write(frame);
    }
  } catch {
    // 流中断：交由客户端合成 error 事件（运行时从不主动发 error）
  } finally {
    res.off('close', onClose);
    void frames.return?.(undefined).catch(() => {
      /* 生成器清理失败不阻塞响应收尾 */
    });
    if (!closed) res.end();
  }
}
