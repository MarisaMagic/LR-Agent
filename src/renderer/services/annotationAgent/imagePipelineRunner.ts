/**
 * @deprecated 仅当 VITE_ANNOTATION_FUSION_PARITY=false 时使用。
 * 默认走 fusionSubImageRunner（ReAct：detect → map_detection_boxes_to_labels → finalize）。
 */
import {
  assertPreAnnotResult,
  runPreAnnot,
} from '../preAnnotService';
import {
  mapDetectionBoxesHeuristic,
  mapDetectionBoxesToLabels,
  mapSingleBoxCrop,
} from '../annotationAgentApi';
import type {
  AnnotationBatchChange,
  BatchAnnotationPlan,
  ImageCandidate,
} from '../../../shared/annotationAgentTypes';
import type { BboxAnnotation } from '../../types/annotationDocument';
import type { PretrainedModelConfig } from '../../types/pretrainedModel';
import { isDetectResult } from '../../../shared/preAnnotTypes';
import { cropNormalizedBoxToJpegBase64 } from './boxCropUtils';

export interface ImagePipelineResult {
  ok: boolean;
  relativePath: string;
  absolutePath: string;
  change?: AnnotationBatchChange;
  reason?: string;
  rawCount?: number;
  keptCount?: number;
  mappedCount?: number;
  elapsedMs?: number;
}

