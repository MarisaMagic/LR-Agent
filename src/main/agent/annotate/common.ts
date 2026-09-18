/**
 * 标注编排的公共基础。
 *
 * 移植自 Python 的这几个小模块：
 *   - `app/agent/annotation/json_utils.py`（`extract_json_object`）
 *   - `app/agent/annotation/llm_invoke.py`（`invoke_json_model`）
 *   - `app/agent/text_sanitize.py`（`sanitize_unicode_text` / `sanitize_json_value`）
 *   - `app/api/v1/annotation_agent.py`（`_http_from_llm_error`）
 */

import { z } from 'zod';
import type { ChatMessage, LlmClient } from '../llm/client';

// ── JSON 提取 ────────────────────────────────────────────────────────

/**
 * 从 LLM 文本响应中提取 JSON 对象。
 *
 * 对齐 Python `extract_json_object` 的三步：
 *   1. 剥掉 markdown 围栏（`strip("`")` 会去掉**两端所有**反引号，再移除行首 `json\n`）
 *   2. 直接 `JSON.parse`，成功且是对象则返回
 *   3. 否则用**贪婪**正则抓第一个 `{...}`（跨行）再解析
 *
 * 任何失败都返回 `{}` 而不是抛异常——让上层的 zod 校验给出结构化错误。
 */
export function extractJsonObject(text: string): Record<string, unknown> {
  let raw = (text ?? '').trim();

  if (raw.startsWith('```')) {
    // Python 的 strip("`") 语义：去掉两端所有反引号
    raw = raw.replace(/^`+/, '').replace(/`+$/, '');
    raw = raw.replace(/^json\s*\n/i, '');
  }

  const direct = tryParseObject(raw);
  if (direct) return direct;

  // 贪婪匹配第一个 { 到最后一个 }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return {};
  return tryParseObject(raw.slice(start, end + 1)) ?? {};
}

function tryParseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

// ── 结构化输出调用 ──────────────────────────────────────────────────

/**
 * 把指定字段的 JSON `null` 归一为 `""`。
 *
 * 避免 LLM 误用 `null` 导致校验失败（Python 的 `coerce_null_string_fields`）。
 */
export function coerceNullStringFields(
  data: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  if (fields.length === 0) return data;
  const out = { ...data };
  for (const key of fields) {
    if (key in out && out[key] === null) out[key] = '';
  }
  return out;
}

export interface InvokeJsonOptions<T> {
  /** 输出模型。 */
  schema: z.ZodType<T>;
  /** 追加到 system 的指令（Python 的 `extra_instruction`）。 */
  extraInstruction?: string;
  /** 日志标签（仅用于调试输出）。 */
  logLabel?: string;
  /** 需要把 null 归一为空串的字段。 */
  nullStringFields?: string[];
  /** 覆盖温度。 */
  temperature?: number;
  signal?: AbortSignal;
}

/**
 * 调用 LLM 并要求结构化 JSON 输出。
 *
 * **不使用** `response_format` / `json_schema`（DeepSeek 等兼容性差，Python 侧同样
 * 刻意避开），改用「系统提示 + 显式指令」约束输出格式，再自行解析与校验。
 *
 * 提示词拼装与 Python 一致：
 *   system = systemParts（或默认）joined with extraInstruction（空则过滤掉）
 *   human  = "只输出一个 JSON 对象，不要 markdown 代码块。" + humanParts
 */
export async function invokeJsonModel<T>(
  llm: LlmClient,
  messages: ChatMessage[],
  options: InvokeJsonOptions<T>,
): Promise<T> {
  const systemParts = messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter((part) => part.length > 0);
  const humanParts = messages
    .filter((m) => m.role === 'user')
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .filter((part) => part.length > 0);

  const systemCandidates = systemParts.length > 0 ? systemParts : ['你是结构化 JSON 助手。'];
  const systemText = [systemCandidates[0], options.extraInstruction]
    .filter((p) => p && p.length > 0)
    .join('\n');
  const humanText = [
    '只输出一个 JSON 对象，不要 markdown 代码块。',
    ...humanParts,
  ].join('\n');

  const turn = await llm.completeChat({
    messages: [
      { role: 'system', content: systemText },
      { role: 'user', content: humanText },
    ],
    signal: options.signal,
    temperature: options.temperature,
  });

  let data = extractJsonObject(turn.content);
  if (options.nullStringFields?.length) {
    data = coerceNullStringFields(data, options.nullStringFields);
  }
  return options.schema.parse(data);
}

// ── Unicode 清洗 ────────────────────────────────────────────────────

/**
 * 移除孤立的 UTF-16 代理码元。
 *
 * 这些字符会让下游的 UTF-8 写盘失败（Python 侧注释：避免沙箱 UTF-8 写盘失败）。
 */
export function sanitizeUnicodeText(text: string): string {
  if (!text) return '';
  // 替换掉孤立代理（合法代理对会被保留）
  const cleaned = text.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    '',
  );
  // Python 还会删掉替换字符本身
  return cleaned.replace(/\ufffd/g, '');
}

/** 递归清洗 JSON 中的全部字符串（键与值）。 */
export function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeUnicodeText(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[sanitizeUnicodeText(key)] = sanitizeJsonValue(val);
    }
    return out;
  }
  return value;
}

// ── HTTP 错误分流 ───────────────────────────────────────────────────

/** 路由层可抛出的带状态码错误。 */
export class AnnotateHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AnnotateHttpError';
    this.status = status;
  }
}

/**
 * 把 LLM 调用异常映射为 HTTP 错误。
 *
 * 对齐 Python `_http_from_llm_error`：
 *   - LLM 返回 4xx（如 `BadRequestError`）→ 400，保留原始信息
 *   - 错误信息含 `response_format` / `json_schema` → 400 + 中文提示
 *     （说明该模型不支持结构化输出）
 *   - 其它 → 502，信息截断到 500 字符
 */
export function httpFromLlmError(err: unknown, status?: number): AnnotateHttpError {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (status !== undefined && status >= 400 && status < 500) {
    return new AnnotateHttpError(400, message || 'llm_bad_request');
  }
  if (lower.includes('response_format') || lower.includes('json_schema')) {
    return new AnnotateHttpError(
      400,
      '当前模型不支持结构化输出，请使用普通对话模型或更换提供商',
    );
  }
  return new AnnotateHttpError(502, message.slice(0, 500) || 'llm_invoke_failed');
}

/** 校验 provider 凭据是否齐全（对齐 `_require_direct_llm` 的前置检查）。 */
export function requireCredentials(params: {
  api_key: string;
  base_url: string;
  model: string;
}): void {
  if (
    !params.api_key.trim() ||
    !params.base_url.trim() ||
    !params.model.trim()
  ) {
    throw new AnnotateHttpError(400, 'provider_credentials_required');
  }
}
