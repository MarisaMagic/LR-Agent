/**
 * 工作区文本文件读取。
 *
 * 移植自 `vendor/local-agent/app/agent/tools/workspace_file_reader.py` 的
 * `read_workspace_text_file` / `_read_ranged_text` / `_read_line_window`。
 *
 * 两个易被忽略但会影响输出的细节：
 *
 *   1. **换行符集合不同**。非范围读取用 `str.splitlines()`，它除了 `\n` 还切分
 *      `\v \f \x1c \x1d \x1e \x85 \u2028 \u2029`；而范围读取走文本模式文件迭代
 *      （universal newlines，仅 `\n` / `\r` / `\r\n`）。两者行号可能不同，
 *      这里刻意分别实现而不是共用一个 split。
 *
 *   2. **编码回退**。Python 先试 `utf-8` 再试 `utf-8-sig`（剥离 BOM）。Node 的
 *      `Buffer.toString('utf8')` 对非法字节会产出替换字符而不报错，因此必须用
 *      `TextDecoder` 的 `fatal` 模式来判断"是否为合法 UTF-8"。
 */

import fs from 'fs-extra';
import path from 'path';
import { resolveWorkspaceFile, type ClientContextLike } from './workspacePath';

/** 单行展示上限：防止 minified / 单行巨型文件撑爆工具结果。 */
const MAX_LINE_DISPLAY_CHARS = 2000;

/** 二进制探测窗口。 */
const BINARY_PROBE_BYTES = 8192;

/** 图片后缀（视觉工具用）。 */
export const IMAGE_SUFFIXES = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
]);

/** 文档后缀（read_document_file 用）。 */
export const DOCUMENT_SUFFIXES = new Set(['.pdf', '.docx']);

/**
 * 不可当纯文本读取的后缀。
 *
 * 与 `src/shared/workspaceTextExtensions.ts` 的 `SPECIAL_PREVIEW_EXTENSIONS`
 * 为同一集合（Python 侧名为 `TEXT_WRITE_BLOCKLIST`）。
 */
const TEXT_BLOCKLIST_SUFFIXES = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.svg',
  '.pdf',
  '.docx',
  '.doc',
  '.zip',
  '.rar',
  '.7z',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.mp3',
  '.mp4',
  '.avi',
  '.mov',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
]);

export function isBlockedTextSuffixExt(suffix: string): boolean {
  return TEXT_BLOCKLIST_SUFFIXES.has(suffix.toLowerCase());
}

/** 单行截断。 */
function capLine(line: string): string {
  if (line.length <= MAX_LINE_DISPLAY_CHARS) return line;
  return `${line.slice(0, MAX_LINE_DISPLAY_CHARS)}…[行已截断，共 ${line.length} 字符]`;
}

/** 6 位右对齐行号（对齐 Python 的 `f"{n:6d}"`）。 */
function numberLine(lineNumber: number, line: string): string {
  return `${String(lineNumber).padStart(6, ' ')}|${capLine(line)}`;
}

/** Python `str.splitlines()` 的行边界字符。 */
const SPLITLINES_EXTRA = new Set([
  0x0b, // \v
  0x0c, // \f
  0x1c,
  0x1d,
  0x1e,
  0x85,
  0x2028,
  0x2029,
]);

/**
 * 等价于 Python `str.splitlines()`。
 *
 * 与 `String.prototype.split(/\r\n|\r|\n/)` 的差异：额外切分上面那组边界字符，
 * 且不产生末尾空串（`"a\n"` → `["a"]`）。
 */
