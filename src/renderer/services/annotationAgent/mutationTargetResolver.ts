import {
  parseFileAnnotationDocument,
  type BboxAnnotation,
} from '../../types/annotationDocument';
import type { LabelDefinition } from '../../types/annotation';

export interface MutationTargetSpec {
  by: 'id' | 'label_name' | 'index' | 'spatial' | 'selected' | 'all';
  id?: string;
  label_name?: string;
  index?: number;
  hint?: string;
}

export interface MutationOperationSpec {
  relative_path: string;
  mutation_kind: 'patch_label' | 'delete';
  targets: MutationTargetSpec[];
  new_label_name?: string | null;
}

const MUTATION_KINDS = new Set(['patch_label', 'delete']);
const TARGET_BY = new Set([
  'id',
  'label_name',
  'index',
  'spatial',
  'selected',
  'all',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMutationTarget(raw: unknown): MutationTargetSpec | null {
  if (!isRecord(raw) || typeof raw.by !== 'string' || !TARGET_BY.has(raw.by)) {
    return null;
  }
  const by = raw.by as MutationTargetSpec['by'];
  const target: MutationTargetSpec = { by };
  if (typeof raw.id === 'string' && raw.id.trim()) target.id = raw.id;
  if (typeof raw.label_name === 'string' && raw.label_name.trim()) {
    target.label_name = raw.label_name;
  }
  if (typeof raw.index === 'number' && Number.isFinite(raw.index)) {
    target.index = raw.index;
  }
  if (typeof raw.hint === 'string' && raw.hint.trim()) target.hint = raw.hint;

  if (by === 'id' && !target.id) return null;
  if (by === 'index' && target.index == null) return null;
  if (by === 'label_name' && !target.label_name) return null;
  if (by === 'spatial' && !target.hint) return null;
  return target;
}

export function parseMutationOperation(
  raw: unknown,
): MutationOperationSpec | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.relative_path !== 'string' || !raw.relative_path.trim()) {
    return null;
  }
  if (
    typeof raw.mutation_kind !== 'string' ||
    !MUTATION_KINDS.has(raw.mutation_kind)
  ) {
    return null;
  }
  if (!Array.isArray(raw.targets)) return null;

  const targets = raw.targets
    .map(parseMutationTarget)
    .filter((t): t is MutationTargetSpec => t != null);
  if (targets.length !== raw.targets.length) return null;

  const spec: MutationOperationSpec = {
    relative_path: raw.relative_path,
    mutation_kind: raw.mutation_kind as MutationOperationSpec['mutation_kind'],
    targets,
  };
  if (raw.new_label_name === null || typeof raw.new_label_name === 'string') {
    spec.new_label_name = raw.new_label_name;
  }
  return spec;
}

export interface ResolveTargetsResult {
  ids: string[];
  errors: string[];
}

function bboxCenter(ann: BboxAnnotation): {
  cx: number;
  cy: number;
  area: number;
} {
  return {
    cx: ann.x + ann.width / 2,
    cy: ann.y + ann.height / 2,
    area: ann.width * ann.height,
  };
}

function labelNameForId(
  labelId: string | null,
  labels: LabelDefinition[],
): string | null {
  if (!labelId) return null;
  return labels.find((l) => l.id === labelId)?.name ?? null;
}

function filterByLabelName(
  bboxes: BboxAnnotation[],
  labelName: string,
  labels: LabelDefinition[],
): BboxAnnotation[] {
  const needle = labelName.trim().toLowerCase();
  return bboxes.filter((ann) => {
    const name = labelNameForId(ann.labelId, labels);
    return name?.toLowerCase() === needle;
  });
}

function applySpatialHint(
  candidates: BboxAnnotation[],
  hint: string | undefined,
): BboxAnnotation[] {
  if (!hint || candidates.length === 0) return candidates;
  const h = hint.toLowerCase();
  if (h.includes('left') || h.includes('左')) {
    const minCx = Math.min(...candidates.map((a) => bboxCenter(a).cx));
    return candidates.filter((a) => bboxCenter(a).cx === minCx);
  }
  if (h.includes('right') || h.includes('右')) {
    const maxCx = Math.max(...candidates.map((a) => bboxCenter(a).cx));
    return candidates.filter((a) => bboxCenter(a).cx === maxCx);
  }
  if (h.includes('largest') || h.includes('最大') || h.includes('biggest')) {
    const maxArea = Math.max(...candidates.map((a) => bboxCenter(a).area));
    return candidates.filter((a) => bboxCenter(a).area === maxArea);
  }
  return candidates;
}

export function resolveMutationTargets(
  bboxes: BboxAnnotation[],
  targets: MutationTargetSpec[],
  labels: LabelDefinition[],
  selectedAnnotationIds: string[],
): ResolveTargetsResult {
  const errors: string[] = [];
  const resolved = new Set<string>();

  for (const target of targets) {
    if (target.by === 'all') {
      for (const ann of bboxes) {
        resolved.add(ann.id);
      }
      continue;
    }

    if (target.by === 'selected') {
      for (const id of selectedAnnotationIds) {
        if (bboxes.some((b) => b.id === id)) {
          resolved.add(id);
        }
      }
      continue;
    }

    if (target.by === 'id' && target.id) {
      if (bboxes.some((b) => b.id === target.id)) {
        resolved.add(target.id);
      } else {
        errors.push(`未找到 id ${target.id}`);
      }
      continue;
    }

    if (target.by === 'index' && target.index != null) {
      const idx = Math.max(1, Math.floor(target.index)) - 1;
      const bbox = bboxes[idx];
      if (bbox) {
        resolved.add(bbox.id);
      } else {
        errors.push(`序号 ${target.index} 超出范围`);
      }
      continue;
    }

    let pool = [...bboxes];

    if (target.by === 'label_name' && target.label_name) {
      pool = filterByLabelName(pool, target.label_name, labels);
      if (pool.length === 0) {
        errors.push(`无标签为 ${target.label_name} 的框`);
        continue;
      }
    }

    if (target.by === 'spatial' || target.hint) {
      pool = applySpatialHint(pool, target.hint);
    }

    if (pool.length === 0) {
      errors.push('空间指代未匹配到框');
      continue;
    }

    for (const ann of pool) {
      resolved.add(ann.id);
    }
  }

  return { ids: [...resolved], errors };
}

export async function readBboxesForPath(
  projectDir: string,
  relativePath: string,
): Promise<BboxAnnotation[]> {
  const raw = await window.electron?.annotation?.readFileAnnotationDoc(
    projectDir,
    relativePath,
  );
  if (!raw) return [];
  const parsed = parseFileAnnotationDocument(raw);
  if (!parsed) return [];
  return parsed.annotations.filter(
    (a) => a.kind === 'bbox',
  ) as BboxAnnotation[];
}

export function labelIdByName(
  name: string | null | undefined,
  labels: LabelDefinition[],
): string | null {
  if (!name?.trim()) return null;
  const needle = name.trim().toLowerCase();
  return labels.find((l) => l.name.toLowerCase() === needle)?.id ?? null;
}