type DetectBox = {
  box_index: number;
  class_name: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

function filterBoxes(
  rawItems: Array<{
    className: string;
    confidence: number;
    geometry: { x: number; y: number; width: number; height: number };
  }>,
  plan: BatchAnnotationPlan,
): DetectBox[] {
  const include = (plan.annotation_scope.include_detection_labels ?? []).map((s) =>
    s.toLowerCase(),
  );
  const exclude = new Set(
    (plan.annotation_scope.exclude_detection_labels ?? []).map((s) => s.toLowerCase()),
  );
  const scoped = rawItems.filter((item) => {
    const cls = item.className.toLowerCase();
    if (exclude.has(cls)) return false;
    if (include.length > 0 && !include.includes(cls)) return false;
    return true;
  });
  return scoped.map((item, boxIndex) => ({
    box_index: boxIndex,
    class_name: item.className,
    confidence: item.confidence,
    x: item.geometry.x,
    y: item.geometry.y,
    width: item.geometry.width,
    height: item.geometry.height,
  }));
}

/** 仅输出已成功映射 label 的框（fusion：无关框不进入 proposal） */
function buildLabeledAnnotations(
  boxes: DetectBox[],
  labelByIndex: Map<number, string>,
): BboxAnnotation[] {
  const now = new Date().toISOString();
  const out: BboxAnnotation[] = [];
  for (const box of boxes) {
    const labelId = labelByIndex.get(box.box_index);
    if (!labelId) continue;
    out.push({
      id: crypto.randomUUID(),
      kind: 'bbox',
      labelId,
      createdAt: now,
      updatedAt: now,
      source: 'preannot',
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    });
  }
  return out;
}

export async function runImagePipeline(options: {
  providerId: string;
  userRequest: string;
  plan: BatchAnnotationPlan;
  image: ImageCandidate;
  detectionModel: PretrainedModelConfig;
  labelCandidates: Array<{ id: string; name: string }>;
  /** 用于进度文案，不刷工具块 */
  onStage?: (message: string) => void;
}): Promise<ImagePipelineResult> {
  const started = Date.now();
  const { image, plan, detectionModel, labelCandidates } = options;
  const base = {
    ok: false as const,
    relativePath: image.relativePath,
    absolutePath: image.absolutePath,
  };
  const minLabeled = plan.sub_agent_constraints.min_labeled_box_count ?? 1;
  const useVision = Boolean(plan.use_vision_mapping);

  options.onStage?.('YOLO 检测…');

  const hints = plan.detection_hints;
  const response = await runPreAnnot('yolo_detect', image.absolutePath, detectionModel, {
    overrides: {
      confThreshold: hints.conf_threshold,
      iouThreshold: hints.iou_threshold,
    },
  });
  const detResult = assertPreAnnotResult(response, isDetectResult, '检测');
  const rawItems = detResult.items.map((item) => ({
    className: item.className,
    confidence: item.confidence,
    geometry: item.geometry as { x: number; y: number; width: number; height: number },
  }));
  const rawCount = rawItems.length;
  const boxes = filterBoxes(rawItems, plan);

  if (boxes.length === 0) {
    return {
      ...base,
      reason: rawCount > 0 ? '检测框均在标注范围外' : '未检测到目标',
      rawCount,
      keptCount: 0,
      mappedCount: 0,
      elapsedMs: Date.now() - started,
    };
  }

  options.onStage?.(`检测 ${rawCount} → 保留 ${boxes.length}（已按范围过滤）`);

  const labelByIndex = new Map<number, string>();
  const validLabelIds = new Set(labelCandidates.map((l) => l.id));

  if (plan.label_strategy === 'single_label_for_all_boxes' && labelCandidates.length === 1) {
    boxes.forEach((b) => labelByIndex.set(b.box_index, labelCandidates[0].id));
  } else {
    options.onStage?.('启发式映射…');
    try {
      const heuristic = await mapDetectionBoxesHeuristic(options.providerId, {
        boxes: boxes.map((b) => ({
          box_index: b.box_index,
          class_name: b.class_name,
          confidence: b.confidence,
        })),
        labelCandidates,
      });
      for (const m of heuristic.mappings) {
        if (m.label_id && validLabelIds.has(m.label_id)) {
          labelByIndex.set(m.box_index, m.label_id);
        }
      }
    } catch {
      // continue
    }
  }

  let unmapped = boxes.filter((b) => !labelByIndex.has(b.box_index));

  if (unmapped.length > 0) {
    options.onStage?.(`文本映射 ${unmapped.length} 框…`);
    try {
      const mapped = await mapDetectionBoxesToLabels(options.providerId, {
        userRequest: options.userRequest,
        intentSummary: plan.intent_summary,
        labelCandidates,
        boxes: unmapped.map((b) => ({
          box_index: b.box_index,
          class_name: b.class_name,
          confidence: b.confidence,
        })),
        labelStrategy: plan.label_strategy,
      });
      for (const m of mapped.mappings) {
        if (m.label_id && validLabelIds.has(m.label_id)) {
          labelByIndex.set(m.box_index, m.label_id);
        }
      }
    } catch {
      // continue
    }
    unmapped = boxes.filter((b) => !labelByIndex.has(b.box_index));
  }

  if (unmapped.length > 0 && useVision) {
    options.onStage?.(`视觉映射 ${unmapped.length} 个目标框…`);
    for (const box of unmapped) {
      const cropB64 = await cropNormalizedBoxToJpegBase64(image.absolutePath, box);
      if (!cropB64) continue;
      try {
        const mapped = await mapSingleBoxCrop(options.providerId, {
          userRequest: options.userRequest,
          intentSummary: plan.intent_summary,
          labelCandidates,
          boxIndex: box.box_index,
          className: box.class_name,
          cropBase64: cropB64,
        });
        if (mapped.label_id && validLabelIds.has(mapped.label_id)) {
          labelByIndex.set(box.box_index, mapped.label_id);
        }
      } catch {
        // skip box
      }
    }
  }

  const annotations = buildLabeledAnnotations(boxes, labelByIndex);
  const mappedCount = annotations.length;

  if (mappedCount < minLabeled) {
    const skipped = boxes.length - mappedCount;
    return {
      ...base,
      reason: `成功映射 ${mappedCount} 框，不足最少要求 ${minLabeled}${skipped > 0 ? `（${skipped} 个检测框已忽略）` : ''}`,
      rawCount,
      keptCount: boxes.length,
      mappedCount,
      elapsedMs: Date.now() - started,
    };
  }

  options.onStage?.(`提交 ${mappedCount} 个框`);

  return {
    ok: true,
    relativePath: image.relativePath,
    absolutePath: image.absolutePath,
    change: {
      relativePath: image.relativePath,
      absolutePath: image.absolutePath,
      operation: 'append',
      annotations,
    },
    rawCount,
    keptCount: boxes.length,
    mappedCount,
    elapsedMs: Date.now() - started,
  };
}
