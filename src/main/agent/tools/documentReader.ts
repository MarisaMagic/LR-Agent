/**
 * `read_document_file`：提取 PDF / DOCX 正文。
 *
 * 输出格式对齐 `vendor/local-agent/app/agent/tools/workspace_file_reader.py`：
 *
 * ```
 * 文件：<name>
 * <meta>
 * （正文已截断至 N 字符）      ← 仅在截断时出现
 * ---
 * <正文>
 * ```
 *
 * meta：PDF → `PDF 共 N 页，已提取前 M 页`；DOCX → `DOCX 段落数：N`
 *
 * **顺带修正一个既有缺陷**：Python 侧 `pypdf` / `python-docx` 被惰性 import 但
 * **未写入 `requirements.txt`**，因此在干净环境中该工具只会返回
 * `解析文档失败：No module named 'pypdf'`。Node 侧把依赖落实：
 *   - DOCX 用已在依赖中的 `mammoth`
 *   - PDF 用本文件的轻量提取器（Node 无现成 PDF 文本库，且不引入重型依赖）
 *
 * **PDF 提取器的覆盖范围与限制**（诚实说明，避免产出"看似正确实则错乱"的正文）：
 *   - 支持：FlateDecode 压缩或未压缩的内容流；`Tj` / `TJ` / `'` / `"` 文本算子；
 *     字面量字符串的转义（含八进制）；十六进制字符串；UTF-16BE（`FEFF` 前缀）与
 *     Latin-1 编码
 *   - 不支持：需要 `ToUnicode` CMap 才能还原的自定义字体编码（此时按字节直译，
 *     非 Latin 文本可能不准确）、扫描件（无文本层）、加密文档
 */

import fs from 'fs-extra';
import path from 'path';
import zlib from 'zlib';
import { resolveWorkspaceFile, type ClientContextLike } from './workspacePath';
import { DOCUMENT_SUFFIXES } from './fileReader';

/**
 * mammoth 按需加载。
 *
 * 它连同 jszip 等依赖约 6.5MB；若在模块顶层 import，运行时启动时就会求值这一整块。
 * 放进函数内 `require` 可推迟到首次解析 DOCX 时——DOCX 是低频能力，不值得占用启动路径。
 */
type MammothModule = typeof import('mammoth');
let mammothModule: MammothModule | null = null;

function loadMammoth(): MammothModule {
  if (!mammothModule) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
    mammothModule = require('mammoth') as MammothModule;
  }
  return mammothModule;
}

export interface DocumentReadOptions {
  maxPages: number;
  maxChars: number;
  /** PDF 起始页（1-indexed，含）；DOCX 忽略。默认第 1 页。 */
  startPage?: number;
}

export async function readDocumentFile(
  clientContext: ClientContextLike | null,
  filePath: string,
  options: DocumentReadOptions,
): Promise<string> {
  const { resolved, error } = resolveWorkspaceFile(clientContext, filePath);
  if (resolved === null) return error;

  const fileName = path.basename(resolved);
  const suffix = path.extname(resolved).toLowerCase();
  if (!DOCUMENT_SUFFIXES.has(suffix)) {
    return `「${fileName}」不是支持的文档格式（pdf、docx）。`;
  }

  let text: string;
  let meta: string;
  try {
    if (suffix === '.pdf') {
      const extracted = extractPdfText(fs.readFileSync(resolved), {
        startPage: options.startPage,
        maxPages: options.maxPages,
      });
      if (extracted.total > 0 && extracted.extracted === 0) {
        return (
          `「${fileName}」第 ${extracted.startPage} 页超出文档范围` +
          `（PDF 共 ${extracted.total} 页）。`
        );
      }
      text = extracted.text;
      meta =
        extracted.startPage > 1
          ? `PDF 共 ${extracted.total} 页，已提取第 ${extracted.startPage}~${extracted.endPage} 页`
          : `PDF 共 ${extracted.total} 页，已提取前 ${extracted.extracted} 页`;
    } else {
      const extracted = await extractDocxText(resolved);
      text = extracted.text;
      meta = `DOCX 段落数：${extracted.paragraphs}`;
    }
  } catch (err) {
    return `解析文档失败：${errMessage(err)}`;
  }

  if (!text.trim()) {
    return `「${fileName}」未能提取到文本（${meta}）。`;
  }

  let truncated = false;
  if (text.length > options.maxChars) {
    text = text.slice(0, options.maxChars);
    truncated = true;
  }

  let header = `文件：${fileName}\n${meta}\n`;
  if (truncated) header += `（正文已截断至 ${options.maxChars} 字符）\n`;
  header += '---\n';
  return header + text;
}

/** DOCX 提取（mammoth 的 extractRawText 返回按段落分行的纯文本）。 */
async function extractDocxText(
  resolved: string,
): Promise<{ text: string; paragraphs: number }> {
  const buffer = fs.readFileSync(resolved);
  const result = await loadMammoth().extractRawText({ buffer });
  const paragraphs = result.value
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { text: paragraphs.join('\n\n'), paragraphs: paragraphs.length };
}

