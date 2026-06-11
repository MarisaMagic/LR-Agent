import { createAgentId } from '../../../shared/agentTypes';
import type {
  AnnotationBatchProposal,
  AnnotationProjectSnapshot,
  BatchAnnotationPlan,
  BatchPrepareResult,
  ImageCandidate,
} from '../../../shared/annotationAgentTypes';
import {
  ANNOTATION_BATCH_CONCURRENCY,
  ANNOTATION_BATCH_MAX_FILES,
} from '../../../shared/annotationAgentTypes';
import {
  logAnnotationDebug,
  logAnnotationDebugImageResult,
  logAnnotationDebugPlan,
} from './annotationAgentDebug';
import type { PretrainedModelConfig } from '../../types/pretrainedModel';
import { getEligiblePreAnnotModels, pickDefaultPreAnnotModel } from '../../utils/preAnnotModelFilter';
import { prepareBatchAnnotation } from '../annotationAgentApi';
import { getRelativeProjectPath } from '../../utils/projectPaths';
import { imagesFromAgentPaths } from './scopeSelection';
import { AsyncEventQueue } from './asyncEventQueue';
import {
  applyScopeToPlan,
  mergeEffectiveDetectionScope,
} from './detectionScope';
import {
  AnnotationStageTimer,
  appendTimingDetail,
  formatDurationMs,
  formatSubImageTiming,
} from './annotationTiming';
import { runFusionSubImageAgent, type FusionSubImageResult } from './fusionSubImageRunner';

type WorkerResult = FusionSubImageResult;

export type AnnotationProgressEvent =
  | {
      type: 'progress';
      stage: string;
      message: string;
      status?: 'running' | 'done' | 'error';
      detail?: string;
      imagePath?: string;
    }
  | {
      type: 'tool';
      toolCallId: string;
      name: string;
      arguments: string;
      status: 'running' | 'done';
      result?: string;
    }
  | { type: 'proposal'; proposal: AnnotationBatchProposal }
  | { type: 'text'; content: string }
  | { type: 'error'; message: string };

function progress(
  stage: string,
  message: string,
  status: 'running' | 'done' | 'error' = 'running',
  detail?: string,
  imagePath?: string,
): AnnotationProgressEvent {
  return { type: 'progress', stage, message, status, detail, imagePath };
}

function planFromBatchPrepare(data: BatchPrepareResult): BatchAnnotationPlan {
  const {
    selected_paths: _paths,
    scope_reason: _reason,
    ...plan
  } = data;
  const rawJudgeConfig = (plan as BatchAnnotationPlan & {
    judge_config?: { enabled?: boolean; maxRetries?: number; max_retries?: number };
  }).judge_config;
  if (rawJudgeConfig) {
    (plan as BatchAnnotationPlan).judge_config = {
      enabled: Boolean(rawJudgeConfig.enabled),
      maxRetries: Math.max(
        0,
        Number(rawJudgeConfig.maxRetries ?? rawJudgeConfig.max_retries ?? 3),
      ),
    };
  }
  return plan;
}

function formatWorkerDetailParts(result: WorkerResult): string[] {
  const fusion = result as FusionSubImageResult;
  const parts = [
    `映射 ${result.mappedCount ?? 0} 框`,
    fusion.rawCount != null ? `检测 ${fusion.rawCount}→保留 ${fusion.keptCount ?? 0}` : '',
    fusion.unmappedCount != null ? `未映射 ${fusion.unmappedCount}` : '',
    fusion.method ? `方式 ${fusion.method}` : '',
    fusion.judge
      ? `评分 ${fusion.judge.verdict === 'weak_accept' ? '弱通过' : fusion.judge.verdict === 'accept' ? '通过' : '拒绝'}`
      : '',
    fusion.judge?.confidence != null ? `评分置信度 ${fusion.judge.confidence.toFixed(2)}` : '',
    fusion.judgeRetryRounds ? `重试 ${fusion.judgeRetryRounds} 次` : '',
  ].filter(Boolean) as string[];
  if (fusion.timing) {
    parts.push(formatSubImageTiming(fusion.timing));
  } else if (result.elapsedMs != null) {
    parts.push(`总 ${formatDurationMs(result.elapsedMs)}`);
  }
  return parts;
}

