import type { AnnotationProjectSnapshot } from '../../shared/annotationAgentTypes';
import type { StreamEvent } from '../../shared/agentTypes';
import { ANNOTATION_BATCH_MAX_FILES } from '../../shared/annotationAgentTypes';
import {
  runAnnotationMutationJob,
  type MutationProgressEvent,
} from './annotationAgent/mutationOrchestrator';
import { getRelativeProjectPath } from '../utils/projectPaths';

export async function startAnnotationMutationJob(options: {
  jobId: string;
  providerId: string;
  userRequest: string;
  sessionId?: string;
  project: AnnotationProjectSnapshot;
  currentFileAbsolutePath: string | null;
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
    const currentRel =
      options.currentFileAbsolutePath &&
      getRelativeProjectPath(
        options.project.directoryPath,
        options.currentFileAbsolutePath,
      );

    const catalog = await window.electron?.annotationAgent?.listImages(
      options.project.directoryPath,
      ANNOTATION_BATCH_MAX_FILES * 4,
    );
    const candidates = (catalog ?? []).map((c) => ({
      relativePath: c.relativePath,
      name: c.name,
      parent: c.parent,
      absolutePath: c.absolutePath,
      index: c.index,
    }));

    for await (const event of runAnnotationMutationJob({
      providerId: options.providerId,
      userRequest: options.userRequest,
      sessionId: options.sessionId,
      project: options.project,
      currentFileAbsolutePath: options.currentFileAbsolutePath,
      candidates,
      currentRelativePath: currentRel ?? '',
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
      message: err instanceof Error ? err.message : '标注变更失败',
    });
  }
}

function mapAndEmit(
  event: MutationProgressEvent,
  onEvent: (event: StreamEvent) => void,
): void {
  if (event.type === 'progress') {
    onEvent({
      type: 'annotation_progress',
      stage: event.stage,
      message: event.message,
      status: event.status,
      detail: event.detail,
      pipelineKind: 'mutation',
    });
    return;
  }
  if (event.type === 'proposal') {
    const summary = event.proposal.summary?.trim();
    if (summary) {
      onEvent({ type: 'text_delta', content: `${summary}\n` });
    }
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
