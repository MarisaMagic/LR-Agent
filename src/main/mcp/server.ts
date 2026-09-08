/**
 * Electron 本地 MCP Server
 *
 * 在 Electron 主进程中启动 Streamable HTTP MCP 服务器（单端点 /mcp），暴露本地能力：
 *   - memory_read / memory_write / memory_create（工作区记忆，需任务开关激活）
 *   - read_agent_skill
 *
 * 后端 Agent 通过 langchain-mcp-adapters（streamable_http）连接此服务器。
 * 前端在 app.whenReady() 后调用 startMcpServer()，并将端口通过 IPC 传给 renderer。
 */

import { randomUUID } from 'crypto';
import http from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import net from 'net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  createMemoryTopic,
  getActiveMemoryScope,
  isWorkspaceMemoryActive,
  listMemoryTopics,
  readMemoryTopic,
  writeMemoryTopic,
} from '../memory/memoryStore';
import { readSkillMarkdown, scanSkillsCatalog } from '../skills/skillScanner';

type McpSession = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

let httpServer: http.Server | null = null;
let listenPort: number | null = null;
const sessions = new Map<string, McpSession>();

/** 获取本机随机空闲端口 */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(addr.port);
      });
    });
    srv.on('error', reject);
  });
}

const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_JSON_BODY_BYTES) {
        req.destroy();
        reject(new Error('payload_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sessionIdFromRequest(req: IncomingMessage): string | undefined {
  const header = req.headers['mcp-session-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (Array.isArray(header) && header[0]?.trim()) return header[0].trim();
  return undefined;
}

function mcpJson(payload: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
  };
}

function requireActiveWorkspaceMemory():
  | { ok: true; scopeKey: string }
  | { ok: false; result: ReturnType<typeof mcpJson> } {
  if (!isWorkspaceMemoryActive()) {
    return {
      ok: false,
      result: mcpJson({
        ok: false,
        error: 'workspace_memory_inactive',
      }),
    };
  }
  return { ok: true, scopeKey: getActiveMemoryScope() };
}

function createMcpServer(): McpServer {
  const mcpServer = new McpServer({
    name: 'lr-agent-local',
    version: '1.0.0',
  });

  mcpServer.tool(
    'memory_read',
    'Read a workspace-memory topic file (full content) for the current annotation task. Topics are listed in the workspace-memory index in the system prompt. Pass the topic filename such as "progress.md" or "annotated-files.md".',
    {
      topic_file: z
        .string()
        .describe('Workspace memory topic filename, e.g. "progress.md"'),
    },
    async ({ topic_file }) => {
      try {
        const active = requireActiveWorkspaceMemory();
        if (!active.ok) return active.result;
        const content = await readMemoryTopic(active.scopeKey, topic_file);
        if (content === null) {
          const topics = await listMemoryTopics(active.scopeKey);
          return mcpJson({
            ok: false,
            error: 'topic_not_found',
            available_topics: topics,
          });
        }
        return mcpJson({ ok: true, content });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpJson({ ok: false, error: msg });
      }
    },
  );

  mcpServer.tool(
    'read_agent_skill',
    'Read the full SKILL.md content of a user-level agent skill. Skills are listed with name and description in the available-skills block in the system prompt. Use this tool when a user request matches a skill description, then follow the steps in the SKILL.md. Pass the skill name exactly as listed (e.g. "caveman").',
    {
      skill_name: z
        .string()
        .describe(
          'Skill name as listed in the available-skills block, e.g. "caveman"',
        ),
    },
    async ({ skill_name }) => {
      try {
        const content = await readSkillMarkdown(skill_name);
        if (content === null) {
          const catalog = await scanSkillsCatalog();
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  error: 'skill_not_found',
                  available_skills: catalog.map((s) => s.name),
                }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: true, content }),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: false, error: msg }),
            },
          ],
        };
      }
    },
  );

  mcpServer.tool(
    'memory_write',
    'Overwrite an existing workspace-memory topic for the current annotation task and update the memory index. Use after finishing annotation work this turn to update progress and annotated/skipped files. File must already exist; use memory_create for a new topic. Keep content concise markdown.',
    {
      topic_file: z
        .string()
        .describe(
          'Existing topic filename, e.g. "progress.md" (letters/digits/dash/underscore, must end with .md)',
        ),
      content: z
        .string()
        .describe(
          'Full markdown content of the topic file (overwrites existing)',
        ),
      index_line: z
        .string()
        .describe(
          'One-line index entry describing this topic, e.g. "- [进度](topics/progress.md)：已标 12/40"',
        ),
    },
    async ({ topic_file, content, index_line }) => {
      try {
        const active = requireActiveWorkspaceMemory();
        if (!active.ok) return active.result;
        await writeMemoryTopic({
          scopeKey: active.scopeKey,
          topicFile: topic_file,
          content,
          indexLine: index_line,
        });
        return mcpJson({
          ok: true,
          topic_file,
          scope: active.scopeKey,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpJson({ ok: false, error: msg });
      }
    },
  );

  mcpServer.tool(
    'memory_create',
    'Create a new workspace-memory topic markdown file for the current annotation task and append an index line. Fails if the file already exists (use memory_write to update). Suggested names: progress.md, annotated-files.md.',
    {
      topic_file: z
        .string()
        .describe(
          'New topic filename, e.g. "progress.md" (letters/digits/dash/underscore, must end with .md)',
        ),
      content: z.string().describe('Full markdown content of the new topic file'),
      index_line: z
        .string()
        .describe(
          'One-line index entry describing this topic, e.g. "- [已标文件](topics/annotated-files.md)：列出已标与跳过文件"',
        ),
    },
    async ({ topic_file, content, index_line }) => {
      try {
        const active = requireActiveWorkspaceMemory();
        if (!active.ok) return active.result;
        await createMemoryTopic({
          scopeKey: active.scopeKey,
          topicFile: topic_file,
          content,
          indexLine: index_line,
        });
        return mcpJson({
          ok: true,
          created: true,
          topic_file,
          scope: active.scopeKey,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return mcpJson({ ok: false, error: msg });
      }
    },
  );

  return mcpServer;
}

async function createSession(): Promise<McpSession> {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, { transport, server });
    },
    onsessionclosed: (sessionId) => {
      sessions.delete(sessionId);
    },
  });
  // 只清 map。不要在这里 server.close()：Protocol.close() 会再调 transport.close()，形成同步死递归。
  transport.onclose = () => {
    const { sessionId } = transport;
    if (sessionId) {
      sessions.delete(sessionId);
    }
  };
  await server.connect(transport);
  return { transport, server };
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sessionId = sessionIdFromRequest(req);
  const existing = sessionId ? sessions.get(sessionId) : undefined;

  if (existing) {
    await existing.transport.handleRequest(req, res);
    return;
  }

  if (req.method === 'POST') {
    let parsedBody: unknown;
    try {
      parsedBody = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'invalid_json' });
      return;
    }
    if (parsedBody !== undefined && isInitializeRequest(parsedBody)) {
      const session = await createSession();
      try {
        await session.transport.handleRequest(req, res, parsedBody);
      } finally {
        if (!session.transport.sessionId) {
          void session.server.close();
        }
      }
      return;
    }
    sendJson(res, sessionId ? 404 : 400, {
      error: sessionId ? 'session_not_found' : 'missing_or_invalid_session',
    });
    return;
  }

  sendJson(res, sessionId ? 404 : 400, {
    error: sessionId ? 'session_not_found' : 'missing_session',
  });
}