async function* drainConcurrentPipelines(
  images: ImageCandidate[],
  concurrency: number,
  runOne: (
    image: ImageCandidate,
    index: number,
    push: (e: AnnotationProgressEvent) => void,
  ) => Promise<WorkerResult>,
): AsyncGenerator<AnnotationProgressEvent, WorkerResult[]> {
  const queue = new AsyncEventQueue<AnnotationProgressEvent>();
  const results: WorkerResult[] = new Array(images.length);
  let nextIndex = 0;
  let active = 0;
  let completed = 0;

  const pump = (): void => {
    while (active < concurrency && nextIndex < images.length) {
      const idx = nextIndex;
      nextIndex += 1;
      active += 1;
      const image = images[idx];
      void runOne(image, idx, (e) => queue.push(e))
        .then((result) => {
          results[idx] = result;
        })
        .catch((err) => {
          results[idx] = {
            ok: false,
            relativePath: image.relativePath,
            absolutePath: image.absolutePath,
            reason: err instanceof Error ? err.message : '处理失败',
          };
        })
        .finally(() => {
          active -= 1;
          completed += 1;
          if (completed >= images.length) {
            queue.close();
          } else {
            pump();
          }
        });
    }
  };

  pump();

  while (true) {
    const ev = await queue.take();
    if (ev === null) break;
    yield ev;
  }

  return results;
}

