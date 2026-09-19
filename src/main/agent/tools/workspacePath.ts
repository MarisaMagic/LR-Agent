/**
 * 工作区 / 项目文件路径解析与安全校验。
 *
 * 移植自 `vendor/local-agent/app/agent/tools/workspace_path.py`。
 * 所有文件读写工具的统一入口：确定允许访问的根 → 解析路径 → 校验范围。
 *
 * **根顺序至关重要**：项目目录优先，其次工作区根。前端 `applyFileBlock` 的写入根
 * 同样是 `project.directoryPath ?? workspaceRoot`；若两侧顺序不一致，提案的
 * relative_display_path 会算出不同结果，落盘会把文件写到另一个根下
 * （历史隐患：同一文件在两个根各落一份），并且前端按路径匹配提案块时会裂成两张卡片。
 *
 * 错误文案需与 Python 侧一致——它们会作为工具结果回灌给模型。
 */

import fs from 'fs-extra';
import path from 'path';

/** Agent 侧可见的最小 client_context 形状（完整定义见 `../schemas`）。 */
export interface ClientContextLike {
  workspaceRoot?: string | null;
  activeFilePath?: string | null;
  activeRelativePath?: string | null;
  projectDirectoryPath?: string | null;
  annotationProjectSnapshot?: {
    projectDirectoryPath?: string | null;
  } | null;
}

export const LR_AGENT_DIR = '.lr-agent';

export const LR_AGENT_WRITE_DENIED =
  '不能用本工具写入标注。新增/重写请调用 auto_annotate，修改请调用 mutate_annotation。';

/** 将相对路径统一为正斜杠，去除空段与 `.`。 */
export function normalizeRelativePath(relativePath: string): string {
  return (relativePath ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.')
    .join('/');
}

/** 相对路径是否落入 .lr-agent 标注库目录。 */
export function isLrAgentRelative(relativePath: string): boolean {
  return normalizeRelativePath(relativePath)
    .split('/')
    .some((part) => part === LR_AGENT_DIR);
}

/** 标注项目目录绝对路径：优先 client_context，其次快照内字段。 */
export function projectDirectory(
  clientContext: ClientContextLike | null | undefined,
): string | null {
  if (!clientContext) return null;
  const direct = (clientContext.projectDirectoryPath ?? '').trim();
  if (direct) return direct;
  const snap = clientContext.annotationProjectSnapshot;
  const fromSnap = (snap?.projectDirectoryPath ?? '').trim();
  return fromSnap || null;
}

/**
 * 可访问的根目录列表（项目目录优先 + 工作区根，去重，已 resolve）。
 *
 * @returns 绝对路径数组；未绑定任何根时为空数组
 */
export function allowedRoots(
  clientContext: ClientContextLike | null | undefined,
): string[] {
  const roots: string[] = [];
  const seen = new Set<string>();
  if (!clientContext) return roots;

  for (const raw of [
    (projectDirectory(clientContext) ?? '').trim(),
    (clientContext.workspaceRoot ?? '').trim(),
  ]) {
    if (!raw) continue;
    let resolved: string;
    try {
      resolved = path.resolve(raw);
    } catch {
      continue;
    }
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push(resolved);
  }
  return roots;
}

/** candidate 是否在 root 目录树下（含相等）。 */
function isUnderRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '') return true;
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** candidate 是否落在 root 下的 .lr-agent 目录内。 */
function isLrAgentUnderRoot(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '' || rel.startsWith('..')) return false;
  return rel.split(path.sep).some((part) => part === LR_AGENT_DIR);
}

/** 将已解析的绝对路径转为相对显示路径（正斜杠）；不在任何根内时回退 fallback。 */
export function relativeDisplayPath(
  clientContext: ClientContextLike | null | undefined,
  resolved: string,
  fallback: string,
): string {
  for (const root of allowedRoots(clientContext)) {
    if (isUnderRoot(resolved, root)) {
      return normalizeRelativePath(path.relative(root, resolved));
    }
  }
  return (fallback ?? '').trim();
}

/** 将绝对路径转为相对某个根的路径（正斜杠）；都不匹配时取 basename。 */
export function relativePathFromRoots(
  candidate: string,
  roots: string[],
): string {
  for (const root of roots) {
    if (isUnderRoot(candidate, root)) {
      return normalizeRelativePath(path.relative(root, candidate));
    }
  }
  return path.basename(candidate);
}

export interface ResolveResult {
  /** 已解析的绝对路径；失败时为 null。 */
  resolved: string | null;
  /** 失败原因（可直接回灌给模型）；成功时为空串。 */
  error: string;
}

/**
 * 解析并校验**已存在文件**的路径。
 *
 * 语义：
 * - `path` 为空时回退到 `active_file_path`（绝对），其次 `active_relative_path`
 * - 绝对路径须落在某个根内且确实存在
 * - 相对路径禁止 `..` 穿越；按根顺序逐个尝试
 */
