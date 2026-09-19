/**
 * 工作区代码 / 文本搜索与目录列表。
 *
 * 移植自 `vendor/local-agent/app/agent/tools/workspace_search.py`。
 *
 * **两个必须保真的点**：
 *
 *   1. **遍历顺序**。Python 用显式栈做 DFS（`stack.pop()` 取末尾），每个目录内按
 *      名称升序处理：先收集本层文件，再把子目录压栈。因是 LIFO，子目录按**逆序**
 *      被展开。顺序直接影响 grep 结果排列，进而影响 golden 基线。
 *
 *   2. **必须用异步 I/O**。这里是唯一会递归遍历整个工作区的工具；若用
 *      `readFileSync` / `readdirSync`，会阻塞运行时事件循环，连 keep-alive 的
 *      LLM 请求都会收到 ECONNRESET（Electron 官方 issue #43186）。
 *
 * 另注意 `fnmatch` 的平台差异：Python 的 `fnmatch.fnmatch` 会经 `os.path.normcase`，
 * 在 Windows 上把两侧都转小写并统一分隔符，因此**匹配是大小写不敏感的**。
 */

import fs from 'fs-extra';
import path from 'path';
import {
  allowedRoots,
  normalizeRelativePath,
  relativePathFromRoots,
  resolveWorkspaceDirectory,
  resolveWorkspaceFile,
  type ClientContextLike,
} from './workspacePath';
import { isBlockedTextSuffixExt } from './fileReader';

/** 显式跳过目录名单。注意 `.github` / `.cursor` 等点目录仍参与搜索。 */
export const SKIP_DIR_NAMES = new Set([
  '.git',
  '.lr-agent',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  'dist',
  'build',
]);

/**
 * Python `os.path.normcase` 等价：Windows 上转小写并把 `/` 换成 `\`；
 * 其它平台原样返回。
 */
