import { API_BASE_URL } from '../config';
import type {
  AgentSession,
  ChatContextConfig,
  ChatMessage,
  ClientContextPayload,
  StreamEvent,
} from '../../shared/agentTypes';
import { DEFAULT_CHAT_CONTEXT_CONFIG as defaultContextConfig } from '../../shared/agentTypes';
import tokenHolder from './tokenHolder';

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
  const accessToken = tokenHolder.getAccessToken();
  if (!accessToken) {
    yield { type: 'error', message: 'not_authenticated' };
    return;
  }

  const body = {
    provider_id: request.providerId,
    session_id: request.sessionId,
    client_job_id: request.clientJobId,
    user_message_id: request.userMessageId,
    assistant_message_id: request.assistantMessageId,
    user_content: request.userContent,
    truncate_from_message_id: request.truncateFromMessageId ?? null,
    messages: request.messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
    context: {
      summary: request.context.summary,
      summary_up_to_message_id: request.context.summaryUpToMessageId,
      config: {
        max_context_tokens: request.context.config.maxContextTokens,
        reserve_completion_tokens: request.context.config.reserveCompletionTokens,
        max_turns_in_window: request.context.config.maxTurnsInWindow,
        summarize_trigger_ratio: request.context.config.summarizeTriggerRatio,
        min_turns_before_summarize: request.context.config.minTurnsBeforeSummarize,
      },
    },
    client_context: request.clientContext
      ? {
          workspace_root: request.clientContext.workspaceRoot ?? null,
          active_file_path: request.clientContext.activeFilePath ?? null,
          active_annotation_project_id:
            request.clientContext.activeAnnotationProjectId ?? null,
        }
      : undefined,
  };

  const response = await fetch(`${API_BASE_URL}/agent/chat/stream`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const errBody = (await response.json()) as { detail?: string };
      detail = errBody.detail ?? detail;
    } catch {
      // ignore
    }
    yield { type: 'error', message: detail || '请求失败' };
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
        if (event.type === 'error' || event.type === 'done') return;
      }
    }
    if (!signal.aborted) {
      yield { type: 'done' };
    }
  } finally {
    reader.releaseLock();
  }
}
