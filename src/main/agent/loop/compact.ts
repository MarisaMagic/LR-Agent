/**
 * 运行时「被动压缩」（reactive compact）。
 *
 * 仅在**上游以 4xx 拒绝请求（上下文超长）**时触发：把窗口内较旧的对话
 * 摘成一段结构化摘要，替换其占位，再重试原请求。正常请求完全不走这里，
 * 因此对既有协议基线零影响。
 *
 * 与渲染层的 `contextSummarizer` 的分工：
 *   - 渲染层是「主动、按预算」的常规压缩；
 *   - 这里是「被动、按报错」的兜底，只负责把请求救回来。
 *
 * 关键约束：**绝不破坏 tool_call / tool_result 配对**。切分点只落在
 * `user` 消息边界上，保证被保留的尾部自身是一段合法的对话历史。
 */

import type { ChatMessage, LlmClient, MessageContent } from '../llm/client';
import type { AgentSettings } from '../config';
import { AGENT_SUMMARY_SYSTEM_PROMPT } from '../../../shared/agentSummaryPrompt';

/** 被挤出内容送给摘要器时的字符上限（超过则保留靠后的、更相关的部分）。 */
const MAX_EVICTED_CHARS = 80_000;

const SUMMARY_HEADER = '【此前对话摘要（因上下文超长触发压缩）】';

function contentToText(content: MessageContent): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.text : '[图片]'))
    .join('');
}

/** 把被挤出的消息渲染成带角色标注的 transcript。 */
function formatEvicted(messages: ChatMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      lines.push(`[工具结果] ${contentToText(message.content)}`);
      continue;
    }
    if (message.role === 'assistant') {
      const text = contentToText(message.content);
      const calls = (message.toolCalls ?? []).map((c) => c.name).join(', ');
      lines.push(`[助手] ${text}${calls ? ` (调用工具: ${calls})` : ''}`);
      continue;
    }
    if (message.role === 'user') {
      lines.push(`[用户] ${contentToText(message.content)}`);
      continue;
    }
    lines.push(`[系统] ${contentToText(message.content)}`);
  }
  let transcript = lines.join('\n');
  if (transcript.length > MAX_EVICTED_CHARS) {
    transcript = `（更早内容已省略）\n${transcript.slice(-MAX_EVICTED_CHARS)}`;
  }
  return transcript;
}

/**
 * 执行一次被动压缩，返回新的消息数组（不改动入参）。
 *
 * @throws 摘要请求失败 / 返回空内容时抛出，由调用方决定是否放弃重试。
 */
export async function reactiveCompact(params: {
  messages: ChatMessage[];
  llm: LlmClient;
  settings: AgentSettings;
  signal?: AbortSignal;
}): Promise<ChatMessage[]> {
  const { messages } = params;

  // 1) 保留开头的 system 块（系统提示词 + 渲染层摘要），它们不参与挤出。
  let head = 0;
  while (head < messages.length && messages[head].role === 'system') head += 1;
  const headMessages = messages.slice(0, head);
  const conversation = messages.slice(head);

  // 2) 在对话区找一个 user 边界作切分点，只保留末尾若干完整轮次。
  //
  // 先从「保留末尾 keepCount 条」的朴素切点出发；若该点落在某轮内部
  // （assistant/tool 中间），**向后**找最近的下一个 user 边界——这样被保留的
  // 尾部仍以完整轮次开始。只有当后方不存在 user 边界时，才回退向前找。
  // 两头都无（或切完无内容）则视为不可压缩。
  const keepCount = Math.max(2, params.settings.reactiveCompactKeepTurns) * 2;
  let cut = Math.max(0, conversation.length - keepCount);
  if (cut > 0 && conversation[cut]?.role !== 'user') {
    let forward = cut;
    while (
      forward < conversation.length &&
      conversation[forward].role !== 'user'
    ) {
      forward += 1;
    }
    if (forward < conversation.length) {
      cut = forward;
    } else {
      while (cut > 0 && conversation[cut].role !== 'user') cut -= 1;
    }
  }
  if (cut <= 0 || cut >= conversation.length) return messages; // 无可挤出的完整轮次

  const evicted = conversation.slice(0, cut);
  const kept = conversation.slice(cut);
  if (evicted.length === 0) return messages;

  const transcript = formatEvicted(evicted);

  const turn = await params.llm.completeChat({
    messages: [
      { role: 'system', content: AGENT_SUMMARY_SYSTEM_PROMPT },
      { role: 'user', content: transcript },
    ],
    temperature: 0.2,
    maxTokens: 2048,
    signal: params.signal,
  });
  const summary = turn.content.trim();
  if (!summary) throw new Error('压缩摘要返回空内容');

  // 3) 把摘要并入最后一条 system 消息（保持消息序列合法，避免中途插入 system）。
  const header = `\n\n${SUMMARY_HEADER}\n${summary}`;
  const outHead = headMessages.slice();
  if (outHead.length > 0) {
    const last = outHead[outHead.length - 1];
    const content =
      typeof last.content === 'string'
        ? `${last.content}${header}`
        : // 保留既有部件（含图片），仅在末尾追加文本部件
          [...last.content, { type: 'text' as const, text: header }];
    outHead[outHead.length - 1] = { ...last, content };
  } else {
    outHead.push({ role: 'system', content: `${SUMMARY_HEADER}\n${summary}` });
  }

  return [...outHead, ...kept];
}
