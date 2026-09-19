/**
 * 写文件提案工具（write / str_replace / delete / move）。
 *
 * 移植自 `vendor/local-agent/app/agent/tools/workspace_file_reader.py` 的四个
 * `*_workspace_file_tool` 与 `extract_doc_proposal_from_tool_result`。
 *
 * **这些工具不落盘**：只校验路径与内容，产出一个带内部标记 `__doc_proposal__`
 * 的结果；调度层据此发出 `file_proposal_start` / `file_proposal_delta` /
 * `file_proposal` 事件，真正写盘由 Electron 在提案定稿后直接执行（免确认，可撤销）。
 *
 * **基线接力（pendingProposals）**：同一轮里对同一文件的多次修改必须累积成一份提案。
 * `str_replace` 以最新**提案内容**为基线，而不是磁盘原文——否则第二份提案基于未含
 * 第一处修改的磁盘内容，确认落盘后会吞掉前一处修改。该缓存是请求级的，由调用方
 * （`ToolContext`）持有。
 *
 * 存储的值是 `(落盘时的磁盘快照 | null, 提案完整内容)`：`null` 表示整文件覆写、
 * 不依赖磁盘快照；非 null 时用于检测「提案生成后磁盘又被改动」（如用户手动保存），
 * 此时旧提案基线已过期，需要丢弃。
 */

import fs from 'fs-extra';
import path from 'path';
import { isBlockedTextExtension } from '../../../shared/workspaceTextExtensions';
import { buildToolResult, DOC_PROPOSAL_MARKER } from './result';
import {
  relativeDisplayPath,
  resolveWorkspaceFile,
  resolveWorkspaceWritePath,
  type ClientContextLike,
} from './workspacePath';

export const WRITE_TOOL_NAME = 'write_workspace_file';
export const STR_REPLACE_TOOL_NAME = 'str_replace_workspace_file';
export const DELETE_TOOL_NAME = 'delete_workspace_file';
export const MOVE_TOOL_NAME = 'move_workspace_file';

export const FILE_PROPOSAL_TOOLS: ReadonlySet<string> = new Set([
  WRITE_TOOL_NAME,
  STR_REPLACE_TOOL_NAME,
  DELETE_TOOL_NAME,
  MOVE_TOOL_NAME,
]);

/** 路径绝对路径 → (磁盘快照 | null, 提案内容)。 */
export type PendingProposalContents = Map<string, [string | null, string]>;

/** 提案数据（供调度层发 SSE 事件）。 */
export interface DocProposal {
  relativePath: string;
  title: string;
  content: string;
  operation: 'write' | 'delete' | 'rename';
  oldPath: string;
}

/**
 * Python `str.title()` 的等价实现。
 *
 * 规则：每个「词」的首字母大写，其余小写；词是新出现在一个非字母字符之后。
 * 用于把文件名主干转成提案标题（如 `app-config` → `App Config`）。
 */
export function pythonTitle(input: string): string {
  let out = '';
  let prevWasLetter = false;
  for (const ch of input) {
    const isLetter = /[A-Za-z]/.test(ch);
    if (isLetter) {
      out += prevWasLetter ? ch.toLowerCase() : ch.toUpperCase();
    } else {
      out += ch;
    }
    prevWasLetter = isLetter;
  }
  return out;
}

/** 由文件绝对路径推导提案标题（沿用 Python 的 stem 处理）。 */
function titleFromPath(resolved: string): string {
  const stem = path.parse(resolved).name;
  return pythonTitle(stem.replace(/-/g, ' ').replace(/_/g, ' '));
}

function notAllowedSuffix(suffix: string): boolean {
  return isBlockedTextExtension(suffix);
}

/** 读取 UTF-8 文本；文件不存在返回 null，非 UTF-8 抛错。 */
function readUtf8OrNull(target: string): { text: string; missing: boolean } {
  if (!fs.existsSync(target)) return { text: '', missing: true };
  const raw = fs.readFileSync(target);
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    return {
      text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
      missing: false,
    };
  } catch {
    throw new Error('NOT_UTF8');
  }
}

