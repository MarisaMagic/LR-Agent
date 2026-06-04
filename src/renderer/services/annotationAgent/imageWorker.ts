import {
  assertPreAnnotResult,
  runPreAnnot,
} from '../preAnnotService';
import { mapDetectionBoxesToLabels } from '../annotationAgentApi';
import type {
  AnnotationBatchChange,
  BatchAnnotationPlan,
  ImageCandidate,
} from '../../../shared/annotationAgentTypes';
import type { BboxAnnotation } from '../../types/annotationDocument';
import type { PretrainedModelConfig } from '../../types/pretrainedModel';
import { isDetectResult } from '../../../shared/preAnnotTypes';

export interface ImageWorkerResult {
  ok: boolean;
  relativePath: string;
  absolutePath: string;
  change?: AnnotationBatchChange;
  reason?: string;
  rawCount?: number;
  keptCount?: number;
  mappedCount?: number;
}

function matchLabelByClassName(
  className: string,
  labels: Array<{ id: string; name: string }>,
): string | null {
  const needle = className.trim().toLowerCase();
  if (!needle) return null;
  const exact = labels.find((l) => l.name.trim().toLowerCase() === needle);
  if (exact) return exact.id;
  const partial = labels.find(
    (l) =>
      l.name.trim().toLowerCase().includes(needle) ||
      needle.includes(l.name.trim().toLowerCase()),
  );
  return partial?.id ?? null;
}

/** @deprecated 使用 imageSubAgentRunner（Phase 2 Sub-Agent + 视觉映射） */
export async function runImageBboxWorker(options: {
  providerId: string;
  userRequest: string;
  plan: BatchAnnotationPlan;
  image: ImageCandidate;
  detectionModel: PretrainedModelConfig;
  labelCandidates: Array<{ id: string; name: string }>;
}): Promise<ImageWorkerResult> {
  const { image, plan, detectionModel, labelCandidates } = options;
  const base = {
    ok: false as const,
    relativePath: image.relativePath,
    absolutePath: image.absolutePath,
  };

  const hints = plan.detection_hints;
  const response = await runPreAnnot('yolo_detect', image.absolutePath, detectionModel, {
    overrides: {
      confThreshold: hints.conf_threshold,
      iouThreshold: hints.iou_threshold,
    },
  });

  const result = assertPreAnnotResult(response, isDetectResult, '检测');
  const rawItems = result.items.map((item) => ({
    className: item.className,
    classId: item.classId,
    confidence: item.confidence,
    geometry: item.geometry,
  }));
  const rawCount = rawItems.length;

  const include = (plan.annotation_scope.include_detection_labels ?? []).map((s) =>
    s.toLowerCase(),
  );
  const exclude = new Set(
    (plan.annotation_scope.exclude_detection_labels ?? []).map((s) => s.toLowerCase()),
  );
  const scopedFull = rawItems.filter((item) => {
    const cls = item.className.toLowerCase();
    if (exclude.has(cls)) return false;
    if (include.length > 0 && !include.includes(cls)) return false;
    return true;
  });
  const boxes = scopedFull.flatMap((item, boxIndex) => {
    const g = item.geometry;
    if (
      typeof g !== 'object' ||
      g === null ||
      !('x' in g) ||
      !('y' in g) ||
      !('width' in g) ||
      !('height' in g)
    ) {
      return [];
    }
    return [
      {
        box_index: boxIndex,
        class_name: item.className,
        confidence: item.confidence,
        x: g.x,
        y: g.y,
        width: g.width,
        height: g.height,
      },
    ];
  });

  const keptCount = boxes.length;
  if (keptCount === 0) {
    return {
      ...base,
      reason: rawCount > 0 ? '检测框均在标注范围外' : '未检测到目标',
      rawCount,
      keptCount: 0,
      mappedCount: 0,
    };
  }

  const minLabeled = plan.sub_agent_constraints.min_labeled_box_count ?? 1;
  const labelByIndex = new Map<number, string>();

  if (plan.label_strategy === 'single_label_for_all_boxes') {
    const single =
      labelCandidates.length === 1 ? labelCandidates[0].id : null;
    if (single) {
      boxes.forEach((b) => labelByIndex.set(b.box_index, single));
    }
  } else {
    const mapping = detectionModel.labelMapping ?? {};
    for (const box of boxes) {
      const mappedId = mapping[box.class_name] ?? mapping[box.class_name.toLowerCase()];
      if (mappedId && labelCandidates.some((l) => l.id === mappedId)) {
        labelByIndex.set(box.box_index, mappedId);
        continue;
      }
      const matched = matchLabelByClassName(box.class_name, labelCandidates);
      if (matched) labelByIndex.set(box.box_index, matched);
    }
  }

  const unmapped = boxes.filter((b) => !labelByIndex.has(b.box_index));
  if (unmapped.length > 0 && plan.label_strategy === 'map_each_box_to_label') {
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
        labelByIndex.set(m.box_index, m.label_id);
      }
    } catch {
      // keep rule-based mappings only
    }
  }

  const allowUnlabeled = plan.sub_agent_constraints.allow_unlabeled_boxes ?? false;
  const annotations: BboxAnnotation[] = [];
  const now = new Date().toISOString();

  for (const box of boxes) {
    const labelId = labelByIndex.get(box.box_index) ?? null;
    if (!labelId && !allowUnlabeled) continue;
    annotations.push({
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

  const mappedCount = annotations.filter((a) => a.labelId).length;
  if (mappedCount >= minLabeled) {
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
      keptCount,
      mappedCount,
    };
  }

  if (plan.label_strategy === 'map_each_box_to_label' && boxes.length > 0) {
    try {
      const mapped = await mapDetectionBoxesToLabels(options.providerId, {
        userRequest: options.userRequest,
        intentSummary: plan.intent_summary,
        labelCandidates,
        boxes: boxes.map((b) => ({
          box_index: b.box_index,
          class_name: b.class_name,
          confidence: b.confidence,
        })),
        labelStrategy: plan.label_strategy,
      });
      labelByIndex.clear();
      for (const m of mapped.mappings) {
        labelByIndex.set(m.box_index, m.label_id);
      }
    } catch {
      // fall through
    }
  }

  const retryAnnotations: BboxAnnotation[] = [];
  const retryNow = new Date().toISOString();
  for (const box of boxes) {
    const labelId = labelByIndex.get(box.box_index) ?? null;
    if (!labelId && !allowUnlabeled) continue;
    retryAnnotations.push({
      id: crypto.randomUUID(),
      kind: 'bbox',
      labelId,
      createdAt: retryNow,
      updatedAt: retryNow,
      source: 'preannot',
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
    });
  }

  const retryMapped = retryAnnotations.filter((a) => a.labelId).length;
  if (retryMapped >= minLabeled) {
    return {
      ok: true,
      relativePath: image.relativePath,
      absolutePath: image.absolutePath,
      change: {
        relativePath: image.relativePath,
        absolutePath: image.absolutePath,
        operation: 'append',
        annotations: retryAnnotations,
      },
      rawCount,
      keptCount,
      mappedCount: retryMapped,
    };
  }

  return {
    ...base,
    reason: `成功映射 ${retryMapped} 框，不足最少要求 ${minLabeled}`,
    rawCount,
    keptCount,
    mappedCount: retryMapped,
  };
}
