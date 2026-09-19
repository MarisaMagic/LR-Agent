/**
 * SSE 事件载荷与序列化。
 *
 * **本模块是 `docs/agent-protocol.md` §2 的可执行形式，改这里必须同步改文档。**
 *
 * 迁移自 `vendor/local-agent/app/schemas/agent.py` 的 `StreamEventPayload.to_sse_dict`，
 * 序列化规则必须逐条保真，否则渲染层会静默降级（`backendChatClient.ts` 的 SSE 解析
 * 对畸形分片是 ignore，协议对不上只会表现为「没有反应」）：
 *
 *   1. 仅当值不为 `null`/`undefined` 时输出该字段；空字符串需要输出
 *   2. `imagePath` 在四类提案事件下改名为 `suggestedRelativePath`
 *   3. `mode` 永远输出；在四类提案事件下额外输出同值的 `operation`
 *   4. `oldPath` 仅在 `file_proposal_start` / `file_proposal` 下输出
 *   5. 四类提案事件下派生 `title`：优先 `summary`，其次 `detail`
 *   6. `clientToolCalls` 同时写入 `clientToolCalls` 与 `toolCalls` 两份同值
 *
 * 另需注意 `arguments` 的类型**不统一**且是既成事实：`tool_start` /
 * `subagent_tool_start` 是 pretty JSON 字符串，而 `tool_pending` 的
 * `clientToolCalls[].arguments` 是对象。不要统一。
 */

/** 提案类事件：这些类型触发字段改名与派生（见模块注释规则 2-5）。 */
const PROPOSAL_TYPES: ReadonlySet<string> = new Set([
  'file_proposal_start',
  'file_proposal_delta',
  'file_proposal',
  'document_proposal',
]);

/** 输出 `oldPath` 的事件类型。 */
const OLD_PATH_TYPES: ReadonlySet<string> = new Set([
  'file_proposal_start',
  'file_proposal',
]);

/** `tool_pending` 中单个客户端工具调用的描述。 */
export interface ClientToolCallPayload {
  toolCallId: string;
  name: string;
  /** 注意：这里是**对象**，与 `tool_start.arguments`（字符串）不同。 */
  arguments: Record<string, unknown>;
}

/**
 * 事件载荷。
 *
 * 字段的「运行时是否发射」有明确边界（见协议文档 §2.2）：
 * - 运行时发射：preparing / text_delta / reasoning_delta / tool_start / tool_result /
 *   tool_pending / file_proposal* / subagent_* / done
 * - 渲染层合成：awaiting_confirmation / terminal_approval* / terminal_output /
 *   annotation_progress / annotation_proposal / error
 * - 死类型（声明但无发射点）：context_updated / route_decided
 *
 * 下面保留全部字段以兼容渲染层的类型与历史数据，但实现侧不要为渲染层合成的事件
 * 写发射逻辑。
 */
export interface StreamEventPayload {
  type: string;
  content?: string | null;
  stage?: string | null;
  status?: string | null;
  detail?: string | null;
  proposal?: Record<string, unknown> | null;
  summary?: string | null;
  summaryUpToMessageId?: string | null;
  tokenEstimate?: number | null;
  toolCallId?: string | null;
  name?: string | null;
  arguments?: string | null;
  result?: string | null;
  message?: string | null;
  imagePath?: string | null;
  mode?: string | null;
  domain?: string | null;
  target?: string | null;
  reason?: string | null;
  clientToolCalls?: ClientToolCallPayload[] | null;
  query?: string | null;
  focusPath?: string | null;
  innerToolCallId?: string | null;
  oldDelta?: string | null;
  newDelta?: string | null;
  oldPath?: string | null;
}

/** 序列化输出（键名已按契约转换）。 */
export type SseDict = Record<string, unknown>;

/**
 * 按契约把事件载荷转为 SSE 字典。
 *
 * 实现刻意与 Python 版保持同构的语句顺序，便于逐条对照校验。
 */
