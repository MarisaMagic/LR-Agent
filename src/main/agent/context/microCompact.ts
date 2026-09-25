/**
 * 循环内 microcompact：本地、零 API 的上下文瘦身。
 *
 * 当单轮工具结果累积逼近预算时，把**较旧的、可重取的**工具结果内容替换为占位符，
 * 只保留最近 N 条。完整的 `tool_call / tool_result` 配对**始终保留**（消息还在，
 * 只是内容变短），因此不会破坏 API 协议。
 *
 * 绝不清理：
 *   - 不可重取的结果（子代理结论、客户端工具结果等）；
 *   - 最近 N 条工具结果（通常是当前任务正在用的）。
 *
 * 需要回原始内容时，模型可重新调用对应只读工具（见 `RE_RETRIEVABLE_TOOLS`）。
 */

import type { ChatMessage } from '../llm/client';
import { RE_RETRIEVABLE_TOOLS } from '../tools/resultOffload';

/** 被清理的工具结果占位文本。 */
export const MICRO_COMPACT_PLACEHOLDER =
  '[较早的工具结果已清理以节省上下文。如仍需该内容，请重新调用对应工具获取。]';

/**
 * 清理旧的可重取工具结果，返回被清理的条数（原地修改）。
 *
 * @param keepRecent 保留最近多少条工具结果不清理
 */
export function microCompactMessages(
  messages: ChatMessage[],
  options: { keepRecent: number },
): number {
  // tool_call_id → 工具名（用于判断是否可重取）
  const nameByCallId = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      if (call.id) nameByCallId.set(call.id, call.name);
    }
  }

  const toolIndexes: number[] = [];
  messages.forEach((message, index) => {
    if (message.role === 'tool') toolIndexes.push(index);
  });

  const keep = Math.max(0, Math.floor(options.keepRecent));
  const cutoff = toolIndexes.length - keep;
  let replaced = 0;

  for (let k = 0; k < cutoff; k += 1) {
    const index = toolIndexes[k];
    const message = messages[index];
    const name = message.toolCallId
      ? nameByCallId.get(message.toolCallId)
      : undefined;
    if (!name || !RE_RETRIEVABLE_TOOLS.has(name)) continue;
    if (message.content === MICRO_COMPACT_PLACEHOLDER) continue;
    // 只清理字符串内容；多模态等保持原样
    if (typeof message.content !== 'string') continue;
    messages[index] = { ...message, content: MICRO_COMPACT_PLACEHOLDER };
    replaced += 1;
  }

  return replaced;
}
