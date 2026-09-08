import { createAgentId } from '../../../shared/agentTypes';
import type {
  AnnotationBatchChange,
  AnnotationBatchProposal,
  AnnotationProjectSnapshot,
  ImageCandidate,
} from '../../../shared/annotationAgentTypes';
import { prepareMutationAnnotation } from '../annotationAgentApi';
import { getAnnotationWorkspaceAgentSnapshot } from '../annotationAgentBridge';
import { logAnnotationDebug } from './annotationAgentDebug';
import {
  labelIdByName,
  readBboxesForPath,
  resolveMutationTargets,
  type MutationOperationSpec,
} from './mutationTargetResolver';

export type MutationProgressEvent =
  | {
      type: 'progress';
      stage: string;
      message: string;
      status?: 'running' | 'done' | 'error';
      detail?: string;
    }
  | { type: 'proposal'; proposal: AnnotationBatchProposal }
  | { type: 'text'; content: string }
  | { type: 'error'; message: string };

function progress(
  stage: string,
  message: string,
  status: 'running' | 'done' | 'error' = 'running',
  detail?: string,
): MutationProgressEvent {
  return { type: 'progress', stage, message, status, detail };
}

export async function* runAnnotationMutationJob(options: {
  providerId: string;
  userRequest: string;
  sessionId?: string;
  conversationTranscript?: string;
  project: AnnotationProjectSnapshot;
  currentFileAbsolutePath: string | null;
  candidates: ImageCandidate[];
  currentRelativePath: string;
  selectedAnnotationIds?: string[];
  isCancelled?: () => boolean;
}): AsyncGenerator<MutationProgressEvent> {
  const {
    providerId,
    userRequest,
    sessionId,
    project,
    candidates,
    currentRelativePath,
  } = options;

  yield progress('prepare', '解析标注变更意图', 'running');

  let prepareResult;
  try {
    const wsSnap = getAnnotationWorkspaceAgentSnapshot();
    const selectedIds =
      options.selectedAnnotationIds ??
      wsSnap.selectedAnnotationIds ??
      (wsSnap.selectedAnnotationId ? [wsSnap.selectedAnnotationId] : []);

    prepareResult = await prepareMutationAnnotation(providerId, {
      userRequest,
      sessionId,
      conversationTranscript: options.conversationTranscript,
      currentRelativePath,
      candidates,
      labelCandidates: project.labels.map((l) => ({ id: l.id, name: l.name })),
      project,
      selectedAnnotationIds: selectedIds,
    });
  } catch (err) {
    yield progress(
      'prepare',
      '变更准备失败',
      'error',
      err instanceof Error ? err.message : undefined,
    );
    yield {
      type: 'error',
      message: err instanceof Error ? err.message : '变更准备失败',
    };
    return;
  }

  if (options.isCancelled?.()) return;

  const operations = (prepareResult.operations ??
    []) as MutationOperationSpec[];
  if (operations.length === 0 && !prepareResult.selected_paths?.length) {
    yield progress('prepare', '未识别变更目标', 'error');
    yield {
      type: 'text',
      content:
        prepareResult.intent_summary ||
        '未能识别要修改或删除的标注。请指定文件与框（如「把 data/7.jpg 左侧 person 改成 worker」），或先在画布选中框。',
    };
    return;
  }

  yield progress(
    'prepare',
    '变更意图已解析',
    'done',
    prepareResult.intent_summary,
  );
  yield progress('resolve', '定位标注目标', 'running');

  const changes: AnnotationBatchChange[] = [];
  const resolveErrors: string[] = [];
  const wsSnap = getAnnotationWorkspaceAgentSnapshot();
  const selectedIds =
    options.selectedAnnotationIds ??
    wsSnap.selectedAnnotationIds ??
    (wsSnap.selectedAnnotationId ? [wsSnap.selectedAnnotationId] : []);

  const candidateByPath = new Map(
    candidates.map((c) => [c.relativePath, c] as const),
  );

  for (const op of operations) {
    const rel = op.relative_path?.replace(/\\/g, '/');
    if (!rel) continue;
    const image = candidateByPath.get(rel);
    if (!image) {
      resolveErrors.push(`${rel}: 不在候选列表`);
      continue;
    }

    const bboxes = await readBboxesForPath(project.directoryPath, rel);
    let targets = op.targets ?? [];
    if (op.mutation_kind === 'delete' && targets.length === 0) {
      targets = [{ by: 'all' }];
    }
    const { ids, errors } = resolveMutationTargets(
      bboxes,
      targets,
      project.labels,
      selectedIds,
    );
    resolveErrors.push(...errors.map((e) => `${rel}: ${e}`));

    if (ids.length === 0) {
      resolveErrors.push(`${rel}: 未解析到任何目标框`);
      continue;
    }

    if (op.mutation_kind === 'delete') {
      changes.push({
        relativePath: rel,
        absolutePath: image.absolutePath,
        operation: 'delete',
        deleteIds: ids,
      });
    } else {
      const labelId = labelIdByName(op.new_label_name, project.labels);
      if (!labelId) {
        resolveErrors.push(`${rel}: 未知标签 ${op.new_label_name ?? ''}`);
        continue;
      }
      changes.push({
        relativePath: rel,
        absolutePath: image.absolutePath,
        operation: 'patch',
        patches: ids.map((id) => ({ id, labelId })),
      });
    }
  }

  if (changes.length === 0) {
    yield progress(
      'resolve',
      '目标解析失败',
      'error',
      resolveErrors.join('；') || undefined,
    );
    yield {
      type: 'text',
      content: `未能定位要变更的标注框。${resolveErrors.join('；')}`,
    };
    return;
  }

  yield progress(
    'resolve',
    `已定位 ${changes.length} 个文件变更`,
    'done',
    resolveErrors.length ? resolveErrors.join('；') : undefined,
  );

  const patchCount = changes.reduce(
    (n, c) =>
      n +
      (c.patches?.length ?? c.deleteIds?.length ?? c.annotations?.length ?? 0),
    0,
  );

  const proposal: AnnotationBatchProposal = {
    id: createAgentId('mutation-proposal'),
    projectId: project.projectId,
    summary: prepareResult.intent_summary || userRequest,
    changes,
    stats: {
      kind: 'bbox' as const,
      processed: changes.length,
      succeeded: changes.length,
      skipped: 0,
      totalBoxes: patchCount,
    },
    createdAt: Date.now(),
  };

  logAnnotationDebug('mutation-proposal', '变更提案', {
    changes: changes.length,
    patchCount,
  });

  yield { type: 'proposal', proposal };
}