export function toSseDict(event: StreamEventPayload): SseDict {
  const data: SseDict = { type: event.type };

  if (event.content != null) data.content = event.content;
  if (event.stage != null) data.stage = event.stage;
  if (event.status != null) data.status = event.status;
  if (event.detail != null) data.detail = event.detail;
  if (event.proposal != null) data.proposal = event.proposal;
  if (event.summary != null) data.summary = event.summary;
  if (event.summaryUpToMessageId != null) {
    data.summaryUpToMessageId = event.summaryUpToMessageId;
  }
  if (event.tokenEstimate != null) data.tokenEstimate = event.tokenEstimate;
  if (event.toolCallId != null) data.toolCallId = event.toolCallId;
  if (event.name != null) data.name = event.name;
  if (event.arguments != null) data.arguments = event.arguments;
  if (event.result != null) data.result = event.result;
  if (event.message != null) data.message = event.message;

  // 规则 2：提案类事件下 imagePath 改名
  if (event.imagePath != null) {
    if (PROPOSAL_TYPES.has(event.type)) {
      data.suggestedRelativePath = event.imagePath;
    } else {
      data.imagePath = event.imagePath;
    }
  }

  // 规则 5：派生 title（summary 优先，其次 detail）
  if (PROPOSAL_TYPES.has(event.type)) {
    if (event.summary != null) data.title = event.summary;
    if (event.detail != null && !('title' in data)) data.title = event.detail;
  }

  // 规则 3：mode 恒输出；提案类事件额外输出同值 operation
  if (event.mode != null) {
    data.mode = event.mode;
    if (PROPOSAL_TYPES.has(event.type)) {
      data.operation = event.mode;
    }
  }

  // 规则 4：oldPath 仅在特定类型下输出
  if (event.oldPath != null && OLD_PATH_TYPES.has(event.type)) {
    data.oldPath = event.oldPath;
  }

  if (event.domain != null) data.domain = event.domain;
  if (event.target != null) data.target = event.target;
  if (event.reason != null) data.reason = event.reason;
  if (event.query != null) data.query = event.query;
  if (event.focusPath != null) data.focusPath = event.focusPath;
  if (event.innerToolCallId != null) {
    data.innerToolCallId = event.innerToolCallId;
  }
  if (event.oldDelta != null) data.oldDelta = event.oldDelta;
  if (event.newDelta != null) data.newDelta = event.newDelta;

  // 规则 6：双写 clientToolCalls / toolCalls
  if (event.clientToolCalls != null) {
    const serialized = event.clientToolCalls.map((call) => ({
      toolCallId: call.toolCallId,
      name: call.name,
      arguments: call.arguments,
    }));
    data.clientToolCalls = serialized;
    data.toolCalls = serialized;
  }

  return data;
}

/**
 * 编码为一帧 SSE。
 *
 * 注意：中文不转义（对应 Python 的 `ensure_ascii=False`），且**没有** `event:` 行。
 */
export function encodeSseFrame(data: SseDict): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/**
 * 流末尾的收尾帧。
 *
 * 这是一个**裸对象**，不是 `StreamEventPayload` 的序列化结果——只有 `type` 字段。
 */
export const DONE_FRAME = 'data: {"type": "done"}\n\n';