export function resolveWorkspaceFile(
  clientContext: ClientContextLike | null | undefined,
  filePath: string,
): ResolveResult {
  let raw = (filePath ?? '').trim();
  if (!raw && clientContext) {
    const activeAbs = (clientContext.activeFilePath ?? '').trim();
    if (activeAbs) {
      raw = activeAbs;
    } else {
      const rel = normalizeRelativePath(clientContext.activeRelativePath ?? '');
      if (rel) raw = rel;
    }
  }

  if (!raw) {
    return {
      resolved: null,
      error: '请提供相对路径，或在工作区中打开目标文件后再提问。',
    };
  }

  const roots = allowedRoots(clientContext);
  if (roots.length === 0) {
    return { resolved: null, error: '未绑定工作区或项目目录，无法读取本地文件。' };
  }

  if (path.isAbsolute(raw)) {
    let candidate: string;
    try {
      candidate = path.resolve(raw);
    } catch (err) {
      return { resolved: null, error: `路径无效：${errMessage(err)}` };
    }
    for (const root of roots) {
      if (isUnderRoot(candidate, root) && isFileSafe(candidate)) {
        return { resolved: candidate, error: '' };
      }
    }
    return { resolved: null, error: '文件不在当前工作区或项目目录内。' };
  }

  const rel = normalizeRelativePath(raw);
  if (rel.split('/').includes('..')) {
    return { resolved: null, error: '路径不能包含 ..' };
  }

  for (const root of roots) {
    const candidate = path.resolve(root, rel);
    if (!isUnderRoot(candidate, root)) continue;
    if (isFileSafe(candidate)) return { resolved: candidate, error: '' };
  }
  return { resolved: null, error: `未找到文件：${rel}` };
}

/**
 * 解析并校验**目录**路径。
 *
 * `path` 为空时回退到第一个根（工作区根语义）。
 */
export function resolveWorkspaceDirectory(
  clientContext: ClientContextLike | null | undefined,
  dirPath: string,
): ResolveResult {
  const raw = (dirPath ?? '').trim();
  const roots = allowedRoots(clientContext);
  if (roots.length === 0) {
    return { resolved: null, error: '未绑定工作区或项目目录，无法访问本地目录。' };
  }

  if (!raw) {
    const root = roots[0];
    if (isDirSafe(root)) return { resolved: root, error: '' };
    return { resolved: null, error: '工作区根目录无效。' };
  }

  if (path.isAbsolute(raw)) {
    let candidate: string;
    try {
      candidate = path.resolve(raw);
    } catch (err) {
      return { resolved: null, error: `路径无效：${errMessage(err)}` };
    }
    for (const root of roots) {
      if (isUnderRoot(candidate, root) && isDirSafe(candidate)) {
        return { resolved: candidate, error: '' };
      }
    }
    return { resolved: null, error: '目录不在当前工作区或项目目录内。' };
  }

  const rel = normalizeRelativePath(raw);
  if (rel.split('/').includes('..')) {
    return { resolved: null, error: '路径不能包含 ..' };
  }

  for (const root of roots) {
    const candidate = path.resolve(root, rel);
    if (!isUnderRoot(candidate, root)) continue;
    if (isDirSafe(candidate)) return { resolved: candidate, error: '' };
  }
  return { resolved: null, error: `未找到目录：${rel}` };
}

/**
 * 解析并校验**写入目标**路径。
 *
 * 与 `resolveWorkspaceFile` 的差异：目标文件不要求已存在；额外禁止 `.lr-agent`。
 */
export function resolveWorkspaceWritePath(
  clientContext: ClientContextLike | null | undefined,
  writePath: string,
): ResolveResult {
  const raw = (writePath ?? '').trim();
  if (!raw) {
    return {
      resolved: null,
      error: '请提供写入目标的相对路径（如 reports/summary.md）。',
    };
  }

  const roots = allowedRoots(clientContext);
  if (roots.length === 0) {
    return { resolved: null, error: '未绑定工作区或项目目录，无法写入本地文件。' };
  }

  if (path.isAbsolute(raw)) {
    let candidate: string;
    try {
      candidate = path.resolve(raw);
    } catch (err) {
      return { resolved: null, error: `路径无效：${errMessage(err)}` };
    }
    for (const root of roots) {
      if (!isUnderRoot(candidate, root)) continue;
      if (isLrAgentUnderRoot(candidate, root)) {
        return { resolved: null, error: LR_AGENT_WRITE_DENIED };
      }
      return { resolved: candidate, error: '' };
    }
    return { resolved: null, error: '目标路径不在当前工作区或项目目录内。' };
  }

  const rel = normalizeRelativePath(raw);
  if (rel.split('/').includes('..')) {
    return { resolved: null, error: '路径不能包含 ..' };
  }
  if (isLrAgentRelative(rel)) {
    return { resolved: null, error: LR_AGENT_WRITE_DENIED };
  }

  for (const root of roots) {
    const candidate = path.resolve(root, rel);
    if (!isUnderRoot(candidate, root)) continue;
    return { resolved: candidate, error: '' };
  }
  return { resolved: null, error: `无法解析写入路径：${rel}` };
}

/**
 * 把模型给的写入路径归一为与工具结果一致的显示路径。
 *
 * 流式拦截器（file_proposal_start / delta）与定稿事件必须产出**同一条**路径字符串，
 * 否则前端按路径匹配提案块时会裂成两张卡片（历史 bug：模型写绝对路径或 `./` 前缀）。
 * 解析失败时退化为 `normalizeRelativePath`，保证至少分隔符与空段是干净的。
 */
export function normalizeWriteDisplayPath(
  clientContext: ClientContextLike | null | undefined,
  rawPath: string,
): string {
  const { resolved } = resolveWorkspaceWritePath(clientContext, rawPath);
  if (resolved === null) return normalizeRelativePath(rawPath);
  return relativeDisplayPath(clientContext, resolved, rawPath);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 容错的 isFile 判断（Python 侧用 Candidate.is_file()，不会抛）。 */
function isFileSafe(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** 容错的 isDirectory 判断。 */
function isDirSafe(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
