/**
 * Electron 本地 MCP Server
 *
 * 在 Electron 主进程中启动一个基于 HTTP/SSE 的 MCP 服务器，暴露本地能力：
 *   - yolo_detect         本地 YOLO 推理（调用 inferenceProcess）
 *   - write_workspace_file 写工作区文本文件（带目录安全校验）
 *   - list_project_images  枚举项目图片候选
 *
 * 后端 Agent 通过 langchain-mcp-adapters 连接此服务器，动态获取工具 schema。
 * 前端在 app.whenReady() 后调用 startMcpServer()，并将端口通过 IPC 传给 renderer。
 */

import http from 'http';
import net from 'net';
import fs from 'fs-extra';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { runPreAnnotInference } from '../preAnnot/inferenceProcess';
import {
  getActiveMemoryScope,
  listMemoryTopics,
  readMemoryTopic,
  writeMemoryTopic,
} from '../memory/memoryStore';
import {
  readSkillMarkdown,
  scanSkillsCatalog,
} from '../skills/skillScanner';

// ── 全局状态 ────────────────────────────────────────────────────────────────
let mcpServer: McpServer | null = null;
let httpServer: http.Server | null = null;
let listenPort: number | null = null;

// ── 图片后缀集合 ─────────────────────────────────────────────────────────────
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp', '.gif']);

import { isBlockedTextExtension } from '../../shared/workspaceTextExtensions';

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

/** 路径安全校验：确保目标在 rootDir 下，无 .. 穿越；黑名单扩展名禁止写盘。 */
function resolveScoped(
  rootDir: string,
  relativePath: string,
): { absolutePath: string; relativePath: string } | { error: string } {
  const root = path.resolve(rootDir);
  const rel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel.includes('..')) return { error: 'path_traversal_forbidden' };
  const ext = path.extname(rel).toLowerCase();
  if (ext && isBlockedTextExtension(ext)) {
    return { error: `extension_blocked: ${ext}` };
  }
  const absolutePath = path.resolve(root, rel);
  const relToRoot = path.relative(root, absolutePath);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    return { error: 'path_outside_root' };
  }
  return { absolutePath, relativePath: rel };
}

