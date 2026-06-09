/**
 * 确定性快路径：detect（本地 YOLO）→ map（API，服务端读本地路径）→ finalize。
 * 固定流程：本地 detect → map API → finalize → optional JudgeAgent。
 */
import {
  judgeDetectionLabels,
  mapDetectionBoxesUnified,
  type JudgeDetectionLabelsResult,
  type MapDetectionBoxesUnifiedResult,
} from '../annotationAgentApi';
import type { BatchAnnotationPlan, ImageCandidate } from '../../../shared/annotationAgentTypes';
import type { PretrainedModelConfig } from '../../types/pretrainedModel';
import type { SubImageTimingBreakdown } from './annotationTiming';
import { tryAutoFinalizeFromMap } from './finalizeFromMappings';
import {
  formatMapMappingRows,
  logAnnotationDebug,
  logAnnotationDebugMapDetail,
} from './annotationAgentDebug';
import type { FusionSubImageResult } from './fusionSubImageTypes';
import {
  readImageBase64,
  runObjectDetectionForSubAgent,
  type SubImageToolContext,
} from './fusionSubImageTools';

export async function runDeterministicSubImageAgent(options: {
  providerId: string;
  userRequest: string;
  plan: BatchAnnotationPlan;
  image: ImageCandidate;
  detectionModel: PretrainedModelConfig;
  labelCandidates: Array<{ id: string; name: string }>;
  onProgress?: (event: {
    stage: string;
    message: string;
    status?: 'running' | 'done' | 'error';
    detail?: string;
    imagePath?: string;
  }) => void;
}): Promise<FusionSubImageResult> {
  const { image, plan } = options;
  const base = {
    ok: false as const,
    relativePath: image.relativePath,
    absolutePath: image.absolutePath,
  };
  const minLabeled = plan.sub_agent_constraints.min_labeled_box_count ?? 1;
  const useVision = Boolean(plan.use_vision_mapping);
  const totalStarted = performance.now();
  const timing: SubImageTimingBreakdown = { total_ms: 0 };

  logAnnotationDebug('sub-agent-start', image.relativePath, {
    mode: 'deterministic',
    provider_id: options.providerId,
    use_vision_mapping: useVision,
    detection_model: options.detectionModel.id,
    user_request: options.userRequest.trim() || undefined,
    intent_summary: plan.intent_summary?.trim() || undefined,
  });

  const ctx: SubImageToolContext = {
    boxes: [],
    rawCount: 0,
    keptCount: 0,
    excludedCount: 0,
    mappings: [],
    mapMethod: '',
    mapHint: '',
  };

  const tDetect = performance.now();
  const det = await runObjectDetectionForSubAgent(
    image,
    plan,
    options.detectionModel,
    {},
  );
  timing.detect_ms = Math.round(performance.now() - tDetect);
  ctx.rawCount = det.rawCount;
  ctx.keptCount = det.keptCount;
  ctx.excludedCount = det.excludedCount;
  ctx.boxes = det.boxes;

  const withTiming = (result: FusionSubImageResult): FusionSubImageResult => ({
    ...result,
    elapsedMs: timing.total_ms,
    timing,
  });

  if (ctx.keptCount === 0) {
    const reason =
      ctx.rawCount > 0
        ? `检测到 ${ctx.rawCount} 个框但全部在范围外`
        : '检测未返回框（可能置信度过高或未检测到目标）';
    timing.total_ms = Math.round(performance.now() - totalStarted);
    return withTiming({
      ...base,
      reason,
      rawCount: ctx.rawCount,
      keptCount: 0,
    });
  }

  const singleLabelId =
    plan.label_strategy === 'single_label_for_all_boxes' &&
    options.labelCandidates.length === 1
      ? options.labelCandidates[0].id
      : null;

  const mapBoxesPayload = ctx.boxes.map((b) => ({
    box_index: b.box_index,
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    class_name: b.class_name,
    confidence: b.confidence,
  }));

  let imageBase64 = '';
  const ensureImageBase64 = async (): Promise<string> => {
    if (imageBase64) return imageBase64;
    const tRead = performance.now();
    imageBase64 = await readImageBase64(image.absolutePath);
    timing.read_image_ms =
      (timing.read_image_ms ?? 0) + Math.round(performance.now() - tRead);
    logAnnotationDebug('read-image-fallback', image.relativePath, {
      elapsed_ms: timing.read_image_ms,
      reason: '服务端无法读取本地路径，回退 base64',
    });
    return imageBase64;
  };

  const runMap = async (
    attempt: number,
    judgeFeedback: string,
    previousMappings: Array<{ box_index: number; label_id: string; reason?: string }>,
  ): Promise<MapDetectionBoxesUnifiedResult> => {
    const tMap = performance.now();
    let mapResult = await mapDetectionBoxesUnified(options.providerId, {
      userRequest: options.userRequest,
      intentSummary: plan.intent_summary,
      labelCandidates: options.labelCandidates,
      boxes: mapBoxesPayload,
      useVision,
      labelStrategy: plan.label_strategy,
      singleLabelId,
      annotationScope: { ...plan.annotation_scope },
      imageAbsolutePath: image.absolutePath,
      judgeFeedback,
      previousMappings,
      attempt,
    });

    if (
      useVision &&
      mapResult.ok === false &&
      (mapResult as { error?: string }).error === 'image_unavailable'
    ) {
      const fallbackBase64 = await ensureImageBase64();
      mapResult = await mapDetectionBoxesUnified(options.providerId, {
        userRequest: options.userRequest,
        intentSummary: plan.intent_summary,
        labelCandidates: options.labelCandidates,
        boxes: mapBoxesPayload,
        useVision,
        labelStrategy: plan.label_strategy,
        singleLabelId,
        annotationScope: { ...plan.annotation_scope },
        imageBase64: fallbackBase64,
        judgeFeedback,
        previousMappings,
        attempt,
      });
    }
    timing.map_ms = (timing.map_ms ?? 0) + Math.round(performance.now() - tMap);
    return mapResult;
  };

  const runJudge = async (
    attempt: number,
    mappings: Array<{ box_index: number; label_id: string; reason?: string }>,
    annotations: Array<Record<string, unknown>>,
  ): Promise<JudgeDetectionLabelsResult> => {
    const maxRetries = Math.max(0, plan.judge_config?.maxRetries ?? 3);
    const tJudge = performance.now();
    try {
      let judge = await judgeDetectionLabels(options.providerId, {
        userRequest: options.userRequest,
        intentSummary: plan.intent_summary,
        labelCandidates: options.labelCandidates,
        boxes: mapBoxesPayload,
        mappings,
        annotations,
        imageAbsolutePath: image.absolutePath,
        attempt,
        maxRetries,
      });
      if (judge.ok === false && judge.error === 'image_unavailable') {
        const fallbackBase64 = await ensureImageBase64();
        judge = await judgeDetectionLabels(options.providerId, {
          userRequest: options.userRequest,
          intentSummary: plan.intent_summary,
          labelCandidates: options.labelCandidates,
          boxes: mapBoxesPayload,
          mappings,
          annotations,
          imageBase64: fallbackBase64,
          attempt,
          maxRetries,
        });
      }
      return judge;
    } catch (err) {
      return {
        ok: false,
        verdict: 'weak_accept',
        confidence: 0,
        summary:
          err instanceof Error
            ? `评分失败，按弱通过处理：${err.message}`
            : '评分失败，按弱通过处理',
        issues: [],
        retryFeedback: '',
        checkedBoxes: mappings.length,
      };
    } finally {
      timing.judge_ms = (timing.judge_ms ?? 0) + Math.round(performance.now() - tJudge);
    }
  };

  const judgeEnabled = useVision && (plan.judge_config?.enabled ?? true);
  const maxJudgeRetries = judgeEnabled ? Math.max(0, plan.judge_config?.maxRetries ?? 3) : 0;
  let judgeFeedback = '';
  let previousMappings: Array<{ box_index: number; label_id: string; reason?: string }> = [];
  let judgeAttempts = 0;
  let judgeRetryRounds = 0;
  let lastJudge: JudgeDetectionLabelsResult | undefined;
  let lastMapMappings = formatMapMappingRows([], options.labelCandidates);

  for (let attempt = 0; attempt <= maxJudgeRetries; attempt += 1) {
    const mapResult = await runMap(attempt, judgeFeedback, previousMappings);
    ctx.mappings = mapResult.mappings ?? [];
    ctx.mapMethod = mapResult.method ?? '';
    ctx.mapHint = mapResult.hint ?? '';
    lastMapMappings = formatMapMappingRows(ctx.mappings, options.labelCandidates);

    logAnnotationDebugMapDetail(image.relativePath, {
      elapsed_ms: timing.map_ms,
      mapResult,
      labelCandidates: options.labelCandidates,
      userRequest: options.userRequest,
      intentSummary: plan.intent_summary,
      judge_feedback: judgeFeedback || undefined,
      attempt,
    });

    const auto = tryAutoFinalizeFromMap({
      plan,
      imageRelativePath: image.relativePath,
      imageAbsolutePath: image.absolutePath,
      boxes: ctx.boxes,
      mappings: ctx.mappings,
      labelCandidates: options.labelCandidates,
    });

    if (!auto.ok || !auto.change) {
      const mappedCount = ctx.mappings.filter((m) => m.label_id).length;
      timing.total_ms = Math.round(performance.now() - totalStarted);
      return withTiming({
        ...base,
        reason: auto.reason || ctx.mapHint || `成功映射 ${mappedCount} 框，不足 ${minLabeled}`,
        rawCount: ctx.rawCount,
        keptCount: ctx.keptCount,
        mappedCount,
        unmappedCount: Math.max(0, ctx.keptCount - mappedCount),
        method: ctx.mapMethod,
        mapHint: ctx.mapHint,
        mapMappings: lastMapMappings,
        judge: lastJudge,
        judgeAttempts,
        judgeRetryRounds,
      });
    }

    if (!judgeEnabled) {
      timing.total_ms = Math.round(performance.now() - totalStarted);
      logAnnotationDebug('sub-agent-done', image.relativePath, {
        elapsed_ms: timing.total_ms,
        ok: true,
        mode: 'deterministic',
        timing,
        method: ctx.mapMethod,
      });
      return withTiming({
        ok: true,
        relativePath: image.relativePath,
        absolutePath: image.absolutePath,
        change: auto.change,
        rawCount: ctx.rawCount,
        keptCount: ctx.keptCount,
        mappedCount: auto.mappedCount,
        unmappedCount: Math.max(0, ctx.keptCount - auto.mappedCount),
        autoFinalized: true,
        method: ctx.mapMethod,
        mapMappings: lastMapMappings,
      });
    }

    options.onProgress?.({
      stage: 'judge',
      message: `评分：${image.relativePath}`,
      status: 'running',
      detail: attempt > 0 ? `第 ${attempt + 1} 轮` : undefined,
      imagePath: image.relativePath,
    });
    lastJudge = await runJudge(
      attempt,
      ctx.mappings,
      auto.change.annotations as unknown as Array<Record<string, unknown>>,
    );
    judgeAttempts += 1;
    const judgeSummary = {
      ...lastJudge,
      attempts: judgeAttempts,
      retryRounds: judgeRetryRounds,
    };

    logAnnotationDebug('judge', image.relativePath, {
      verdict: lastJudge.verdict,
      confidence: lastJudge.confidence,
      summary: lastJudge.summary,
      issue_count: lastJudge.issues?.length ?? 0,
      attempt,
    });

    if (lastJudge.verdict === 'accept' || lastJudge.verdict === 'weak_accept') {
      options.onProgress?.({
        stage: 'judge',
        message: `评分完成：${image.relativePath}`,
        status: 'done',
        detail: [
          lastJudge.verdict === 'weak_accept' ? '弱通过' : '通过',
          lastJudge.confidence != null ? `置信度 ${lastJudge.confidence.toFixed(2)}` : '',
          lastJudge.summary,
        ]
          .filter(Boolean)
          .join(' · '),
        imagePath: image.relativePath,
      });
      timing.total_ms = Math.round(performance.now() - totalStarted);
      logAnnotationDebug('sub-agent-done', image.relativePath, {
        elapsed_ms: timing.total_ms,
        ok: true,
        mode: 'deterministic',
        timing,
        method: ctx.mapMethod,
        judge_verdict: lastJudge.verdict,
      });
      return withTiming({
        ok: true,
        relativePath: image.relativePath,
        absolutePath: image.absolutePath,
        change: { ...auto.change, judge: judgeSummary },
        rawCount: ctx.rawCount,
        keptCount: ctx.keptCount,
        mappedCount: auto.mappedCount,
        unmappedCount: Math.max(0, ctx.keptCount - auto.mappedCount),
        autoFinalized: true,
        method: ctx.mapMethod,
        mapMappings: lastMapMappings,
        judge: judgeSummary,
        judgeAttempts,
        judgeRetryRounds,
        weakAccepted: lastJudge.verdict === 'weak_accept',
      });
    }

    if (attempt < maxJudgeRetries) {
      judgeRetryRounds += 1;
      judgeFeedback =
        lastJudge.retryFeedback?.trim() ||
        lastJudge.summary?.trim() ||
        '评分子 Agent 判定存在标签错误，请重新结合整图和检测框分配标签。';
      options.onProgress?.({
        stage: 'retry',
        message: `重新打标签：${image.relativePath}`,
        status: 'running',
        detail: `Judge 拒绝，第 ${judgeRetryRounds} 次重试 · ${judgeFeedback}`,
        imagePath: image.relativePath,
      });
      previousMappings = ctx.mappings;
      continue;
    }

    options.onProgress?.({
      stage: 'judge',
      message: `评分拒绝：${image.relativePath}`,
      status: 'error',
      detail: lastJudge.summary || lastJudge.retryFeedback || '标签质量未通过',
      imagePath: image.relativePath,
    });
    timing.total_ms = Math.round(performance.now() - totalStarted);
    return withTiming({
      ...base,
      reason: `评分拒绝：${lastJudge.summary || lastJudge.retryFeedback || '标签质量未通过'}`,
      rawCount: ctx.rawCount,
      keptCount: ctx.keptCount,
      mappedCount: auto.mappedCount,
      unmappedCount: Math.max(0, ctx.keptCount - auto.mappedCount),
      method: ctx.mapMethod,
      mapHint: ctx.mapHint,
      mapMappings: lastMapMappings,
      judge: {
        ...lastJudge,
        attempts: judgeAttempts,
        retryRounds: judgeRetryRounds,
      },
      judgeAttempts,
      judgeRetryRounds,
      rejectedByJudge: true,
    });
  }

  const mappedCount = ctx.mappings.filter((m) => m.label_id).length;
  timing.total_ms = Math.round(performance.now() - totalStarted);
  return withTiming({
    ...base,
    reason: ctx.mapHint || `成功映射 ${mappedCount} 框，不足 ${minLabeled}`,
    rawCount: ctx.rawCount,
    keptCount: ctx.keptCount,
    mappedCount,
    unmappedCount: Math.max(0, ctx.keptCount - mappedCount),
    method: ctx.mapMethod,
    mapHint: ctx.mapHint,
    mapMappings: lastMapMappings,
    judge: lastJudge,
    judgeAttempts,
    judgeRetryRounds,
  });
}