/** 准备写文件提案。 */
export function writeWorkspaceFileTool(
  clientContext: ClientContextLike | null,
  relativePath: string,
  content: string,
  pendingProposals?: PendingProposalContents,
): string {
  const resolveResult = resolveWorkspaceWritePath(clientContext, relativePath);
  if (resolveResult.resolved === null) {
    return buildToolResult({
      ok: false,
      tool: WRITE_TOOL_NAME,
      status: 'error',
      summary: `无法写入文件：${resolveResult.error}`,
    });
  }
  const { resolved } = resolveResult;
  const relDisplay = relativeDisplayPath(clientContext, resolved, relativePath);

  const suffix = path.extname(resolved).toLowerCase();
  if (notAllowedSuffix(suffix)) {
    return buildToolResult({
      ok: false,
      tool: WRITE_TOOL_NAME,
      status: 'error',
      summary:
        `write_workspace_file 不支持后缀 ${suffix}（二进制/富媒体格式）。` +
        '请使用 UTF-8 文本或代码文件。',
    });
  }

  const title = titleFromPath(resolved);
  const summary =
    `已创建文件：${relDisplay}。` +
    '内容已直接写入磁盘（无需确认），用户可在对话中撤销本次修改。' +
    '可以在回复中告知用户文件已创建。';

  if (pendingProposals) pendingProposals.set(resolved, [null, content]);

  return buildToolResult({
    ok: true,
    tool: WRITE_TOOL_NAME,
    status: 'proposal_ready',
    summary,
    file_written: false,
    proposal_pending: true,
    [DOC_PROPOSAL_MARKER]: true,
    relative_path: relDisplay,
    title,
    content,
    operation: 'write',
  });
}

/** 在已有文本文件中做精确替换，生成完整新内容的提案。 */
export function strReplaceWorkspaceFileTool(
  clientContext: ClientContextLike | null,
  relativePath: string,
  oldString: string,
  newString: string,
  replaceAll = false,
  pendingProposals?: PendingProposalContents,
): string {
  const failure = (summary: string): string =>
    buildToolResult({
      ok: false,
      tool: STR_REPLACE_TOOL_NAME,
      status: 'error',
      summary,
    });

  const resolveResult = resolveWorkspaceFile(clientContext, relativePath);
  let { resolved } = resolveResult;

  if (resolved === null) {
    // 文件在磁盘上不存在：若同路径已有未落盘的 write 提案，则以提案为基线继续
    if (pendingProposals) {
      const writeResult = resolveWorkspaceWritePath(
        clientContext,
        relativePath,
      );
      if (
        writeResult.resolved !== null &&
        pendingProposals.has(writeResult.resolved)
      ) {
        resolved = writeResult.resolved;
      }
    }
    if (resolved === null) {
      return failure(`无法读取文件：${resolveResult.error}`);
    }
  }

  const suffix = path.extname(resolved).toLowerCase();
  if (notAllowedSuffix(suffix)) {
    return failure(`不支持后缀 ${suffix}，请使用 UTF-8 文本或代码文件。`);
  }

  if (!oldString) return failure('old_string 不能为空。');

  let original: string;
  try {
    original = readUtf8OrNull(resolved).text;
  } catch (err) {
    if (err instanceof Error && err.message === 'NOT_UTF8') {
      return failure('文件不是 UTF-8 文本。');
    }
    return failure(`读取失败：${errMessage(err)}`);
  }

  // 基线接力：同路径已有未落盘提案且磁盘未再被改动时，以提案内容为基线，
  // 使本轮的多处修改在同一份提案里累积。
  let base = original;
  let baseFromPending = false;
  if (pendingProposals) {
    const pending = pendingProposals.get(resolved);
    if (pending) {
      const [pendingDiskSnap, pendingContent] = pending;
      if (pendingDiskSnap === null || pendingDiskSnap === original) {
        base = pendingContent;
        baseFromPending = true;
      } else {
        // 磁盘在提案生成后又被改动（如用户手动保存），旧提案基线过期
        pendingProposals.delete(resolved);
      }
    }
  }

  const count = countOccurrences(base, oldString);
  if (count === 0) {
    const hint = baseFromPending
      ? '（注意：本轮对该文件已有未落盘的提案，替换基线是提案内容而非磁盘原文，' +
        'read_workspace_file 读到的磁盘原文可能不含此前提案的修改）'
      : '';
    const firstLine = oldString.split(/\r\n|\r|\n/)[0]?.slice(0, 80) ?? '';
    return failure(
      `未找到 old_string（首行：${firstLine}）。` +
        `常见原因：缩进/空白字符与原文不一致，或该处内容已变化。` +
        `请先用 read_workspace_file 核对目标段落，原样复制（含缩进）后重试。${
          hint
        }`,
    );
  }
  if (count > 1 && !replaceAll) {
    return failure(
      `old_string 出现 ${count} 次。请前后多带几行上下文使片段唯一；` +
        '确需替换全部出现时设 replace_all=true。',
    );
  }

  const content = replaceAll
    ? replaceAllOccurrences(base, oldString, newString)
    : replaceFirstOccurrence(base, oldString, newString);

  if (pendingProposals) pendingProposals.set(resolved, [original, content]);

  const relDisplay = relativeDisplayPath(clientContext, resolved, relativePath);
  const title = titleFromPath(resolved);
  const summary =
    `已替换 ${relDisplay} 中的 ${replaceAll ? count : 1} 处内容。` +
    '修改已直接写入磁盘（无需确认），用户可在对话中撤销本次修改。';

  return buildToolResult({
    ok: true,
    tool: STR_REPLACE_TOOL_NAME,
    status: 'proposal_ready',
    summary,
    file_written: false,
    proposal_pending: true,
    [DOC_PROPOSAL_MARKER]: true,
    relative_path: relDisplay,
    title,
    content,
    operation: 'write',
  });
}

