/**
 * 阶段 0 行为基线：SSE 事件序列归一化。
 *
 * 抓取到的原始事件里含有每次运行都会变化的字段（工具调用 id 等），直接 diff 会
 * 产生噪声。归一化把易变字段替换为按出现顺序编号的稳定占位符，并规范化对象键顺序，
 * 使同一输入在 Python / Node 两种实现下产出**可直接 diff** 的序列。
 *
 * 归一化是**有状态**的：同一个 tool_call id 在整条序列中映射到同一个占位符。
 */

/** 需要按出现顺序做 id 归一化的字段名。 */
const ID_FIELDS = ['toolCallId', 'innerToolCallId'];

/** 递归规范化：对象键排序、数组保序。 */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

/**
 * 对单个事件做字段级归一化（不含 id 映射，映射由调用方维护）。
 *
 * @param {Record<string, unknown>} event
 * @param {Map<string, string>} idMap
 */
function normalizeEvent(event, idMap) {
  const out = JSON.parse(JSON.stringify(event));

  const mapId = (raw) => {
    if (typeof raw !== 'string' || raw === '') return raw;
    if (!idMap.has(raw)) idMap.set(raw, `<tc:${idMap.size}>`);
    return idMap.get(raw);
  };

  for (const field of ID_FIELDS) {
    if (field in out) out[field] = mapId(out[field]);
  }

  // tool_pending 的 clientToolCalls / toolCalls 双写里也含 id
  for (const field of ['clientToolCalls', 'toolCalls']) {
    if (Array.isArray(out[field])) {
      out[field] = out[field].map((call) => ({
        ...call,
        toolCallId: mapId(call.toolCallId),
      }));
    }
  }

  return sortDeep(out);
}

/**
 * 归一化一整条事件序列。
 *
 * @param {Array<Record<string, unknown>>} events 解析后的 SSE 事件对象数组
 * @returns {Array<Record<string, unknown>>}
 */
export function normalizeEvents(events) {
  const idMap = new Map();
  return events.map((e) => normalizeEvent(e, idMap));
}

/**
 * 把原始 SSE 文本解析为事件对象数组。
 *
 * 只认 `data:` 行，与渲染层解析器保持一致。
 *
 * @param {string} text
 * @returns {Array<Record<string, unknown>>}
 */
export function parseSse(text) {
  const events = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      // 与渲染层一致：畸形分片忽略
    }
  }
  return events;
}

/** 供 diff 使用的稳定序列化（每行一个事件）。 */
export function serializeEvents(events) {
  return events.map((e) => JSON.stringify(e)).join('\n');
}