/** 便于构造事件的辅助函数（只覆盖运行时会发射的类型）。 */
export const sse = {
  preparing: (stage: string): StreamEventPayload => ({ type: 'preparing', stage }),
  /**
   * 流中途失败。
   *
   * 渲染层对 `error` 事件的处理是完整的（`agentJobRegistry` 置 job 为 Error、
   * `AgentChatContext` 置消息 status='error' 并显示 `translateError(message)`），
   * 因此运行时不发该事件会让失败**静默退化为正常结束**：
   * SSE 层吞掉异常 → 客户端读到 EOF → 合成 `done` → 用户只看到回复被截断、零提示。
   *
   * 只在**非取消**的真实故障时发射；取消由渲染层按 Cancelled 处理，不应报错。
   */
  error: (message: string): StreamEventPayload => ({ type: 'error', message }),
  textDelta: (content: string): StreamEventPayload => ({
    type: 'text_delta',
    content,
  }),
  reasoningDelta: (content: string): StreamEventPayload => ({
    type: 'reasoning_delta',
    content,
  }),
  toolStart: (toolCallId: string, name: string, args: unknown): StreamEventPayload => ({
    type: 'tool_start',
    toolCallId,
    name,
    // pretty JSON 字符串（与 subagent_tool_start 一致）
    arguments: JSON.stringify(args ?? {}, null, 2),
  }),
  toolResult: (toolCallId: string, result: string): StreamEventPayload => ({
    type: 'tool_result',
    toolCallId,
    result,
  }),
  toolPending: (calls: ClientToolCallPayload[]): StreamEventPayload => ({
    type: 'tool_pending',
    clientToolCalls: calls,
  }),
  fileProposalStart: (params: {
    summary: string;
    relativePath: string;
    detail: string;
    mode?: string | null;
  }): StreamEventPayload => ({
    type: 'file_proposal_start',
    summary: params.summary,
    imagePath: params.relativePath,
    detail: params.detail,
    mode: params.mode ?? null,
  }),
  fileProposalDelta: (params: {
    content: string;
    relativePath: string;
    mode?: string | null;
  }): StreamEventPayload => ({
    type: 'file_proposal_delta',
    content: params.content,
    imagePath: params.relativePath,
    mode: params.mode ?? null,
  }),
  fileProposal: (params: {
    summary: string;
    content: string;
    relativePath: string;
    mode: string;
    oldPath?: string | null;
    status?: string | null;
  }): StreamEventPayload => ({
    type: 'file_proposal',
    summary: params.summary,
    content: params.content,
    imagePath: params.relativePath,
    mode: params.mode,
    oldPath: params.oldPath ?? null,
    status: params.status ?? null,
  }),
  fileEditDelta: (params: {
    relativePath: string;
    oldDelta?: string | null;
    newDelta?: string | null;
  }): StreamEventPayload => ({
    type: 'file_edit_delta',
    imagePath: params.relativePath,
    oldDelta: params.oldDelta ?? null,
    newDelta: params.newDelta ?? null,
  }),
  subagentStart: (params: {
    toolCallId: string;
    query: string;
    focusPath?: string | null;
  }): StreamEventPayload => ({
    type: 'subagent_start',
    toolCallId: params.toolCallId,
    query: params.query,
    focusPath: params.focusPath ?? null,
  }),
  subagentTextDelta: (toolCallId: string, content: string): StreamEventPayload => ({
    type: 'subagent_text_delta',
    toolCallId,
    content,
  }),
  subagentToolStart: (params: {
    toolCallId: string;
    innerToolCallId: string;
    name: string;
    args: unknown;
  }): StreamEventPayload => ({
    type: 'subagent_tool_start',
    toolCallId: params.toolCallId,
    innerToolCallId: params.innerToolCallId,
    name: params.name,
    arguments: JSON.stringify(params.args ?? {}, null, 2),
  }),
  subagentToolResult: (params: {
    toolCallId: string;
    innerToolCallId: string;
    result: string;
    status: 'done' | 'error';
  }): StreamEventPayload => ({
    type: 'subagent_tool_result',
    toolCallId: params.toolCallId,
    innerToolCallId: params.innerToolCallId,
    result: params.result,
    status: params.status,
  }),
  subagentDone: (params: {
    toolCallId: string;
    summary: string;
    status: 'done' | 'error';
  }): StreamEventPayload => ({
    type: 'subagent_done',
    toolCallId: params.toolCallId,
    summary: params.summary,
    status: params.status,
  }),
};