export function splitLines(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let i = 0;
  while (i < text.length) {
    const code = text.codePointAt(i) as number;
    const charLen = code > 0xffff ? 2 : 1;

    if (code === 0x0d) {
      // \r 或 \r\n
      out.push(current);
      current = '';
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (code === 0x0a || SPLITLINES_EXTRA.has(code)) {
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

/**
 * 文本模式文件迭代的换行切分（universal newlines：`\n` / `\r` / `\r\n`）。
 *
 * 用于范围读取，与 `splitLines` 刻意区分。
 */
export function universalLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const parts = normalized.split('\n');
  // 文本迭代到 EOF 时若以换行结尾不会产生额外空行
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/** 解码结果。 */
type DecodeOutcome =
  { ok: true; text: string } | { ok: false; reason: 'binary' | 'not_utf8' };

/**
 * 探测并解码 UTF-8 文本。
 *
 * @param probe 用于二进制探测的字节（前 8192）
 * @param payload 待解码的完整字节（可能已被 max_bytes 截断）
 */
function decodeUtf8(probe: Buffer, payload: Buffer): DecodeOutcome {
  if (probe.includes(0)) return { ok: false, reason: 'binary' };
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
    // 对齐 Python 的 utf-8-sig：剥离 BOM
    return {
      ok: true,
      text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text,
    };
  } catch {
    return { ok: false, reason: 'not_utf8' };
  }
}

export interface ReadTextOptions {
  maxBytes: number;
  maxLines: number;
  startLine?: number | null;
  endLine?: number | null;
}

/**
 * 读取工作区文本/代码文件。
 *
 * 指定行范围时按窗口读取，支持大文件任意位置且不受 maxBytes 对头部的预截断影响；
 * 否则读取文件头部并按字节/行数截断。
 */
export function readWorkspaceTextFile(
  clientContext: ClientContextLike | null | undefined,
  filePath: string,
  options: ReadTextOptions,
): string {
  const { resolved, error } = resolveWorkspaceFile(clientContext, filePath);
  if (resolved === null) return error;

  const suffix = path.extname(resolved).toLowerCase();
  if (isBlockedTextSuffixExt(suffix)) {
    return (
      `「${path.basename(resolved)}」不是纯文本文件。` +
      '图片请用 read_image_for_vision；PDF/DOCX 请用 read_document_file。'
    );
  }

  const { maxBytes, maxLines, startLine, endLine } = options;
  let size: number;
  try {
    size = fs.statSync(resolved).size;
  } catch (err) {
    return `无法读取文件：${errMessage(err)}`;
  }

  if (startLine != null || endLine != null) {
    return readRangedText(
      resolved,
      size,
      startLine ?? null,
      endLine ?? null,
      maxLines,
    );
  }

  let raw: Buffer;
  let truncated = false;
  try {
    raw = fs.readFileSync(resolved);
    if (size > maxBytes) {
      truncated = true;
      raw = raw.subarray(0, maxBytes);
    }
  } catch (err) {
    return `读取失败：${errMessage(err)}`;
  }

  const name = path.basename(resolved);
  const decoded = decodeUtf8(raw.subarray(0, BINARY_PROBE_BYTES), raw);
  if (!decoded.ok) {
    return decoded.reason === 'binary'
      ? `「${name}」似乎是二进制文件，请使用对应专用工具。`
      : `「${name}」不是 UTF-8 文本，暂不支持读取。`;
  }

  let lines = splitLines(decoded.text);
  if (lines.length > maxLines) {
    truncated = true;
    lines = lines.slice(0, maxLines);
  }

  let header = `文件：${name}\n大小：${size} 字节\n`;
  if (truncated) {
    header +=
      `（内容已截断，最多 ${maxBytes} 字节 / ${maxLines} 行；` +
      '可用 start_line/end_line 分段读取后续内容）\n';
  }
  header += '---\n';

  return (
    header + lines.map((line, index) => numberLine(1 + index, line)).join('\n')
  );
}

/** 行范围读取。 */
function readRangedText(
  resolved: string,
  size: number,
  startLine: number | null,
  endLine: number | null,
  maxLines: number,
): string {
  const start = Math.max(1, startLine ?? 1);
  if (endLine != null && endLine < start) {
    return `无效行范围：start_line (${start}) 不能大于 end_line (${endLine})。`;
  }

  const name = path.basename(resolved);

  let probe: Buffer;
  try {
    const fd = fs.openSync(resolved, 'r');
    try {
      const buffer = Buffer.alloc(BINARY_PROBE_BYTES);
      const read = fs.readSync(fd, buffer, 0, BINARY_PROBE_BYTES, 0);
      probe = buffer.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return `读取失败：${errMessage(err)}`;
  }
  if (probe.includes(0)) {
    return `「${name}」似乎是二进制文件，请使用对应专用工具。`;
  }

  let content: string;
  try {
    content = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    return `读取失败：${errMessage(err)}`;
  }
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

  const all = universalLines(content);
  const collected: string[] = [];
  let total: number | null = 0;
  let truncated = false;

  for (let idx = start; idx <= all.length; idx += 1) {
    if (endLine != null && idx > endLine) {
      total = null;
      break;
    }
    if (collected.length >= maxLines) {
      truncated = true;
      total = null;
      break;
    }
    collected.push(all[idx - 1]);
    total = idx;
  }

  const endLabel = endLine != null ? `L${endLine}` : 'EOF';
  let header = `文件：${name}\n大小：${size} 字节\n行范围：L${start}-${endLabel}`;
  if (total != null) header += `（共 ${total} 行）`;
  header += '\n';
  if (truncated) {
    header +=
      `（行窗口已截断，最多 ${maxLines} 行；` +
      '可用 start_line/end_line 继续分段读取）\n';
  }
  header += '---\n';

  if (collected.length === 0) {
    return total != null
      ? `${header}（起始行超出文件末尾，共 ${total} 行）`
      : `${header}（指定范围内无内容）`;
  }

  return (
    header +
    collected.map((line, offset) => numberLine(start + offset, line)).join('\n')
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
