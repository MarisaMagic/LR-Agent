import http from 'node:http';
import { afterEach, describe, expect, it } from '@jest/globals';
import {
  assertCorsConfig,
  resolveCorsOrigin,
  startAgentServer,
  type AgentServer,
  type RouteHandler,
} from './server';

const TOKEN = 'test-token-0123456789';

/** 极简 HTTP 客户端，避免依赖 jest 环境下的 fetch 实现。 */
function request(
  port: number,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: init.method ?? 'GET',
        headers: init.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

const started: AgentServer[] = [];

async function boot(
  overrides: Record<string, RouteHandler> = {},
): Promise<number> {
  const server = await startAgentServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    corsOrigins: ['http://localhost:1212'],
    routes: {
      'POST /api/v1/agent/echo': (req) => ({
        kind: 'json',
        body: { ok: true, echoed: req.rawBody },
      }),
      'POST /api/v1/agent/stub': () => ({ kind: 'not_implemented' }),
      ...overrides,
    },
  });
  started.push(server);
  return server.port;
}

afterEach(async () => {
  while (started.length) {
    const server = started.pop();
    // eslint-disable-next-line no-await-in-loop
    await server?.close();
  }
});

describe('agent runtime HTTP server', () => {
  describe('健康检查', () => {
    it('免鉴权返回 200', async () => {
      const port = await boot();
      const res = await request(port, '/health');
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ status: 'ok' });
    });
  });

  describe('鉴权', () => {
    it('缺少 token 返回 401', async () => {
      const port = await boot();
      const res = await request(port, '/api/v1/agent/echo', { method: 'POST' });
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body).detail).toBe('invalid_local_token');
    });

    it('token 错误返回 401', async () => {
      const port = await boot();
      const res = await request(port, '/api/v1/agent/echo', {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong-token' },
      });
      expect(res.status).toBe(401);
    });

    it('token 长度不同也不抛异常（常量时间比较）', async () => {
      const port = await boot();
      const res = await request(port, '/api/v1/agent/echo', {
        method: 'POST',
        headers: { Authorization: 'Bearer x' },
      });
      expect(res.status).toBe(401);
    });

    it('token 正确时放行', async () => {
      const port = await boot();
      const res = await request(port, '/api/v1/agent/echo', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
        body: 'payload',
      });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ok: true, echoed: 'payload' });
    });
  });

  describe('路由', () => {
    it('未实现路由返回 501（阶段 1 全部业务路由如此）', async () => {
      const port = await boot();
      const res = await request(port, '/api/v1/agent/stub', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(501);
      expect(JSON.parse(res.body).detail).toBe('not_implemented');
    });

    it('未知路径返回 404', async () => {
      const port = await boot();
      const res = await request(port, '/api/v1/nope', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(404);
    });

    it('路径存在但方法不符返回 405', async () => {
      const port = await boot();
      const res = await request(port, '/api/v1/agent/echo', {
        method: 'GET',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(405);
    });

    it('handler 抛异常返回 500 而不是崩溃', async () => {
      const port = await boot({
        'POST /api/v1/agent/boom': () => {
          throw new Error('boom');
        },
      });
      const res = await request(port, '/api/v1/agent/boom', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(res.status).toBe(500);
      expect(JSON.parse(res.body).message).toBe('boom');
    });
  });

  describe('CORS', () => {
    it('允许来源携带 ACAO 与 credentials 头', async () => {
      const port = await boot();
      const res = await request(port, '/health', {
        headers: { Origin: 'http://localhost:1212' },
      });
      expect(res.headers['access-control-allow-origin']).toBe(
        'http://localhost:1212',
      );
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('未列入白名单的来源不返回 ACAO', async () => {
      const port = await boot();
      const res = await request(port, '/health', {
        headers: { Origin: 'http://evil.example' },
      });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('OPTIONS 预检返回 200 且不需要鉴权', async () => {
      const port = await boot();
      const res = await request(port, '/api/v1/agent/echo', {
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost:1212' },
      });
      expect(res.status).toBe(200);
    });
  });
});

describe('CORS 配置校验', () => {
  it('拒绝通配符来源', () => {
    expect(() => assertCorsConfig(['*'])).toThrow(/通配符/);
  });

  it('放行显式来源', () => {
    expect(() => assertCorsConfig(['http://localhost:1212'])).not.toThrow();
  });

  it('无 Origin 时不返回 ACAO', () => {
    expect(resolveCorsOrigin(undefined, ['http://localhost:1212'])).toBeNull();
  });
});
