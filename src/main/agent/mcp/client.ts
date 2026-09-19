/**
 * MCP 客户端：连接本机 Electron MCP Server 与用户配置的远程 MCP，动态发现工具。
 *
 * 移植自 `vendor/local-agent/app/agent/tools/mcp_client.py`。
 *
 * 用**仓库已依赖**的 `@modelcontextprotocol/sdk`（`src/main/mcp/server.ts` 用的是它的
 * 服务端部分）替换 Python 的 `langchain-mcp-adapters`——两者底层同源，因此是净收益。
 *
 * 三条必须保真的行为：
 *
 *   1. **TTL 缓存 + stale-while-revalidate**。缓存键为 `(url, transport, 排序后 headers)`。
 *      命中但已过期时，本轮**先用旧列表**、后台重建连，下一轮才生效——避免让首 token
 *      等在重建连上。只有应用启动后的首轮（无缓存）才同步等待发现。
 *   2. **单台失败隔离**。并行建连，任一台失败只跳过该台，不影响其它 server 与主流程。
 *   3. **名字去重**。`_infer_mcp_capability` 当前对全部本地 MCP 工具返回 null，
 *      因此实际去重靠「名字已在前面 server 出现过则跳过」。
 *
 * 与 Python 的一处实现差异：工具调用的连接策略按传输区分——
 *   - `streamable_http` 无状态，**按需建连**（每次 `callTool` 独立握手），
 *     发现连接用完即关，换来无状态、无泄漏；
 *   - `sse` 是有状态长连接，**复用发现时建立的连接**做后续 `callTool`，
 *     避免每次调用重新 `initialize` 握手（按会话绑定的服务端，如 ModelScope
 *     托管 MCP，会「列出工具成功、调用却失败」）。SSE 连接在刷新/清空缓存时关闭。
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { z } from 'zod';
import type { ToolDefinition } from '../tools/registry';

/** 连接参数。 */
export interface McpConnection {
  url: string;
  transport: 'streamable_http' | 'sse';
  headers?: Record<string, string>;
  /** 连接超时（毫秒）；发现用 60_000，probe 用 30_000。 */
  timeoutMs?: number;
  /** SSE 读取超时（毫秒）；发现用 300_000，probe 用 60_000。 */
  sseReadTimeoutMs?: number;
}

/** 远程 server 的输入形态（来自 client_context.mcp_servers）。 */
export interface McpServerInput {
  id: string;
  url: string;
  transport: 'streamable_http' | 'sse';
  headers: Record<string, string>;
  disabledTools: string[];
}

/** 发现阶段的超时配置（对齐 Python 的 timeout / sse_read_timeout）。 */
const DISCOVER_TIMEOUT_MS = 60_000;
const DISCOVER_SSE_READ_TIMEOUT_MS = 300_000;
const PROBE_TIMEOUT_MS = 30_000;
const PROBE_SSE_READ_TIMEOUT_MS = 60_000;

/** 默认 TTL（秒）；<=0 关闭缓存。 */
export const DEFAULT_MCP_TTL_SECONDS = 1800;

// ── 缓存 ────────────────────────────────────────────────────────────

interface CacheEntry {
  tools: DiscoveredTool[];
  /** 单调递增的过期时间（毫秒）。 */
  expiresAt: number;
}

/** 已发现的工具（含按需建连的调用器）。 */
export interface DiscoveredTool {
  name: string;
  description: string;
  /** MCP 原生 JSON Schema，直接透传。 */
  parameters: Record<string, unknown>;
  invoke: (args: Record<string, unknown>) => Promise<string>;
}

const toolsCache = new Map<string, CacheEntry>();
/** 正在后台刷新的连接指纹，避免同一 server 并发重复刷新。 */
const refreshing = new Set<string>();
/** 后台刷新任务，持有强引用避免被回收。 */
const refreshTasks = new Set<Promise<void>>();
/**
 * 复用的 SSE 长连接（key → Client）。
 *
 * SSE 是有状态长连接：发现工具时建立的连接要保留给后续 `tools/call` 复用，
 * 否则每次调用都重新 `initialize` 握手，遇到「按会话绑定」的服务端
 * （如 ModelScope 托管 MCP）会列出工具成功、调用却失败。streamable_http 无状态，
 * 仍走按需建连，不在此登记。刷新/清空缓存时统一关闭，避免泄漏。
 */
const openClients = new Map<string, Client>();

