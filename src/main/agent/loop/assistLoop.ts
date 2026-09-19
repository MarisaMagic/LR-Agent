/**
 * Assist 工具循环主干。
 *
 * 移植自 `vendor/local-agent/app/agent/assist_service.py` 的 `stream_assist`
 * 与 `app/agent/assist/tool_loop.py` 的 `execute_round`。
 *
 * 单轮结构（与协议文档 §6.2 一致）：
 *
 *   阶段 A：一次 astream，产出 text_delta / reasoning_delta，并把 tool_call 分片
 *          累积成完整的 assistant 消息。**tool_start 不在此阶段发**。
 *   阶段 B：execute_round —— 五道过滤后分类执行工具，产出 tool_start / tool_result，
 *          并回灌 ToolMessage。ASYNC 工具在此产出 tool_pending 并结束本轮。
 *   阶段 C：本轮无 tool call → 视觉兜底（阶段 5）或结束循环。
 *
 * 轮次预算耗尽时追加一条「不要再调用工具」的提示，再跑一次不带工具的调用产出最终回答。
 */

import {
  ToolCallAccumulator,
  type ChatMessage,
  type ChatToolCall,
  type LlmClient,
  type ToolSpec,
} from '../llm/client';
import {
  DONE_FRAME,
  sse,
  type ClientToolCallPayload,
  type StreamEventPayload,
} from '../sse';
import {
  type ToolContext,
  type ToolDefinition,
  type ToolKind,
  toToolSpec,
} from '../tools/registry';
import {
  buildToolResult,
  extractVisionPath,
  formatToolResultForDisplay,
  stripInternalMarkers,
} from '../tools/result';
import {
  extractDocProposalFromToolResult,
  FILE_PROPOSAL_TOOLS,
  STR_REPLACE_TOOL_NAME,
  type PendingProposalContents,
} from '../tools/fileProposal';
import { ProposalStreamInterceptor } from './proposalStreamer';
import { isLrAgentRelative } from '../tools/workspacePath';
import { pythonJsonDumps } from '../json';
import { VisionAutoLoader } from '../vision/autoLoader';
import {
  EXPLORE_READONLY_FORBIDDEN_INNER,
  EXPLORE_READONLY_TOOL_NAME,
  resolveExploreInnerNames,
  shouldIncludeAnnotationReads,
  streamExploreReadonly,
} from '../subagent/exploreReadonly';
import {
  buildMultimodalUserMessage,
  VISION_ATTACHMENT_TEXT,
} from '../context/multimodal';
import type { ClientContextLike } from '../tools/workspacePath';
import type { AgentSettings } from '../config';
import {
  appendClientToolResultsToMessages,
  type ClientToolResultInput,
} from '../context/contextService';
import type { ImageService } from '../services/imageService';
import {
  checkCallAllowed,
  gatingEnabled,
  type TaskPhaseContext,
} from './taskPhase';
import {
  ASYNC_TOOL_NAMES,
  asyncDedupeKey,
  clientToolMentionedInText,
  resolveRoundToolCalls,
  splitResolvedCalls,
  type ResolvedToolCall,
} from './toolInvocation';

/** 同轮含标注写入时，被顺延的工作区写入工具的反馈文案。 */
const SAME_ROUND_BLOCKED_SUMMARY =
  '同一轮中已有标注写入调用，工作区写入需在标注提案确认后再进行。';

/** 被门禁拦下的调用反馈。 */
const PHASE_BLOCKED_STATUS = 'phase_blocked';

/** 重复调用去重的反馈文案。 */
const DUPLICATE_CALL_SUMMARY = '该工具本轮已用相同参数调用，已跳过重复调用。';

/** 同轮多个 auto_annotate 被合并后的反馈。 */
const COALESCED_SUMMARY = '同一轮中的多个 auto_annotate 已合并为一次批量调用，本调用已跳过。';

/** 已执行过的调用被重复发起时的反馈文案。 */
const ALREADY_COMPLETED_SUMMARY =
  '该工具本轮已执行，请勿重复调用。请总结，勿重跑标注工具。';

/**
 * 未知工具的失败结果。
 *
 * 与 Python `_invoke_tool_fn` 一致：这里是**裸 JSON**，不经 `buildToolResult`，
 * 因此不含 `file_written` / `proposal_pending` 两个键。
 *
 * 触发场景：模型调用了不在**当前工具集**内的工具。工具集由 `resolveAssistToolSet`
 * 按模式裁剪（例如 `describe_client_context` / `get_account_summary` 刻意不注入主
 * Agent），此时即使工具在注册表中存在，也必须按「未知工具」拒绝。
 */
