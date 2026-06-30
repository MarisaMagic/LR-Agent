import type { AnnotationProject } from '../types/annotation';
import { joinPath } from '../types/file';

export function resolveWorkspaceRoot(
  project: AnnotationProject | null,
  workspaceRoot: string | null,
): string | null {
  return project?.directoryPath ?? workspaceRoot;
}

export function resolveWorkspaceAbsolutePath(
  relativePath: string,
  project: AnnotationProject | null,
  workspaceRoot: string | null,
): string | null {
  const root = resolveWorkspaceRoot(project, workspaceRoot);
  if (!root || !relativePath.trim()) return null;
  return joinPath(root, relativePath.replace(/^[/\\]+/, ''));
}
