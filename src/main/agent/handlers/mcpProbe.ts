/**
 * `POST /api/v1/agent/mcp/probe`：测试连接单个 MCP Server 并列出工具名。
 *
 * 移植自 `vendor/local-agent/app/api/v1/agent.py` 的 `probe_mcp_server`。
 *
 * 与 Python 一致的降级语义：异常**不外抛**，转成 `{ok:false, error}`——
 * 配置页需要把失败原因展示给用户，而不是让请求 500。
 */

import { AGENT_ROUTE_PATHS } from '../routes';
import type { RouteHandler } from '../server';
import { probeMcpTools } from '../mcp/client';

interface ProbeBody {
  url?: unknown;
  transport?: unknown;
  headers?: unknown;
}

export const mcpProbeHandler: RouteHandler = async (req) => {
  let body: ProbeBody = {};
  try {
    body = req.rawBody ? (JSON.parse(req.rawBody) as ProbeBody) : {};
  } catch {
    return { kind: 'json', body: { ok: false, error: '请求体不是合法 JSON' } };
  }

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  // 与 Python 一致：仅接受 http(s)
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { kind: 'json', body: { ok: false, error: '仅支持 http(s) MCP 端点' } };
  }

  const transport =
    body.transport === 'sse' ? ('sse' as const) : ('streamable_http' as const);

  const headers: Record<string, string> = {};
  if (body.headers && typeof body.headers === 'object' && !Array.isArray(body.headers)) {
    for (const [key, value] of Object.entries(body.headers as Record<string, unknown>)) {
      if (typeof value === 'string') headers[key] = value;
    }
  }

  try {
    const tools = await probeMcpTools({ url, transport, headers });
    return { kind: 'json', body: { ok: true, tools: tools.map((t) => t.name) } };
  } catch (err) {
    return {
      kind: 'json',
      body: { ok: false, error: err instanceof Error ? err.message : String(err) },
    };
  }
};

/** 供路由表装配使用。 */
export const MCP_PROBE_KEY = `POST ${AGENT_ROUTE_PATHS.mcpProbe}`;