export function unknownToolResult(name: string): string {
  return pythonJsonDumps({
    ok: false,
    tool: name,
    status: 'error',
    summary: `未知工具: ${name}`,
  });
}

/** 工具执行抛异常时的失败结果（同样是裸 JSON，对齐 Python）。 */
export function toolErrorResult(name: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return pythonJsonDumps({
    ok: false,
    tool: name,
    status: 'error',
    summary: `工具执行失败: ${message}`,
  });
}

/**
 * 并行预取的只读工具白名单。
 *
 * 这些工具无副作用且相互独立，先并发取结果再按原顺序发事件——
 * **事件顺序仍是串行的**，只有实际执行被并行化。
 */
export const PARALLEL_SYNC_TOOLS: ReadonlySet<string> = new Set([
  'get_lr_agent_help',
  'describe_annotation_project',
  'read_file_annotation',
  'read_workspace_file',
  'grep_workspace',
  'glob_workspace',
  'list_workspace_directory',
  'read_document_file',
]);

export interface AssistLoopParams {
  llm: LlmClient;
  messages: ChatMessage[];
  toolSpecs: ToolSpec[];
  tools: Map<string, ToolDefinition>;
  /**
   * 当前模式下允许调用的工具名集合。
   *
   * **必须用它来判定可执行性**，而不是 `tools` 的键——`tools` 是全量注册表，
   * 而工具集经模式裁剪（`describe_client_context` 等刻意不注入主 Agent）。
   * Python 侧 `fn_map` 只包含筛选后的工具，越界调用返回「未知工具」。
   */
  toolSet: ReadonlySet<string>;
  settings: AgentSettings;
  clientContext: ClientContextLike | null;
  providerIsVision: boolean;
  userContent: string;
  clientToolResults?: ClientToolResultInput[];
  taskPhaseContext: TaskPhaseContext | null;
  isCancelled: () => boolean;
  signal?: AbortSignal;
  /** 图像服务（探测纯本地；编码经 RPC 走主进程 nativeImage）。 */
  imageService: ImageService;
}

/** 单轮执行结果，用于驱动外层循环。 */
type RoundOutcome =
  | { kind: 'continued' }
  | { kind: 'finished' }
  | { kind: 'pending' };

/**
 * 可变的轮次结果容器。
 *
 * 异步生成器无法通过返回值向外传递控制信号（`for await` 会丢弃 return 值），
 * 因此用一个调用方持有的对象回传。
 */
interface RoundOutcomeHolder {
  kind: 'continued' | 'finished' | 'pending';
}

function kindOf(tools: Map<string, ToolDefinition>, name: string): ToolKind {
  return tools.get(name)?.kind ?? 'sync';
}

/**
 * 运行 Assist 工具循环，产出 SSE 事件序列。
 *
 * 调用方负责把事件序列化为 SSE 帧，并在流末尾追加 `done` 帧。
 *
 * 本函数是**故障兜底外壳**：内层循环抛出的异常（最典型是 LLM 请求失败）
 * 会被转成一条 `error` 事件。若不这样做，异常会被 SSE 层吞掉、客户端读到 EOF
 * 后合成 `done`，用户只会看到回复被截断而没有任何提示。
 *
 * 用户主动取消（`isCancelled()` 为真）不算故障，静默结束即可——渲染层会按
 * Cancelled 处理，报错反而会出现「点了停止却弹错误」的干扰。
 */
export async function* streamAssist(
  params: AssistLoopParams,
): AsyncGenerator<StreamEventPayload> {
  try {
    yield* streamAssistInner(params);
  } catch (err) {
    if (params.isCancelled() || isAbortError(err)) return;
    console.error(
      '[agentRuntime] Assist 循环异常终止:',
      err instanceof Error ? (err.stack ?? err.message) : String(err),
    );
    yield sse.error(err instanceof Error ? err.message : '模型请求失败');
  }
}

/** abort（取消）导致的异常不应被当作故障上报。 */
function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError';
}

