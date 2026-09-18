/**
 * Python `json.dumps` 兼容的序列化。
 *
 * 为什么需要它：工具结果 JSON 会**原文**回灌给模型并出现在 SSE 的 `result` 字段里，
 * 而 Python 的 `json.dumps` 默认分隔符是 `(', ', ': ')`（逗号与冒号后都有空格），
 * JavaScript 的 `JSON.stringify` 则不插空格：
 *
 *   Python: {"ok": false, "tool": "x"}
 *   JS    : {"ok":false,"tool":"x"}
 *
 * 多数情况下这个差异会被 `formatToolResultForDisplay` 折叠掉（只取 `summary`），
 * 但对**提案工具失败**这类「原样回灌完整 JSON」的路径会直接暴露，因此需要精确对齐。
 *
 * 注意：带缩进（`indent=2`）时 Python 的元素分隔符变成 `,`（无空格），键分隔符仍是
 * `': '`——这与 `JSON.stringify(value, null, 2)` 一致，故**缩进场景可直接用
 * `JSON.stringify`**，只有紧凑场景需要本函数。
 *
 * `ensure_ascii=False` 语义：非 ASCII 字符原样输出（JS 的 `JSON.stringify` 本就如此）。
 */

/** 需要转义的字符（与 Python 的 ESCAPE 表一致）。 */
const ESCAPES: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
};

/** 转义字符串（含控制字符走 `\uXXXX`，与 Python 一致）。 */
function encodeString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const escaped = ESCAPES[ch];
    if (escaped !== undefined) {
      out += escaped;
      continue;
    }
    const code = ch.codePointAt(0) as number;
    if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
  }
  return `${out}"`;
}

function encodeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    // Python 默认 allow_nan=True，输出 NaN / Infinity / -Infinity
    if (Number.isNaN(value)) return 'NaN';
    return value > 0 ? 'Infinity' : '-Infinity';
  }
  if (Number.isInteger(value)) return String(value);
  return String(value);
}

function serialize(value: unknown): string {
  if (value === null || value === undefined) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return encodeNumber(value);
    case 'string':
      return encodeString(value);
    case 'bigint':
      return String(value);
    case 'object':
      break;
    default:
      return 'null';
  }

  if (Array.isArray(value)) {
    // Python 的 json 不支持 tuple 但 list 用 ', ' 分隔
    return `[${value.map((item) => serialize(item ?? null)).join(', ')}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => v !== undefined,
  );
  const body = entries
    .map(([key, val]) => `${encodeString(key)}: ${serialize(val ?? null)}`)
    .join(', ');
  return `{${body}}`;
}

/**
 * 等价于 `json.dumps(value, ensure_ascii=False)`（紧凑、带分隔空格）。
 *
 * `undefined` 的键会被跳过（对齐 Python 中不存在该键的情形）。
 */
export function pythonJsonDumps(value: unknown): string {
  return serialize(value);
}
