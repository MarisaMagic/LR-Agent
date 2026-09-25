/**
 * Generalized geometry sub-image agent: PreAnnot inference → map → finalize.
 */
import {
  mapDetectionBoxesUnified,
  type MapDetectionBoxesUnifiedResult,
} from '../annotationAgentApi';
import type {
  BatchAnnotationPlan,
  ImageCandidate,
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
import {
  normalizeImageForCrop,
  prepareMapImageSource,
  type MapImageSource,
} from './imageNormalize';

type MappingRow = { box_index: number; label_id: string; reason?: string };

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
  const skipMapping =
    adapter.skipLabelMapping?.(options.adapterContext) ?? false;
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

  // 交给映射接口的图像来源。非 PNG/JPEG 先在渲染侧转码：
  // 主进程 nativeImage 只保证解码 PNG/JPEG，其余格式会裁不出任何区域。
  // 仅在服务端真的会走逐框裁剪时才转码（服务端条件是 use_vision && supports_vision）。
  const willCrop = useVision && Boolean(options.providerSupportsVision);
  let mapSource: MapImageSource = {
    absolutePath: image.absolutePath,
    base64: '',
  };
  if (willCrop) {
    mapSource = await prepareMapImageSource(image.absolutePath);
  }
  const mapImageFields = (): {
    imageAbsolutePath: string;
    imageBase64: string;
  } =>
    mapSource.base64
      ? { imageAbsolutePath: '', imageBase64: mapSource.base64 }
      : { imageAbsolutePath: mapSource.absolutePath, imageBase64: '' };

  const runMap = async (): Promise<MapDetectionBoxesUnifiedResult> => {
    throwIfAborted();
    const tMap = performance.now();
    const callMap = (fields: {
      imageAbsolutePath: string;
      imageBase64: string;
    }): Promise<MapDetectionBoxesUnifiedResult> =>
      mapDetectionBoxesUnified(options.providerId, {
        userRequest: options.userRequest,
        intentSummary: plan.intent_summary,
        labelCandidates: options.labelCandidates,
        boxes: mapBoxesPayload,
        useVision,
        labelStrategy: plan.label_strategy,
        labelUniqueness: plan.label_uniqueness,
        singleLabelId,
        annotationScope: { ...plan.annotation_scope },
        imageAbsolutePath: fields.imageAbsolutePath || undefined,
        imageBase64: fields.imageBase64 || undefined,
        providerApiKey: options.providerApiKey ?? '',
        providerBaseUrl: options.providerBaseUrl ?? '',
        providerModel: options.providerModel ?? '',
        providerSupportsVision: options.providerSupportsVision ?? false,
        signal: options.signal,
      });

    let mapResult = await callMap(mapImageFields());

    // 图像不可读：改用原始字节（仅在首次请求没走 base64 时才有意义）
    if (
      useVision &&
      mapResult.ok === false &&
      mapResult.error === 'image_unavailable' &&
      !mapSource.base64
    ) {
      const fallbackBase64 = await ensureImageBase64();
      if (fallbackBase64) {
        mapResult = await callMap({
          imageAbsolutePath: '',
          imageBase64: fallbackBase64,
        });
      }
    }

    // 主进程解不出像素（WebP/BMP/ICO，或截断的 PNG/JPEG）：转码后重试一次
    if (
      useVision &&
      mapResult.ok === false &&
      mapResult.error === 'crop_unavailable' &&
      !mapSource.base64
    ) {
      const normalized = await normalizeImageForCrop(image.absolutePath);
      if (normalized) {
        mapSource = { absolutePath: '', base64: normalized };
        mapResult = await callMap(mapImageFields());
      }
    }

    timing.map_ms = (timing.map_ms ?? 0) + Math.round(performance.now() - tMap);
    return mapResult;
  };

  let lastMapMappings = formatMapMappingRows([], options.labelCandidates);
  let mapError = '';
  let labelPoolSource = '';
  let labelPoolEffective = 0;
  let ctxMappings: MappingRow[] = skipMapping
    ? buildPresetMappings(instances)
    : [];

  throwIfAborted();

  if (!skipMapping) {
    const mapResult = await runMap();
    ctxMappings = mapResult.mappings ?? [];
    mapMethod = mapResult.method ?? '';
    mapHint = mapResult.hint ?? '';
    mapError = mapResult.error ?? '';
    labelPoolSource = mapResult.label_pool_source ?? '';
    labelPoolEffective =
      mapResult.label_candidates?.length ??
      mapResult.label_pool_debug?.effective_count ??
      0;
    lastMapMappings = formatMapMappingRows(
      ctxMappings,
      options.labelCandidates,
    );
    logAnnotationDebugMapDetail(image.relativePath, {
      elapsed_ms: timing.map_ms,
      mapResult,
      labelCandidates: options.labelCandidates,
      userRequest: options.userRequest,
      attempt: 0,
    });
  } else if (singleLabelId) {
    ctxMappings = instances.map((inst) => ({
      box_index: inst.instance_index,
      label_id: singleLabelId,
      reason: 'single_label_strategy',
    }));
    mapMethod = 'preset';
    lastMapMappings = formatMapMappingRows(
      ctxMappings,
      options.labelCandidates,
    );
  }

  const auto = tryAutoFinalizeFromGeometry({
    plan,
    imageRelativePath: image.relativePath,
    imageAbsolutePath: image.absolutePath,
    instances,
    mappings: ctxMappings,
    labelCandidates: options.labelCandidates,
  });

  const unmappedRows = ctxMappings.filter((m) => !m.label_id);
  const unmappedFailed = unmappedRows.filter((m) =>
    /失败|unavailable|crop|error/i.test(String(m.reason ?? '')),
  ).length;
  const unmappedNoMatch = unmappedRows.length - unmappedFailed;
  const poolFields = {
    labelPoolSource,
    labelPoolEffective,
    unmappedNoMatch,
    unmappedFailed,
  };

  if (!auto.ok || !auto.change) {
    const mappedCount = ctxMappings.filter((m) => m.label_id).length;
    timing.total_ms = Math.round(performance.now() - totalStarted);
    // 一个映射条目都没有、且映射阶段自己报了错时，优先报它的原因：
    // 否则「mappings 为空」这类下游校验文案会把真实原因（多为图片解不出像素）盖掉。
    const mapFailureReason =
      ctxMappings.length === 0 && mapError ? mapHint || mapError : '';
    return withTiming({
      ...base,
      reason:
        mapFailureReason ||
        auto.reason ||
        mapHint ||
        `成功映射 ${mappedCount} 个实例，不足 ${minLabeled}`,
      rawCount,
      keptCount,
      mappedCount,
      unmappedCount: Math.max(0, keptCount - mappedCount),
      unlabeledInProposal: auto.unlabeledInProposal,
      ...poolFields,
      method: mapMethod,
      mapHint,
      mapMappings: lastMapMappings,
    });
  }

  timing.total_ms = Math.round(performance.now() - totalStarted);
  return withTiming({
    ok: true,
    relativePath: image.relativePath,
    absolutePath: image.absolutePath,
    change: auto.change,
    rawCount,
    keptCount,
    mappedCount: auto.mappedCount,
    unmappedCount: Math.max(0, keptCount - auto.mappedCount),
    unlabeledInProposal: auto.unlabeledInProposal,
    autoFinalized: true,
    ...poolFields,
    method: mapMethod,
    mapMappings: lastMapMappings,
  });
}