/** 工具循环主体（异常由 `streamAssist` 统一兜底）。 */
async function* streamAssistInner(
  params: AssistLoopParams,
): AsyncGenerator<StreamEventPayload> {
  const { llm, tools, settings, isCancelled, signal } = params;

  yield sse.preparing('streaming');

  const messages: ChatMessage[] = [...params.messages];
  const completedTools = new Set<string>();
  const clientToolResults = params.clientToolResults ?? [];
  const isResume = clientToolResults.length > 0;

  // 阶段为 verify 表示用户已 Keep All、提案已落盘
  const proposalsApplied = params.taskPhaseContext?.phase === 'verify';

  if (isResume) {
    for (const result of clientToolResults) completedTools.add(result.toolCallId);
    appendClientToolResultsToMessages(messages, clientToolResults, {
      userContent: params.userContent,
      proposalsApplied,
    });
  }

  const toolContext: ToolContext = {
    clientContext: params.clientContext,
    settings,
    providerIsVision: params.providerIsVision,
    userContent: params.userContent,
    // 请求级提案缓存：让同轮对同一文件的多次 str_replace 累积到同一份提案
    pendingProposals: new Map() as PendingProposalContents,
    imageService: params.imageService,
  };

  // 视觉兜底加载器：只在首轮无 tool call 时尝试一次
  const visionLoader = new VisionAutoLoader({
    settings,
    clientContext: params.clientContext,
    providerIsVision: params.providerIsVision,
    userContent: params.userContent,
    imageService: params.imageService,
  });
  // 可变容器：跨生成器传递「本请求是否已处理过视觉图」
  const visionState = { bootstrapped: false };

  let budgetExhausted = true;

  for (let roundIdx = 0; roundIdx <= settings.maxToolRounds; roundIdx += 1) {
    if (isCancelled()) return;

    const accumulator = new ToolCallAccumulator();
    // 拦截器必须**每轮新建**：tc_index 每轮从 0 重新编号
    const interceptor = new ProposalStreamInterceptor(params.clientContext);
    let pendingText = '';
    let gatheredAny = false;

    // ── 阶段 A：单次 astream ────────────────────────────────
    for await (const delta of llm.streamChat({
      messages,
      tools: params.toolSpecs,
      toolChoice: 'auto',
      signal,
    })) {
      if (isCancelled()) return;
      if (delta.content) {
        pendingText += delta.content;
        yield sse.textDelta(delta.content);
        gatheredAny = true;
      }
      if (delta.reasoning) {
        yield sse.reasoningDelta(delta.reasoning);
        gatheredAny = true;
      }
      if (delta.toolCallChunks?.length) {
        accumulator.push(delta.toolCallChunks);
        gatheredAny = true;
        // 流式拦截：在 chunk 期间实时发出提案 start / delta 事件
        for (const event of interceptor.onChunk(delta.toolCallChunks)) {
          yield event;
        }
      }
    }

    if (!gatheredAny) {
      // 空轮：无任何产出，结束循环（视为已完成，不再走预算耗尽分支）
      budgetExhausted = false;
      break;
    }

    const apiToolCalls = accumulator.resolve();
    const outcome: RoundOutcomeHolder = { kind: 'finished' };

    // ── 阶段 B：执行本轮 ────────────────────────────────────
    yield* executeRound({
      apiToolCalls,
      fullText: pendingText,
      messages,
      tools,
      toolSet: params.toolSet,
      toolContext,
      completedTools,
      taskPhaseContext: params.taskPhaseContext,
      outcome,
      llm,
      isCancelled,
      signal,
      accumulatedText: pendingText,
      isResume,
      toolSpecs: params.toolSpecs,
      interceptor,
      visionState,
      settings,
    });

    if (outcome.kind === 'pending') {
      // tool_pending 已发出：本轮 HTTP 结束，等待客户端执行后 resume
      return;
    }
    if (outcome.kind === 'continued') {
      budgetExhausted = true;
      continue;
    }

    // ── 阶段 C：本轮无 tool call ────────────────────────────
    // 弱模型首轮未调用任何工具时的视觉兜底（正常路径由模型自己调
    // read_image_for_vision）。触发后置标记并进入下一轮，避免重复注入。
    if (
      roundIdx === 0 &&
      !isResume &&
      visionLoader.shouldLoad(isResume) &&
      !visionState.bootstrapped
    ) {
      visionState.bootstrapped = true;
      yield* visionLoader.tryFallback(messages);
      budgetExhausted = true;
      continue;
    }
    budgetExhausted = false;
    break;
  }

  // ── 轮次预算耗尽：强制一次不带工具的最终回答 ────────────────
  if (budgetExhausted) {
    messages.push({
      role: 'user',
      content: '工具调用预算已用完。请基于以上进展直接给出最终回答，不要再调用工具。',
    });
    for await (const delta of llm.streamChat({ messages, signal })) {
      if (isCancelled()) return;
      if (delta.content) yield sse.textDelta(delta.content);
      if (delta.reasoning) yield sse.reasoningDelta(delta.reasoning);
    }
  }
}

