/**
 * OpenAI 兼容的 LLM 客户端。
 *
 * 迁移自 Python 侧对 `langchain_openai.ChatOpenAI` 的使用，但**不引入任何 LLM SDK**：
 * 项目只需要一个 OpenAI 兼容端点（provider 差异全部由 `baseURL` 吸收），
 * 直接用 `fetch` 手写流式解析即可，与渲染层 `localChatClient.ts` 的做法一致。
 *
 * 对齐的既有行为（见协议文档 §11）：
 *   - `temperature` 0.7、`timeout` 120s、`streaming` true（主/辅助模型一致）
 *   - provider 差异：`reasoning_content` 增量需透传（DeepSeek 等）
 *   - `tool_choice="any"` 用于强制模型真正发起 tool_call（非流式）
 *
 * 这里**不做**任何消息裁剪、prompt 组装或工具语义处理——那些属于 loop / context 层。
 * 本模块只负责「把请求发出去、把增量取回来」。
 */

/* eslint-disable max-classes-per-file -- 本文件是单一协议层模块：
 * `LlmRequestError`（错误契约）、`LlmClient`（请求/流式解析）、
 * `ToolCallAccumulator`（流式 tool_call 分片累积）三者互相耦合
 * （客户端抛错误、并靠累积器拼参数），拆文件只会把这份契约切碎，
 * 反而降低可读性。 */

/** 消息内容可以是纯文本，或多模态部件数组。 */
export type MessageContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string } }
    >;

export interface ChatToolCall {
  id: string;
  name: string;
  /** 已解析的参数对象（解析失败时为 `{}`）。 */
  args: Record<string, unknown>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: MessageContent;
  /** 仅 assistant：该轮发起的工具调用。 */
  toolCalls?: ChatToolCall[];
  /** 仅 tool：对应的 tool_call id。 */
  toolCallId?: string;
}

/** 发给 API 的工具声明（OpenAI function calling 格式）。 */
export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 流式增量。 */
export interface LlmDelta {
  content?: string;
  reasoning?: string;
  /** 原始 tool_call 分片，由累积器按 index 合并。 */
  toolCallChunks?: Array<{
    index: number;
    id?: string;
    name?: string;
    argsFragment?: string;
  }>;
  finishReason?: string | null;
}

/** 累积后的 assistant 轮次。 */
export interface AssistantTurn {
  content: string;
  reasoning: string;
  toolCalls: ChatToolCall[];
}

export interface LlmClientOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 默认 120s（对齐 Python 侧 `ChatOpenAI(timeout=120)`）。 */
  timeoutMs?: number;
  /** 默认 0.7（对齐 Python 侧）。 */
  temperature?: number;
  /** 测试注入点。 */
  fetchImpl?: typeof fetch;
  /** 网络层失败重试次数（默认 2，即最多 3 次尝试）。 */
  maxRetries?: number;
  /** 重试退避基数（毫秒，默认 300）。 */
  retryBaseDelayMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 300;

/**
 * 判定错误体是否表示「上下文超长」。
 *
 * 不同 provider 的措辞差异很大（OpenAI `context_length_exceeded`、
 * Anthropic `prompt is too long`、DeepSeek `maximum context length` 等），
 * 因此按关键词宽匹配；仅在上层确实要「压缩后重试」时才使用，误判的代价
 * 是压缩一次而非崩溃，可接受。
 */
export function isContextLengthExceededBody(body: string): boolean {
  return /context[_ ]?length|maximum context|context window|prompt is too long|prompt too long|too many tokens|reduce the length|exceeds? the (maximum )?context|输入.{0,4}(过长|超长)|上下文.{0,4}(过长|超长)/i.test(
    body,
  );
}

/** 调用失败时抛出，携带 HTTP 状态与响应体片段以便上层分流。 */
export class LlmRequestError extends Error {
  readonly status: number;

  readonly body: string;

  /** 是否为「上下文超长」类错误（触发运行时压缩重试的依据）。 */
  readonly isContextLengthExceeded: boolean;

