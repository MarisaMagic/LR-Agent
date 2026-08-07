/**
 * 全局 Agent Skills 只读扫描（对标 Cursor / Claude Code 的 skills）。
 *
 * 约定位置（用户级）：{home}/.agents/skills/<skill-name>/SKILL.md
 *   - frontmatter 提供 name / description / disable-model-invocation
 *   - catalog（name + description）注入 system prompt
 *   - 正文 SKILL.md 由模型按需经 MCP 工具 read_agent_skill 读取
 *
 * 安全模型：skillName 必须匹配安全命名（防路径穿越），resolve 后校验仍在根目录内。
 */

import { app } from 'electron';
import fs from 'fs-extra';
import path from 'path';

/** catalog 注入条目数上限 */
export const MAX_CATALOG_ENTRIES = 30;
/** 单条 description 注入长度上限 */
export const MAX_DESCRIPTION_CHARS = 300;
/** 单个 SKILL.md 正文读取上限 */
export const MAX_SKILL_CHARS = 32_000;
/** 扫描结果 TTL 缓存 */
const CACHE_TTL_MS = 30_000;

/** skill 目录名 / 读取参数白名单（防路径穿越，同 memory 的 topic 命名） */
const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface AgentSkillEntry {
  name: string;
  description: string;
  /** 预留 scope 字段：未来支持项目级 .lragent/skills/ 时区分来源 */
  scope: 'user';
}

export interface ParsedSkillFrontmatter {
  name?: string;
  description?: string;
  disableModelInvocation?: boolean;
}

/** 用户级 skills 根目录（~/.agents/skills） */
export function getUserSkillsRoot(): string {
  return path.join(app.getPath('home'), '.agents', 'skills');
}

/**
 * 轻量解析 SKILL.md 的 YAML frontmatter，不引入 js-yaml。
 * 仅提取 name（单行标量）、description（单行 / `>` 折叠 / `|` 字面量）、
 * disable-model-invocation（布尔）。frontmatter 缺失或结构非法时返回 null。
 */
export function parseSkillFrontmatter(content: string): ParsedSkillFrontmatter | null {
  const trimmed = content.replace(/^\uFEFF/, '');
  if (!trimmed.startsWith('---')) return null;
  const endMarker = trimmed.indexOf('\n---', 3);
  if (endMarker < 0) return null;

  const body = trimmed.slice(3, endMarker);
  const result: ParsedSkillFrontmatter = {};
  let currentKey: string | null = null;
  let currentBlock: string[] | null = null;
  let blockStyle: 'folded' | 'literal' | null = null;

  const lines = body.split('\n');
  for (const line of lines) {
    // 缩进行：块标量（`>` / `|`）的续行
    if (currentKey && currentBlock && /^\s+\S/.test(line)) {
      const indent = line.match(/^\s*/)![0];
      const raw = line.slice(indent.length);
      if (blockStyle === 'literal') {
        currentBlock.push(raw);
      } else {
        currentBlock.push(raw.trim());
      }
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    const flush = () => {
      if (currentKey === 'description' && currentBlock) {
        result.description =
          blockStyle === 'literal'
            ? currentBlock.join('\n')
            : currentBlock.join(' ');
      }
      currentKey = null;
      currentBlock = null;
      blockStyle = null;
    };
    if (!match) {
      flush();
      continue;
    }

    const key = match[1];
    const value = match[2].trim();
    if (key === 'name') {
      flush();
      result.name = value;
    } else if (key === 'description') {
      flush();
      if (value.startsWith('>')) {
        currentKey = key;
        currentBlock = [];
        blockStyle = 'folded';
      } else if (value.startsWith('|')) {
        currentKey = key;
        currentBlock = [];
        blockStyle = 'literal';
      } else {
        result.description = value;
      }
    } else if (key === 'disable-model-invocation') {
      flush();
      result.disableModelInvocation = value === 'true';
    } else {
      flush();
    }
  }
  // 收尾未闭合的 description 块
  if (currentKey === 'description' && currentBlock) {
    result.description =
      blockStyle === 'literal'
        ? currentBlock.join('\n')
        : currentBlock.join(' ');
  }
  return result;
}

function isPathWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// ── TTL 缓存 ────────────────────────────────────────────────────────────────
interface TimedEntry<T> {
  value: T;
  loadedAt: number;
}

const catalogCache = new Map<string, TimedEntry<AgentSkillEntry[]>>();
const skillContentCache = new Map<string, TimedEntry<string | null>>();

function readCache<T>(cache: Map<string, TimedEntry<T>>, key: string): T | undefined {
  const entry = cache.get(key);
  if (entry && Date.now() - entry.loadedAt < CACHE_TTL_MS) {
    return entry.value;
  }
  return undefined;
}

function writeCache<T>(cache: Map<string, TimedEntry<T>>, key: string, value: T): void {
  cache.set(key, { value, loadedAt: Date.now() });
}

/** 清空缓存（测试或用户编辑 skill 目录后调用） */
export function clearSkillsCache(): void {
  catalogCache.clear();
  skillContentCache.clear();
}

/**
 * 扫描 skills 根目录下的全部 skill 目录，返回 catalog。
 * 仅收集含 SKILL.md、frontmatter 有效、未禁用模型调用且带 description 的目录。
 */
export async function scanSkillsCatalog(
  rootDir: string = getUserSkillsRoot(),
): Promise<AgentSkillEntry[]> {
  const cached = readCache(catalogCache, rootDir);
  if (cached) return cached;

  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: AgentSkillEntry[] = [];
  for (const entry of entries) {
    if (skills.length >= MAX_CATALOG_ENTRIES) break;
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    const skillPath = path.join(rootDir, entry.name, 'SKILL.md');
    let content: string;
    try {
      const stat = await fs.stat(skillPath);
      if (!stat.isFile()) continue;
      content = await fs.readFile(skillPath, 'utf-8');
    } catch {
      continue;
    }

    const parsed = parseSkillFrontmatter(content);
    if (!parsed || parsed.disableModelInvocation) continue;

    const name = parsed.name?.trim() || entry.name;
    const description = (parsed.description ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_DESCRIPTION_CHARS);
    if (!description) continue;

    skills.push({ name, description, scope: 'user' });
  }

  writeCache(catalogCache, rootDir, skills);
  return skills;
}

/**
 * 读取指定 skill 的 SKILL.md 正文。
 * skillName 必须是安全命名（防止路径穿越），且 resolve 后位于 skills 根目录内。
 * 内容超限截断；不存在或读取失败返回 null。
 */
export async function readSkillMarkdown(
  skillName: string,
  rootDir: string = getUserSkillsRoot(),
): Promise<string | null> {
  const name = skillName.trim();
  if (!SKILL_NAME_PATTERN.test(name)) return null;

  const cacheKey = `${rootDir}\u0000${name}`;
  const cached = readCache(skillContentCache, cacheKey);
  if (cached !== undefined) return cached;

  const root = path.resolve(rootDir);
  const skillDir = path.resolve(root, name);
  if (!isPathWithin(skillDir, root)) {
    writeCache(skillContentCache, cacheKey, null);
    return null;
  }

  const skillPath = path.join(skillDir, 'SKILL.md');
  let result: string | null;
  try {
    const stat = await fs.stat(skillPath);
    if (!stat.isFile()) return null;
    const content = await fs.readFile(skillPath, 'utf-8');
    result =
      content.length > MAX_SKILL_CHARS
        ? `${content.slice(0, MAX_SKILL_CHARS)}\n…（内容过长已截断）`
        : content;
  } catch {
    result = null;
  }
  writeCache(skillContentCache, cacheKey, result);
  return result;
}
