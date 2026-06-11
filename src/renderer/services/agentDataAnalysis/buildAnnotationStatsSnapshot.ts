import { parseFileAnnotationDocument } from '../../types/annotationDocument';
import type { AnnotationProjectSnapshot } from '../../../shared/annotationAgentTypes';

/** 去除孤立 UTF-16 surrogate，避免分析沙箱 UTF-8 写盘失败。 */
function sanitizeUnicodeText(text: string): string {
  return text.replace(/\uFFFD/g, '').replace(/[\uD800-\uDFFF]/g, '');
}

export interface AnnotationStatsSnapshot {
  projectId: string;
  projectName: string;
  totalFiles: number;
  annotatedFiles: number;
  totalBoxes: number;
  labelCounts: Record<string, number>;
  files: Array<{
    relativePath: string;
    boxCount: number;
    labelCounts: Record<string, number>;
  }>;
}

export async function buildAnnotationStatsSnapshot(
  project: AnnotationProjectSnapshot,
  maxFiles = 200,
): Promise<AnnotationStatsSnapshot> {
  const catalog = await window.electron?.annotationAgent?.listImages(
    project.directoryPath,
    maxFiles,
  );
  const labelNameById = new Map(
    project.labels.map((l) => [l.id, l.name] as const),
  );
  const globalLabelCounts: Record<string, number> = {};
  const files: AnnotationStatsSnapshot['files'] = [];
  let annotatedFiles = 0;
  let totalBoxes = 0;

  for (const item of catalog ?? []) {
    const raw = await window.electron?.annotation?.readFileAnnotationDoc(
      project.directoryPath,
      item.relativePath,
    );
    const parsed = raw ? parseFileAnnotationDocument(raw) : null;
    const bboxes = (parsed?.annotations ?? []).filter((a) => a.kind === 'bbox');
    if (bboxes.length > 0) {
      annotatedFiles += 1;
    }
    totalBoxes += bboxes.length;
    const fileLabelCounts: Record<string, number> = {};
    for (const box of bboxes) {
      const rawName = box.labelId
        ? labelNameById.get(box.labelId) ?? box.labelId
        : '(unlabeled)';
      const name = sanitizeUnicodeText(rawName);
      fileLabelCounts[name] = (fileLabelCounts[name] ?? 0) + 1;
      globalLabelCounts[name] = (globalLabelCounts[name] ?? 0) + 1;
    }
    files.push({
      relativePath: sanitizeUnicodeText(item.relativePath),
      boxCount: bboxes.length,
      labelCounts: fileLabelCounts,
    });
  }

  return {
    projectId: sanitizeUnicodeText(project.projectId),
    projectName: sanitizeUnicodeText(project.name),
    totalFiles: catalog?.length ?? 0,
    annotatedFiles,
    totalBoxes,
    labelCounts: globalLabelCounts,
    files,
  };
}
