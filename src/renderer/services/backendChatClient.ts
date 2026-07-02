import { API_BASE_URL } from '../config';
import type {
  AgentSession,
  ChatContextConfig,
  ChatMessage,
  ClientContextPayload,
  ClientToolResult,
  StreamEvent,
} from '../../shared/agentTypes';
import { DEFAULT_CHAT_CONTEXT_CONFIG as defaultContextConfig } from '../../shared/agentTypes';
import { buildApiClientContext } from './agentClientContext';

export interface BackendChatRequest {
  providerId: string;
  sessionId: string;
  userMessageId: string;
  assistantMessageId: string;
  messages: Array<{ role: string; content: string }>;
  context: {
    summary?: string;
    summaryUpToMessageId?: string;
    config: ChatContextConfig;
  };
  clientJobId: string;
  truncateFromMessageId?: string | null;
  userContent: string;
  clientContext?: ClientContextPayload;
  /** 上轮客户端工具执行结果，resume 时携带 */
  clientToolResults?: ClientToolResult[];
  // Stateless backend fields (provider config from frontend)
  apiKey: string;
  baseUrl: string;
  model: string;
  supportsVision?: boolean;
  systemPrompt?: string;
}

export function buildBackendMessages(
  messageIds: string[],
  sessionMessages: Record<string, ChatMessage>,
): Array<{ role: string; content: string }> {
  return messageIds
    .map((id) => sessionMessages[id])
    .filter((message): message is ChatMessage => Boolean(message))
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => {
      const text = message.blocks
        .filter(
          (block): block is Extract<typeof block, { type: 'text' }> =>
            block.type === 'text',
        )
        .map((block) => block.content)
        .join('\n');
      return { role: message.role, content: text };
    })
    .filter((message) => message.content.trim());
}

export function sessionContextPayload(session: AgentSession): BackendChatRequest['context'] {
  return {
    summary: session.contextSummary,
    summaryUpToMessageId: session.summaryUpToMessageId,
    config: defaultContextConfig,
  };
}

function parseSseBuffer(buffer: string): { events: StreamEvent[]; rest: string } {
  const events: StreamEvent[] = [];
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';

  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload) continue;
    try {
      const json = JSON.parse(payload) as StreamEvent;
      if (json && typeof json === 'object' && 'type' in json) {
        events.push(json);
      }
    } catch {
      // ignore malformed chunks
    }
  }

  return { events, rest };
}

export async function* streamChatViaBackend(
  request: BackendChatRequest,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const body: Record<string, unknown> = {
    api_key: request.apiKey,
    base_url: request.baseUrl,
    model: request.model,
    messages: request.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    user_content: request.userContent,
    client_job_id: request.clientJobId,
  };

  if (request.systemPrompt) {
    body.system_prompt = request.systemPrompt;
  }
  if (request.supportsVision !== undefined) {
    body.supports_vision = request.supportsVision;
  }
  if (request.context.summary) {
    body.context_summary = request.context.summary;
  }
  if (request.context.summaryUpToMessageId) {
    body.context_summary_up_to_message_id = request.context.summaryUpToMessageId;
  }
  if (request.clientContext) {
    body.client_context = buildApiClientContext(request.clientContext);
  }
  if (request.clientToolResults?.length) {
    body.client_tool_results = request.clientToolResults.map((r) => ({
      tool_call_id: r.toolCallId,
      name: r.name,
      result: r.result,
    }));
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/agent/chat/stream`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    yield { type: 'error', message: err instanceof Error ? err.message : '网络请求失败' };
    return;
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const errBody = await response.json();
      detail = errBody?.detail ?? detail;
    } catch {
      // ignore
    }
    yield { type: 'error', message: detail };
    return;
  }

  if (!response.body) {
    yield { type: 'error', message: '响应体为空' };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseBuffer(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        yield event;
        if (event.type === 'done' || event.type === 'error') return;
        if (event.type === 'tool_pending') return;
      }
    }
    if (!signal.aborted) {
      yield { type: 'done' };
    }
  } finally {
    reader.releaseLock();
  }
}
