import { DEFAULT_CHAT_CONTEXT_CONFIG, JobState } from '../../shared/agentTypes';
import type {
  AgentSession,
  ChatMessage,
  ClientContextPayload,
  ClientToolCall,
  ClientToolResult,
  StreamEvent,
} from '../../shared/agentTypes';
import type { AnnotationProjectSnapshot } from '../../shared/annotationAgentTypes';
import type { PretrainedModelConfig } from '../types/pretrainedModel';
import { mockChatStream } from './agentStreamMock';
import { streamChatDirectly } from './localChatClient';
import {
  buildBackendMessages,
  streamChatViaBackend,
} from './backendChatClient';
import { startAnnotationBatchJob } from './annotationBatchJob';
import { startAnnotationMutationJob } from './annotationMutationBatchJob';
import { createDebugLogger } from './agentDebugLogger';

export type JobEventListener = (event: StreamEvent) => void;

interface RunningJob {
  controller: AbortController;
  listeners: Set<JobEventListener>;
  state: JobState;
}

const runningJobs = new Map<string, RunningJob>();
/** Listeners registered before startChatJob creates the job entry */
const pendingListeners = new Map<string, Set<JobEventListener>>();

function attachPendingListeners(jobId: string, job: RunningJob): void {
  const pending = pendingListeners.get(jobId);
  if (!pending) return;
  pending.forEach((listener) => job.listeners.add(listener));
  pendingListeners.delete(jobId);
}

export function subscribeJobEvents(
  jobId: string,
  listener: JobEventListener,
): () => void {
  const job = runningJobs.get(jobId);
  if (job) {
    job.listeners.add(listener);
    return () => job.listeners.delete(listener);
  }

  let pending = pendingListeners.get(jobId);
  if (!pending) {
    pending = new Set();
    pendingListeners.set(jobId, pending);
  }
  pending.add(listener);
  return () => {
    pendingListeners.get(jobId)?.delete(listener);
  };
}

function emitJobEvent(jobId: string, event: StreamEvent): void {
  const job = runningJobs.get(jobId);
  if (!job) return;
  job.listeners.forEach((listener) => listener(event));
}

export function isJobRunning(jobId: string): boolean {
  return runningJobs.has(jobId);
}

export function getJobState(jobId: string): JobState | null {
  const job = runningJobs.get(jobId);
  return job ? job.state : null;
}

export function stopJob(jobId: string): void {
  const job = runningJobs.get(jobId);
  if (!job) return;
  job.controller.abort();
  runningJobs.delete(jobId);
  pendingListeners.delete(jobId);
}

/** 上下文参数：客户端工具执行时使用，无标注项目时为 null */
export interface ClientToolContext {
  project: AnnotationProjectSnapshot;
  detectionModels: PretrainedModelConfig[];
  currentFileAbsolutePath: string | null;
  /** 对话上下文 transcript，透传给 batch/mutation prepare API */
  conversationTranscript?: string;
}

/**
 * 执行单个客户端工具，收集结果摘要并转发 StreamEvent 到 jobId 监听者。
 * 返回 JSON 序列化的结果字符串（作为 ToolMessage 内容传回后端）。
 */
type ClientToolResultPayload = {
  status: 'completed' | 'error' | 'skipped';
  tool: string;
  user_request: string;
  summary: string;
  message?: string;
  file_written?: boolean;
  proposal_pending?: boolean;
};

function formatClientToolResult(payload: ClientToolResultPayload): string {
  return JSON.stringify(payload);
}

/** 直连 LLM 时后端无法注入摘要，把摘要拼入 systemPrompt */
function composeDirectSystemPrompt(
  systemPrompt: string | undefined,
  contextSummary: string | undefined,
): string | undefined {
  const summary = contextSummary?.trim();
  if (!summary) return systemPrompt;
  const summaryBlock = `【此前对话摘要】\n${summary}`;
  return systemPrompt ? `${systemPrompt}\n\n${summaryBlock}` : summaryBlock;
}

function pendingToolCallsFromEvent(
  event: StreamEvent,
): ClientToolCall[] | null {
  if (event.type === 'tool_pending') {
    const e = event as Record<string, unknown>;
    return (e.toolCalls ?? e.client_tool_calls) as ClientToolCall[] | null;
  }
  return null;
}

const ANNOTATION_CLIENT_TOOLS = new Set(['auto_annotate', 'mutate_annotation']);

