import type { AnnotationProjectSnapshot } from '../../shared/annotationAgentTypes';
import type { StreamEvent, TurnKind } from '../../shared/agentTypes';
import {
  runReportJob,
  type ReportProgressEvent,
} from './agentReport/reportRunner';

export async function startReportBatchJob(options: {
  providerId: string;
  userRequest: string;
  project: AnnotationProjectSnapshot;
  turnKind: TurnKind;
  sessionId?: string;
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
    for await (const event of runReportJob({
      providerId: options.providerId,
      userRequest: options.userRequest,
      project: options.project,
      turnKind: options.turnKind,
      sessionId: options.sessionId,
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
      message: err instanceof Error ? err.message : '报告生成失败',
    });
  }
}

function mapAndEmit(
  event: ReportProgressEvent,
  onEvent: (event: StreamEvent) => void,
): void {
  if (event.type === 'progress') {
    onEvent({
      type: 'annotation_progress',
      stage: event.stage,
      message: event.message,
      status: event.status,
      detail: event.detail,
      pipelineKind: 'report',
    });
    return;
  }
  if (event.type === 'document_proposal') {
    const title = event.title?.trim() || '报告';
    const summary = event.summary?.trim();
    if (summary) {
      onEvent({
        type: 'text_delta',
        content: `[报告] ${title}: ${summary}\n`,
      });
    }
    onEvent({
      type: 'document_proposal',
      title: event.title,
      content: event.content,
      suggestedRelativePath: event.suggestedRelativePath,
      status: 'pending',
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
