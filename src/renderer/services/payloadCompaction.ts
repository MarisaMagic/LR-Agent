/**
 * 渲染层发请求前的 payload 级上下文治理。
 *
 * 与主进程运行时共享 `src/shared/microCompact.ts` 的计划逻辑：
 *   - estimatePayloadTokens：把工具消息（tool_calls / tool 结果）也算进去的估算
 *   - microCompactPayload：软线本地清理（占位符替换可重取的旧工具结果）
 *   - applySoftLineBudget：超软线才清理的统一入口
 */

import {
  MICRO_COMPACT_KEEP_RECENT_DEFAULT,
  MICRO_COMPACT_PLACEHOLDER,
  MICRO_COMPACT_SOFT_RATIO,
  planMicroCompact,
} from '../../shared/microCompact';

/** 兼容 BackendChatMessage 与 TurnHistoryMessage 的最小形状。 */
export interface PayloadMessage {
  role: string;
  content: string;
  tool_calls?: Array<{ id?: string; name?: string; args?: unknown }>;
  tool_call_id?: string;
}

/** 粗略 token 估算：中英混合按 chars/3 折算（与主进程口径一致）。 */
export function estimatePayloadTokens(messages: PayloadMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += typeof message.content === 'string' ? message.content.length : 0;
    for (const call of message.tool_calls ?? []) {
      chars += (call.name ?? '').length;
      try {
        chars += JSON.stringify(call.args ?? {}).length;
      } catch {
        // 循环引用等异常忽略，不影响估算
      }
    }
  }
  return Math.ceil(chars / 3);
}

/**
 * 对 payload 做一次微压缩。返回新数组；无需清理时原引用返回。
 */
export function microCompactPayload<T extends PayloadMessage>(
  messages: T[],
  options: { keepRecent?: number } = {},
): { messages: T[]; replaced: number } {
  const clear = planMicroCompact(
    messages.map((message) => ({
      role: message.role,
      content: message.content,
      toolCallId: message.tool_call_id,
      toolCalls: message.tool_calls?.map((call) => ({
        id: call.id,
        name: call.name,
      })),
    })),
    { keepRecent: options.keepRecent ?? MICRO_COMPACT_KEEP_RECENT_DEFAULT },
  );
  if (clear.size === 0) return { messages, replaced: 0 };

  let replaced = 0;
  const out = messages.map((message) => {
    if (message.role !== 'tool') return message;
    if (!message.tool_call_id || !clear.has(message.tool_call_id)) {
      return message;
    }
    replaced += 1;
    return { ...message, content: MICRO_COMPACT_PLACEHOLDER };
  });
  return { messages: out, replaced };
}

/** 超软线才清理；否则原样返回（引用不变）。 */
export function applySoftLineBudget<T extends PayloadMessage>(
  messages: T[],
  budgetTokens: number | undefined,
): T[] {
  if (!budgetTokens || budgetTokens <= 0) return messages;
  if (
    estimatePayloadTokens(messages) <=
    budgetTokens * MICRO_COMPACT_SOFT_RATIO
  ) {
    return messages;
  }
  return microCompactPayload(messages).messages;
}