async function runClientTool(
  toolCall: ClientToolCall,
  jobId: string,
  providerId: string,
  sessionId: string | undefined,
  ctx: ClientToolContext | null,
  clientContext: ClientContextPayload | null | undefined,
  signal: AbortSignal,
  onPersistEvent?: (event: StreamEvent) => void,
  providerApiKey = '',
  providerBaseUrl = '',
  providerModel = '',
  providerSupportsVision = false,
): Promise<string> {
  const userRequest =
    (toolCall.arguments as { user_request?: string }).user_request?.trim() ||
    JSON.stringify(toolCall.arguments);

  const emit = (event: StreamEvent): void => {
    emitJobEvent(jobId, event);
    onPersistEvent?.(event);
  };

  if (
    clientContext?.workMode === 'editor' &&
    ANNOTATION_CLIENT_TOOLS.has(toolCall.name)
  ) {
    return formatClientToolResult({
      status: 'error',
      tool: toolCall.name,
      user_request: userRequest,
      summary: '编辑器模式下不可用标注工具',
      message: 'annotation_tools_disabled_in_editor_mode',
    });
  }

  if (toolCall.name === 'auto_annotate') {
    if (!ctx) {
      return formatClientToolResult({
        status: 'error',
        tool: 'auto_annotate',
        user_request: userRequest,
        summary: '未绑定标注项目，无法执行自动标注',
        message: '未绑定标注项目，无法执行自动标注',
      });
    }
    const scopeHint =
      (toolCall.arguments as { scope_hint?: string }).scope_hint?.trim() ||
      undefined;
    const controller = new AbortController();
    signal.addEventListener('abort', () => controller.abort());
    const onEvent = (event: StreamEvent): void => {
      emit(event);
    };
    try {
      const batchResult = await startAnnotationBatchJob({
        jobId,
        providerId,
        userRequest,
        preselectedPaths: [],
        sessionId,
        project: ctx.project,
        currentFileAbsolutePath: ctx.currentFileAbsolutePath,
        detectionModels: ctx.detectionModels,
        onEvent,
        signal: controller.signal,
        providerApiKey,
        providerBaseUrl,
        providerModel,
        providerSupportsVision,
        scopeHint,
      });
      return formatClientToolResult({
        status:
          batchResult.status === 'completed' ? 'completed' : batchResult.status,
        tool: 'auto_annotate',
        user_request: userRequest,
        summary: batchResult.summary,
        message: batchResult.summary,
        file_written: false,
      });
    } catch {
      return formatClientToolResult({
        status: 'error',
        tool: 'auto_annotate',
        user_request: userRequest,
        summary: '自动标注流水线执行失败',
        message: '自动标注流水线执行失败',
        file_written: false,
      });
    }
  }

  if (toolCall.name === 'mutate_annotation') {
    if (!ctx) {
      return formatClientToolResult({
        status: 'error',
        tool: 'mutate_annotation',
        user_request: userRequest,
        summary: '未绑定标注项目，无法执行标注变更',
        message: '未绑定标注项目，无法执行标注变更',
      });
    }
    const controller = new AbortController();
    signal.addEventListener('abort', () => controller.abort());
    try {
      await startAnnotationMutationJob({
        jobId,
        providerId,
        userRequest,
        sessionId,
        conversationTranscript: ctx.conversationTranscript,
        project: ctx.project,
        currentFileAbsolutePath: ctx.currentFileAbsolutePath,
        signal: controller.signal,
        onEvent: emit,
      });
    } catch {
      // already emitted
    }
    return formatClientToolResult({
      status: 'completed',
      tool: 'mutate_annotation',
      user_request: userRequest,
      summary: '标注变更流水线已完成，提案已发送给用户确认。',
    });
  }

  return formatClientToolResult({
    status: 'error',
    tool: toolCall.name,
    user_request: userRequest,
    summary: `未知客户端工具: ${toolCall.name}`,
    message: `未知客户端工具: ${toolCall.name}`,
  });
}

