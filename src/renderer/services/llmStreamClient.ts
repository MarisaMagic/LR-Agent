import {
  normalizeBaseUrl,
  type LlmProviderConfig,
  type StreamEvent,
} from '../../shared/agentTypes';

function parseSseLines(buffer: string): { events: StreamEvent[]; rest: string } {
  const events: StreamEvent[] = [];
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';

  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') {
      if (payload === '[DONE]') events.push({ type: 'done' });
      continue;
    }

    try {
      const json = JSON.parse(payload) as {
        choices?: Array<{
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
          finish_reason?: string | null;
        }>;
        error?: { message?: string };
      };

      if (json.error?.message) {
        events.push({ type: 'error', message: json.error.message });
        continue;
      }

      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.reasoning_content) {
        events.push({ type: 'reasoning_delta', content: delta.reasoning_content });
      }
      if (delta.content) {
        events.push({ type: 'text_delta', content: delta.content });
      }
      if (delta.tool_calls?.length) {
        for (const toolCall of delta.tool_calls) {
          if (toolCall.id && toolCall.function?.name) {
            events.push({
              type: 'tool_start',
              toolCallId: toolCall.id,
              name: toolCall.function.name,
              arguments: toolCall.function.arguments ?? '',
            });
          } else if (toolCall.function?.arguments) {
            events.push({
              type: 'tool_start',
              toolCallId: toolCall.id ?? `tool-${toolCall.index ?? 0}`,
              name: toolCall.function.name ?? 'tool',
              arguments: toolCall.function.arguments,
            });
          }
        }
      }
    } catch {
      // ignore malformed chunks
    }
  }

  return { events, rest };
}

export async function* streamChatCompletion(
  provider: LlmProviderConfig,
  messages: Array<{ role: string; content: string }>,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const baseUrl = normalizeBaseUrl(provider.baseUrl);
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: provider.model,
      messages,
      stream: true,
    }),
    signal,
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      detail = body.error?.message ?? detail;
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
      const parsed = parseSseLines(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        yield event;
        if (event.type === 'error' || event.type === 'done') return;
      }
    }
    yield { type: 'done' };
  } finally {
    reader.releaseLock();
  }
}

export function canUseLiveStream(provider: LlmProviderConfig): boolean {
  return Boolean(
    provider.enabled &&
      provider.apiKey.trim() &&
      provider.baseUrl.trim() &&
      provider.model.trim(),
  );
}
