/** Shared LLM API call utility for annotation generation pipelines. */

export interface LlmCallOptions {
  providerId: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** Optional base64-encoded image for vision models */
  imageBase64?: string;
  imageMimeType?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmCallResult {
  ok: boolean;
  content: string;
  error?: string;
}

export async function callLlmApi(options: LlmCallOptions): Promise<LlmCallResult> {
  const url = `${options.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const messages: object[] = [
    { role: 'system', content: options.systemPrompt },
  ];

  if (options.imageBase64) {
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: options.userPrompt,
        },
        {
          type: 'image_url',
          image_url: {
            url: `data:${options.imageMimeType || 'image/jpeg'};base64,${options.imageBase64}`,
          },
        },
      ],
    });
  } else {
    messages.push({ role: 'user', content: options.userPrompt });
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages,
        temperature: options.temperature ?? 0.3,
        max_tokens: options.maxTokens ?? 4096,
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return { ok: false, content: '', error: `API 错误 ${response.status}: ${errText.slice(0, 200)}` };
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content ?? '';
    return { ok: true, content };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, content: '', error: '已取消' };
    }
    return {
      ok: false,
      content: '',
      error: err instanceof Error ? err.message : 'LLM 调用失败',
    };
  }
}
