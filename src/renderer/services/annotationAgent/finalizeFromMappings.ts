import type { AnnotationBatchChange, BatchAnnotationPlan } from '../../../shared/annotationAgentTypes';
import type { BboxAnnotation } from '../../types/annotationDocument';
import { validateMappingsForFinalize } from './boxValidation';

type DetectBox = {
  box_index: number;
  class_name: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export function buildLabeledAnnotationsFromMappings(
  boxes: DetectBox[],
  mappings: Array<{ box_index: number; label_id: string }>,
  validLabelIds: Set<string>,
  options?: { allowUnlabeledBoxes?: boolean },
): BboxAnnotation[] {
  const allowUnlabeled = options?.allowUnlabeledBoxes !== false;
  const byIndex = new Map<number, string>();
  for (const m of mappings) {
    const lid = (m.label_id || '').trim();
    if (lid && validLabelIds.has(lid)) {
      byIndex.set(m.box_index, lid);
    }
  }
  const now = new Date().toISOString();
  const out: BboxAnnotation[] = [];
  for (const box of boxes) {
    const labelId = byIndex.get(box.box_index);
    if (!labelId) {
      if (!allowUnlabeled) continue;
      out.push({
        id: crypto.randomUUID(),
        kind: 'bbox',
        labelId: null,
        createdAt: now,
        updatedAt: now,
        source: 'preannot',
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      });
      continue;
    }
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

export function tryAutoFinalizeFromMap(options: {
  plan: BatchAnnotationPlan;
  imageRelativePath: string;
  imageAbsolutePath: string;
  boxes: DetectBox[];
  mappings: Array<{ box_index: number; label_id: string; reason?: string }>;
  labelCandidates: Array<{ id: string; name: string }>;
}): {
  ok: boolean;
  change?: AnnotationBatchChange;
  reason?: string;
  mappedCount: number;
  unlabeledInProposal?: number;
} {
  const validIds = new Set(options.labelCandidates.map((l) => l.id));
  const validation = validateMappingsForFinalize(options.boxes, options.mappings, validIds);
  if (!validation.valid) {
    return {
      ok: false,
      reason: validation.errors.join('；'),
      mappedCount: validation.labeledCount,
      unlabeledInProposal: validation.unlabeledCount,
    };
  }

  const constraints = options.plan.sub_agent_constraints;
  const minLabeled = constraints.min_labeled_box_count ?? 1;
  const allowUnlabeled =
    constraints.allow_unlabeled_boxes !== false;
  const annotations = buildLabeledAnnotationsFromMappings(
    options.boxes,
    options.mappings,
    validIds,
    { allowUnlabeledBoxes: allowUnlabeled },
  );
  const mappedCount = validation.labeledCount;
  const unlabeledInProposal = annotations.filter((a) => a.labelId == null).length;

  if (mappedCount < minLabeled) {
    return {
      ok: false,
      reason: `成功映射 ${mappedCount} 框，不足 min_labeled_box_count=${minLabeled}`,
      mappedCount,
      unlabeledInProposal,
    };
  }
  if (annotations.length === 0) {
    return {
      ok: false,
      reason: '无检测框可写入提案',
      mappedCount,
      unlabeledInProposal: 0,
    };
  }

  return {
    ok: true,
    mappedCount,
    unlabeledInProposal,
    change: {
      relativePath: options.imageRelativePath,
      absolutePath: options.imageAbsolutePath,
      operation: 'append',
      annotations,
    },
  };
}