/** 准备删除文本文件的提案。 */
export function deleteWorkspaceFileTool(
  clientContext: ClientContextLike | null,
  relativePath: string,
  pendingProposals?: PendingProposalContents,
): string {
  const failure = (summary: string): string =>
    buildToolResult({
      ok: false,
      tool: DELETE_TOOL_NAME,
      status: 'error',
      summary,
    });

  const fileResult = resolveWorkspaceFile(clientContext, relativePath);
  if (fileResult.resolved === null) {
    return failure(`无法删除文件：${fileResult.error}`);
  }
  const { resolved } = fileResult;

  const writeResult = resolveWorkspaceWritePath(clientContext, relativePath);
  if (writeResult.resolved === null) {
    return failure(`无法删除文件：${writeResult.error}`);
  }

  const suffix = path.extname(resolved).toLowerCase();
  if (notAllowedSuffix(suffix)) {
    return failure(`不支持删除后缀 ${suffix}。`);
  }

  const relDisplay = relativeDisplayPath(clientContext, resolved, relativePath);
  const title = `删除 ${path.basename(resolved)}`;
  const summary =
    `已删除 ${relDisplay}。` +
    '删除已直接生效（无需确认），用户可在对话中撤销本次修改。';

  if (pendingProposals) pendingProposals.delete(resolved);

  return buildToolResult({
    ok: true,
    tool: DELETE_TOOL_NAME,
    status: 'proposal_ready',
    summary,
    file_written: false,
    proposal_pending: true,
    [DOC_PROPOSAL_MARKER]: true,
    relative_path: relDisplay,
    title,
    content: '',
    operation: 'delete',
  });
}

