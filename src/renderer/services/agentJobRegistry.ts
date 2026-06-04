import type {
  AgentSession,
  ChatMessage,
  ClientContextPayload,
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
        },
        controller.signal,
      )
    : mockChatStream(options.userContent, controller.signal);

  try {
    let finished = false;
    for await (const event of stream) {
      emitJobEvent(options.jobId, event);
      if (event.type === 'done') {
        finished = true;
      }
      if (
        event.type === 'done' ||
        event.type === 'error' ||
        controller.signal.aborted
      ) {
        break;
      }
    }
    if (!controller.signal.aborted && !finished) {
      emitJobEvent(options.jobId, { type: 'done' });
    }
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