interface ExecuteRoundParams {
  apiToolCalls: ChatToolCall[];
  fullText: string;
  messages: ChatMessage[];
  tools: Map<string, ToolDefinition>;
  toolSet: ReadonlySet<string>;
  toolSpecs: ToolSpec[];
  toolContext: ToolContext;
  completedTools: Set<string>;
  taskPhaseContext: TaskPhaseContext | null;
  outcome: RoundOutcomeHolder;
  llm: LlmClient;
  isCancelled: () => boolean;
  signal?: AbortSignal;
  accumulatedText: string;
  isResume: boolean;
  interceptor: ProposalStreamInterceptor;
  /** 「本请求是否已处理过视觉图」——由调用方持有，跨轮次共享。 */
  visionState: { bootstrapped: boolean };
  settings: AgentSettings;
}

/**
 * 执行一轮的 tool_calls。
 *
 * 五道过滤（顺序与 Python 一致）：
 *   1. 调用规整化（丢弃空名与已完成 id）
 *   2. 同轮顺序不变量（标注写入与工作区写入不能同轮）
 *   3. 阶段门禁
 *   4. 同轮多 auto_annotate 合并
 *   5. 同批异步去重
 */
async function* executeRound(
  params: ExecuteRoundParams,
): AsyncGenerator<StreamEventPayload> {
  const {
    apiToolCalls,
    fullText,
    messages,
    tools,
    toolSet,
    toolSpecs,
    toolContext,
    completedTools,
    taskPhaseContext,
    outcome,
    llm,
    isCancelled,
    signal,
    interceptor,
  } = params;
  const { settings } = toolContext;

  let resolved = resolveRoundToolCalls({
    apiToolCalls,
    completedTools,
  });

  // 部分模型会在正文里写工具伪代码而不真正发起 tool_call：用 tool_choice="any"
  // 非流式强制一次。条件是本轮没有真实调用、正文命中了 ASYNC 工具名、门禁允许。
  if (resolved.length === 0 && apiToolCalls.length === 0) {
    const forced = await forceToolCallOnce({
      fullText,
      messages,
      tools,
      toolSet,
      toolSpecs,
      taskPhaseContext,
      llm,
      signal,
    });
    if (forced) resolved = forced;
  }

  if (resolved.length === 0) {
    if (apiToolCalls.length === 0) {
      outcome.kind = 'finished';
      return;
    }
    // 所有调用都因「已完成」被丢弃：补 ToolMessage 让模型自己总结，继续下一轮
    messages.push({
      role: 'assistant',
      content: fullText,
      toolCalls: apiToolCalls,
    });
    for (const call of apiToolCalls) {
      const payload = buildToolResult({
        ok: false,
        tool: call.name,
        status: 'already_completed',
        summary: ALREADY_COMPLETED_SUMMARY,
      });
      messages.push({
        role: 'tool',
        content: payload,
        toolCallId: call.id,
      });
    }
    outcome.kind = 'continued';
    return;
  }

  // 先记录 assistant 轮次（含全部 tool_calls），后续为每个调用补 ToolMessage
  messages.push({
    role: 'assistant',
    content: fullText,
    toolCalls: apiToolCalls.length ? apiToolCalls : resolved.map(toChatToolCall),
  });

  /** 被拦下的调用：发 tool_start + tool_result 并回灌 ToolMessage。 */
  async function* blocked(
    call: ResolvedToolCall,
    status: string,
    summary: string,
  ): AsyncGenerator<StreamEventPayload> {
    yield sse.toolStart(call.toolCallId, call.name, call.arguments);
    const payload = buildToolResult({
      ok: false,
      tool: call.name,
      status,
      summary,
    });
    const display = formatToolResultForDisplay(payload);
    yield sse.toolResult(call.toolCallId, display);
    messages.push({
      role: 'tool',
      content: display,
      toolCallId: call.toolCallId,
    });
  }

  // ── 过滤 2：同轮顺序不变量 ────────────────────────────────
  const hasAnnotationWrite = resolved.some((call) =>
    ['auto_annotate', 'mutate_annotation'].includes(call.name),
  );
  const deferred = new Set<string>();
  if (hasAnnotationWrite) {
    for (const call of resolved) {
      if (['write_workspace_file', 'str_replace_workspace_file', 'delete_workspace_file', 'move_workspace_file'].includes(call.name)) {
        deferred.add(call.toolCallId);
      }
    }
  }
  for (const call of resolved) {
    if (deferred.has(call.toolCallId)) {
      yield* blocked(call, PHASE_BLOCKED_STATUS, SAME_ROUND_BLOCKED_SUMMARY);
    }
  }

  // ── 过滤 3：阶段门禁 ──────────────────────────────────────
  const gatedOut = new Set<string>();
  if (gatingEnabled(taskPhaseContext)) {
    for (const call of resolved) {
      if (deferred.has(call.toolCallId)) continue;
      const reason = checkCallAllowed(call.name, call.arguments, taskPhaseContext);
      if (reason) {
        gatedOut.add(call.toolCallId);
        yield* blocked(call, PHASE_BLOCKED_STATUS, reason);
      }
    }
  }

  // ── 过滤 4：同轮多个 auto_annotate 合并 ───────────────────
  const coalescedOut = new Set<string>();
  const autoCalls = resolved.filter(
    (call) =>
      call.name === 'auto_annotate' &&
      !deferred.has(call.toolCallId) &&
      !gatedOut.has(call.toolCallId),
  );
  if (autoCalls.length > 1) {
    // 保留第一个，其余合并进去
    for (const call of autoCalls.slice(1)) {
      coalescedOut.add(call.toolCallId);
      yield* blocked(call, 'coalesced', COALESCED_SUMMARY);
    }
  }

  // ── 过滤 5：同批异步去重 ──────────────────────────────────
  const duplicateOut = new Set<string>();
  const seenKeys = new Set<string>();
  for (const call of resolved) {
    if (
      deferred.has(call.toolCallId) ||
      gatedOut.has(call.toolCallId) ||
      coalescedOut.has(call.toolCallId)
    ) {
      continue;
    }
    if (kindOf(tools, call.name) !== 'async') continue;
    const key = asyncDedupeKey(call);
    if (seenKeys.has(key)) {
      duplicateOut.add(call.toolCallId);
      yield* blocked(call, 'duplicate_call', DUPLICATE_CALL_SUMMARY);
      continue;
    }
    seenKeys.add(key);
  }

  const executable = resolved.filter(
    (call) =>
      !deferred.has(call.toolCallId) &&
      !gatedOut.has(call.toolCallId) &&
      !coalescedOut.has(call.toolCallId) &&
      !duplicateOut.has(call.toolCallId),
  );

  if (executable.length === 0) {
    outcome.kind = 'continued';
    return;
  }

  // ── 分类执行 ──────────────────────────────────────────────
  // 拦截器已流式出卡的路径：定稿时用来抑制重复的 start/delta，
  // 工具报错时用来补发 dismissed 终态
  const streamedPathsByCallId = interceptor.streamedPathsByCallId();
  const streamedPaths = new Set(streamedPathsByCallId.values());

  const { immediate, asyncPending } = splitResolvedCalls(executable, (name) =>
    kindOf(tools, name),
  );

  // explore_readonly 单独成路：它由子代理 runner 接管，且事件形态不同
  // （工具自身不执行，改由 subagent_* 事件族表达）
  const exploreCalls = immediate.filter(
    (call) => call.name === EXPLORE_READONLY_TOOL_NAME,
  );
  const otherImmediate = immediate.filter(
    (call) => call.name !== EXPLORE_READONLY_TOOL_NAME,
  );

  // 并行预取只读工具（事件仍按顺序发出）
  const prefetched = new Map<string, string>();
  const parallelCalls = otherImmediate.filter(
    (call) =>
      PARALLEL_SYNC_TOOLS.has(call.name) &&
      typeof tools.get(call.name)?.execute === 'function',
  );
  if (parallelCalls.length > 0) {
    const results = await Promise.all(
      parallelCalls.map((call) => invokeTool(call, tools, toolSet, toolContext)),
    );
    parallelCalls.forEach((call, index) => {
      prefetched.set(call.toolCallId, results[index]);
    });
  }

  for (const call of otherImmediate) {
    if (isCancelled()) return;
    yield* streamToolExecution({
      call,
      tools,
      toolSet,
      toolContext,
      messages,
      prefetchedResult: prefetched.get(call.toolCallId),
      streamedPaths,
      streamedPathsByCallId,
    });
    // 模型真实调用过视觉工具后，兜底不应再触发（对齐 Python 的 vision_bootstrapped）
    if (call.name === 'read_image_for_vision') {
      params.visionState.bootstrapped = true;
    }
  }

  // explore 调用：允许多个并行（事件交错），完成后统一补 tool_result
  if (exploreCalls.length > 0) {
    const finals = new Map<string, { summary: string; status: 'done' | 'error' }>();
    const streams = exploreCalls.map((call) =>
      trackedExplore({
        call,
        tools,
        toolSet,
        toolContext,
        settings,
        llm,
        isCancelled,
        signal,
        finals,
      }),
    );
    yield* mergeAsyncIterators(streams);

    for (const call of exploreCalls) {
      const final = finals.get(call.toolCallId) ?? {
        summary: '查阅失败',
        status: 'error' as const,
      };
      // 父级 tool_result 的 result 是「摘要」——_explore_result_text 产出带 summary 的
      // JSON，再经显示格式化折叠为 summary 文本
      const display = formatToolResultForDisplay(
        buildToolResult({
          ok: final.status === 'done',
          tool: EXPLORE_READONLY_TOOL_NAME,
          status: final.status === 'done' ? 'ok' : 'error',
          summary: final.summary || '（无摘要）',
        }),
      );
      yield sse.toolResult(call.toolCallId, display);
      messages.push({
        role: 'tool',
        content: display,
        toolCallId: call.toolCallId,
      });
    }
  }

  if (asyncPending.length > 0) {
    // 派发前为每个调用各发一条 tool_start，再发 tool_pending 结束本轮
    for (const call of asyncPending) {
      yield sse.toolStart(call.toolCallId, call.name, call.arguments);
    }
    const payloads: ClientToolCallPayload[] = asyncPending.map((call) => ({
      toolCallId: call.toolCallId,
      name: call.name,
      arguments: call.arguments,
    }));
    yield sse.toolPending(payloads);
    outcome.kind = 'pending';
    return;
  }

  outcome.kind = 'continued';
}