export async function startChatJob(options: {
  jobId: string;
  session: AgentSession;
  messageIds: string[];
  sessionMessages: Record<string, ChatMessage>;
  providerId: string;
  providerBaseUrl: string;
  providerApiKey: string;
  providerModel: string;
  providerSupportsVision?: boolean;
  userMessageId: string;
  assistantMessageId: string;
  userContent: string;
  truncateFromMessageId?: string | null;
  clientContext?: ClientContextPayload;
  systemPrompt?: string;
  /** 客户端工具执行所需上下文，有标注项目时传入 */
  clientToolContext?: ClientToolContext | null;
  onPersistEvent?: (event: StreamEvent) => void;
}): Promise<void> {
  if (runningJobs.has(options.jobId)) return;

  const controller = new AbortController();
  const job: RunningJob = {
    controller,
    listeners: new Set(),
    state: JobState.Registered,
  };
  runningJobs.set(options.jobId, job);
  attachPendingListeners(options.jobId, job);

  // 有工作区或标注项目上下文 → 需要工具 → 走后端 SSE
  // 纯文本无上下文 → 直连 LLM
  const needsTools = Boolean(
    options.clientContext?.workspaceRoot ||
    options.clientContext?.activeAnnotationProjectId ||
    options.session.annotationProjectId,
  );
  const useDirect = !needsTools && Boolean(options.providerApiKey);

  // ── Debug Logger ────────────────────────────────────────────────────────
  const debugLogger = createDebugLogger(options.jobId);
  debugLogger.logJobState(JobState.Registered);

  // Log send context once at entry
  const msgsForSend = buildBackendMessages(
    options.messageIds,
    options.sessionMessages,
  );
  debugLogger.logSendContext({
    jobId: options.jobId,
    providerId: options.providerId,
    sessionId: options.session.id,
    messages: msgsForSend,
    userContent: options.userContent,
    clientContext: options.clientContext,
    clientToolResults: undefined,
  });

  // ── 内部：执行一轮 SSE 流并处理 tool_pending 的 resume 循环 ──────
  const runLoop = async (
    accumulatedResults: ClientToolResult[] = [],
  ): Promise<void> => {
    if (controller.signal.aborted) return;

    // 若携带累积结果，标记为 resume 状态并记录
    if (accumulatedResults.length > 0) {
      job.state = JobState.Resuming;
      debugLogger.logJobState(JobState.Resuming);
    }

    const stream = useDirect
      ? streamChatDirectly(
          {
            providerId: options.providerId,
            baseUrl: options.providerBaseUrl,
            apiKey: options.providerApiKey,
            model: options.providerModel,
            sessionId: options.session.id,
            userMessageId: options.userMessageId,
            assistantMessageId: options.assistantMessageId,
            messages: buildBackendMessages(
              options.messageIds,
              options.sessionMessages,
            ),
            userContent: options.userContent,
            systemPrompt: composeDirectSystemPrompt(
              options.systemPrompt,
              options.session.contextSummary,
            ),
          },
          controller.signal,
        )
      : needsTools
        ? streamChatViaBackend(
            {
              providerId: options.providerId,
              sessionId: options.session.id,
              userMessageId: options.userMessageId,
              assistantMessageId: options.assistantMessageId,
              messages: buildBackendMessages(
                options.messageIds,
                options.sessionMessages,
              ),
              context: {
                summary: options.session.contextSummary,
                summaryUpToMessageId: options.session.summaryUpToMessageId,
                config: DEFAULT_CHAT_CONTEXT_CONFIG,
              },
              clientJobId: options.jobId,
              truncateFromMessageId: options.truncateFromMessageId,
              userContent: options.userContent,
              clientContext: options.clientContext,
              clientToolResults:
                accumulatedResults.length > 0 ? accumulatedResults : undefined,
              apiKey: options.providerApiKey,
              baseUrl: options.providerBaseUrl,
              model: options.providerModel,
              supportsVision: options.providerSupportsVision,
              systemPrompt: options.systemPrompt,
            },
            controller.signal,
          )
        : mockChatStream(options.userContent, controller.signal);

    let pendingToolCalls: ClientToolCall[] | null = null;
    let finished = false;

    // 累积本轮 LLM 输出的文本
    let accumulatedText = '';

    for await (const event of stream) {
      emitJobEvent(options.jobId, event);
      options.onPersistEvent?.(event);

      // 收集 text_delta 文本用于最终汇总
      if (event.type === 'text_delta') {
        accumulatedText += event.content;
      }

      // 调试输出（text_delta/reasoning_delta 不逐条打印）
      if (event.type !== 'text_delta' && event.type !== 'reasoning_delta') {
        debugLogger.logEvent(event);
      }

      if (event.type === 'done') {
        job.state = JobState.Done;
        debugLogger.logJobState(JobState.Done);
        debugLogger.logTextOutput(accumulatedText);
        finished = true;
        break;
      }
      if (event.type === 'error' || controller.signal.aborted) {
        job.state = controller.signal.aborted
          ? JobState.Cancelled
          : JobState.Error;
        debugLogger.logJobState(job.state);
        debugLogger.logTextOutput(accumulatedText);
        break;
      }
      const pending = pendingToolCallsFromEvent(event);
      if (pending) {
        job.state = JobState.ToolPending;
        debugLogger.logJobState(JobState.ToolPending);
        debugLogger.logTextOutput(accumulatedText);
        pendingToolCalls = pending;
        break;
      }
    }

    if (controller.signal.aborted) return;

    // ── 有客户端工具需要执行：分派 → 收集结果 → resume ──────────────────
    if (pendingToolCalls && pendingToolCalls.length > 0) {
      const results: ClientToolResult[] = [];
      for (const toolCall of pendingToolCalls) {
        // Debug: log client tool dispatch
        console.log(
          `%c[LR-Agent]%c ⚡ runClientTool %c${toolCall.name}`,
          'color: #ff9800; font-weight:bold;',
          '',
          'color: #4caf50;',
        );
        const result = await runClientTool(
          toolCall,
          options.jobId,
          options.providerId,
          options.session.id,
          options.clientToolContext ?? null,
          options.clientContext,
          controller.signal,
          options.onPersistEvent,
          options.providerApiKey,
          options.providerBaseUrl,
          options.providerModel,
          options.providerSupportsVision ?? false,
        );
        results.push({
          toolCallId: toolCall.toolCallId,
          name: toolCall.name,
          result,
        });
        console.log(
          `%c[LR-Agent]%c ⚡ clientToolResult %c${toolCall.name}%c → ${result.slice(0, 120)}`,
          'color: #ff9800; font-weight:bold;',
          '',
          'color: #4caf50;',
          '',
        );
        if (controller.signal.aborted) return;
      }
      const allResults = [...accumulatedResults, ...results];
      // 递归 resume：携带累积的全部 client tool 结果
      await runLoop(allResults);
      return;
    }

    if (!controller.signal.aborted && !finished) {
      emitJobEvent(options.jobId, { type: 'done' });
    }
  };

  try {
    await runLoop();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return;
    }
    const errorMsg = err instanceof Error ? err.message : '流式请求失败';
    console.log(
      `%c[LR-Agent]%c ❌ startChatJob error %c${errorMsg}`,
      'color: #ff9800; font-weight:bold;',
      '',
      'color: #f44336; font-weight:bold;',
    );
    emitJobEvent(options.jobId, {
      type: 'error',
      message: errorMsg,
    });
  } finally {
    runningJobs.delete(options.jobId);
    pendingListeners.delete(options.jobId);
  }
}

