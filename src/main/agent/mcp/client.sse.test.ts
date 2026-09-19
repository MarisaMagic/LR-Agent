/**
 * @jest-environment node
 *
 * 验证 MCP 客户端对 SSE 与 streamable_http 两种传输的连接生命周期差异：
 *   - SSE 是有状态长连接：发现工具时建立的连接要复用给 tools/call，
 *     不能每次调用都重新 connect（否则「按会话绑定」的服务端列出工具成功、调用失败）。
 *   - streamable_http 无状态：发现连接用完即关，调用按需建连（现状）。
 */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { clearMcpToolsCache, loadMcpToolsFromServers } from './client';

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: jest.fn(),
}));
jest.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: jest.fn(),
}));
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn(),
}));

const ClientMock = Client as unknown as jest.Mock;

/** 构造一个 mock 客户端实例，每个用例独立，close 计数互不污染。 */
function mockClientInstance() {
  return {
    connect: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    listTools: jest.fn<() => Promise<unknown>>().mockResolvedValue({
      tools: [
        {
          name: 'echo',
          description: 'echo tool',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    }),
    callTool: jest
      .fn<() => Promise<unknown>>()
      .mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
    close: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

const sseServer = {
  id: 'srv-sse',
  url: 'https://example.com/sse',
  transport: 'sse' as const,
  headers: {},
  disabledTools: [],
};

const httpServer = {
  id: 'srv-http',
  url: 'https://example.com/mcp',
  transport: 'streamable_http' as const,
  headers: {},
  disabledTools: [],
};

beforeEach(() => {
  // 先清理缓存（会关闭上一用例遗留的 SSE 连接），再清空 mock 计数。
  clearMcpToolsCache();
  ClientMock.mockClear();
});

describe('SSE 连接复用', () => {
  it('发现时建连一次，工具调用复用同一条连接（不重新 connect、不 close）', async () => {
    const instance = mockClientInstance();
    ClientMock.mockImplementation(() => instance);

    const tools = await loadMcpToolsFromServers({
      remoteServers: [sseServer],
      ttlSeconds: 0,
    });

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('echo');
    // 发现阶段：建连一次
    expect(ClientMock).toHaveBeenCalledTimes(1);
    expect(instance.listTools).toHaveBeenCalledTimes(1);

    // 调用工具：复用发现连接，不重新建连
    const result = await tools[0]!.execute!({}, undefined as never);
    expect(result).toBe('ok');
    expect(instance.callTool).toHaveBeenCalledTimes(1);
    expect(ClientMock).toHaveBeenCalledTimes(1);
    // 复用连接既不在发现结束、也不在调用结束时被关闭
    expect(instance.close).not.toHaveBeenCalled();
  });
});

describe('streamable_http 按需建连（保持现状）', () => {
  it('发现连接用完即关，工具调用重新建连', async () => {
    const instance = mockClientInstance();
    ClientMock.mockImplementation(() => instance);

    const tools = await loadMcpToolsFromServers({
      remoteServers: [httpServer],
      ttlSeconds: 0,
    });

    expect(tools).toHaveLength(1);
    // 发现阶段：建连一次，发现后关闭
    expect(ClientMock).toHaveBeenCalledTimes(1);
    expect(instance.close).toHaveBeenCalledTimes(1);

    // 调用工具：按需重建一条连接，用完再关
    await tools[0]!.execute!({}, undefined as never);
    expect(ClientMock).toHaveBeenCalledTimes(2);
    expect(instance.callTool).toHaveBeenCalledTimes(1);
    expect(instance.close).toHaveBeenCalledTimes(2);
  });
});
