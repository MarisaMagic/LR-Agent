import {
  FILE_ANNOTATION_SCHEMA_VERSION,
  parseFileAnnotationDocument,
  type AnnotationInstance,
  type BboxAnnotation,
  type FileAnnotationDocument,
} from '../types/annotationDocument';
import {
  MAX_MUTATIONS_PER_PROPOSAL,
  type AnnotationBatchChange,
  type AnnotationBatchProposal,
  type AnnotationPatch,
} from '../../shared/annotationAgentTypes';
import type { AnnotationProject, LabelDefinition } from '../types/annotation';

export interface SourceFreshnessHint {
  mtimeMs?: number;
  size?: number;
}

export interface MutationValidationResult {
  valid: boolean;
  errors: string[];
}

export interface ApplyMutationsResult {
  appliedFiles: number;
  appliedBoxes: number;
  appliedPatches: number;
  appliedDeletes: number;
  relativePaths: string[];
}

async function statsForPath(
  absPath: string,
): Promise<SourceFreshnessHint> {
  const s = await window.electron.fileSystem?.getFileStats(absPath);
  if (!s || s.isDirectory) return {};
  return { mtimeMs: s.mtime.getTime(), size: s.size };
}

export function checkSourceFreshness(
  stored: SourceFreshnessHint | undefined,
  current: SourceFreshnessHint,
): { fresh: boolean; reason?: string } {
  if (stored?.mtimeMs == null || current.mtimeMs == null) {
    return { fresh: true };
  }
  if (stored.mtimeMs !== current.mtimeMs) {
    return {
      fresh: false,
      reason: '源图片文件已变更，请先保存工作区或刷新后再应用',
    };
  }
  if (
    stored.size != null &&
    current.size != null &&
    stored.size !== current.size
  ) {
    return {
      fresh: false,
      reason: '源图片文件大小已变化，请先保存工作区或刷新后再应用',
    };
  }
  return { fresh: true };
}

function labelIdSet(labels: LabelDefinition[]): Set<string> {
  return new Set(labels.map((l) => l.id));
}

function countMutationsInChange(change: AnnotationBatchChange): number {
  switch (change.operation) {
    case 'append':
    case 'replace':
    case 'replace_bboxes':
      return change.annotations?.length ?? 0;
    case 'patch':
      return change.patches?.length ?? 0;
    case 'delete':
      return change.deleteIds?.length ?? 0;
    default:
      return 0;
  }
}