// ── PDF 文本提取 ────────────────────────────────────────────────────

export interface PdfExtractOptions {
  /** 1-indexed 起始页（含）；默认第 1 页。 */
  startPage?: number;
  /** 本次最多提取页数。 */
  maxPages: number;
}

interface PdfExtractResult {
  text: string;
  total: number;
  extracted: number;
  /** 1-indexed 实际起始页。 */
  startPage: number;
  /** 1-indexed 实际结束页（含）；未提取到任何页时为 startPage - 1。 */
  endPage: number;
}

/**
 * 轻量 PDF 文本提取。
 *
 * 策略：扫描 `N 0 obj ... endobj` 取出对象表 → 找出页对象（`/Type /Page`）与其
 * `/Contents` 引用 → 解压内容流 → 按文本算子抽取文字。页顺序取对象在文件中出现的
 * 顺序，对绝大多数文档与页树顺序一致。
 *
 * 支持 `startPage` 页偏移：超过总页数时返回 `extracted: 0`，由调用方给出明确提示。
 */
export function extractPdfText(
  bytes: Buffer,
  options: PdfExtractOptions,
): PdfExtractResult {
  // 用 latin1 解析结构：字节保真，且不会因二进制内容破坏索引
  const raw = bytes.toString('latin1');

  const objects = collectObjects(raw);
  const pageContents = collectPageContentRefs(objects);

  const total = pageContents.length;
  const startIndex = Math.max(0, Math.floor(options.startPage ?? 1) - 1);
  const startPage = startIndex + 1;

  if (total === 0 || startIndex >= total) {
    return { text: '', total, extracted: 0, startPage, endPage: startPage - 1 };
  }

  const limit = Math.min(total - startIndex, Math.max(1, options.maxPages));
  const endPage = startIndex + limit;

  const parts: string[] = [];
  for (let i = startIndex; i < endPage; i += 1) {
    const chunks = pageContents[i]
      .map((objNum) => objects.get(objNum))
      .filter((obj): obj is PdfObject => obj !== undefined)
      .map((obj) => obj.stream ?? Buffer.alloc(0));
    parts.push(chunks.map(extractTextFromContentStream).join(''));
  }

  return {
    text: parts.join('\n\n'),
    total,
    extracted: limit,
    startPage,
    endPage,
  };
}

interface PdfObject {
  /** 对象的原始文本（不含 `endobj`）。 */
  body: string;
  /** 已解码的流内容（若有）；解码失败时为原始字节。 */
  stream: Buffer | null;
}

/** 扫描所有 `N 0 obj` 定义。 */
function collectObjects(raw: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(raw)) !== null) {
    const objNum = Number(match[1]);
    const start = match.index + match[0].length;
    const endObj = raw.indexOf('endobj', start);
    const end = endObj === -1 ? raw.length : endObj;
    const body = raw.slice(start, end);

    let stream: Buffer | null = null;
    const streamIdx = body.indexOf('stream');
    if (streamIdx !== -1) {
      // stream 关键字后需跟 CRLF 或 LF
      let dataStart = streamIdx + 'stream'.length;
      if (body[dataStart] === '\r') dataStart += 1;
      if (body[dataStart] === '\n') dataStart += 1;
      const endStream = body.lastIndexOf('endstream');
      const dataEnd = endStream > dataStart ? endStream : body.length;
      const rawStream = Buffer.from(body.slice(dataStart, dataEnd), 'latin1');

      const dict = body.slice(0, streamIdx);
      stream = inflateIfNeeded(dict, rawStream);
    }

    objects.set(objNum, { body, stream });
  }

  return objects;
}

