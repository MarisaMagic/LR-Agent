import {
  FILE_ANNOTATION_SCHEMA_VERSION,
  parseFileAnnotationDocument,
  type BboxAnnotation,
  type FileAnnotationDocument,
} from '../types/annotationDocument';
import type { AnnotationBatchProposal } from '../../shared/annotationAgentTypes';
import type { AnnotationProject } from '../types/annotation';

async function statsForPath(
  absPath: string,
): Promise<{ mtimeMs?: number; size?: number }> {
  const s = await window.electron.fileSystem?.getFileStats(absPath);
  if (!s || s.isDirectory) return {};
  return { mtimeMs: s.mtime.getTime(), size: s.size };
}

export async function applyAnnotationBatchProposal(
  project: AnnotationProject,
  proposal: AnnotationBatchProposal,
): Promise<{ appliedFiles: number; appliedBoxes: number }> {
  const projectDir = project.directoryPath;
  let appliedFiles = 0;
  let appliedBoxes = 0;

  for (const change of proposal.changes) {
    const raw = await window.electron?.annotation?.readFileAnnotationDoc(
      projectDir,
      change.relativePath,
    );
    const parsed = raw ? parseFileAnnotationDocument(raw) : null;
    const hint = await statsForPath(change.absolutePath);

    const now = new Date().toISOString();
    let doc: FileAnnotationDocument;

    if (parsed) {
      const existing = parsed.annotations.filter((a) => a.kind === 'bbox') as BboxAnnotation[];
      const merged =
        change.operation === 'replace'
          ? change.annotations
          : [...existing, ...change.annotations];
      doc = {
        ...parsed,
        annotations: [
          ...parsed.annotations.filter((a) => a.kind !== 'bbox'),
          ...merged,
        ],
        updatedAt: now,
      };
    } else {
      doc = {
        schemaVersion: FILE_ANNOTATION_SCHEMA_VERSION,
        projectId: project.id,
        filePath: change.relativePath,
        modality: 'image',
        annotationType: 'bbox',
        source: hint.mtimeMs
          ? { width: 0, height: 0, mtimeMs: hint.mtimeMs, size: hint.size }
          : undefined,
        annotations: change.annotations,
        updatedAt: now,
      };
    }

    await window.electron?.annotation?.writeFileAnnotationDoc(
      projectDir,
      change.relativePath,
      doc,
      hint,
    );
    appliedFiles += 1;
    appliedBoxes += change.annotations.length;
  }

  return { appliedFiles, appliedBoxes };
}