function toChatToolCall(call: ResolvedToolCall): ChatToolCall {
  return { id: call.toolCallId, name: call.name, args: call.arguments };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 构造子代理可用的内层工具（按白名单与父级工具集求交）。 */
function buildInnerExploreTools(params: {
  tools: Map<string, ToolDefinition>;
  toolSet: ReadonlySet<string>;
  clientContext: ClientContextLike | null;
}): Map<string, ToolDefinition> {
  const includeAnnotations = shouldIncludeAnnotationReads(
    params.clientContext as { workMode?: string | null } | null,
    params.toolSet,
  );
  const allowed = resolveExploreInnerNames(includeAnnotations);

  const inner = new Map<string, ToolDefinition>();
  for (const [name, tool] of params.tools) {
    // 与 Python 一致：必须是「父级工具集内的」且在白名单内
    if (!params.toolSet.has(name)) continue;
    if (!allowed.has(name)) continue;
    if (EXPLORE_READONLY_FORBIDDEN_INNER.has(name)) continue;
    inner.set(name, tool);
  }
  return inner;
}

interface TrackedExploreParams {
  call: ResolvedToolCall;
  tools: Map<string, ToolDefinition>;
  toolSet: ReadonlySet<string>;
  toolContext: ToolContext;
  settings: AgentSettings;
  llm: LlmClient;
  isCancelled: () => boolean;
  signal?: AbortSignal;
  finals: Map<string, { summary: string; status: 'done' | 'error' }>;
}

/**
 * 包装一次子代理执行。
 *
 * 先发父级 `tool_start`（与基线一致，只发一次），再跑子代理循环，
 * 最后把 summary/status 记入 `finals` 供调用方补 `tool_result`。
 */
async function* trackedExplore(
  params: TrackedExploreParams,
): AsyncGenerator<StreamEventPayload> {
  const { call, finals } = params;

  yield sse.toolStart(call.toolCallId, call.name, call.arguments);

  let summary = '';
  let status: 'done' | 'error' = 'error';

  try {
    const innerTools = buildInnerExploreTools({
      tools: params.tools,
      toolSet: params.toolSet,
      clientContext: params.toolContext.clientContext,
    });
    const innerToolSpecs = [...innerTools.values()]
      .map(toToolSpec)
      .sort((a, b) => (a.function.name < b.function.name ? -1 : 1));

    const focusRaw = call.arguments?.focus_path;
    const focusPath =
      typeof focusRaw === 'string' && focusRaw.trim() ? focusRaw.trim() : null;

    for await (const event of streamExploreReadonly(
      {
        llm: params.llm,
        settings: params.settings,
        isCancelled: params.isCancelled,
        signal: params.signal,
        innerTools,
        innerToolSpecs,
        toolContext: params.toolContext,
      },
      {
        query: String(call.arguments?.query ?? ''),
        focusPath,
        parentToolId: call.toolCallId,
      },
    )) {
      if (event.type === 'subagent_done') {
        summary = event.summary ?? '';
        status = event.status === 'done' ? 'done' : 'error';
      }
      yield event;
    }
  } catch (err) {
    summary = `查阅失败：${errMessage(err)}`;
    status = 'error';
    yield sse.subagentDone({
      toolCallId: call.toolCallId,
      summary,
      status: 'error',
    });
  }

  finals.set(call.toolCallId, { summary, status });
}

/**
 * 合并多个异步事件流（交错产出）。
 *
 * 对应 Python 的 `_merge_async_iterators`：用于多个 explore_readonly 并行时的
 * 事件交错。调用方应保证 `streams` 非空。
 */
export async function* mergeAsyncIterators<T>(
  streams: Array<AsyncGenerator<T>>,
): AsyncGenerator<T> {
  if (streams.length === 0) return;
  if (streams.length === 1) {
    yield* streams[0];
    return;
  }

  // 每个流一个消费任务，把事件投递到共享队列；流结束时投递 null 作为结束标记
  type Item = { value: T } | null;
  const queue: Item[] = [];
  let notify: (() => void) | null = null;
  let remaining = streams.length;
  let failure: unknown = null;

  const push = (item: Item): void => {
    queue.push(item);
    if (notify) {
      const fn = notify;
      notify = null;
      fn();
    }
  };

  const pumps = streams.map(async (stream) => {
    try {
      for await (const value of stream) push({ value });
    } catch (err) {
      failure = err;
    } finally {
      remaining -= 1;
      push(null);
    }
  });

  try {
    while (remaining > 0 || queue.length > 0) {
      if (queue.length === 0) {
        // 等待下一个事件
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        continue;
      }
      const item = queue.shift() as Item;
      if (item === null) continue;
      yield item.value;
    }
    if (failure) throw failure;
  } finally {
    // 调用方提前退出（如取消）时，确保所有 pump 被回收
    await Promise.allSettled(pumps);
  }
}

/** 执行单个工具并返回原始结果字符串。 */
async function invokeTool(
  call: ResolvedToolCall,
  tools: Map<string, ToolDefinition>,
  toolSet: ReadonlySet<string>,
  ctx: ToolContext,
): Promise<string> {
  // 越界调用按「未知工具」拒绝——工具集是模式裁剪后的结果，
  // 注册表里存在但不在集合内的一律不可执行（与 Python fn_map 语义一致）
  if (!toolSet.has(call.name)) return unknownToolResult(call.name);

  const tool = tools.get(call.name);
  if (!tool || typeof tool.execute !== 'function') {
    return unknownToolResult(call.name);
  }
  try {
    return await tool.execute(call.arguments, ctx);
  } catch (err) {
    return toolErrorResult(call.name, err);
  }
}

interface StreamToolExecutionParams {
  call: ResolvedToolCall;
  tools: Map<string, ToolDefinition>;
  toolSet: ReadonlySet<string>;
  toolContext: ToolContext;
  messages: ChatMessage[];
  /** 并行预取好的结果；未预取时现场执行。 */
  prefetchedResult?: string;
  /** 拦截器已流式出卡的显示路径集合。 */
  streamedPaths?: ReadonlySet<string>;
  /** callId → 已流式出卡的显示路径。 */
  streamedPathsByCallId?: Map<string, string>;
}

/**
 * 执行单个工具并产出事件。
 *
 * `tool_start` 的 `arguments` 是 pretty JSON 字符串；回灌给模型的 ToolMessage 用
 * **显示文本**（`formatToolResultForDisplay`），与子代理内部回灌原文的做法不同。
 *
 * 提案类工具（`FILE_PROPOSAL_TOOLS`）额外做两件事：
 *   - 从结果里提取 `__doc_proposal__`，发出定稿的 `file_proposal`（若该路径已在流式
 *     期间出过卡，则跳过重复的 start/delta burst）
 *   - 提取失败（工具报错，如 `old_string` 未命中）时，为已出卡的路径补发
 *     `status="dismissed"` 终态，否则前端会留下悬挂卡片、Keep All 可能把空内容写盘
 */
async function* streamToolExecution(
  params: StreamToolExecutionParams,
): AsyncGenerator<StreamEventPayload> {
  const {
    call,
    tools,
    toolSet,
    toolContext,
    messages,
    prefetchedResult,
    streamedPaths,
    streamedPathsByCallId,
  } = params;

  yield sse.toolStart(call.toolCallId, call.name, call.arguments);

  const raw =
    prefetchedResult ?? (await invokeTool(call, tools, toolSet, toolContext));

  // read_image_for_vision 的结果含内部标记，需剥离后再展示
  let display: string;
  let visionPath = '';
  let docProposal: ReturnType<typeof extractDocProposalFromToolResult> = null;

  if (call.name === 'read_image_for_vision') {
    visionPath = extractVisionPath(raw);
    // 提取到路径才剥离内部标记（输出完整缩进 JSON，而非 summary）；
    // 否则保持原样——对齐 Python 的分支写法
    display = visionPath ? stripInternalMarkers(raw) : raw;
  } else if (FILE_PROPOSAL_TOOLS.has(call.name)) {
    docProposal = extractDocProposalFromToolResult(call.name, raw);
    // 只有拿到提案数据才走显示文本；工具报错时**保持完整 JSON 原样回灌**
    // （Python 的 elif 分支只在 doc_proposal 存在时赋值 display_result）
    display = docProposal ? formatToolResultForDisplay(raw) : raw;
  } else {
    display = formatToolResultForDisplay(raw);
  }

  yield sse.toolResult(call.toolCallId, display);
  messages.push({
    role: 'tool',
    content: display,
    toolCallId: call.toolCallId,
  });

  // ── 提案失败兜底：补发 dismissed 终态 ──────────────────────
  if (
    docProposal === null &&
    FILE_PROPOSAL_TOOLS.has(call.name) &&
    streamedPathsByCallId &&
    streamedPathsByCallId.size > 0
  ) {
    const streamedPath = streamedPathsByCallId.get(call.toolCallId);
    if (streamedPath) {
      yield sse.fileProposal({
        summary: String(call.arguments.relative_path ?? streamedPath) || streamedPath,
        content: '',
        relativePath: streamedPath,
        mode: call.name === STR_REPLACE_TOOL_NAME ? 'edit' : 'write',
        status: 'dismissed',
      });
    }
  }

  // ── 提案定稿 ──────────────────────────────────────────────
  if (docProposal) {
    const fullContent = docProposal.content;
    const relPath = docProposal.relativePath;

    // 注意：`.lr-agent` 路径的终态事件**仍然发射**（与流式拦截的 suppress 不同）
    if (!isLrAgentRelative(relPath)) {
      const operation = docProposal.operation;
      const omitForPath = streamedPaths?.has(relPath) ?? false;

      if (operation !== 'delete' && !omitForPath) {
        yield sse.fileProposalStart({
          summary: docProposal.title,
          relativePath: relPath,
          detail: String(fullContent.length),
          mode: operation,
        });
        // 定稿补齐时分 200 字符一片
        const CHUNK_SIZE = 200;
        for (let offset = 0; offset < fullContent.length; offset += CHUNK_SIZE) {
          yield sse.fileProposalDelta({
            content: fullContent.slice(offset, offset + CHUNK_SIZE),
            relativePath: relPath,
            mode: operation,
          });
        }
      }

      yield sse.fileProposal({
        summary: docProposal.title,
        content: fullContent,
        relativePath: relPath,
        mode: operation,
        oldPath: docProposal.oldPath || null,
      });
    }
  }

  // 视觉附图注入：在对应 ToolMessage 之后追加一条多模态 HumanMessage
  if (visionPath && toolContext.providerIsVision) {
    messages.push(
      await buildMultimodalUserMessage(
        VISION_ATTACHMENT_TEXT,
        {
          imageAbsolutePath: visionPath,
          maxEdge: toolContext.settings.chatVisionMaxEdge,
          jpegQuality: toolContext.settings.chatVisionJpegQuality,
        },
        toolContext.imageService,
      ),
    );
  }
}

interface ForceToolCallParams {
  fullText: string;
  messages: ChatMessage[];
  tools: Map<string, ToolDefinition>;
  toolSet: ReadonlySet<string>;
  toolSpecs: ToolSpec[];
  taskPhaseContext: TaskPhaseContext | null;
  llm: LlmClient;
  signal?: AbortSignal;
}

/**
 * 用 `tool_choice="any"` 强制模型真正发起 tool_call。
 *
 * 触发条件（须全部满足，与 Python `_maybe_force_tool_call` 一致）：
 *   1. 正文命中某个 ASYNC 工具名
 *   2. 该工具**在当前工具集内**（而非仅在注册表中）
 *   3. 门禁允许
 *
 * 注意必须把工具声明传下去，否则模型没有可调用的工具。
 */
async function forceToolCallOnce(
  params: ForceToolCallParams,
): Promise<ResolvedToolCall[] | null> {
  const mentioned = clientToolMentionedInText(params.fullText);
  if (!mentioned) return null;

  // 必须是当前模式下可用的工具：注册表里有但被模式裁剪掉的不算
  if (!params.toolSet.has(mentioned)) return null;
  if (!ASYNC_TOOL_NAMES.has(mentioned)) return null;

  // 门禁预检：若该工具会被拦下，不浪费一次额外调用
  const probe = checkCallAllowed(mentioned, {}, params.taskPhaseContext);
  if (probe) return null;

  try {
    const turn = await params.llm.completeChat({
      messages: params.messages,
      tools: params.toolSpecs,
      toolChoice: 'any',
      signal: params.signal,
    });
    const calls = turn.toolCalls.filter((call) => call.name === mentioned);
    if (calls.length === 0) return null;
    return calls.map((call) => ({
      toolCallId: call.id,
      name: call.name,
      arguments: call.args,
      source: 'api' as const,
    }));
  } catch {
    return null;
  }
}

/** 供路由层在流末尾追加收尾帧。 */
export { DONE_FRAME };
