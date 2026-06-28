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
import {
  buildBackendMessages,
  sessionContextPayload,
  streamChatViaBackend,
} from './backendChatClient';
import { startAnnotationBatchJob } from './annotationBatchJob';
import { startAnnotationMutationJob } from './annotationMutationBatchJob';
import { startAnalysisBatchJob } from './analysisBatchJob';
import { cancelChatJobOnApi } from './llmProviderApi';
import tokenHolder from './tokenHolder';

export type JobEventListener = (event: StreamEvent) => void;

interface RunningJob {
  controller: AbortController;
  listeners: Set<JobEventListener>;
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

export function stopJob(jobId: string): void {
  const job = runningJobs.get(jobId);
  if (!job) return;
  job.controller.abort();
  runningJobs.delete(jobId);
  pendingListeners.delete(jobId);
  if (tokenHolder.getAccessToken()) {
    cancelChatJobOnApi(jobId).catch(() => undefined);
  }
}

/** 上下文参数：客户端工具执行时使用，无标注项目时为 null */
export interface ClientToolContext {
  project: AnnotationProjectSnapshot;
  detectionModels: PretrainedModelConfig[];
  currentFileAbsolutePath: string | null;
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

function pendingToolCallsFromEvent(event: StreamEvent): ClientToolCall[] | null {
  if (event.type === 'tool_pending') {
    return event.toolCalls;
  }
  if (event.type === 'client_tool_pending') {
    return event.clientToolCalls;
  }
  return null;
}

const ANNOTATION_CLIENT_TOOLS = new Set([
  'execute_batch_annotation',
  'mutate_annotation',
  'analyze_data',
]);

async function runClientTool(
  toolCall: ClientToolCall,
  jobId: string,
  providerId: string,
  sessionId: string | undefined,
  ctx: ClientToolContext | null,
  clientContext: ClientContextPayload | null | undefined,
  signal: AbortSignal,
  onPersistEvent?: (event: StreamEvent) => void,
): Promise<string> {
  const userRequest =
    (toolCall.arguments as { user_request?: string }).user_request ??
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

  if (toolCall.name === 'execute_batch_annotation') {
    if (!ctx) {
      return formatClientToolResult({
        status: 'error',
        tool: 'execute_batch_annotation',
        user_request: userRequest,
        summary: '未绑定标注项目，无法执行批量标注',
        message: '未绑定标注项目，无法执行批量标注',
      });
    }
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
      });
      return formatClientToolResult({
        status: batchResult.status === 'completed' ? 'completed' : batchResult.status,
        tool: 'execute_batch_annotation',
        user_request: userRequest,
        summary: batchResult.summary,
        message: batchResult.summary,
        file_written: false,
      });
    } catch {
      return formatClientToolResult({
        status: 'error',
        tool: 'execute_batch_annotation',
        user_request: userRequest,
        summary: '批量标注流水线执行失败',
        message: '批量标注流水线执行失败',
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

  if (toolCall.name === 'analyze_data') {
    if (!ctx) {
      return formatClientToolResult({
        status: 'error',
        tool: 'analyze_data',
        user_request: userRequest,
        summary: '未绑定标注项目，无法执行数据分析',
        message: '未绑定标注项目，无法执行数据分析',
      });
    }
    const controller = new AbortController();
    signal.addEventListener('abort', () => controller.abort());
    let analysisResult: string | null = null;
    const onEvent = (event: StreamEvent): void => {
      emit(event);
      if (event.type === 'analysis_script_proposal' && event.result) {
        analysisResult = event.result;
      }
    };
    try {
      await startAnalysisBatchJob({
        providerId,
        userRequest,
        project: ctx.project,
        sessionId,
        signal: controller.signal,
        onEvent,
      });
    } catch {
      // already emitted
    }
    return formatClientToolResult({
      status: 'completed',
      tool: 'analyze_data',
      user_request: userRequest,
      summary: analysisResult ?? '分析脚本已执行，结果已展示给用户。',
      file_written: false,
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
  userMessageId: string;
  assistantMessageId: string;
  userContent: string;
  truncateFromMessageId?: string | null;
  clientContext?: ClientContextPayload;
  /** 客户端工具执行所需上下文，有标注项目时传入 */
  clientToolContext?: ClientToolContext | null;
  onPersistEvent?: (event: StreamEvent) => void;
}): Promise<void> {
  if (runningJobs.has(options.jobId)) return;

  const controller = new AbortController();
  const job: RunningJob = {
    controller,
    listeners: new Set(),
  };
  runningJobs.set(options.jobId, job);
  attachPendingListeners(options.jobId, job);

  const useBackend = Boolean(tokenHolder.getAccessToken());

  // ── 内部：执行一轮 SSE 流并处理 client_tool_pending 的 resume 循环 ──────
  const runLoop = async (accumulatedResults: ClientToolResult[] = []): Promise<void> => {
    if (controller.signal.aborted) return;

    const stream = useBackend
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
            context: sessionContextPayload(options.session),
            clientJobId: options.jobId,
            truncateFromMessageId: options.truncateFromMessageId,
            userContent: options.userContent,
            clientContext: options.clientContext,
            clientToolResults:
              accumulatedResults.length > 0 ? accumulatedResults : undefined,
          },
          controller.signal,
        )
      : mockChatStream(options.userContent, controller.signal);

    let pendingToolCalls: ClientToolCall[] | null = null;
    let finished = false;

    for await (const event of stream) {
      emitJobEvent(options.jobId, event);
      options.onPersistEvent?.(event);

      if (event.type === 'done') {
        finished = true;
        break;
      }
      if (event.type === 'error' || controller.signal.aborted) {
        break;
      }
      const pending = pendingToolCallsFromEvent(event);
      if (pending) {
        pendingToolCalls = pending;
        break;
      }
    }

    if (controller.signal.aborted) return;

    // ── 有客户端工具需要执行：分派 → 收集结果 → resume ──────────────────
    if (pendingToolCalls && pendingToolCalls.length > 0) {
      const results: ClientToolResult[] = [];
      for (const toolCall of pendingToolCalls) {
        const result = await runClientTool(
          toolCall,
          options.jobId,
          options.providerId,
          options.session.id,
          options.clientToolContext ?? null,
          options.clientContext,
          controller.signal,
          options.onPersistEvent,
        );
        results.push({
          toolCallId: toolCall.toolCallId,
          name: toolCall.name,
          result,
        });
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
    emitJobEvent(options.jobId, {
      type: 'error',
      message: err instanceof Error ? err.message : '流式请求失败',
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
}): Promise<void> {
  if (runningJobs.has(options.jobId)) return;

  const controller = new AbortController();
  const job: RunningJob = {
    controller,
    listeners: new Set(),
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

export async function startAnalysisJobRunner(options: {
  jobId: string;
  providerId: string;
  userRequest: string;
  sessionId?: string;
  project: AnnotationProjectSnapshot;
  onPersistEvent?: (event: StreamEvent) => void;
}): Promise<void> {
  if (runningJobs.has(options.jobId)) return;

  const controller = new AbortController();
  const job: RunningJob = {
    controller,
    listeners: new Set(),
  };
  runningJobs.set(options.jobId, job);
  attachPendingListeners(options.jobId, job);

  try {
    await startAnalysisBatchJob({
      providerId: options.providerId,
      userRequest: options.userRequest,
      project: options.project,
      sessionId: options.sessionId,
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
      message: err instanceof Error ? err.message : '数据分析失败',
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
