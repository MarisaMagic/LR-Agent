/**
 * 确定性快路径：detect（本地 YOLO）→ map（API，服务端读本地路径）→ finalize。
 * 固定流程：本地 detect → map API → finalize。
 */
import { mapDetectionBoxesUnified } from '../annotationAgentApi';
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
  });

  if (
    useVision &&
    mapResult.ok === false &&
    (mapResult as { error?: string }).error === 'image_unavailable'
  ) {
    const tRead = performance.now();
    const imageBase64 = await readImageBase64(image.absolutePath);
    timing.read_image_ms = Math.round(performance.now() - tRead);
    logAnnotationDebug('read-image-fallback', image.relativePath, {
      elapsed_ms: timing.read_image_ms,
      reason: '服务端无法读取本地路径，回退 base64',
    });
    mapResult = await mapDetectionBoxesUnified(options.providerId, {
      userRequest: options.userRequest,
      intentSummary: plan.intent_summary,
      labelCandidates: options.labelCandidates,
      boxes: mapBoxesPayload,
      useVision,
      labelStrategy: plan.label_strategy,
      singleLabelId,
      annotationScope: { ...plan.annotation_scope },
      imageBase64,
    });
  }

  timing.map_ms = Math.round(performance.now() - tMap);
  ctx.mappings = mapResult.mappings ?? [];
  ctx.mapMethod = mapResult.method ?? '';
  ctx.mapHint = mapResult.hint ?? '';
  const mapMappings = formatMapMappingRows(ctx.mappings, options.labelCandidates);

  logAnnotationDebugMapDetail(image.relativePath, {
    elapsed_ms: timing.map_ms,
    mapResult,
    labelCandidates: options.labelCandidates,
    userRequest: options.userRequest,
    intentSummary: plan.intent_summary,
  });

  const auto = tryAutoFinalizeFromMap({
    plan,
    imageRelativePath: image.relativePath,
    imageAbsolutePath: image.absolutePath,
    boxes: ctx.boxes,
    mappings: ctx.mappings,
    labelCandidates: options.labelCandidates,
  });

  timing.total_ms = Math.round(performance.now() - totalStarted);

  if (auto.ok && auto.change) {
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
      mapMappings,
    });
  }

  const mappedCount = ctx.mappings.filter((m) => m.label_id).length;
  return withTiming({
    ...base,
    reason: auto.reason || ctx.mapHint || `成功映射 ${mappedCount} 框，不足 ${minLabeled}`,
    rawCount: ctx.rawCount,
    keptCount: ctx.keptCount,
    mappedCount,
    unmappedCount: Math.max(0, ctx.keptCount - mappedCount),
    method: ctx.mapMethod,
    mapHint: ctx.mapHint,
    mapMappings,
  });
}
