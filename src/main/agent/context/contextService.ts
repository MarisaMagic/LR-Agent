/**
 * 对话上下文服务：Assist resume 注入与纯对话系统提示词。
 *
 * 移植自 `vendor/local-agent/app/agent/context_service.py`。
 *
 * `appendClientToolResultsToMessages` 的「补造 AIMessage」分支是 resume 正确性的关键：
 * 客户端工具执行完回传结果时，历史里可能**没有**对应的 AIMessage（例如客户端多执行了
 * 一个运行时没声明的调用）；此时必须先补一条带 tool_calls 的 AIMessage，
 * 否则模型会报 `tool_call_id` 不匹配。
 */

import type { ChatMessage } from '../llm/client';

/** 纯对话（无工具）路径的默认系统提示词。 */
export const CHAT_SYSTEM_PROMPT =
  '在 LR-Agent 系统内回答用户问题。结合【你的身份】中的模型信息作答，勿自称独立产品助手或其它未配置的模型。';

export const RESUME_NEXT_HINT =
  '客户端工具已结束。不要重复调用刚才同一个 tool_call。' +
  '若 proposal_pending=true：提案未 Keep All、未写盘，不要声称已标注/已删除/已写入。' +
  '改或删已有标注必须调用 mutate_annotation。' +
  '若还要给其他文件做新标注，再调用 auto_annotate 并传入新的 paths。' +
  '不要 memory_write progress.md 或 annotated-files.md。';

export const RESUME_APPLIED_NEXT_HINT =
  '客户端工具已结束，用户已 Keep All：提案已写盘，file_written=true。' +
  '可用 read_file_annotation 核对落盘结果；如任务要求报告，用 write_workspace_file 生成。' +
  '报告中的每个数字必须来自工具返回或提案明细，禁止估算。' +
  '不要对已写盘文件重复调用 auto_annotate 整文件重标；' +
  '核对发现错标/漏标/重复框时，用 mutate_annotation 定向修正（带上 paths 或 annotation_ids）。' +
  '提案已确认落盘，禁止再要求用户确认、Keep All 或查看提案。' +
  '不要 memory_write progress.md 或 annotated-files.md。';

export interface ClientToolResultInput {
  toolCallId: string;
  name: string;
  result: string;
}

/**
 * 找出「已声明但未应答」的 tool_call id。
 *
 * 用于判断客户端回传的结果是否需要补造 AIMessage。
 */
export function unansweredToolCallIds(messages: ChatMessage[]): Set<string> {
  const declared = new Set<string>();
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        if (call.id) declared.add(call.id);
      }
    } else if (message.role === 'tool' && message.toolCallId) {
      answered.add(message.toolCallId);
    }
  }
  for (const id of answered) declared.delete(id);
  return declared;
}

/**
 * 为 resume 的客户端工具结果补上 `next_hint`（已有则保留）。
 *
 * `proposalsApplied`（用户已 Keep All）时同步修正 `proposal_pending` / `file_written`，
 * 避免模型把已落盘提案误判为未确认。
 */
export function enrichResumeToolResult(
  result: string,
  options: { proposalsApplied?: boolean } = {},
): string {
  let data: unknown;
  try {
    data = JSON.parse(result);
  } catch {
    return result;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return result;
  const record = data as Record<string, unknown>;

  // 谎报防护：skipped / 未生成提案的 mutate（Dismiss 后或被门禁拦下）不能标成已写盘
  if (options.proposalsApplied && record.proposal_pending === true) {
    record.proposal_pending = false;
    record.file_written = true;
    record.next_hint = RESUME_APPLIED_NEXT_HINT;
  } else if (!String(record.next_hint ?? '').trim()) {
    record.next_hint = RESUME_NEXT_HINT;
  }
  return JSON.stringify(record);
}

/**
 * Resume 时补齐客户端工具的 ToolMessage。
 *
 * 已有对应 AIMessage 时直接补 ToolMessage；否则先补造 AIMessage 再补 ToolMessage。
 */
export function appendClientToolResultsToMessages(
  messages: ChatMessage[],
  clientToolResults: ClientToolResultInput[],
  options: { userContent?: string; proposalsApplied?: boolean } = {},
): ChatMessage[] {
  if (!clientToolResults.length) return messages;

  const unanswered = unansweredToolCallIds(messages);

  for (const ctr of clientToolResults) {
    const result = enrichResumeToolResult(ctr.result, {
      proposalsApplied: options.proposalsApplied,
    });

    if (unanswered.has(ctr.toolCallId)) {
      messages.push({ role: 'tool', content: result, toolCallId: ctr.toolCallId });
      unanswered.delete(ctr.toolCallId);
      continue;
    }

    // 历史里没有对应 AIMessage：补造一条，保证 tool_call_id 有归属
    const args: Record<string, unknown> = {
      user_request: (options.userContent ?? '').trim(),
    };
    try {
      const parsed = JSON.parse(ctr.result);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const userRequest = (parsed as Record<string, unknown>).user_request;
        if (userRequest) args.user_request = String(userRequest);
      }
    } catch {
      /* 解析失败时保留默认 args */
    }

    messages.push({
      role: 'assistant',
      content: '',
      toolCalls: [{ id: ctr.toolCallId, name: ctr.name, args }],
    });
    messages.push({ role: 'tool', content: result, toolCallId: ctr.toolCallId });
  }

  return messages;
}