export async function* runAnnotationBatchJob(options: {
  providerId: string;
  userRequest: string;
  /** 仅 UI 显式勾选等场景传入；对话 Agent 不传，由 batch-prepare 每轮选图 */
  preselectedPaths?: string[];
  sessionId?: string;
  project: AnnotationProjectSnapshot;
  currentFileAbsolutePath: string | null;
  detectionModels: PretrainedModelConfig[];
  isCancelled?: () => boolean;
}): AsyncGenerator<AnnotationProgressEvent> {
  const { project, userRequest, providerId } = options;

  if (project.modality !== 'image' || project.annotationType !== 'bbox') {
    yield {
      type: 'error',
      message: '当前仅支持已打开的图片矩形框标注项目的批量 Agent 标注。',
    };
    return;
  }

  const batchTimer = new AnnotationStageTimer();
  const currentRel =
    options.currentFileAbsolutePath &&
    getRelativeProjectPath(project.directoryPath, options.currentFileAbsolutePath);

  const labelCandidates = project.labels.map((l) => ({ id: l.id, name: l.name }));
  const detectionSummaries = getEligiblePreAnnotModels('bbox', options.detectionModels).map(
    (m) => ({
      id: m.id,
      name: m.name ?? m.id,
      isDefault: m.isDefault,
    }),
  );

  yield progress('prepare', '正在准备批量标注（范围与计划）…');
  batchTimer.mark('prepare');

  let scopeReason = '';
  let images: ImageCandidate[] = [];
  let plan: BatchAnnotationPlan;
  let effectiveUserRequest = userRequest;

  try {
    const catalog = await window.electron?.annotationAgent?.listImages(
      project.directoryPath,
      ANNOTATION_BATCH_MAX_FILES * 4,
    );
    const candidates: ImageCandidate[] = (catalog ?? []).map((c) => ({
      relativePath: c.relativePath,
      name: c.name,
      parent: c.parent,
      absolutePath: c.absolutePath,
      index: c.index,
    }));

    const prepared = await prepareBatchAnnotation(providerId, {
      userRequest: effectiveUserRequest,
      preselectedPaths: options.preselectedPaths,
      sessionId: options.sessionId,
      currentRelativePath: currentRel ?? '',
      candidates,
      labelCandidates,
      detectionModels: detectionSummaries,
      project,
    });
    effectiveUserRequest =
      prepared.resolved_user_request?.trim() || userRequest;

    scopeReason = prepared.scope_reason ?? '';
    const { images: resolved, missing } = imagesFromAgentPaths(
      candidates,
      prepared.selected_paths ?? [],
      ANNOTATION_BATCH_MAX_FILES,
    );
    images = resolved;
    if (missing.length) {
      scopeReason = `${scopeReason}；未匹配：${missing.join(', ')}`.trim();
    }

    let rawPlan = planFromBatchPrepare(prepared);
    const effectiveScope = mergeEffectiveDetectionScope(
      prepared.annotation_scope,
      rawPlan.annotation_scope,
    );
    plan = applyScopeToPlan(rawPlan, effectiveScope);

    logAnnotationDebugPlan({
      ...plan,
      annotation_scope: plan.annotation_scope as Record<string, unknown>,
      detection_hints: plan.detection_hints as Record<string, unknown>,
      sub_agent_constraints: plan.sub_agent_constraints as Record<string, unknown>,
    });

    const prepareMs = batchTimer.lap('prepare');
    const scopeHint =
      effectiveScope.scope_summary?.trim() ||
      (effectiveScope.include_detection_labels?.length
        ? `检测白名单：${effectiveScope.include_detection_labels.join(', ')}`
        : effectiveScope.exclude_detection_labels?.length
          ? `检测排除：${effectiveScope.exclude_detection_labels.join(', ')}`
          : '检测范围：未限定（保留全部检测类）');

    logAnnotationDebug('prepare', '批量准备完成', {
      elapsed_ms: Math.round(prepareMs),
      image_count: images.length,
      paths: images.map((i) => i.relativePath),
      reason: scopeReason,
      use_vision_mapping: plan.use_vision_mapping,
      intent_summary: plan.intent_summary,
      resolved_user_request: effectiveUserRequest.trim() || undefined,
      project_label_names: labelCandidates.map((l) => l.name),
    });

    const detail = [
      images.length ? `已选定 ${images.length} 张图片` : scopeReason || '未选定图片',
      scopeHint,
      appendTimingDetail(undefined, prepareMs),
    ]
      .filter(Boolean)
      .join(' · ');

    yield progress(
      'prepare',
      images.length ? '批量准备完成' : '未选定图片',
      images.length ? 'done' : 'error',
      detail || undefined,
    );
  } catch (err) {
    yield progress(
      'prepare',
      '批量准备失败',
      'error',
      err instanceof Error ? err.message : undefined,
    );
    yield {
      type: 'error',
      message: err instanceof Error ? err.message : '批量准备失败',
    };
    return;
  }

  if (images.length === 0) {
    yield {
      type: 'text',
      content:
        scopeReason ||
        '未识别为批量标注请求。请更具体说明文件夹或文件名（如 data 下的 7.jpg 和 8.jpg），或切换到 Ask 模式进行问答。',
    };
    return;
  }

  const preferredId = plan.detection_hints.model_id;
  let detModel =
    options.detectionModels.find((m) => m.id === preferredId && m.enabled) ?? null;
  if (!detModel) {
    detModel = pickDefaultPreAnnotModel('bbox', options.detectionModels);
  }
  if (!detModel) {
    yield {
      type: 'error',
      message: '未找到可用的目标检测预训练模型，请先在「预训练模型」中配置并启用 YOLO 模型。',
    };
    return;
  }

  logAnnotationDebug('batch-setup', '批量配置', {
    providerId,
    plan_use_vision_mapping: plan.use_vision_mapping,
    label_strategy: plan.label_strategy,
    intent_summary: plan.intent_summary,
    effective_user_request: effectiveUserRequest.trim() || undefined,
    detection_model_id: detModel.id,
    detection_model_name: detModel.name,
    label_names: labelCandidates.map((l) => l.name),
    annotation_scope: plan.annotation_scope,
    note: '后端终端查看 provider_model / provider_is_vision / map-api 日志',
  });

  const total = images.length;
  yield progress('workers', `共 ${total} 张图片，子 Agent 并发处理`, 'running');
  batchTimer.mark('workers');

  const pipelineGen = drainConcurrentPipelines(
    images,
    ANNOTATION_BATCH_CONCURRENCY,
    async (image, index, push) => {
      if (options.isCancelled?.()) {
        return {
          ok: false,
          relativePath: image.relativePath,
          absolutePath: image.absolutePath,
          reason: '已取消',
        };
      }
      push(
        progress(
          'worker',
          `处理中 (${index + 1}/${total})：${image.relativePath}`,
          'running',
          undefined,
          image.relativePath,
        ),
      );
      const imageStarted = performance.now();
      const result = await runFusionSubImageAgent({
        providerId,
        userRequest: effectiveUserRequest,
        plan,
        image,
        detectionModel: detModel!,
        labelCandidates,
        onProgress: (event) => push(progress(
          event.stage,
          event.message,
          event.status ?? 'running',
          event.detail,
          event.imagePath ?? image.relativePath,
        )),
      });
      if (result.elapsedMs == null) {
        result.elapsedMs = Math.round(performance.now() - imageStarted);
      }
      return result;
    },
  );

  let workerResults: WorkerResult[] = [];
  while (true) {
    const next = await pipelineGen.next();
    if (next.done) {
      workerResults = next.value ?? [];
      break;
    }
    yield next.value;
  }

  for (const result of workerResults) {
    if (result.ok) {
      const fusion = result as FusionSubImageResult;
      logAnnotationDebugImageResult(result.relativePath, {
        ok: true,
        rawCount: fusion.rawCount,
        keptCount: fusion.keptCount,
        mappedCount: fusion.mappedCount,
        unmappedCount: fusion.unmappedCount,
        method: fusion.method,
        autoFinalized: fusion.autoFinalized,
        mappings: fusion.mapMappings,
        judge: fusion.judge,
        judge_retry_rounds: fusion.judgeRetryRounds,
      });
      const detailParts = formatWorkerDetailParts(result);
      yield progress(
        'worker',
        `完成：${result.relativePath}`,
        'done',
        detailParts.join(' · ') || undefined,
        result.relativePath,
      );
    } else {
      const fusionFail = result as FusionSubImageResult;
      logAnnotationDebugImageResult(result.relativePath, {
        ok: false,
        reason: result.reason,
        rawCount: fusionFail.rawCount,
        keptCount: fusionFail.keptCount,
        mappedCount: fusionFail.mappedCount,
        unmappedCount: fusionFail.unmappedCount,
        method: fusionFail.method,
        mapHint: fusionFail.mapHint,
        mappings: fusionFail.mapMappings,
        judge: fusionFail.judge,
        judge_retry_rounds: fusionFail.judgeRetryRounds,
        rejected_by_judge: fusionFail.rejectedByJudge,
      });
      const skipDetail = [
        result.reason,
        formatWorkerDetailParts(result).join(' · '),
      ]
        .filter(Boolean)
        .join(' · ');
      yield progress(
        'worker',
        `跳过：${result.relativePath}`,
        'error',
        skipDetail || undefined,
        result.relativePath,
      );
    }
  }

  const succeeded = workerResults.filter((r) => r.ok && r.change);
  const skipped = workerResults.filter((r) => !r.ok);

  const workersMs = batchTimer.lap('workers');
  const batchTotalMs = batchTimer.total();
  logAnnotationDebug('workers', '图片处理结束', {
    elapsed_ms: Math.round(workersMs),
    batch_total_ms: Math.round(batchTotalMs),
    image_count: total,
    succeeded: succeeded.length,
    skipped: skipped.length,
  });
  yield progress(
    'workers',
    `批量处理完成 · 成功 ${succeeded.length} · 跳过 ${skipped.length} · 共 ${total} 张`,
    'done',
    `本阶段 ${formatDurationMs(workersMs)} · 全流程累计 ${formatDurationMs(batchTotalMs)}`,
  );
  const totalBoxes = succeeded.reduce(
    (sum, r) => sum + (r.change?.annotations?.length ?? 0),
    0,
  );
  const judged = workerResults.filter((r) => Boolean((r as FusionSubImageResult).judge)).length;
  const accepted = succeeded.filter(
    (r) => (r as FusionSubImageResult).judge?.verdict === 'accept',
  ).length;
  const weakAccepted = succeeded.filter(
    (r) => (r as FusionSubImageResult).judge?.verdict === 'weak_accept',
  ).length;
  const rejected = skipped.filter(
    (r) => (r as FusionSubImageResult).rejectedByJudge,
  ).length;
  const retryRounds = workerResults.reduce(
    (sum, r) => sum + ((r as FusionSubImageResult).judgeRetryRounds ?? 0),
    0,
  );

  if (succeeded.length === 0) {
    const detail = skipped
      .map((r) => `${r.relativePath}: ${r.reason ?? '未知原因'}`)
      .slice(0, 6)
      .join('；');
    yield {
      type: 'error',
      message: `未能生成可应用的批量标注。${detail ? `详情：${detail}` : ''}`,
    };
    return;
  }

  const proposal: AnnotationBatchProposal = {
    id: createAgentId('proposal'),
    projectId: project.projectId,
    summary: `批量矩形框标注：${succeeded.length} 张图片，共 ${totalBoxes} 个框`,
    changes: succeeded.map((r) => r.change!),
    stats: {
      processed: workerResults.length,
      succeeded: succeeded.length,
      skipped: skipped.length,
      totalBoxes,
      judged,
      accepted,
      weakAccepted,
      rejected,
      retryRounds,
    },
    plan,
    createdAt: Date.now(),
  };

  const summaryLines = [
    `已处理 ${images.length} 张图片，成功 ${succeeded.length} 张，跳过 ${skipped.length} 张。`,
    `共生成 ${totalBoxes} 个带标签的候选框。`,
    judged
      ? `评分复核：通过 ${accepted} 张，弱通过 ${weakAccepted} 张，拒绝 ${rejected} 张。`
      : '',
    scopeReason ? `范围说明：${scopeReason}` : '',
    plan.plan_steps.length
      ? `计划：\n\n${plan.plan_steps.map((s) => `- ${s}`).join('\n')}`
      : '',
    '请在下方卡片中确认并「应用标注」。',
  ].filter(Boolean);

  yield { type: 'text', content: summaryLines.join('\n\n') };
  yield { type: 'proposal', proposal };
}