/** 缓存键：url + transport + 排序后的 headers。 */
export function cacheKey(conn: McpConnection): string {
  const headers = Object.entries(conn.headers ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}:${v}`)
    .join('|');
  return `${conn.url}\u0000${conn.transport}\u0000${headers}`;
}

/** 清空缓存与在途刷新（测试或强制刷新用）。 */
export function clearMcpToolsCache(): void {
  toolsCache.clear();
  refreshing.clear();
  refreshTasks.clear();
  for (const client of openClients.values()) {
    void client.close().catch(() => {
      /* 关闭失败不阻断 */
    });
  }
  openClients.clear();
}

// ── 连接与调用 ──────────────────────────────────────────────────────

/** 给一个 Promise 加整体超时；超时后拒绝并清理定时器。 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 建立客户端并初始化。 */
async function connect(conn: McpConnection): Promise<Client> {
  const client = new Client(
    { name: 'lr-agent-local', version: '1.0.0' },
    { capabilities: {} },
  );

  const transport =
    conn.transport === 'sse'
      ? new SSEClientTransport(new URL(conn.url), {
          requestInit:
            conn.headers && Object.keys(conn.headers).length > 0
              ? { headers: conn.headers }
              : undefined,
        })
      : new StreamableHTTPClientTransport(new URL(conn.url), {
          requestInit:
            conn.headers && Object.keys(conn.headers).length > 0
              ? { headers: conn.headers }
              : undefined,
        });

  // SSE 的 start() 会等待服务端 `endpoint` 事件，若服务端不发则无限挂起；
  // 用 conn.timeoutMs 兜底（默认 DISCOVER_TIMEOUT_MS，probe 用更短的 PROBE_TIMEOUT_MS）。
  const timeoutMs = conn.timeoutMs ?? DISCOVER_TIMEOUT_MS;
  try {
    await withTimeout(
      client.connect(transport),
      timeoutMs,
      `连接 MCP server 超时（${timeoutMs}ms）：${conn.url}`,
    );
  } catch (err) {
    await client.close().catch(() => {
      /* 关闭失败不阻断 */
    });
    throw err;
  }
  return client;
}

/**
 * 发现单个 server 的工具。
 *
 * 失败时抛异常，由调用方决定跳过（单台失败隔离）。
 */
async function discoverTools(conn: McpConnection): Promise<DiscoveredTool[]> {
  const client = await connect(conn);
  // SSE 是有状态长连接：发现时建立的连接保留给 invoke 复用；
  // streamable_http 无状态，发现连接用完即关，invoke 按需建连。
  const reuseConnection = conn.transport === 'sse';
  const key = cacheKey(conn);
  try {
    const listed = await client.listTools();

    if (reuseConnection) {
      // 登记新连接前关闭上一次的同源连接（刷新场景），避免泄漏
      const previous = openClients.get(key);
      if (previous && previous !== client) {
        await previous.close().catch(() => {
          /* 关闭失败不阻断 */
        });
      }
      openClients.set(key, client);
    }

    const tools = (listed.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      // MCP 的 inputSchema 就是 JSON Schema，直接透传
      parameters: (tool.inputSchema as Record<string, unknown>) ?? {
        type: 'object',
        properties: {},
      },
      invoke: async (args: Record<string, unknown>): Promise<string> => {
        const callClient = reuseConnection ? client : await connect(conn);
        try {
          const result = await callClient.callTool({
            name: tool.name,
            arguments: args,
          });
          return stringifyMcpResult(result);
        } finally {
          if (!reuseConnection) {
            await callClient.close().catch(() => {
              /* 关闭失败不阻断 */
            });
          }
        }
      },
    }));

    if (!reuseConnection) {
      await client.close().catch(() => {
        /* 关闭失败不阻断 */
      });
    }
    return tools;
  } catch (err) {
    openClients.delete(key);
    await client.close().catch(() => {
      /* 关闭失败不阻断 */
    });
    throw err;
  }
}

/**
 * 把 MCP 工具调用结果收成字符串。
 *
 * 对齐 Python `stringify_tool_output` 对内容块数组的处理：拼接 text 部件。
 */
export function stringifyMcpResult(result: unknown): string {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;

  if (typeof result === 'object') {
    const { content } = result as { content?: unknown };
    if (Array.isArray(content)) {
      const parts: string[] = [];
      for (const item of content) {
        if (typeof item === 'string') {
          parts.push(item);
        } else if (item && typeof item === 'object') {
          const record = item as Record<string, unknown>;
          if (record.type === 'text') parts.push(String(record.text ?? ''));
          else if (typeof record.text === 'string') parts.push(record.text);
        }
      }
      const joined = parts.filter((p) => p.length > 0).join('\n');
      if (joined) return joined;
      // 无文本部件时退化为结构化 JSON（例如 image/audio 内容块）
      return JSON.stringify(result);
    }
    return JSON.stringify(result);
  }

  return String(result);
}

// ── 连接参数构造 ────────────────────────────────────────────────────

/**
 * 本机 Electron MCP Server 连接参数。
 *
 * 端点固定拼 `/mcp`（见 `src/main/mcp/server.ts`）；token 作为 Bearer 头注入。
 */
export function localConnection(
  mcpServerUrl: string,
  token?: string | null,
): McpConnection {
  const conn: McpConnection = {
    url: `${mcpServerUrl.replace(/\/+$/, '')}/mcp`,
    transport: 'streamable_http',
    timeoutMs: DISCOVER_TIMEOUT_MS,
    sseReadTimeoutMs: DISCOVER_SSE_READ_TIMEOUT_MS,
  };
  const trimmed = (token ?? '').trim();
  if (trimmed) conn.headers = { Authorization: `Bearer ${trimmed}` };
  return conn;
}

/** 远程 MCP Server 连接参数：URL **原样使用**（不拼 /mcp），协议按配置。 */
export function remoteConnection(server: McpServerInput): McpConnection {
  const transport =
    server.transport === 'sse'
      ? ('sse' as const)
      : ('streamable_http' as const);
  const conn: McpConnection = {
    url: (server.url ?? '').trim(),
    transport,
    timeoutMs: DISCOVER_TIMEOUT_MS,
    sseReadTimeoutMs: DISCOVER_SSE_READ_TIMEOUT_MS,
  };
  const headers = server.headers ?? {};
  if (Object.keys(headers).length > 0) conn.headers = { ...headers };
  return conn;
}

// ── 工具暴露策略 ────────────────────────────────────────────────────

/**
 * 是否把某个 MCP 工具暴露给 Agent。
 *
 * - 工作区记忆关闭时不暴露 `memory_*`（`read_agent_skill` 不受影响）
 * - Ask 模式（`agent_mode !== "annotation"`）只暴露 `memory_read`，
 *   禁止 `memory_write` / `memory_create`
 */
export function shouldExposeMcpTool(
  toolName: string,
  options: { workspaceMemoryEnabled: boolean; agentMode?: string | null },
): boolean {
  if (toolName.startsWith('memory_')) {
    if (!options.workspaceMemoryEnabled) return false;
    if (options.agentMode !== 'annotation') return toolName === 'memory_read';
    return true;
  }
  return true;
}

/**
 * 从 MCP 工具名推断能力类型。
 *
 * 当前本地 MCP 工具（`memory_*` / `read_agent_skill` / `list_agent_skill_files`）
 * 与内置能力不冲突，一律返回 null；将来若暴露与 canonical 重叠的名字，
 * 在此登记以免双轨注入。
 */
export function inferMcpCapability(_toolName: string): string | null {
  return null;
}

// ── 主流程 ──────────────────────────────────────────────────────────

export interface LoadMcpToolsParams {
  localServerUrl?: string | null;
  localServerToken?: string | null;
  remoteServers?: McpServerInput[];
  /** 已存在的能力集合（保留参数，当前去重实际按名字）。 */
  existingCapabilities?: ReadonlySet<string>;
  ttlSeconds?: number;
  onLog?: (level: 'info' | 'warn', message: string) => void;
}

/**
 * 连接本机 + 远程 MCP Server，动态发现并按名字去重后返回工具定义。
 *
 * 返回的 `ToolDefinition` 可直接并入工具集（`rawParameters` 携带 MCP 原生 schema）。
 */
export async function loadMcpToolsFromServers(
  params: LoadMcpToolsParams,
): Promise<ToolDefinition[]> {
  const ttlSeconds = params.ttlSeconds ?? DEFAULT_MCP_TTL_SECONDS;
  const log = params.onLog ?? (() => {});

  const connections = new Map<string, McpConnection>();
  const disabledByConn = new Map<string, Set<string>>();

  const localUrl = (params.localServerUrl ?? '').trim();
  if (localUrl) {
    connections.set(
      'lr-agent-local',
      localConnection(localUrl, params.localServerToken),
    );
  }

  const remotes = params.remoteServers ?? [];
  remotes.forEach((server, index) => {
    const conn = remoteConnection(server);
    if (!conn.url) return;
    const name = `mcp-remote-${server.id || index}`;
    connections.set(name, conn);
    const disabled = new Set(
      (server.disabledTools ?? []).filter(
        (n) => typeof n === 'string' && n.trim().length > 0,
      ),
    );
    disabledByConn.set(name, disabled);
  });

  if (connections.size === 0) return [];

  const now = Date.now();
  const rawByConn = new Map<string, DiscoveredTool[]>();
  const pending = new Map<string, McpConnection>();

  for (const [name, conn] of connections) {
    const key = cacheKey(conn);
    const cached = ttlSeconds > 0 ? toolsCache.get(key) : undefined;
    if (!cached) {
      pending.set(name, conn);
      continue;
    }
    rawByConn.set(name, cached.tools);
    if (cached.expiresAt <= now) {
      // 过期但可用：先用旧列表，后台刷新下一轮生效
      scheduleRefresh(name, conn, ttlSeconds, log);
    }
  }

  if (pending.size > 0) {
    const entries = [...pending.entries()];
    const results = await Promise.allSettled(
      entries.map(([, conn]) => discoverTools(conn)),
    );
    entries.forEach(([name, conn], index) => {
      const result = results[index];
      if (result.status === 'rejected') {
        log(
          'warn',
          `MCP: 连接 ${name} (${conn.url}) 失败，跳过该 server：${String(result.reason)}`,
        );
        return;
      }
      rawByConn.set(name, result.value);
      if (ttlSeconds > 0) {
        toolsCache.set(cacheKey(conn), {
          tools: result.value,
          expiresAt: Date.now() + ttlSeconds * 1000,
        });
      }
    });
  }

  // 顺序遍历（保持与 Python 一致的 server 顺序），按名字去重
  const seenNames = new Set<string>();
  const out: ToolDefinition[] = [];

  for (const name of connections.keys()) {
    let tools = rawByConn.get(name);
    if (!tools) continue;

    const disabled = disabledByConn.get(name);
    if (disabled && disabled.size > 0) {
      tools = tools.filter((tool) => !disabled.has(tool.name));
    }

    for (const tool of tools) {
      const capability = inferMcpCapability(tool.name);
      if (capability !== null && params.existingCapabilities?.has(capability)) {
        continue;
      }
      if (seenNames.has(tool.name)) continue;
      seenNames.add(tool.name);

      out.push({
        name: tool.name,
        description: tool.description,
        kind: 'sync',
        // MCP 不做 zod 校验（schema 已是权威），用宽松透传
        argsSchema: z.record(z.string(), z.unknown()),
        rawParameters: tool.parameters,
        execute: (args) => tool.invoke(args),
      });
    }
  }

  return out;
}

/** 后台重新发现（不阻塞本轮请求）；失败沿用旧条目。 */
function scheduleRefresh(
  name: string,
  conn: McpConnection,
  ttlSeconds: number,
  log: (level: 'info' | 'warn', message: string) => void,
): void {
  const key = cacheKey(conn);
  if (refreshing.has(key)) return;
  refreshing.add(key);

  const task = (async () => {
    try {
      const tools = await discoverTools(conn);
      if (ttlSeconds > 0) {
        toolsCache.set(key, {
          tools,
          expiresAt: Date.now() + ttlSeconds * 1000,
        });
      }
      log('info', `MCP: 后台刷新 ${name} 完成，${tools.length} 个工具`);
    } catch (err) {
      log(
        'warn',
        `MCP: 后台刷新 ${name} (${conn.url}) 失败，沿用旧工具列表：${String(err)}`,
      );
    } finally {
      refreshing.delete(key);
    }
  })();

  refreshTasks.add(task);
  void task.finally(() => refreshTasks.delete(task));
}

/**
 * 连接单个 MCP Server 并列出工具名（配置页「测试连接」用）。
 *
 * 失败时抛异常，由调用方转为错误响应。
 */
export async function probeMcpTools(params: {
  url: string;
  transport: 'streamable_http' | 'sse';
  headers?: Record<string, string>;
}): Promise<{ name: string; description: string }[]> {
  const conn: McpConnection = {
    url: params.url.trim(),
    transport: params.transport === 'sse' ? 'sse' : 'streamable_http',
    timeoutMs: PROBE_TIMEOUT_MS,
    sseReadTimeoutMs: PROBE_SSE_READ_TIMEOUT_MS,
  };
  const headers = params.headers ?? {};
  if (Object.keys(headers).length > 0) conn.headers = { ...headers };

  const tools = await discoverTools(conn);
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
  }));
}
