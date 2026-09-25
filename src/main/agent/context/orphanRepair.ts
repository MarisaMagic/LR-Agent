/**
 * 孤立 `tool_use` 修复。
 *
 * OpenAI / Anthropic 协议都有同一条死规定：**每个 assistant 发起的 `tool_call`
 * 必须有一条对应的 `tool` 消息**。若历史里存在「已声明但无人应答」的调用，
 * 下一次请求会被 API 直接拒收（`tool_call_id` 不匹配）。
 *
 * 何时会出现孤立调用：
 *   1. 模型流完 `tool_call` 后、执行前用户取消 / 网络中断；
 *   2. `tool_pending` 之后客户端 resume，但结果列表里漏了某个调用；
 *   3. 主循环在工具执行途中被 abort。
 *
 * 处理方式对齐 Claude Code 的 `yieldMissingToolResultBlocks`：**合成一条明确标注
 * 为错误的 `tool_result`**，而不是删除调用。这样既不破坏配对，又能让模型知道
 * 「上个工具没跑」，从而自行决定重试或继续。
 *
 * 幂等：对已修复的数组再次调用不会重复补。
 */

import type { ChatMessage } from '../llm/client';
import { buildToolResult, formatToolResultForDisplay } from '../tools/result';

/** 合成结果的状态与文案。 */
export const ORPHAN_TOOL_STATUS = 'not_executed';
export const ORPHAN_TOOL_SUMMARY =
  '该工具未执行（会话中断或结果缺失）。如需继续，请重新发起调用。';

/** 构造一条合成的错误 tool_result 消息。 */
function syntheticToolMessage(id: string, name: string): ChatMessage {
  const display = formatToolResultForDisplay(
    buildToolResult({
      ok: false,
      tool: name,
      status: ORPHAN_TOOL_STATUS,
      summary: ORPHAN_TOOL_SUMMARY,
    }),
  );
  return { role: 'tool', content: display, toolCallId: id };
}

/**
 * 统计并补齐「已声明但未应答」的 tool_call。原地修改并返回同一数组。
 *
 * 关键：合成消息必须**紧跟声明它的 assistant 消息**（在其已有的 tool 结果之后），
 * 而不是追加到数组尾部——否则当孤立调用位于历史中段（后面还有 user 消息）时，
 * `tool` 与其 `tool_calls` 之间会隔着 user 消息，API 仍会拒收。
 */
export function repairOrphanToolCalls(messages: ChatMessage[]): ChatMessage[] {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool' && message.toolCallId) {
      answered.add(message.toolCallId);
    }
  }

  // 按「声明它的 assistant 下标」归组孤立调用
  const orphansByAssistant = new Map<
    number,
    Array<{ id: string; name: string }>
  >();
  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    for (const call of message.toolCalls ?? []) {
      if (!call.id || answered.has(call.id)) continue;
      const list = orphansByAssistant.get(index) ?? [];
      list.push({ id: call.id, name: call.name });
      orphansByAssistant.set(index, list);
    }
  });
  if (orphansByAssistant.size === 0) return messages;

  // 从后往前插入，避免前面的 splice 影响后面的下标
  const assistantIndexes = [...orphansByAssistant.keys()].sort((a, b) => b - a);
  for (const assistantIndex of assistantIndexes) {
    // 插到该 assistant 已直接跟随的 tool 结果之后
    let pos = assistantIndex + 1;
    while (pos < messages.length && messages[pos].role === 'tool') pos += 1;
    const synthetic = (orphansByAssistant.get(assistantIndex) ?? []).map(
      (orphan) => syntheticToolMessage(orphan.id, orphan.name),
    );
    messages.splice(pos, 0, ...synthetic);
  }

  return messages;
}
