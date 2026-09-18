/**
 * 统一工具结果结构。
 *
 * 移植自 `vendor/local-agent/app/agent/tools/tool_result.py`。
 *
 * 两条输出路径的差异是**既成事实**，不要统一（见协议文档 §5.4）：
 *   - `buildToolResult` 产出带 `summary` 的 JSON，回灌给模型的 `ToolMessage`
 *     走 `formatToolResultForDisplay`，因此实际只回 `summary` 文本
 *   - 子代理内部回灌的是**原文**（不经 `formatToolResultForDisplay`）
 *
 * 少数只读工具（如 `list_workspace_directory`、`grep_workspace`）直接返回纯文本，
 * 不经 `buildToolResult` 包装；此时 `formatToolResultForDisplay` 原样返回。
 */

/** 生成统一工具结果 JSON。`file_written` / `proposal_pending` 默认 false。 */
export function buildToolResult(params: {
  ok: boolean;
  tool: string;
  status: string;
  summary: string;
  [extra: string]: unknown;
}): string {
  const { ok, tool, status, summary, ...rest } = params;
  const payload: Record<string, unknown> = {
    ok,
    tool,
    status,
    summary,
    file_written: rest.file_written ?? false,
    proposal_pending: rest.proposal_pending ?? false,
  };
  delete rest.file_written;
  delete rest.proposal_pending;
  Object.assign(payload, rest);
  return JSON.stringify(payload);
}

/**
 * 将工具结果格式化为 UI / 模型可读摘要。
 *
 * 规则：非 JSON → 原样；JSON 非对象 → 原样；有 `summary` → 只取 `summary`；
 * 否则有 `message` → 取 `message`；否则原样。
 */
export function formatToolResultForDisplay(resultText: string): string {
  let data: unknown;
  try {
    data = JSON.parse(resultText);
  } catch {
    return resultText;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return resultText;
  const record = data as Record<string, unknown>;
  if (record.summary) return String(record.summary);
  if (record.message) return String(record.message);
  return resultText;
}

/** 解析工具结果 JSON；非对象返回 null。 */
export function parseToolResult(resultText: string): Record<string, unknown> | null {
  try {
    const data = JSON.parse(resultText);
    return data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 工具结果中的内部字段名（不在 UI 展示，供调度层消费）。 */
export const VISION_PATH_MARKER = '__vision_image_path__';
export const DOC_PROPOSAL_MARKER = '__doc_proposal__';

/**
 * 剥离内部标记字段，得到可发给前端的显示文本。
 *
 * 仅 `read_image_for_vision` 用到 `VISION_PATH_MARKER`；其余工具无标记，原样返回。
 */
export function stripInternalMarkers(resultText: string): string {
  const parsed = parseToolResult(resultText);
  if (!parsed) return resultText;
  if (!(VISION_PATH_MARKER in parsed)) return resultText;
  const { [VISION_PATH_MARKER]: _removed, ...rest } = parsed;
  return JSON.stringify(rest);
}

/** 从视觉工具结果中提取图片绝对路径；无标记时返回空串。 */
export function extractVisionPath(resultText: string): string {
  const parsed = parseToolResult(resultText);
  const value = parsed?.[VISION_PATH_MARKER];
  return typeof value === 'string' ? value : '';
}
