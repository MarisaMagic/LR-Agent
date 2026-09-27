/**
 * @jest-environment node
 *
 * 需要 Node 全局 `Response` 来伪造 fetch 响应（jsdom 不提供）。
 */
import { LlmClient, type LlmUsage } from './client';

function sseResponse(frames: string[]): Response {
  return new Response(`data: ${frames.join('\n\ndata: ')}\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) {
    // 消费流即可
  }
}

describe('LlmClient usage 埋点', () => {
  it('无 onUsage 时不发送 stream_options，也不回调', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return sseResponse([
        JSON.stringify({
          choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
        }),
        JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        '[DONE]',
      ]);
    }) as unknown as typeof fetch;

    const client = new LlmClient({
      apiKey: 'k',
      baseUrl: 'http://mock/v1',
      model: 'm',
      fetchImpl,
    });
    await drain(
      client.streamChat({ messages: [{ role: 'user', content: 'hi' }] }),
    );

    expect(bodies).toHaveLength(1);
    expect(bodies[0].stream_options).toBeUndefined();
  });

  it('流式：请求 include_usage 并回调用量', async () => {
    const usages: Array<{ usage: LlmUsage; model: string; stream: boolean }> =
      [];
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return sseResponse([
        JSON.stringify({
          choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
        }),
        JSON.stringify({
          choices: [],
          usage: {
            prompt_tokens: 120,
            completion_tokens: 30,
            total_tokens: 150,
            completion_tokens_details: { reasoning_tokens: 12 },
          },
        }),
        '[DONE]',
      ]);
    }) as unknown as typeof fetch;

    const client = new LlmClient({
      apiKey: 'k',
      baseUrl: 'http://mock/v1',
      model: 'deepseek-chat',
      fetchImpl,
      onUsage: (usage, context) => {
        usages.push({ usage, ...context });
      },
    });
    await drain(
      client.streamChat({ messages: [{ role: 'user', content: 'hi' }] }),
    );

    expect(bodies).toHaveLength(1);
    expect(bodies[0].stream_options).toEqual({ include_usage: true });
    expect(usages).toHaveLength(1);
    expect(usages[0]).toEqual({
      usage: {
        promptTokens: 120,
        completionTokens: 30,
        totalTokens: 150,
        reasoningTokens: 12,
      },
      model: 'deepseek-chat',
      stream: true,
    });
  });

  it('非流式：从响应体回调用量', async () => {
    const usages: LlmUsage[] = [];
    const fetchImpl = (async () =>
      jsonResponse({
        choices: [
          {
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
      })) as unknown as typeof fetch;

    const client = new LlmClient({
      apiKey: 'k',
      baseUrl: 'http://mock/v1',
      model: 'm',
      fetchImpl,
      onUsage: (usage) => usages.push(usage),
    });
    const turn = await client.completeChat({
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(turn.content).toBe('ok');
    expect(usages).toEqual([
      {
        promptTokens: 5,
        completionTokens: 6,
        totalTokens: 11,
        reasoningTokens: undefined,
      },
    ]);
  });
});