function normCase(value: string): string {
  if (process.platform !== 'win32') return value;
  return value.toLowerCase().replace(/\//g, '\\');
}

/**
 * Python `fnmatch.translate` 的等价实现（3.10 语义：`*` 匹配任意字符含分隔符）。
 *
 * 支持 `*`、`?`、`[seq]`、`[!seq]`；其余字符按字面处理，未闭合的 `[` 视为字面。
 */
function fnmatchTranslate(pattern: string): RegExp {
  let result = '';
  let i = 0;
  const n = pattern.length;

  while (i < n) {
    const c = pattern[i];
    i += 1;
    if (c === '*') {
      result += '.*';
    } else if (c === '?') {
      result += '.';
    } else if (c === '[') {
      let j = i;
      if (j < n && (pattern[j] === '!' || pattern[j] === '^')) j += 1;
      if (j < n && pattern[j] === ']') j += 1;
      while (j < n && pattern[j] !== ']') j += 1;
      if (j >= n) {
        result += '\\[';
      } else {
        let stuff = pattern.slice(i, j).replace(/\\/g, '\\\\');
        i = j + 1;
        if (stuff.startsWith('!')) stuff = `^${stuff.slice(1)}`;
        else if (stuff.startsWith('^')) stuff = `\\${stuff}`;
        result += `[${stuff}]`;
      }
    } else {
      result += c.replace(/[.^$+{}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^(?:${result})$`, 's');
}

const fnmatchCache = new Map<string, RegExp>();

/** 等价于 Python `fnmatch.fnmatch`（含平台 normcase）。 */
export function fnmatch(name: string, pattern: string): boolean {
  const key = `${normCase(pattern)}`;
  let regex = fnmatchCache.get(key);
  if (!regex) {
    regex = fnmatchTranslate(normCase(pattern));
    fnmatchCache.set(key, regex);
  }
  return regex.test(normCase(name));
}

/** 文件搜索时的 glob 匹配（按 basename）。 */
function matchesGlob(name: string, globPattern: string): boolean {
  const pattern = (globPattern ?? '*').trim();
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) return fnmatch(name, pattern);
  return fnmatch(name, pattern) || fnmatch(name, `*${pattern}`);
}

/** glob_workspace 时对相对路径的匹配。 */
function relMatchesGlob(relativePath: string, globPattern: string): boolean {
  const rel = (relativePath ?? '').replace(/\\/g, '/');
  const pat = (globPattern ?? '*').trim().replace(/\\/g, '/');
  if (!pat || pat === '**/*' || pat === '*') return true;
  const name = rel.split('/').pop() ?? rel;
  if (pat.startsWith('**/')) {
    const rest = pat.slice(3);
    return fnmatch(rel, pat) || fnmatch(rel, rest) || fnmatch(name, rest);
  }
  return fnmatch(rel, pat) || fnmatch(name, pat);
}

/** 是否是可搜索的文本文件（后缀不在二进制黑名单内）。 */
async function isSearchableFile(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target);
    if (!stat.isFile()) return false;
  } catch {
    return false;
  }
  return !isBlockedTextSuffixExt(path.extname(target).toLowerCase());
}

/**
 * 递归收集可搜索文件，上限 `maxFiles`。
 *
 * 遍历顺序刻意与 Python 栈式 DFS 一致（见模块注释）。
 */
async function iterSearchFiles(
  searchRoot: string,
  globPattern: string,
  maxFiles: number,
): Promise<string[]> {
  const files: string[] = [];
  const stack: string[] = [searchRoot];

  while (stack.length > 0 && files.length < maxFiles) {
    const current = stack.pop() as string;

    let entries: import('fs').Dirent[];
    try {
      // eslint-disable-next-line no-await-in-loop
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        // eslint-disable-next-line no-await-in-loop
        if (!(await isSearchableFile(full))) continue;
        if (matchesGlob(entry.name, globPattern)) files.push(full);
      }
    }
  }

  return files;
}

/** 解码 UTF-8 文本；失败返回 null。 */
function tryDecodeUtf8(raw: Buffer): string | null {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}

/** Python `str.splitlines()` 的等价（与 fileReader 保持一致）。 */
const EXTRA_BOUNDARIES = new Set([
  0x0b, 0x0c, 0x1c, 0x1d, 0x1e, 0x85, 0x2028, 0x2029,
]);

function splitLinesForGrep(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let i = 0;
  while (i < text.length) {
    const code = text.codePointAt(i) as number;
    const charLen = code > 0xffff ? 2 : 1;
    if (code === 0x0d) {
      out.push(current);
      current = '';
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (code === 0x0a || EXTRA_BOUNDARIES.has(code)) {
      out.push(current);
      current = '';
      i += charLen;
      continue;
    }
    current += text.slice(i, i + charLen);
    i += charLen;
  }
  if (current !== '') out.push(current);
  return out;
}

/** Python `str.rstrip()`（无参，去全部尾随空白）。 */
function rstrip(text: string): string {
  return text.replace(/[\s\u0085]+$/u, '');
}

export interface GrepOptions {
  maxResults: number;
  maxFilesScanned: number;
}

/**
 * 在工作区内按正则搜索代码/文本，返回 `path:line: content` 格式。
 *
 * 正则语法与 Python `re` 基本一致但不完全相同（JavaScript RegExp 无 `(?P<>)` 等）；
 * 非法正则返回中文错误而非抛异常。
 */
export async function grepWorkspace(
  clientContext: ClientContextLike | null | undefined,
  pattern: string,
  options: GrepOptions & {
    path?: string;
    globPattern?: string;
    caseInsensitive?: boolean;
  },
): Promise<string> {
  const needle = (pattern ?? '').trim();
  if (!needle) return '请提供搜索 pattern（正则表达式）。';

  let regex: RegExp;
  try {
    regex = new RegExp(needle, options.caseInsensitive ? 'i' : '');
  } catch (err) {
    return `无效的正则表达式：${errMessage(err)}`;
  }

  const roots = allowedRoots(clientContext);
  if (roots.length === 0) return '未绑定工作区或项目目录，无法搜索。';

  const limit = Math.min(Math.max(options.maxResults, 1), options.maxResults);
  const maxFiles = options.maxFilesScanned;
  const globPattern = options.globPattern ?? '*';
  const rawPath = (options.path ?? '').trim();

  let filesToSearch: string[] = [];
  if (rawPath) {
    const fileResult = resolveWorkspaceFile(clientContext, rawPath);
    if (fileResult.resolved !== null) {
      filesToSearch = [fileResult.resolved];
    } else {
      const dirResult = resolveWorkspaceDirectory(clientContext, rawPath);
      if (dirResult.resolved === null) {
        return fileResult.error || dirResult.error || '路径无效。';
      }
      filesToSearch = await iterSearchFiles(
        dirResult.resolved,
        globPattern,
        maxFiles,
      );
    }
  } else {
    for (const root of roots) {
      // eslint-disable-next-line no-await-in-loop
      const found = await iterSearchFiles(root, globPattern, maxFiles);
      filesToSearch.push(...found);
      if (filesToSearch.length >= maxFiles) {
        filesToSearch = filesToSearch.slice(0, maxFiles);
        break;
      }
    }
  }

  const results: string[] = [];
  let filesScanned = 0;
  let truncatedFiles = false;

  for (const filePath of filesToSearch) {
    if (filesScanned >= maxFiles) {
      truncatedFiles = true;
      break;
    }
    filesScanned += 1;

    let raw: Buffer;
    try {
      // eslint-disable-next-line no-await-in-loop
      raw = await fs.readFile(filePath);
    } catch {
      continue;
    }
    if (raw.subarray(0, 8192).includes(0)) continue;

    const text = tryDecodeUtf8(raw);
    if (text === null) continue;

    const rel = relativePathFromRoots(filePath, roots);
    const lines = splitLinesForGrep(text);
    let hitLimit = false;
    for (let idx = 0; idx < lines.length; idx += 1) {
      if (regex.test(lines[idx])) {
        results.push(`${rel}:${idx + 1}: ${rstrip(lines[idx])}`);
        if (results.length >= limit) {
          hitLimit = true;
          break;
        }
      }
    }
    if (hitLimit) break;
  }

  const scope = rawPath ? normalizeRelativePath(rawPath) : 'workspace';
  let header = `搜索：${needle}\n范围：${scope}\n`;
  if (globPattern && globPattern !== '*')
    header += `文件匹配：${globPattern}\n`;

  if (results.length === 0) {
    return `${header}未找到匹配。\n`;
  }

  if (results.length >= limit) header += `（结果已截断，最多 ${limit} 条）\n`;
  if (truncatedFiles) header += `（已扫描文件数达上限 ${maxFiles}）\n`;
  header += '---\n';
  return header + results.join('\n');
}

/** 按 glob 递归列出工作区文件。 */
export async function globWorkspace(
  clientContext: ClientContextLike | null | undefined,
  globPattern: string,
  options: { relativeDir?: string; maxFilesScanned: number },
): Promise<string> {
  const pattern = (globPattern ?? '').trim();
  if (!pattern) return '请提供 glob_pattern（如 **/*.py、src/**/*.ts）。';

  const roots = allowedRoots(clientContext);
  if (roots.length === 0) return '未绑定工作区或项目目录，无法搜索。';

  const rawDir = (options.relativeDir ?? '').trim();
  let searchRoots: string[];
  if (rawDir) {
    const dirResult = resolveWorkspaceDirectory(clientContext, rawDir);
    if (dirResult.resolved === null) return dirResult.error || '目录无效。';
    searchRoots = [dirResult.resolved];
  } else {
    searchRoots = [...roots];
  }

  const maxFiles = options.maxFilesScanned;
  const files: string[] = [];
  let truncated = false;

  for (const searchRoot of searchRoots) {
    // eslint-disable-next-line no-await-in-loop
    const found = await iterSearchFiles(searchRoot, '*', maxFiles);
    for (const filePath of found) {
      const rel = relativePathFromRoots(filePath, roots);
      if (!relMatchesGlob(rel, pattern)) continue;
      files.push(filePath);
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
    }
    if (truncated) break;
  }

  const relDir = searchRoots.length
    ? relativePathFromRoots(searchRoots[0], roots)
    : '';
  let header = `glob：${pattern}\n范围：${relDir || '.'}\n`;
  if (files.length === 0) return `${header}未找到匹配文件。\n`;

  header += `条目数：${files.length}`;
  if (truncated) header += `（已截断，最多 ${maxFiles} 条）`;
  header += '\n---\n';
  return header + files.map((f) => relativePathFromRoots(f, roots)).join('\n');
}

/**
 * 列出工作区目录下的文件与子目录。
 *
 * 注意与 grep 的差异：这里**跳过所有以 `.` 开头的条目**（grep 只跳显式名单）。
 */
export async function listWorkspaceDirectory(
  clientContext: ClientContextLike | null | undefined,
  relativeDir: string,
  options: { maxEntries: number },
): Promise<string> {
  const dirResult = resolveWorkspaceDirectory(clientContext, relativeDir);
  if (dirResult.resolved === null) return dirResult.error;

  const roots = allowedRoots(clientContext);
  const cap = options.maxEntries;

  let relDir = roots.length
    ? relativePathFromRoots(dirResult.resolved, roots)
    : '';
  if (!relDir && (relativeDir ?? '').trim()) {
    relDir = normalizeRelativePath(relativeDir);
  }

  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(dirResult.resolved, { withFileTypes: true });
  } catch (err) {
    return `无法读取目录：${errMessage(err)}`;
  }
  entries.sort((a, b) =>
    a.name.toLowerCase() < b.name.toLowerCase()
      ? -1
      : a.name.toLowerCase() > b.name.toLowerCase()
        ? 1
        : 0,
  );

  const lines: string[] = [];
  let truncated = false;
  for (const entry of entries) {
    if (lines.length >= cap) {
      truncated = true;
      break;
    }
    if (entry.name.startsWith('.')) continue;

    const childRel = normalizeRelativePath(
      relDir ? `${relDir}/${entry.name}` : entry.name,
    );
    let kind: string;
    if (entry.isDirectory()) kind = 'directory';
    else if (entry.isFile()) kind = 'file';
    else continue;
    lines.push(`${entry.name} | ${kind} | ${childRel}`);
  }

  let header = `目录：${relDir || '.'}\n`;
  header += `条目数：${lines.length}`;
  if (truncated) header += `（已截断，最多 ${cap} 条）`;
  header += '\n---\n';

  if (lines.length === 0) return `${header}（空目录或无可见条目）\n`;
  return header + lines.join('\n');
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
