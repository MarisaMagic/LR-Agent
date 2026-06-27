import type { AnnotationProject } from '../types/annotation';
import { computeLineDiff } from './fileDiffStats';

export async function readWorkspaceTextFile(options: {
  project: AnnotationProject | null;
  workspaceRoot: string | null;
  relativePath: string;
}): Promise<{ content: string; exists: boolean }> {
  const root = options.project?.directoryPath ?? options.workspaceRoot;
  if (!root || !window.electron?.workspace?.readTextFile) {
    return { content: '', exists: false };
  }
  const result = await window.electron.workspace.readTextFile({
    rootDir: root,
    relativePath: options.relativePath,
  });
  if (!result.success) {
    return { content: '', exists: false };
  }
  return {
    content: result.content ?? '',
    exists: Boolean(result.exists),
  };
}

export async function computeFileProposalDiffStats(options: {
  project: AnnotationProject | null;
  workspaceRoot: string | null;
  relativePath: string;
  newContent: string;
}): Promise<{ additions: number; deletions: number }> {
  const { content: oldContent, exists } = await readWorkspaceTextFile({
    project: options.project,
    workspaceRoot: options.workspaceRoot,
    relativePath: options.relativePath,
  });
  if (!exists) {
    const lineCount = options.newContent
      ? options.newContent.replace(/\n$/, '').split('\n').length
      : 0;
    return { additions: lineCount, deletions: 0 };
  }
  const diff = computeLineDiff(oldContent, options.newContent);
  return { additions: diff.additions, deletions: diff.deletions };
}
