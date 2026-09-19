/**
 * @jest-environment node
 */
import { beforeEach, describe, expect, it } from '@jest/globals';
import {
  cacheKey,
  clearMcpToolsCache,
  inferMcpCapability,
  localConnection,
  remoteConnection,
  shouldExposeMcpTool,
  stringifyMcpResult,
} from './client';

beforeEach(() => {
  clearMcpToolsCache();
});

describe('cacheKey：连接指纹', () => {
  it('同 URL 与 transport 生成同一键', () => {
    const a = cacheKey({ url: 'http://x/mcp', transport: 'streamable_http' });
    const b = cacheKey({ url: 'http://x/mcp', transport: 'streamable_http' });
    expect(a).toBe(b);
  });

  it('transport 不同则键不同', () => {
    const a = cacheKey({ url: 'http://x/mcp', transport: 'streamable_http' });
    const b = cacheKey({ url: 'http://x/mcp', transport: 'sse' });
    expect(a).not.toBe(b);
  });

  it('headers 顺序不影响键（排序后比较）', () => {
    const a = cacheKey({
      url: 'http://x/mcp',
      transport: 'streamable_http',
      headers: { B: '2', A: '1' },
    });
    const b = cacheKey({
      url: 'http://x/mcp',
      transport: 'streamable_http',
      headers: { A: '1', B: '2' },
    });
    expect(a).toBe(b);
  });

  it('headers 值不同则键不同', () => {
    const a = cacheKey({
      url: 'http://x/mcp',
      transport: 'streamable_http',
      headers: { Authorization: 'Bearer a' },
    });
    const b = cacheKey({
      url: 'http://x/mcp',
      transport: 'streamable_http',
      headers: { Authorization: 'Bearer b' },
    });
    expect(a).not.toBe(b);
  });

  it('无 headers 与空 headers 等价', () => {
    const a = cacheKey({ url: 'http://x', transport: 'sse' });
    const b = cacheKey({ url: 'http://x', transport: 'sse', headers: {} });
    expect(a).toBe(b);
  });
});

describe('localConnection：本机连接参数', () => {
  it('端点固定拼 /mcp', () => {
    expect(localConnection('http://127.0.0.1:1234').url).toBe(
      'http://127.0.0.1:1234/mcp',
    );
  });

  it('URL 末尾斜杠不会产生双斜杠', () => {
    expect(localConnection('http://127.0.0.1:1234/').url).toBe(
      'http://127.0.0.1:1234/mcp',
    );
  });

  it('传输固定为 streamable_http', () => {
    expect(localConnection('http://x').transport).toBe('streamable_http');
  });

  it('有 token 时注入 Bearer 头', () => {
    const conn = localConnection('http://x', 'tok-123');
    expect(conn.headers?.Authorization).toBe('Bearer tok-123');
  });

  it('空白 token 不注入头', () => {
    expect(localConnection('http://x', '   ').headers).toBeUndefined();
    expect(localConnection('http://x', null).headers).toBeUndefined();
  });
});

describe('remoteConnection：远程连接参数', () => {
  it('URL 原样使用（不拼 /mcp）', () => {
    const conn = remoteConnection({
      id: 'a',
      url: 'https://example.com/api/mcp',
      transport: 'streamable_http',
      headers: {},
      disabledTools: [],
    });
    expect(conn.url).toBe('https://example.com/api/mcp');
  });

  it('按配置选择传输协议', () => {
    const sse = remoteConnection({
      id: 'a',
      url: 'https://x',
      transport: 'sse',
      headers: {},
      disabledTools: [],
    });
    expect(sse.transport).toBe('sse');
  });

  it('headers 透传', () => {
    const conn = remoteConnection({
      id: 'a',
      url: 'https://x',
      transport: 'streamable_http',
      headers: { 'X-Api-Key': 'k' },
      disabledTools: [],
    });
    expect(conn.headers).toEqual({ 'X-Api-Key': 'k' });
  });

  it('无 headers 时不设置该字段', () => {
    const conn = remoteConnection({
      id: 'a',
      url: 'https://x',
      transport: 'streamable_http',
      headers: {},
      disabledTools: [],
    });
    expect(conn.headers).toBeUndefined();
  });
});

describe('shouldExposeMcpTool：记忆工具与模式', () => {
  it('记忆关闭时不暴露 memory_*', () => {
    expect(
      shouldExposeMcpTool('memory_read', {
        workspaceMemoryEnabled: false,
        agentMode: 'annotation',
      }),
    ).toBe(false);
  });

  it('记忆关闭不影响 read_agent_skill', () => {
    expect(
      shouldExposeMcpTool('read_agent_skill', {
        workspaceMemoryEnabled: false,
        agentMode: 'annotation',
      }),
    ).toBe(true);
  });

  it('记忆开启 + 标注模式：全部 memory_* 可用', () => {
    for (const name of ['memory_read', 'memory_write', 'memory_create']) {
      expect(
        shouldExposeMcpTool(name, {
          workspaceMemoryEnabled: true,
          agentMode: 'annotation',
        }),
      ).toBe(true);
    }
  });

  it('记忆开启 + Ask 模式：只放行 memory_read', () => {
    expect(
      shouldExposeMcpTool('memory_read', {
        workspaceMemoryEnabled: true,
        agentMode: 'chat',
      }),
    ).toBe(true);
    expect(
      shouldExposeMcpTool('memory_write', {
        workspaceMemoryEnabled: true,
        agentMode: 'chat',
      }),
    ).toBe(false);
    expect(
      shouldExposeMcpTool('memory_create', {
        workspaceMemoryEnabled: true,
        agentMode: null,
      }),
    ).toBe(false);
  });

  it('非记忆工具始终放行', () => {
    expect(
      shouldExposeMcpTool('tavily_search', {
        workspaceMemoryEnabled: false,
        agentMode: 'chat',
      }),
    ).toBe(true);
  });
});

describe('inferMcpCapability：能力推断', () => {
  it('当前一律返回 null（本地 MCP 工具与内置能力不冲突）', () => {
    for (const name of [
      'memory_read',
      'read_agent_skill',
      'list_agent_skill_files',
      'grep_workspace',
      'anything',
    ]) {
      expect(inferMcpCapability(name)).toBeNull();
    }
  });
});

describe('stringifyMcpResult：结果收拢', () => {
  it('null / undefined 收成空串', () => {
    expect(stringifyMcpResult(null)).toBe('');
    expect(stringifyMcpResult(undefined)).toBe('');
  });

  it('字符串原样返回', () => {
    expect(stringifyMcpResult('hello')).toBe('hello');
  });

  it('拼接 text 内容块（对齐 Python 的 stringify_tool_output）', () => {
    expect(
      stringifyMcpResult({
        content: [
          { type: 'text', text: 'line1' },
          { type: 'text', text: 'line2' },
        ],
      }),
    ).toBe('line1\nline2');
  });

  it('过滤空文本部件', () => {
    expect(
      stringifyMcpResult({
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: '' },
        ],
      }),
    ).toBe('a');
  });

  it('无文本部件时退化为结构化 JSON（如图片内容块）', () => {
    const result = stringifyMcpResult({
      content: [{ type: 'image', data: 'xxx', mimeType: 'image/png' }],
    });
    expect(JSON.parse(result)).toMatchObject({ content: [{ type: 'image' }] });
  });

  it('无 content 字段时序列化整个对象', () => {
    expect(stringifyMcpResult({ foo: 'bar' })).toBe('{"foo":"bar"}');
  });
});