/** 准备移动/重命名文件的提案。 */
export function moveWorkspaceFileTool(
  clientContext: ClientContextLike | null,
  relativePath: string,
  newRelativePath: string,
  pendingProposals?: PendingProposalContents,
): string {
  const failure = (summary: string): string =>
    buildToolResult({
      ok: false,
      tool: MOVE_TOOL_NAME,
      status: 'error',
      summary,
    });

  const fileResult = resolveWorkspaceFile(clientContext, relativePath);
  if (fileResult.resolved === null) {
    return failure(`无法移动文件：${fileResult.error}`);
  }
  const { resolved } = fileResult;

  const suffix = path.extname(resolved).toLowerCase();
  if (notAllowedSuffix(suffix)) {
    return failure(`不支持移动后缀 ${suffix} 的文件。`);
  }

  const newRaw = (newRelativePath ?? '').trim();
  if (!newRaw) return failure('new_relative_path 不能为空。');

  const targetResult = resolveWorkspaceWritePath(clientContext, newRaw);
  if (targetResult.resolved === null) {
    return failure(`目标路径无效：${targetResult.error}`);
  }
  const target = targetResult.resolved;

  if (target === resolved) {
    return failure('目标路径与原路径相同，无需移动。');
  }
  if (fs.existsSync(target)) {
    return failure(
      `目标已存在：${relativeDisplayPath(clientContext, target, newRaw)}。请换一个目标路径。`,
    );
  }
  const targetSuffix = path.extname(target).toLowerCase();
  if (notAllowedSuffix(targetSuffix)) {
    return failure(
      `目标后缀 ${targetSuffix} 不受支持，请使用 UTF-8 文本或代码文件。`,
    );
  }

  const oldDisplay = relativeDisplayPath(clientContext, resolved, relativePath);
  const newDisplay = relativeDisplayPath(clientContext, target, newRaw);
  const title = `移动 ${path.basename(resolved)}`;
  const summary =
    `已移动/重命名：${oldDisplay} → ${newDisplay}。` +
    '变更已直接生效（无需确认），用户可在对话中撤销本次修改。';

  if (pendingProposals) {
    pendingProposals.delete(resolved);
    pendingProposals.delete(target);
  }

  return buildToolResult({
    ok: true,
    tool: MOVE_TOOL_NAME,
    status: 'proposal_ready',
    summary,
    file_written: false,
    proposal_pending: true,
    [DOC_PROPOSAL_MARKER]: true,
    relative_path: newDisplay,
    old_path: oldDisplay,
    title,
    content: '',
    operation: 'rename',
  });
}

/**
 * 从写/补丁/删除工具结果中提取文档提案数据。
 *
 * `operation` 被收窄为 `write` / `delete` / `rename` 三值。
 */
export function extractDocProposalFromToolResult(
  toolName: string,
  resultText: string,
): DocProposal | null {
  if (!FILE_PROPOSAL_TOOLS.has(toolName)) return null;

  let data: unknown;
  try {
    data = JSON.parse(resultText);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (!record[DOC_PROPOSAL_MARKER]) return null;

  let operation = String(record.operation ?? 'write');
  if (
    operation !== 'write' &&
    operation !== 'delete' &&
    operation !== 'rename'
  ) {
    operation = 'write';
  }

  return {
    relativePath: String(record.relative_path ?? '') || 'document.md',
    title: String(record.title ?? '') || '文档',
    content: String(record.content ?? ''),
    operation: operation as DocProposal['operation'],
    oldPath: String(record.old_path ?? ''),
  };
}

// ── 字符串工具（避免正则的特殊字符与大小写陷阱） ────────────────────

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count += 1;
    from = idx + needle.length;
    if (count > 1000) break;
  }
  return count;
}

function replaceFirstOccurrence(
  haystack: string,
  needle: string,
  replacement: string,
): string {
  const idx = haystack.indexOf(needle);
  if (idx === -1) return haystack;
  return (
    haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length)
  );
}

function replaceAllOccurrences(
  haystack: string,
  needle: string,
  replacement: string,
): string {
  if (!needle) return haystack;
  return haystack.split(needle).join(replacement);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