  constructor(status: number, body: string) {
    super(`LLM 请求失败 HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = 'LlmRequestError';
    this.status = status;
    this.body = body;
    this.isContextLengthExceeded =
      (status === 400 || status === 413 || status === 422) &&
      isContextLengthExceededBody(body);
  }
}

/**
 * 仅「未收到任何响应」的网络层错误可重试；取消/超时/HTTP 状态码错误一律不重试。
 *
 * - `LlmRequestError` 表示已拿到 4xx/5xx 响应，重试大概率相同，跳过。
 * - 沿 cause 链排查：某些 Node 版本会把 AbortError/TimeoutError 包成
 *   `TypeError: fetch failed`，必须逐层看 cause，否则会把取消/超时误判成可重试。
 */
function isRetryableNetworkError(err: unknown): boolean {
  if (err instanceof LlmRequestError) return false;
  if (!(err instanceof Error)) return false;

  let cur: unknown = err;
  for (let depth = 0; cur && depth < 4; depth += 1) {
    const e = cur as Error;
    if (e.name === 'AbortError' || e.name === 'TimeoutError') return false;
    cur = e.cause;
  }
  return true;
}

export class LlmClient {
  private readonly options: Required<
    Pick<
      LlmClientOptions,
      | 'apiKey'
      | 'baseUrl'
      | 'model'
      | 'timeoutMs'
      | 'temperature'
      | 'maxRetries'
      | 'retryBaseDelayMs'
    >
  >;

  private readonly fetchImpl: typeof fetch;

  constructor(options: LlmClientOptions) {
    this.options = {
      apiKey: options.apiKey,
      // Python 侧对 base_url 做了 rstrip('/')
      baseUrl: options.baseUrl.replace(/\/+$/, ''),
      model: options.model,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    };
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 组装请求体。子类/测试可据此断言线格式。 */
  private buildBody(params: {
    messages: ChatMessage[];
    tools?: ToolSpec[];
    toolChoice?: 'auto' | 'any' | 'none';
    stream: boolean;
    maxTokens?: number;
    temperature?: number;
  }): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.options.model,
      messages: params.messages.map(serializeMessage),
      stream: params.stream,
      temperature: params.temperature ?? this.options.temperature,
    };
    if (params.tools?.length) {
      body.tools = params.tools;
      if (params.toolChoice) body.tool_choice = params.toolChoice;
    }
    if (params.maxTokens != null) body.max_tokens = params.maxTokens;
    return body;
  }

  private async post(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const { maxRetries } = this.options;
    const baseDelay = this.options.retryBaseDelayMs;

    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        this.options.timeoutMs,
      );
      // 上游取消也要能中断请求
      const onAbort = (): void => controller.abort();
      signal?.addEventListener('abort', onAbort);

      try {
        const res = await this.fetchImpl(
          `${this.options.baseUrl}/chat/completions`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${this.options.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          },
        );
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new LlmRequestError(res.status, text);
        }
        return res;
      } catch (err) {
        // 仅「尚未收到任何响应」的网络层错误可重试；HTTP 状态码错误 / 取消 /
        // 超时一律不重试（避免无谓重放与把取消误判为故障）。
        const canRetry =
          attempt < maxRetries &&
          isRetryableNetworkError(err) &&
          !signal?.aborted;
        if (!canRetry) throw err;
        const delay = Math.min(baseDelay * 2 ** attempt, 2000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }
  }

  /**
   * 流式调用，逐条产出增量。
   *
   * 解析容错与渲染层保持一致：畸形分片忽略而非中断整个流。
   */
  async *streamChat(params: {
    messages: ChatMessage[];
    tools?: ToolSpec[];
    toolChoice?: 'auto' | 'any' | 'none';
    signal?: AbortSignal;
    maxTokens?: number;
    temperature?: number;
  }): AsyncGenerator<LlmDelta> {
    const body = this.buildBody({
      ...params,
      stream: true,
      maxTokens: params.maxTokens,
      temperature: params.temperature,
    });
    const res = await this.post(body, params.signal);
    const bodyStream = res.body;
    if (!bodyStream) throw new Error('LLM 响应没有 body');

    const reader = bodyStream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') continue;

          let chunk: unknown;
          try {
            chunk = JSON.parse(payload);
          } catch {
            // 与渲染层一致：畸形分片忽略
            continue;
          }
          const delta = parseChunk(chunk);
          if (delta) yield delta;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * 非流式调用。
   *
   * 用于 `tool_choice="any"` 的强制兜底：部分模型会在正文里写工具伪代码而不真正
   * 发起 tool_call，此时用非流式 + `tool_choice="any"` 逼出真实调用。
   */
  async completeChat(params: {
    messages: ChatMessage[];
    tools?: ToolSpec[];
    toolChoice?: 'auto' | 'any' | 'none';
    signal?: AbortSignal;
    maxTokens?: number;
    temperature?: number;
  }): Promise<AssistantTurn> {
    const body = this.buildBody({
      ...params,
      stream: false,
      maxTokens: params.maxTokens,
      temperature: params.temperature,
    });
    const res = await this.post(body, params.signal);
    const json = (await res.json()) as unknown;
    return parseCompletion(json);
  }
}

function serializeMessage(message: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: message.role };
  out.content = message.content;
  if (message.toolCalls?.length) {
    out.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
    }));
  }
  if (message.toolCallId != null) out.tool_call_id = message.toolCallId;
  return out;
}

/** 从流式 chunk 提取增量；结构不符时返回 null（容错）。 */
function parseChunk(chunk: unknown): LlmDelta | null {
  if (!chunk || typeof chunk !== 'object') return null;
  const { choices } = chunk as { choices?: unknown };
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as {
    delta?: Record<string, unknown>;
    finish_reason?: string | null;
  };
  const delta = first?.delta;
  if (!delta) return null;

  const out: LlmDelta = {};
  if (typeof delta.content === 'string') out.content = delta.content;
  if (typeof delta.reasoning_content === 'string') {
    out.reasoning = delta.reasoning_content;
  }
  if (Array.isArray(delta.tool_calls)) {
    out.toolCallChunks = (
      delta.tool_calls as Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>
    ).map((tc, fallbackIndex) => ({
      index: typeof tc.index === 'number' ? tc.index : fallbackIndex,
      id: tc.id,
      name: tc.function?.name,
      argsFragment: tc.function?.arguments,
    }));
  }
  if (first.finish_reason != null) out.finishReason = first.finish_reason;
  return out;
}

function parseCompletion(json: unknown): AssistantTurn {
  const choice =
    json && typeof json === 'object'
      ? ((json as { choices?: unknown }).choices as unknown[] | undefined)?.[0]
      : undefined;
  const message = (choice as { message?: Record<string, unknown> } | undefined)
    ?.message;
  if (!message) return { content: '', reasoning: '', toolCalls: [] };

  const content = typeof message.content === 'string' ? message.content : '';
  const reasoning =
    typeof message.reasoning_content === 'string'
      ? message.reasoning_content
      : '';

  const rawCalls = Array.isArray(message.tool_calls)
    ? (message.tool_calls as Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>)
    : [];

  const toolCalls: ChatToolCall[] = rawCalls.map((call, index) => ({
    id: call.id ?? `tool-${index}`,
    name: call.function?.name ?? '',
    args: safeParseArgs(call.function?.arguments),
  }));

  return { content, reasoning, toolCalls };
}

/** 参数解析失败时退化为 `{}`（对齐 Python `normalize_api_tool_calls` 的兜底）。 */
export function safeParseArgs(
  raw: string | undefined | null,
): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * 按 index 合并 tool_call 分片。
 *
 * 等价于 LangChain `AIMessageChunk.__add__` 对 `tool_call_chunks` 的合并语义：
 * 同 index 的 id/name 取首个非空值，arguments 逐片拼接。
 */
export class ToolCallAccumulator {
  private readonly byIndex = new Map<
    number,
    { id: string; name: string; argsRaw: string }
  >();

  /** 追加一批分片。 */
  push(
    chunks: Array<{
      index: number;
      id?: string;
      name?: string;
      argsFragment?: string;
    }>,
  ): void {
    for (const chunk of chunks) {
      const existing = this.byIndex.get(chunk.index) ?? {
        id: '',
        name: '',
        argsRaw: '',
      };
      if (chunk.id && !existing.id) existing.id = chunk.id;
      if (chunk.name && !existing.name) existing.name = chunk.name;
      if (chunk.argsFragment) existing.argsRaw += chunk.argsFragment;
      this.byIndex.set(chunk.index, existing);
    }
  }

  /** 取出已合并的调用，按 index 升序。 */
  resolve(): ChatToolCall[] {
    return [...this.byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, value]) => ({
        id: value.id,
        name: value.name,
        args: safeParseArgs(value.argsRaw),
      }));
  }

  /** 已累积的原始 arguments 字符串（调试与测试用）。 */
  rawArgsByIndex(): Map<number, string> {
    return new Map([...this.byIndex].map(([k, v]) => [k, v.argsRaw]));
  }

  get isEmpty(): boolean {
    return this.byIndex.size === 0;
  }
}
