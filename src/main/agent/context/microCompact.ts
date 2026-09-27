/**
 * 循环内 microcompact：本地、零 API 的上下文瘦身（主进程运行时侧）。
 *
 * 核心计划逻辑在 `src/shared/microCompact.ts`，与渲染层发请求前管线同源；
 * 这里只做 `ChatMessage` 的适配与应用（原地修改 content）。
 */

import type { ChatMessage } from '../llm/client';
import {
  MICRO_COMPACT_PLACEHOLDER,
  RE_RETRIEVABLE_TOOLS,
  planMicroCompact,
} from '../../../shared/microCompact';

export { MICRO_COMPACT_PLACEHOLDER, RE_RETRIEVABLE_TOOLS };

/**
 * 清理旧的可重取工具结果，返回被清理的条数（原地修改）。
 *
 * @param keepRecent 保留最近多少条工具结果不清理
 */
export function microCompactMessages(
  messages: ChatMessage[],
  options: { keepRecent: number },
): number {
  const clear = planMicroCompact(
    messages.map((message) => ({
      role: message.role,
      content: message.content,
      toolCallId: message.toolCallId,
      toolCalls: message.toolCalls?.map((call) => ({
        id: call.id,
        name: call.name,
      })),
    })),
    options,
  );
  if (clear.size === 0) return 0;

  let replaced = 0;
  messages.forEach((message, index) => {
    if (message.role !== 'tool') return;
    if (!message.toolCallId || !clear.has(message.toolCallId)) return;
    messages[index] = { ...message, content: MICRO_COMPACT_PLACEHOLDER };
    replaced += 1;
  });

  return replaced;
}
