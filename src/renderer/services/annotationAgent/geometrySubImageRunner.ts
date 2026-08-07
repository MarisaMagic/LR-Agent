/**
 * Generalized geometry sub-image agent: PreAnnot inference → map → finalize → judge.
 */
import {
  judgeDetectionLabels,
  mapDetectionBoxesUnified,
  type JudgeDetectionLabelsResult,
  type MapDetectionBoxesUnifiedResult,
} from '../annotationAgentApi';
import type {
  BatchAnnotationPlan,
  ImageCandidate,
  AnnotationBatchChange,
  AnnotationJudgeSummary,
} from '../../../shared/annotationAgentTypes';
import type { PretrainedModelConfig } from '../../types/pretrainedModel';
import type { SubImageTimingBreakdown } from './annotationTiming';
import { tryAutoFinalizeFromGeometry } from './geometryFinalize';
import {
  buildPresetMappings,
  getGeometryAdapter,
  type GeometryAdapterContext,
} from './geometryPipelineAdapter';
import type { GeometryAnnotationType, GeometryInstance } from './geometryTypes';
import { instancesToMapBoxes } from './geometryTypes';
import {
  formatMapMappingRows,
  logAnnotationDebug,
  logAnnotationDebugMapDetail,
} from './annotationAgentDebug';
import type { FusionSubImageResult } from './fusionSubImageTypes';
import { readImageBase64 } from './fusionSubImageTools';

type MappingRow = { box_index: number; label_id: string; reason?: string };

function mergeMappings(base: MappingRow[], updates: MappingRow[]): MappingRow[] {
  const byIndex = new Map<number, MappingRow>();
  for (const row of base) byIndex.set(row.box_index, row);
  for (const row of updates) byIndex.set(row.box_index, row);
  return [...byIndex.values()].sort((a, b) => a.box_index - b.box_index);
}

function extractIssueBoxIndices(judge: JudgeDetectionLabelsResult): number[] {
  const indices = new Set<number>();
  for (const issue of judge.issues ?? []) {
    if (issue.boxIndex != null && Number.isFinite(issue.boxIndex)) {
      indices.add(issue.boxIndex);
    }
  }
  return [...indices];
}