/** 按字典中的 `/Filter` 决定是否解压。 */
function inflateIfNeeded(dict: string, data: Buffer): Buffer {
  const isFlate =
    /\/Filter\s*\/FlateDecode/.test(dict) ||
    /\/Filter\s*\[\s*\/FlateDecode/.test(dict);
  if (!isFlate) return data;
  try {
    return zlib.inflateSync(data);
  } catch {
    try {
      // 部分文件缺少 zlib 头，尝试 raw deflate
      return zlib.inflateRawSync(data);
    } catch {
      return data;
    }
  }
}

/**
 * 收集每页的 `/Contents` 对象号。
 *
 * 只认 `/Type /Page`（排除 `/Pages`），并解析 `/Contents N 0 R` 或
 * `/Contents [N 0 R M 0 R ...]` 两种形式。
 */
function collectPageContentRefs(objects: Map<number, PdfObject>): number[][] {
  const pages: Array<{ objNum: number; refs: number[] }> = [];

  for (const [objNum, obj] of objects) {
    if (!/\/Type\s*\/Page\b/.test(obj.body)) continue;
    if (/\/Type\s*\/Pages\b/.test(obj.body)) continue;

    const m = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(obj.body);
    if (!m) {
      pages.push({ objNum, refs: [] });
      continue;
    }
    const refs = [...m[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((r) =>
      Number(r[1]),
    );
    pages.push({ objNum, refs });
  }

  // 页顺序：优先按对象号升序（与页树顺序一致度最高）
  pages.sort((a, b) => a.objNum - b.objNum);
  return pages.map((page) => page.refs);
}

/**
 * 从内容流中抽取文本。
 *
 * 按 `BT`/`ET` 分块，处理 `Tj`、`TJ`、`'`、`"` 算子，以及 `Td`/`TD`/`T*` 换行提示。
 */
export function extractTextFromContentStream(content: Buffer): string {
  const text = content.toString('latin1');
  const out: string[] = [];
  let i = 0;

  // 简单的词法扫描：识别字符串字面量、十六进制串、数组与算子
  const stack: string[] = [];
  let pending: string[] = [];

  const flushLine = (): void => {
    if (pending.length) {
      out.push(pending.join(''));
      pending = [];
    }
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === '%') {
      // 注释到行尾
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }

    if (ch === '(') {
      const { value, next } = readLiteralString(text, i);
      stack.push(value);
      i = next;
      continue;
    }

    if (ch === '<' && text[i + 1] !== '<') {
      const { value, next } = readHexString(text, i);
      stack.push(value);
      i = next;
      continue;
    }

    if (ch === '[' || ch === ']') {
      // 数组边界：不作为内容，但保留已压入的字符串
      i += 1;
      continue;
    }

    if (/[A-Za-z'"*]/.test(ch)) {
      // 读一个算子
      let j = i;
      while (j < text.length && /[A-Za-z0-9'"*]/.test(text[j])) j += 1;
      const op = text.slice(i, j);
      i = j;

      if (op === 'Tj') {
        const value = stack.pop();
        if (value != null) pending.push(value);
      } else if (op === "'" || op === '"') {
        // `'` / `"` 的语义是「移到下一行并显示文本」：先结束上一行，再放新内容
        flushLine();
        const value = stack.pop();
        if (value != null) pending.push(value);
      } else if (op === 'TJ') {
        // 数组内的字符串按顺序拼接（数值是字距调整，忽略）
        pending.push(...stack);
        stack.length = 0;
      } else if (op === 'Td' || op === 'TD' || op === 'T*') {
        flushLine();
      } else if (op === 'ET') {
        flushLine();
      }
      continue;
    }

    i += 1;
  }
  flushLine();

  return out.join('\n');
}

/** 读取 PDF 字面量字符串 `(...)`，处理转义与嵌套括号。 */
function readLiteralString(
  text: string,
  start: number,
): { value: string; next: number } {
  const bytes: number[] = [];
  let depth = 1;
  let i = start + 1;

  while (i < text.length && depth > 0) {
    const ch = text[i];
    if (ch === '\\') {
      const nxt = text[i + 1];
      switch (nxt) {
        case 'n':
          bytes.push(0x0a);
          i += 2;
          break;
        case 'r':
          bytes.push(0x0d);
          i += 2;
          break;
        case 't':
          bytes.push(0x09);
          i += 2;
          break;
        case 'b':
          bytes.push(0x08);
          i += 2;
          break;
        case 'f':
          bytes.push(0x0c);
          i += 2;
          break;
        case '(':
        case ')':
        case '\\':
          bytes.push(nxt.charCodeAt(0));
          i += 2;
          break;
        default:
          if (nxt >= '0' && nxt <= '7') {
            // 最多三位八进制
            let oct = '';
            let k = i + 1;
            while (
              k < text.length &&
              oct.length < 3 &&
              text[k] >= '0' &&
              text[k] <= '7'
            ) {
              oct += text[k];
              k += 1;
            }
            bytes.push(parseInt(oct, 8) & 0xff);
            i = k;
          } else {
            bytes.push(nxt.charCodeAt(0));
            i += 2;
          }
          break;
      }
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
    bytes.push(text.charCodeAt(i) & 0xff);
    i += 1;
  }

  return { value: decodePdfBytes(Buffer.from(bytes)), next: i };
}

/** 读取十六进制字符串 `<...>`。 */
function readHexString(
  text: string,
  start: number,
): { value: string; next: number } {
  const end = text.indexOf('>', start + 1);
  const hex = (
    end === -1 ? text.slice(start + 1) : text.slice(start + 1, end)
  ).replace(/[^0-9a-fA-F]/g, '');
  const padded = hex.length % 2 === 0 ? hex : `${hex}0`;
  const bytes = Buffer.from(padded, 'hex');
  return {
    value: decodePdfBytes(bytes),
    next: end === -1 ? text.length : end + 1,
  };
}

/**
 * 解码 PDF 字符串字节。
 *
 * `FEFF` 前缀视为 UTF-16BE；否则按 Latin-1（即字节直译）处理。
 * 需要 `ToUnicode` CMap 的自定义编码不在此覆盖范围内。
 */
function decodePdfBytes(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeUtf16Be(bytes.subarray(2));
  }
  return bytes.toString('latin1');
}

/** UTF-16BE → JS 字符串（按码元成对解析）。 */
function decodeUtf16Be(bytes: Buffer): string {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  }
  return out;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
