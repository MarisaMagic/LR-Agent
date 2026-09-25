/**
 * 运行时的消息 token 估算（粗略，中英混合按 chars/3 折算）。
 *
 * 与渲染层 `contextPreparer.estimateTokens` 保持同一启发式，避免两侧口径不一致。
 * 仅用于「是否触发循环内 microcompact」的决策，不追求精确。
 */

import type { ChatMessage, MessageContent } from '../llm/client';

/** 单张图片的等效字符开销（保守估计，避免图片型历史被严重低估）。 */
const IMAGE_EQUIV_CHARS = 3_000;

function contentChars(content: MessageContent): number {
  if (typeof content === 'string') return content.length;
  let total = 0;
  for (const part of content) {
    if (part.type === 'text') total += part.text.length;
    else total += IMAGE_EQUIV_CHARS;
  }
  return total;
}

/** 估算一组消息的总 token 数。 */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += contentChars(message.content);
    for (const call of message.toolCalls ?? []) {
      chars += call.name.length;
      try {
        chars += JSON.stringify(call.args ?? {}).length;
      } catch {
        /* 循环引用等异常忽略，不影响估算 */
      }
    }
  }
  return Math.ceil(chars / 3);
}
