import type { AnnotationProjectSnapshot } from '../../shared/annotationAgentTypes';
import type { StreamEvent } from '../../shared/agentTypes';
import {
  runDataAnalysisJob,
  type AnalysisProgressEvent,
} from './agentDataAnalysis/dataAnalysisRunner';

export async function startAnalysisBatchJob(options: {
  providerId: string;
  userRequest: string;
  project: AnnotationProjectSnapshot;
  sessionId?: string;
  onEvent: (event: StreamEvent) => void;
  onPersistEvent?: (event: StreamEvent) => void;
  signal: AbortSignal;
  providerApiKey?: string;
  providerBaseUrl?: string;
  providerModel?: string;
}): Promise<void> {
  const emit = (event: StreamEvent): void => {
    options.onEvent(event);
    options.onPersistEvent?.(event);
  };
  const isCancelled = () => options.signal.aborted;

  try {
    for await (const event of runDataAnalysisJob({
      providerId: options.providerId,
      userRequest: options.userRequest,
      project: options.project,
      sessionId: options.sessionId,
      isCancelled,
      signal: options.signal,
      providerApiKey: options.providerApiKey,
      providerBaseUrl: options.providerBaseUrl,
      providerModel: options.providerModel,
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
      message: err instanceof Error ? err.message : '数据分析失败',
    });
  }
}

function mapAndEmit(
  event: AnalysisProgressEvent,
  onEvent: (event: StreamEvent) => void,
): void {
  if (event.type === 'progress') {
    onEvent({
      type: 'annotation_progress',
      stage: event.stage,
      message: event.message,
      status: event.status,
      detail: event.detail,
      pipelineKind: 'analysis' as const,
    });
    return;
  }
  if (event.type === 'analysis_script_proposal') {
    onEvent({
      type: 'analysis_script_proposal',
      script: event.script,
      explanation: event.explanation,
      status: event.status ?? 'pending',
      result: event.result,
      error: event.error,
    });
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
