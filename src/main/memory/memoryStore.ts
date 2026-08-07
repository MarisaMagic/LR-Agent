/**
 * Auto Memory 存储（对标 Claude Code 的 Auto Memory）。
 *
 * 目录结构（Electron userData 下，机器本地）：
 *   {userData}/agent-memory/
 *   ├── user/MEMORY.md                       # 用户级偏好索引
 *   └── projects/{projectId|workspaceHash}/
 *       ├── MEMORY.md                        # 索引，注入前 200 行 / 25KB
 *       └── topics/*.md                      # 细节文件，按需读取
 *
 * 写 topic 与更新索引两步合一，避免孤儿 topic 文件。
 */

import { app } from 'electron';
import fs from 'fs-extra';
import path from 'path';

/** 索引注入上限：前 200 行 / 25KB */
const INDEX_MAX_LINES = 200;
const INDEX_MAX_BYTES = 25 * 1024;
/** 单个 topic 文件读取上限（约 64KB 字符） */
const TOPIC_MAX_CHARS = 64_000;

const SCOPE_KEY_PATTERN = /^(user|projects\/[A-Za-z0-9][A-Za-z0-9._-]*)$/;
const TOPIC_FILE_PATTERN = /^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5._-]*\.md$/;

/** 当前活动记忆作用域（renderer 发消息时设置，MCP 工具使用） */
let activeScopeKey = 'user';

export function setActiveMemoryScope(scopeKey: string): void {
  if (SCOPE_KEY_PATTERN.test(scopeKey)) {
    activeScopeKey = scopeKey;
  }
}

export function getActiveMemoryScope(): string {
  return activeScopeKey;
}

export function getMemoryRootDir(): string {
  return path.join(app.getPath('userData'), 'agent-memory');
}

function resolveScopeDir(scopeKey: string): string {
  if (!SCOPE_KEY_PATTERN.test(scopeKey)) {
    throw new Error(`invalid_memory_scope: ${scopeKey}`);
  }
  return path.join(getMemoryRootDir(), ...scopeKey.split('/'));
}

function resolveTopicPath(scopeKey: string, topicFile: string): string {
  if (!TOPIC_FILE_PATTERN.test(topicFile)) {
    throw new Error(`invalid_topic_file: ${topicFile}`);
  }
  return path.join(resolveScopeDir(scopeKey), 'topics', topicFile);
}

/** 读取 MEMORY.md 索引，按 200 行 / 25KB 截断；不存在或为空时返回 null */
export async function readMemoryIndex(scopeKey: string): Promise<string | null> {
  const indexPath = path.join(resolveScopeDir(scopeKey), 'MEMORY.md');
  let content: string;
  try {
    content = await fs.readFile(indexPath, 'utf-8');
  } catch {
    return null;
  }
  const trimmed = content.trim();
  if (!trimmed) return null;

  let lines = trimmed.split('\n');
  let truncated = false;
  if (lines.length > INDEX_MAX_LINES) {
    lines = lines.slice(0, INDEX_MAX_LINES);
    truncated = true;
  }
  let result = lines.join('\n');
  while (Buffer.byteLength(result, 'utf-8') > INDEX_MAX_BYTES) {
    lines.pop();
    result = lines.join('\n');
    truncated = true;
  }
  return truncated ? `${result}\n…（索引过长已截断）` : result;
}

/** 读取某 topic 文件全文；不存在时返回 null */
export async function readMemoryTopic(
  scopeKey: string,
  topicFile: string,
): Promise<string | null> {
  const topicPath = resolveTopicPath(scopeKey, topicFile);
  try {
    const content = await fs.readFile(topicPath, 'utf-8');
    return content.length > TOPIC_MAX_CHARS
      ? `${content.slice(0, TOPIC_MAX_CHARS)}\n…（内容过长已截断）`
      : content;
  } catch {
    return null;
  }
}

/** 列出 scope 下的 topic 文件名 */
export async function listMemoryTopics(scopeKey: string): Promise<string[]> {
  const topicsDir = path.join(resolveScopeDir(scopeKey), 'topics');
  try {
    const entries = await fs.readdir(topicsDir);
    return entries.filter((name) => name.endsWith('.md')).sort();
  } catch {
    return [];
  }
}

/**
 * 写 topic 文件并同步更新 MEMORY.md 索引（两步合一，避免孤儿文件）。
 *
 * indexLine：描述该 topic 的一行索引（如 "- [标注偏好](topics/annotation.md)：用户偏好小框"）。
 * 若索引中已有引用同一 topic 文件的行则替换，否则追加。
 */
export async function writeMemoryTopic(options: {
  scopeKey: string;
  topicFile: string;
  content: string;
  indexLine?: string;
}): Promise<{ topicPath: string }> {
  const topicPath = resolveTopicPath(options.scopeKey, options.topicFile);
  await fs.ensureDir(path.dirname(topicPath));
  await fs.writeFile(topicPath, options.content, 'utf-8');

  const indexLine = options.indexLine?.trim();
  if (indexLine) {
    const scopeDir = resolveScopeDir(options.scopeKey);
    const indexPath = path.join(scopeDir, 'MEMORY.md');
    let existing = '';
    try {
      existing = await fs.readFile(indexPath, 'utf-8');
    } catch {
      existing = '# Agent 记忆索引\n';
    }
    const marker = `topics/${options.topicFile}`;
    const lines = existing.split('\n');
    const lineIndex = lines.findIndex((line) => line.includes(marker));
    if (lineIndex >= 0) {
      lines[lineIndex] = indexLine;
    } else {
      if (lines.length && lines[lines.length - 1]!.trim() === '') lines.pop();
      lines.push(indexLine);
    }
    await fs.ensureDir(scopeDir);
    await fs.writeFile(indexPath, `${lines.join('\n')}\n`, 'utf-8');
  }

  return { topicPath };
}

/** 确保 scope 目录存在并返回绝对路径（供 UI 打开目录） */
export async function ensureMemoryDir(scopeKey: string): Promise<string> {
  const dir = resolveScopeDir(scopeKey);
  await fs.ensureDir(path.join(dir, 'topics'));
  return dir;
}
