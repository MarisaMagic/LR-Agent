/**
 * 微压缩共享核心（渲染层发请求前管线与主进程运行时同源）。
 *
 * 当会话预算逼近软线时，把**较旧的、可重取的**工具结果内容替换为占位符，
 * 只保留最近 N 条。完整的 `tool_call / tool_result` 配对始终保留（消息还在，
 * 只是内容变短），因此不会破坏 API 协议。
 *
 * 绝不清理：
 *   - 不可重取的结果（子代理结论、客户端工具结果、标注/写入提案等）；
 *   - 最近 N 条工具结果（通常是当前任务正在用的）。
 *
 * 需要回原始内容时，模型可重新调用对应只读工具（见 `RE_RETRIEVABLE_TOOLS`）。
 */

/** 被清理的工具结果占位文本。 */
export const MICRO_COMPACT_PLACEHOLDER =
  '[较早的工具结果已清理以节省上下文。如仍需该内容，请重新调用对应工具获取。]';

/** 可重取、纯文本输出的只读工具（工具名必须与注册表一致）。 */
export const RE_RETRIEVABLE_TOOLS: ReadonlySet<string> = new Set<string>([
  'read_workspace_file',
  'read_document_file',
  'grep_workspace',
  'glob_workspace',
  'list_workspace_directory',
]);

/** 默认保留的最近工具结果条数。 */
export const MICRO_COMPACT_KEEP_RECENT_DEFAULT = 5;

/** 软线：会话预算占比，超过才做本地清理（与主进程运行时口径一致）。 */
export const MICRO_COMPACT_SOFT_RATIO = 0.7;

/** 归一化后的消息形状：兼容主进程 camelCase 与渲染层 snake_case。 */
export interface MicroCompactMessageShape {
  role: string;
  content: unknown;
  toolCallId?: string;
  toolCalls?: Array<{ id?: string; name?: string }>;
}

/**
 * 计算本次应清理哪些 tool_call_id（纯函数，不改动入参）。
 *
 * @param keepRecent 保留最近多少条工具结果不清理
 */
export function planMicroCompact(
  messages: MicroCompactMessageShape[],
  options: { keepRecent: number },
): Set<string> {
  // tool_call_id → 工具名（用于判断是否可重取）
  const nameByCallId = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      if (call.id) nameByCallId.set(call.id, call.name ?? '');
    }
  }

  const toolIndexes: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === 'tool') toolIndexes.push(index);
  });

  const keep = Math.max(0, Math.floor(options.keepRecent));
  const cutoff = toolIndexes.length - keep;
  const clear = new Set<string>();

  for (let k = 0; k < cutoff; k += 1) {
    const message = messages[toolIndexes[k]];
    const name = message.toolCallId
      ? nameByCallId.get(message.toolCallId)
      : undefined;
    if (!name || !RE_RETRIEVABLE_TOOLS.has(name)) continue;
    // 只清理字符串内容；多模态等保持原样
    if (typeof message.content !== 'string') continue;
    if (message.content === MICRO_COMPACT_PLACEHOLDER) continue;
    if (message.toolCallId) clear.add(message.toolCallId);
  }

  return clear;
}
