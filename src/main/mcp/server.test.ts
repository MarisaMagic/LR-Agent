/**
 * @jest-environment node
 */
import http from 'http';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { getMcpServerToken, startMcpServer, stopMcpServer } from './server';

jest.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    getName: () => 'lr-agent',
  },
}));

function request(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

let baseUrl = '';

beforeAll(async () => {
  baseUrl = await startMcpServer();
});

afterAll(() => {
  stopMcpServer();
});

describe('MCP server 鉴权与请求校验', () => {
  it('/health 保持开放', async () => {
    const res = await request(`${baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  it('缺少 Authorization 时返回 401', async () => {
    const res = await request(`${baseUrl}/mcp`);
    expect(res.status).toBe(401);
  });

  it('错误 token 返回 401', async () => {
    const res = await request(`${baseUrl}/mcp`, {
      Authorization: 'Bearer wrong-token',
    });
    expect(res.status).toBe(401);
  });

  it('带跨源 Origin 时返回 403', async () => {
    const token = getMcpServerToken();
    const res = await request(`${baseUrl}/mcp`, {
      Authorization: `Bearer ${token}`,
      Origin: 'http://evil.example',
    });
    expect(res.status).toBe(403);
  });

  it('正确 token 且无 session 时返回 400（已通过鉴权）', async () => {
    const token = getMcpServerToken();
    expect(token).toBeTruthy();
    const res = await request(`${baseUrl}/mcp`, {
      Authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(400);
  });
});