export async function runGeometrySubImageAgent(options: {
  annotationType: GeometryAnnotationType;
  providerId: string;
  userRequest: string;
  plan: BatchAnnotationPlan;
  image: ImageCandidate;
  primaryModel: PretrainedModelConfig;
  secondaryModel?: PretrainedModelConfig | null;
  labelCandidates: Array<{ id: string; name: string }>;
  adapterContext: GeometryAdapterContext;
  onProgress?: (event: {
    stage: string;
    message: string;
    status?: 'running' | 'done' | 'error';
    detail?: string;
    imagePath?: string;
  }) => void;
  providerApiKey?: string;
  providerBaseUrl?: string;
  providerModel?: string;
  providerSupportsVision?: boolean;
  signal?: AbortSignal;
}): Promise<FusionSubImageResult> {
  const { image, plan, annotationType } = options;
  const adapter = getGeometryAdapter(annotationType);
  const base = {
    ok: false as const,
    relativePath: image.relativePath,
    absolutePath: image.absolutePath,
  };
  if (!adapter) {
    return { ...base, reason: `不支持的标注类型：${annotationType}` };
  }

  const minLabeled = plan.sub_agent_constraints.min_labeled_box_count ?? 1;
  const useVision = Boolean(plan.use_vision_mapping);
  const skipMapping = adapter.skipLabelMapping?.(options.adapterContext) ?? false;
  const totalStarted = performance.now();
  const timing: SubImageTimingBreakdown = { total_ms: 0 };

  const throwIfAborted = (): void => {
    if (options.signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
  };

  logAnnotationDebug('sub-agent-start', image.relativePath, {
    mode: 'geometry',
    geometry_type: annotationType,
    provider_id: options.providerId,
    use_vision_mapping: useVision,
    skip_label_mapping: skipMapping,
    primary_model: options.primaryModel.id,
    secondary_model: options.secondaryModel?.id,
    user_request: options.userRequest.trim() || undefined,
  });

  let instances: GeometryInstance[] = [];
  let rawCount = 0;
  let keptCount = 0;
  let excludedCount = 0;
  let mapMethod = '';
  let mapHint = '';

  throwIfAborted();
  const tInfer = performance.now();
  try {
    const inferResult = await adapter.runInference({
      image,
      plan,
      primaryModel: options.primaryModel,
      secondaryModel: options.secondaryModel,
      adapterContext: options.adapterContext,
      onProgress: (message) =>
        options.onProgress?.({
          stage: 'infer',
          message,
          status: 'running',
          imagePath: image.relativePath,
        }),
    });
    instances = inferResult.instances;
    rawCount = inferResult.rawCount;
    keptCount = inferResult.keptCount;
    excludedCount = inferResult.excludedCount;
  } catch (err) {
    timing.total_ms = Math.round(performance.now() - totalStarted);
    return {
      ...base,
      reason: err instanceof Error ? err.message : '几何推理失败',
      elapsedMs: timing.total_ms,
      timing,
    };
  }
  timing.detect_ms = Math.round(performance.now() - tInfer);

  const withTiming = (result: FusionSubImageResult): FusionSubImageResult => ({
    ...result,
    elapsedMs: timing.total_ms,
    timing,
  });

  if (keptCount === 0) {
    const reason =
      rawCount > 0
        ? `检测到 ${rawCount} 个实例但全部在范围外或未生成分割/关键点`
        : '推理未返回实例';
    timing.total_ms = Math.round(performance.now() - totalStarted);
    return withTiming({
      ...base,
      reason,
      rawCount,
      keptCount: 0,
    });
  }

  const mapBoxesPayload = instancesToMapBoxes(instances);
  const singleLabelId =
    plan.label_strategy === 'single_label_for_all_boxes' &&
    options.labelCandidates.length === 1
      ? options.labelCandidates[0].id
      : null;

  let imageBase64 = '';
  const ensureImageBase64 = async (): Promise<string> => {
    if (imageBase64) return imageBase64;
    const tRead = performance.now();
    imageBase64 = await readImageBase64(image.absolutePath);
    timing.read_image_ms =
      (timing.read_image_ms ?? 0) + Math.round(performance.now() - tRead);
    return imageBase64;
  };

  const runMap = async (
    attempt: number,
    judgeFeedback: string,
    previousMappings: MappingRow[],
    boxesOverride?: typeof mapBoxesPayload,
  ): Promise<MapDetectionBoxesUnifiedResult> => {
    throwIfAborted();
    const boxesToMap = boxesOverride ?? mapBoxesPayload;
    const tMap = performance.now();
    let mapResult = await mapDetectionBoxesUnified(options.providerId, {
      userRequest: options.userRequest,
      intentSummary: plan.intent_summary,
      labelCandidates: options.labelCandidates,
      boxes: boxesToMap,
      useVision,
      labelStrategy: plan.label_strategy,
      singleLabelId,
      annotationScope: { ...plan.annotation_scope },
      imageAbsolutePath: image.absolutePath,
      judgeFeedback,
      previousMappings,
      attempt,
      providerApiKey: options.providerApiKey ?? '',
      providerBaseUrl: options.providerBaseUrl ?? '',
      providerModel: options.providerModel ?? '',
      providerSupportsVision: options.providerSupportsVision ?? false,
      signal: options.signal,
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
        boxes: boxesToMap,
        useVision,
        labelStrategy: plan.label_strategy,
        singleLabelId,
        annotationScope: { ...plan.annotation_scope },
        imageBase64: fallbackBase64,
        judgeFeedback,
        previousMappings,
        attempt,
        providerApiKey: options.providerApiKey ?? '',
        providerBaseUrl: options.providerBaseUrl ?? '',
        providerModel: options.providerModel ?? '',
        providerSupportsVision: options.providerSupportsVision ?? false,
        signal: options.signal,
      });
    }
    timing.map_ms = (timing.map_ms ?? 0) + Math.round(performance.now() - tMap);
    return mapResult;
  };

  const runJudge = async (
    attempt: number,
    mappings: MappingRow[],
    annotations: Array<Record<string, unknown>>,
  ): Promise<JudgeDetectionLabelsResult> => {
    throwIfAborted();
    const maxRetries = Math.max(0, plan.judge_config?.maxRetries ?? 1);
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
        providerApiKey: options.providerApiKey ?? '',
        providerBaseUrl: options.providerBaseUrl ?? '',
        providerModel: options.providerModel ?? '',
        providerSupportsVision: options.providerSupportsVision ?? false,
        signal: options.signal,
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
          providerApiKey: options.providerApiKey ?? '',
          providerBaseUrl: options.providerBaseUrl ?? '',
          providerModel: options.providerModel ?? '',
          providerSupportsVision: options.providerSupportsVision ?? false,
          signal: options.signal,
        });
      }
      return judge;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
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
  const maxJudgeRetries = judgeEnabled ? Math.max(0, plan.judge_config?.maxRetries ?? 1) : 0;
  const rejectSubmitPartial = plan.judge_config?.rejectSubmitPartial !== false;
  let judgeFeedback = '';
  let previousMappings: MappingRow[] = [];
  let issueBoxIndices: number[] = [];
  let judgeAttempts = 0;
  let judgeRetryRounds = 0;
  let lastJudge: JudgeDetectionLabelsResult | undefined;
  let lastMapMappings = formatMapMappingRows([], options.labelCandidates);
  let ctxMappings: MappingRow[] = skipMapping ? buildPresetMappings(instances) : [];

  const buildSuccessResult = (
    auto: {
      change?: AnnotationBatchChange;
      mappedCount: number;
      unlabeledInProposal?: number;
    },
    judgeSummary?: AnnotationJudgeSummary & { attempts?: number; retryRounds?: number },
    weakAccepted = false,
  ): FusionSubImageResult => {
    timing.total_ms = Math.round(performance.now() - totalStarted);
    return withTiming({
      ok: true,
      relativePath: image.relativePath,
      absolutePath: image.absolutePath,
      change: judgeSummary ? { ...auto.change!, judge: judgeSummary } : auto.change!,
      rawCount,
      keptCount,
      mappedCount: auto.mappedCount,
      unmappedCount: Math.max(0, keptCount - auto.mappedCount),
      unlabeledInProposal: auto.unlabeledInProposal,
      autoFinalized: true,
      method: mapMethod,
      mapMappings: lastMapMappings,
      judge: judgeSummary,
      judgeAttempts,
      judgeRetryRounds,
      weakAccepted,
    });
  };

  for (let attempt = 0; attempt <= maxJudgeRetries; attempt += 1) {
    throwIfAborted();

    if (!skipMapping) {
      let mapResult: MapDetectionBoxesUnifiedResult;
      if (attempt > 0 && issueBoxIndices.length > 0) {
        const subsetBoxes = mapBoxesPayload.filter((b) =>
          issueBoxIndices.includes(b.box_index),
        );
        mapResult = await runMap(attempt, judgeFeedback, previousMappings, subsetBoxes);
        ctxMappings = mergeMappings(previousMappings, mapResult.mappings ?? []);
      } else {
        mapResult = await runMap(attempt, judgeFeedback, previousMappings);
        ctxMappings = mapResult.mappings ?? [];
      }
      mapMethod = mapResult.method ?? '';
      mapHint = mapResult.hint ?? '';
      lastMapMappings = formatMapMappingRows(ctxMappings, options.labelCandidates);
      logAnnotationDebugMapDetail(image.relativePath, {
        elapsed_ms: timing.map_ms,
        mapResult,
        labelCandidates: options.labelCandidates,
        userRequest: options.userRequest,
        attempt,
      });
    } else if (singleLabelId) {
      ctxMappings = instances.map((inst) => ({
        box_index: inst.instance_index,
        label_id: singleLabelId,
        reason: 'single_label_strategy',
      }));
      mapMethod = 'preset';
      lastMapMappings = formatMapMappingRows(ctxMappings, options.labelCandidates);
    }

    const auto = tryAutoFinalizeFromGeometry({
      plan,
      imageRelativePath: image.relativePath,
      imageAbsolutePath: image.absolutePath,
      instances,
      mappings: ctxMappings,
      labelCandidates: options.labelCandidates,
    });

    if (!auto.ok || !auto.change) {
      const mappedCount = ctxMappings.filter((m) => m.label_id).length;
      timing.total_ms = Math.round(performance.now() - totalStarted);
      return withTiming({
        ...base,
        reason: auto.reason || mapHint || `成功映射 ${mappedCount} 个实例，不足 ${minLabeled}`,
        rawCount,
        keptCount,
        mappedCount,
        unmappedCount: Math.max(0, keptCount - mappedCount),
        unlabeledInProposal: auto.unlabeledInProposal,
        method: mapMethod,
        mapHint,
        mapMappings: lastMapMappings,
        judge: lastJudge,
        judgeAttempts,
        judgeRetryRounds,
      });
    }

    if (!judgeEnabled) {
      return buildSuccessResult(auto);
    }

    options.onProgress?.({
      stage: 'judge',
      message: `评分：${image.relativePath}`,
      status: 'running',
      imagePath: image.relativePath,
    });
    lastJudge = await runJudge(
      attempt,
      ctxMappings,
      auto.change.annotations as unknown as Array<Record<string, unknown>>,
    );
    judgeAttempts += 1;
    const judgeSummary = {
      ...lastJudge,
      attempts: judgeAttempts,
      retryRounds: judgeRetryRounds,
    };

    if (lastJudge.verdict === 'accept' || lastJudge.verdict === 'weak_accept') {
      return buildSuccessResult(auto, judgeSummary, lastJudge.verdict === 'weak_accept');
    }

    if (attempt < maxJudgeRetries) {
      judgeRetryRounds += 1;
      issueBoxIndices = extractIssueBoxIndices(lastJudge);
      judgeFeedback =
        lastJudge.retryFeedback?.trim() ||
        lastJudge.summary?.trim() ||
        '评分子 Agent 判定存在标签错误，请重新分配标签。';
      previousMappings = ctxMappings;
      continue;
    }

    if (rejectSubmitPartial && auto.ok && auto.change && auto.mappedCount >= minLabeled) {
      return buildSuccessResult(auto, judgeSummary, true);
    }

    timing.total_ms = Math.round(performance.now() - totalStarted);
    return withTiming({
      ...base,
      reason: `评分拒绝：${lastJudge.summary || lastJudge.retryFeedback || '标签质量未通过'}`,
      rawCount,
      keptCount,
      mappedCount: auto.mappedCount,
      method: mapMethod,
      mapMappings: lastMapMappings,
      judge: judgeSummary,
      judgeAttempts,
      judgeRetryRounds,
      rejectedByJudge: true,
    });
  }

  timing.total_ms = Math.round(performance.now() - totalStarted);
  return withTiming({
    ...base,
    reason: mapHint || '未能完成标注',
    rawCount,
    keptCount,
    method: mapMethod,
    mapMappings: lastMapMappings,
    judge: lastJudge,
    judgeAttempts,
    judgeRetryRounds,
  });
}
