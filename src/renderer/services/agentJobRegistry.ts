import type { LlmProviderConfig, StreamEvent } from '../../shared/agentTypes';
import { mockStreamResponse } from './agentStreamMock';
import {
  canUseLiveStream,
  streamChatCompletion,
} from './llmStreamClient';

export type JobEventListener = (event: StreamEvent) => void;

interface RunningJob {
  controller: AbortController;
  listeners: Set<JobEventListener>;
}

const runningJobs = new Map<string, RunningJob>();

export function subscribeJobEvents(
  jobId: string,
  listener: JobEventListener,
): () => void {
  const job = runningJobs.get(jobId);
  if (!job) return () => undefined;
  job.listeners.add(listener);
  return () => job.listeners.delete(listener);
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
}

export async function startChatJob(options: {
  jobId: string;
  provider: LlmProviderConfig;
  apiMessages: Array<{ role: string; content: string }>;
  userContent: string;
}): Promise<void> {
  if (runningJobs.has(options.jobId)) return;

  const controller = new AbortController();
  runningJobs.set(options.jobId, {
    controller,
    listeners: new Set(),
  });

  const stream = canUseLiveStream(options.provider)
    ? streamChatCompletion(
        options.provider,
        options.apiMessages,
        controller.signal,
      )
    : mockStreamResponse(options.userContent, controller.signal);

  try {
    for await (const event of stream) {
      emitJobEvent(options.jobId, event);
      if (
        event.type === 'done' ||
        event.type === 'error' ||
        controller.signal.aborted
      ) {
        break;
      }
    }
    if (!controller.signal.aborted) {
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
  }
}
