import type { AnnotationProjectSnapshot } from '../../shared/annotationAgentTypes';
import type { PretrainedModelConfig } from '../types/pretrainedModel';
import type { StreamEvent } from '../../shared/agentTypes';
import {
  runAnnotationBatchJob,
  type AnnotationProgressEvent,
} from './annotationAgent/batchOrchestrator';

export async function startAnnotationBatchJob(options: {
  jobId: string;
  providerId: string;
  userRequest: string;
  preselectedPaths?: string[];
  sessionId?: string;
  project: AnnotationProjectSnapshot;
  currentFileAbsolutePath: string | null;
  detectionModels: PretrainedModelConfig[];
  onEvent: (event: StreamEvent) => void;
  onPersistEvent?: (event: StreamEvent) => void;
  signal: AbortSignal;
}): Promise<void> {
  const emit = (event: StreamEvent): void => {
    options.onEvent(event);
    options.onPersistEvent?.(event);
  };
  const isCancelled = () => options.signal.aborted;

  try {
    for await (const event of runAnnotationBatchJob({
      providerId: options.providerId,
      userRequest: options.userRequest,
      preselectedPaths: options.preselectedPaths,
      sessionId: options.sessionId,
      project: options.project,
      currentFileAbsolutePath: options.currentFileAbsolutePath,
      detectionModels: options.detectionModels,
      isCancelled,
    })) {
      if (isCancelled()) break;
      mapAndEmit(event, emit);
      if (event.type === 'error') break;
    }
    if (!isCancelled()) {
      emit({ type: 'done' });
    }
  } catch (err) {
    if (options.signal.aborted) return;
    emit({
      type: 'error',
      message: err instanceof Error ? err.message : '批量标注失败',
    });
  }
}

function mapAndEmit(
  event: AnnotationProgressEvent,
  onEvent: (event: StreamEvent) => void,
): void {
  if (event.type === 'progress') {
    onEvent({
      type: 'annotation_progress',
      stage: event.stage,
      message: event.message,
      status: event.status,
      detail: event.detail,
    });
    return;
  }
  if (event.type === 'tool') {
    if (event.status !== 'done' || !event.result) {
      return;
    }
    onEvent({
      type: 'tool_start',
      toolCallId: event.toolCallId,
      name: event.name,
      arguments: event.arguments,
    });
    onEvent({
      type: 'tool_result',
      toolCallId: event.toolCallId,
      result: event.result,
    });
    return;
  }
  if (event.type === 'proposal') {
    onEvent({ type: 'annotation_proposal', proposal: event.proposal });
    return;
  }
  if (event.type === 'text') {
    onEvent({ type: 'text_delta', content: event.content });
    return;
  }
  if (event.type === 'error') {
    onEvent({ type: 'error', message: event.message });
  }
}