/** 启动 Electron 本地 MCP Server，返回监听地址 */
export async function startMcpServer(): Promise<string> {
  if (httpServer && listenPort) {
    return `http://127.0.0.1:${listenPort}`;
  }

  const port = await getFreePort();

  mcpServer = new McpServer({
    name: 'lr-agent-local',
    version: '1.0.0',
  });

  // ── 工具：YOLO 推理 ───────────────────────────────────────────────────────
  mcpServer.tool(
    'yolo_detect',
    'Run local YOLO object detection on a single image file. Returns detected bounding boxes with class names and confidence scores.',
    {
      image_path: z.string().describe('Absolute path to the image file'),
      model_id: z.string().describe('Pre-trained model ID to use for detection'),
      model_weights_path: z.string().describe('Absolute path to the model weights file'),
      confidence_threshold: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .default(0.25)
        .describe('Confidence threshold (0-1)'),
    },
    async ({ image_path, model_id, model_weights_path, confidence_threshold }) => {
      try {
        const resp = await runPreAnnotInference({
          jobId: `mcp-${Date.now()}`,
          kind: 'detect',
          imagePath: image_path,
          model: {
            id: model_id,
            name: model_id,
            kind: 'detect',
            weightsPath: model_weights_path,
            params: { conf: confidence_threshold ?? 0.25, iou: 0.45 },
          },
        });
        if (!resp.ok) {
          return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: resp.error }) }] };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: true, result: resp.result }),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: msg }) }] };
      }
    },
  );

  // ── 工具：写工作区文件 ─────────────────────────────────────────────────────
  mcpServer.tool(
    'write_workspace_file',
    'Write a UTF-8 text file to a path within the workspace root. Blocked extensions: images, PDF, archives, binaries, etc. Creates parent directories as needed.',
    {
      workspace_root: z.string().describe('Absolute path to the workspace root directory'),
      relative_path: z
        .string()
        .describe('Relative path within workspace (e.g. reports/summary.md)'),
      content: z.string().describe('Full file content to write'),
    },
    async ({ workspace_root, relative_path, content }) => {
      const resolved = resolveScoped(workspace_root, relative_path);
      if ('error' in resolved) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: resolved.error }) }],
        };
      }
      try {
        await fs.ensureDir(path.dirname(resolved.absolutePath));
        await fs.writeFile(resolved.absolutePath, content, 'utf8');
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: true, path: resolved.relativePath }),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: msg }) }] };
      }
    },
  );

  // ── 工具：枚举项目图片 ─────────────────────────────────────────────────────
  mcpServer.tool(
    'list_project_images',
    'List all image files within a project directory (recursive, max 2000 results).',
    {
      project_directory: z
        .string()
        .describe('Absolute path to the annotation project directory'),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .optional()
        .default(500)
        .describe('Maximum number of image paths to return'),
    },
    async ({ project_directory, max_results }) => {
      const limit = max_results ?? 500;
      const results: string[] = [];

      async function walk(dir: string): Promise<void> {
        if (results.length >= limit) return;
        let entries: fs.Dirent[];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (results.length >= limit) break;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(fullPath);
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (IMAGE_EXTS.has(ext)) {
              results.push(fullPath.replace(/\\/g, '/'));
            }
          }
        }
      }

      await walk(project_directory);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              images: results,
              total: results.length,
              limited: results.length >= limit,
            }),
          },
        ],
      };
    },
  );

  // ── 工具：读取记忆 topic 文件 ──────────────────────────────────────────────
  mcpServer.tool(
    'memory_read',
    'Read a saved memory topic file (full content). Memory topic files are listed in the saved-memory index in the system prompt. Pass the topic filename such as "annotation-preferences.md".',
    {
      topic_file: z
        .string()
        .describe('Memory topic filename, e.g. "annotation-preferences.md"'),
    },
    async ({ topic_file }) => {
      try {
        const scopeKey = getActiveMemoryScope();
        const content = await readMemoryTopic(scopeKey, topic_file);
        if (content === null) {
          const topics = await listMemoryTopics(scopeKey);
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  error: 'topic_not_found',
                  available_topics: topics,
                }),
              },
            ],
          };
        }
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify({ ok: true, content }) },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: msg }) }] };
      }
    },
  );

  // ── 工具：读取 Agent Skill 正文 ────────────────────────────────────────────
  mcpServer.tool(
    'read_agent_skill',
    'Read the full SKILL.md content of a user-level agent skill. Skills are listed with name and description in the available-skills block in the system prompt. Use this tool when a user request matches a skill description, then follow the steps in the SKILL.md. Pass the skill name exactly as listed (e.g. "caveman").',
    {
      skill_name: z
        .string()
        .describe('Skill name as listed in the available-skills block, e.g. "caveman"'),
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
            { type: 'text' as const, text: JSON.stringify({ ok: true, content }) },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: msg }) }] };
      }
    },
  );

  // ── 工具：写入记忆 topic 文件（同步更新索引） ──────────────────────────────
  mcpServer.tool(
    'memory_write',
    'Save a memory topic file for future sessions and update the memory index. Use when the user explicitly asks to remember something, or corrects your approach with a lasting preference/constraint. Keep content concise markdown.',
    {
      topic_file: z
        .string()
        .describe('Memory topic filename, e.g. "annotation-preferences.md" (letters/digits/dash/underscore, must end with .md)'),
      content: z.string().describe('Full markdown content of the topic file (overwrites existing)'),
      index_line: z
        .string()
        .describe('One-line index entry describing this topic, e.g. "- [标注偏好](topics/annotation-preferences.md)：用户偏好紧贴目标的小框"'),
    },
    async ({ topic_file, content, index_line }) => {
      try {
        const scopeKey = getActiveMemoryScope();
        await writeMemoryTopic({
          scopeKey,
          topicFile: topic_file,
          content,
          indexLine: index_line,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ ok: true, topic_file, scope: scopeKey }),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: msg }) }] };
      }
    },
  );

  // ── HTTP 服务器：处理 SSE 和 POST 消息 ────────────────────────────────────
  const transports: Map<string, SSEServerTransport> = new Map();

  httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

    if (req.method === 'GET' && url.pathname === '/sse') {
      const transport = new SSEServerTransport('/messages', res);
      transports.set(transport.sessionId, transport);
      res.on('close', () => transports.delete(transport.sessionId));
      await mcpServer!.connect(transport);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId') ?? '';
      const transport = transports.get(sessionId);
      if (!transport) {
        res.writeHead(404);
        res.end('Session not found');
        return;
      }
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', async () => {
        try {
          await transport.handlePostMessage(req, res, JSON.parse(body));
        } catch {
          res.writeHead(400);
          res.end('Bad Request');
        }
      });
      return;
    }

    // Health check
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
  console.log(`[MCP] Local MCP server started at http://127.0.0.1:${port}`);
  return `http://127.0.0.1:${port}`;
}

/** 停止 MCP Server */
export function stopMcpServer(): void {
  if (httpServer) {
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