export async function startAnnotationBatchJobRunner(options: {
  jobId: string;
  providerId: string;
  userRequest: string;
  preselectedPaths?: string[];
  sessionId?: string;
  project: AnnotationProjectSnapshot;
  currentFileAbsolutePath: string | null;
  detectionModels: PretrainedModelConfig[];
  onPersistEvent?: (event: StreamEvent) => void;
  providerApiKey?: string;
  providerBaseUrl?: string;
  providerModel?: string;
  providerSupportsVision?: boolean;
}): Promise<void> {
  if (runningJobs.has(options.jobId)) return;

  const controller = new AbortController();
  const job: RunningJob = {
    controller,
    listeners: new Set(),
    state: JobState.Registered,
  };
  runningJobs.set(options.jobId, job);
  attachPendingListeners(options.jobId, job);

  try {
    await startAnnotationBatchJob({
      jobId: options.jobId,
      providerId: options.providerId,
      userRequest: options.userRequest,
      preselectedPaths: options.preselectedPaths,
      sessionId: options.sessionId,
      project: options.project,
      currentFileAbsolutePath: options.currentFileAbsolutePath,
      detectionModels: options.detectionModels,
      signal: controller.signal,
      onEvent: (event) => emitJobEvent(options.jobId, event),
      onPersistEvent: options.onPersistEvent,
      providerApiKey: options.providerApiKey ?? '',
      providerBaseUrl: options.providerBaseUrl ?? '',
      providerModel: options.providerModel ?? '',
      providerSupportsVision: options.providerSupportsVision ?? false,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return;
    }
    emitJobEvent(options.jobId, {
      type: 'error',
      message: err instanceof Error ? err.message : '批量标注失败',
    });
  } finally {
    runningJobs.delete(options.jobId);
    pendingListeners.delete(options.jobId);
  }
}

export async function startAnnotationMutationJobRunner(options: {
  jobId: string;
  providerId: string;
  userRequest: string;
  sessionId?: string;
  project: AnnotationProjectSnapshot;
  currentFileAbsolutePath: string | null;
  onPersistEvent?: (event: StreamEvent) => void;
}): Promise<void> {
  if (runningJobs.has(options.jobId)) return;

  const controller = new AbortController();
  const job: RunningJob = {
    controller,
    listeners: new Set(),
    state: JobState.Registered,
  };
  runningJobs.set(options.jobId, job);
  attachPendingListeners(options.jobId, job);

  try {
    await startAnnotationMutationJob({
      jobId: options.jobId,
      providerId: options.providerId,
      userRequest: options.userRequest,
      sessionId: options.sessionId,
      project: options.project,
      currentFileAbsolutePath: options.currentFileAbsolutePath,
      signal: controller.signal,
      onEvent: (event) => emitJobEvent(options.jobId, event),
      onPersistEvent: options.onPersistEvent,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return;
    }
    emitJobEvent(options.jobId, {
      type: 'error',
      message: err instanceof Error ? err.message : '标注变更失败',
    });
  } finally {
    runningJobs.delete(options.jobId);
    pendingListeners.delete(options.jobId);
  }
}