/** 启动 Electron 本地 MCP Server，返回监听地址（不含 path） */
export async function startMcpServer(): Promise<string> {
  if (httpServer && listenPort) {
    return `http://127.0.0.1:${listenPort}`;
  }

  const port = await getFreePort();

  httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (url.pathname === '/mcp') {
      try {
        await handleMcpRequest(req, res);
      } catch (err) {
        console.error('[MCP] Failed to handle /mcp request:', err);
        sendJson(res, 500, { error: 'internal_error' });
      }
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server: 'lr-agent-local-mcp' }));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  await new Promise<void>((resolve, reject) => {
    httpServer!.listen(port, '127.0.0.1', () => resolve());
    httpServer!.on('error', reject);
  });

  listenPort = port;
  console.log(`[MCP] Local MCP server started at http://127.0.0.1:${port}/mcp`);
  return `http://127.0.0.1:${port}`;
}

/** 停止 MCP Server */
export function stopMcpServer(): void {
  const active = [...sessions.values()];
  sessions.clear();
  for (const { server } of active) {
    void server.close();
  }
  if (httpServer) {
    httpServer.closeAllConnections?.();
    httpServer.close();
    httpServer = null;
    listenPort = null;
  }
}

/** 获取当前 MCP Server URL（未启动时返回 null） */
export function getMcpServerUrl(): string | null {
  if (listenPort) return `http://127.0.0.1:${listenPort}`;
  return null;
}