export function validateMutations(
  doc: FileAnnotationDocument | null,
  change: AnnotationBatchChange,
  projectLabels: LabelDefinition[],
): MutationValidationResult {
  const errors: string[] = [];
  const validLabelIds = labelIdSet(projectLabels);
  const existingIds = new Set(
    (doc?.annotations ?? []).map((a) => a.id),
  );
  const mutationCount = countMutationsInChange(change);

  if (mutationCount === 0) {
    errors.push(`${change.relativePath}: 变更项为空`);
  }
  if (mutationCount > MAX_MUTATIONS_PER_PROPOSAL) {
    errors.push(
      `${change.relativePath}: 单次变更超过上限 ${MAX_MUTATIONS_PER_PROPOSAL}`,
    );
  }

  const op = change.operation;

  if (op === 'append' || op === 'replace' || op === 'replace_bboxes') {
    const annotations = change.annotations ?? [];
    if (annotations.length === 0) {
      errors.push(`${change.relativePath}: append/replace 需要 annotations`);
    }
    for (const ann of annotations) {
      if (ann.labelId != null && !validLabelIds.has(ann.labelId)) {
        errors.push(`${change.relativePath}: 未知标签 id ${ann.labelId}`);
      }
    }
    if ((op === 'replace' || op === 'replace_bboxes') && !doc) {
      errors.push(`${change.relativePath}: replace 需要已有标注文档`);
    }
  }

  if (op === 'patch') {
    const patches = change.patches ?? [];
    if (patches.length === 0) {
      errors.push(`${change.relativePath}: patch 需要 patches`);
    }
    if (!doc) {
      errors.push(`${change.relativePath}: patch 需要已有标注文档`);
    }
    for (const patch of patches) {
      if (!patch.id?.trim()) {
        errors.push(`${change.relativePath}: patch 缺少 id`);
        continue;
      }
      if (!existingIds.has(patch.id)) {
        errors.push(`${change.relativePath}: 未找到标注 id ${patch.id}`);
      }
      if (patch.labelId != null && !validLabelIds.has(patch.labelId)) {
        errors.push(`${change.relativePath}: 未知标签 id ${patch.labelId}`);
      }
      if (patch.labelId == null && patch.note == null) {
        errors.push(`${change.relativePath}: patch ${patch.id} 无有效字段`);
      }
    }
  }

  if (op === 'delete') {
    const ids = change.deleteIds ?? [];
    if (ids.length === 0) {
      errors.push(`${change.relativePath}: delete 需要 deleteIds`);
    }
    if (!doc) {
      errors.push(`${change.relativePath}: delete 需要已有标注文档`);
    }
    for (const id of ids) {
      if (!existingIds.has(id)) {
        errors.push(`${change.relativePath}: 未找到标注 id ${id}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function applyPatchToAnnotation(
  ann: AnnotationInstance,
  patch: AnnotationPatch,
): AnnotationInstance {
  if (ann.id !== patch.id) return ann;
  const now = new Date().toISOString();
  return {
    ...ann,
    ...(patch.labelId !== undefined ? { labelId: patch.labelId } : {}),
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    updatedAt: now,
  };
}

function applyChangeToDoc(
  parsed: FileAnnotationDocument | null,
  change: AnnotationBatchChange,
  project: AnnotationProject,
  hint: SourceFreshnessHint,
): FileAnnotationDocument {
  const now = new Date().toISOString();
  const op = change.operation;

  if (!parsed) {
    if (op !== 'append') {
      throw new Error(`${change.relativePath}: 无法对不存在的文档执行 ${op}`);
    }
    return {
      schemaVersion: FILE_ANNOTATION_SCHEMA_VERSION,
      projectId: project.id,
      filePath: change.relativePath,
      modality: 'image',
      annotationType: 'bbox',
      source: hint.mtimeMs
        ? { width: 0, height: 0, mtimeMs: hint.mtimeMs, size: hint.size }
        : undefined,
      annotations: change.annotations ?? [],
      updatedAt: now,
    };
  }

  let annotations = [...parsed.annotations];

  if (op === 'append') {
    const existingIds = new Set(annotations.map((a) => a.id));
    const deduped = (change.annotations ?? []).filter(
      (ann) => !existingIds.has(ann.id),
    );
    annotations = [...annotations, ...deduped];
  } else if (op === 'replace' || op === 'replace_bboxes') {
    const nonBbox = annotations.filter((a) => a.kind !== 'bbox');
    annotations = [...nonBbox, ...(change.annotations ?? [])];
  } else if (op === 'patch') {
    const patchMap = new Map(
      (change.patches ?? []).map((p) => [p.id, p] as const),
    );
    annotations = annotations.map((ann) => {
      const patch = patchMap.get(ann.id);
      return patch ? applyPatchToAnnotation(ann, patch) : ann;
    });
  } else if (op === 'delete') {
    const deleteSet = new Set(change.deleteIds ?? []);
    annotations = annotations.filter((ann) => !deleteSet.has(ann.id));
  }

  return {
    ...parsed,
    annotations,
    updatedAt: now,
  };
}

export async function applyMutations(
  project: AnnotationProject,
  changes: AnnotationBatchChange[],
  options?: {
    skipFreshnessCheck?: boolean;
    onFreshnessConflict?: (relativePath: string, reason: string) => boolean;
  },
): Promise<ApplyMutationsResult> {
  const projectDir = project.directoryPath;
  let appliedFiles = 0;
  let appliedBoxes = 0;
  let appliedPatches = 0;
  let appliedDeletes = 0;
  const relativePaths: string[] = [];

  for (const change of changes) {
    const raw = await window.electron?.annotation?.readFileAnnotationDoc(
      projectDir,
      change.relativePath,
    );
    const parsed = raw ? parseFileAnnotationDocument(raw) : null;
    const fullValidation = validateMutations(parsed, change, project.labels);
    if (!fullValidation.valid) {
      throw new Error(fullValidation.errors.join('；'));
    }

    const hint = await statsForPath(change.absolutePath);
    if (!options?.skipFreshnessCheck && parsed?.source) {
      const freshness = checkSourceFreshness(parsed.source, hint);
      if (!freshness.fresh) {
        const proceed = options?.onFreshnessConflict?.(
          change.relativePath,
          freshness.reason ?? '文件已变更',
        );
        if (!proceed) {
          throw new Error(
            freshness.reason ??
              `${change.relativePath}: 源文件已变更，已取消应用`,
          );
        }
      }
    }

    const doc = applyChangeToDoc(parsed, change, project, hint);

    await window.electron?.annotation?.writeFileAnnotationDoc(
      projectDir,
      change.relativePath,
      doc,
      hint,
    );

    appliedFiles += 1;
    relativePaths.push(change.relativePath);

    if (
      change.operation === 'append' ||
      change.operation === 'replace' ||
      change.operation === 'replace_bboxes'
    ) {
      appliedBoxes += change.annotations?.length ?? 0;
    } else if (change.operation === 'patch') {
      appliedPatches += change.patches?.length ?? 0;
    } else if (change.operation === 'delete') {
      appliedDeletes += change.deleteIds?.length ?? 0;
    }
  }

  return {
    appliedFiles,
    appliedBoxes,
    appliedPatches,
    appliedDeletes,
    relativePaths,
  };
}

export async function applyAnnotationBatchProposal(
  project: AnnotationProject,
  proposal: AnnotationBatchProposal,
  options?: {
    skipFreshnessCheck?: boolean;
    onFreshnessConflict?: (relativePath: string, reason: string) => boolean;
  },
): Promise<ApplyMutationsResult> {
  return applyMutations(project, proposal.changes, options);
}

export function dispatchMutationsAppliedEvent(
  projectId: string,
  relativePaths: string[],
): void {
  window.dispatchEvent(
    new CustomEvent('lr-agent:annotation-mutations-applied', {
      detail: { projectId, relativePaths },
    }),
  );
  // Backward compat for existing listeners
  window.dispatchEvent(
    new CustomEvent('lr-agent:annotation-batch-applied', {
      detail: { projectId, relativePaths },
    }),
  );
}
