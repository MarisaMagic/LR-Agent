import fs from 'fs-extra';
import path from 'path';
import { isAllowedTextFileExtension } from '../../shared/workspaceTextExtensions';

export function resolveScopedTextPath(
  rootDir: string,
  relativePath: string,
): { absolutePath: string; relativePath: string } | { error: string } {
  const root = path.resolve(rootDir);
  const rel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel.includes('..')) {
    return { error: 'path_traversal_forbidden' };
  }
  const ext = path.extname(rel).toLowerCase();
  if (!isAllowedTextFileExtension(ext)) {
    return { error: 'extension_not_allowed' };
  }
  const absolutePath = path.resolve(root, rel);
  const relToRoot = path.relative(root, absolutePath);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    return { error: 'path_outside_root' };
  }
  return { absolutePath, relativePath: rel.replace(/\\/g, '/') };
}

export async function writeScopedTextFile(
  rootDir: string,
  relativePath: string,
  content: string,
): Promise<{ success: boolean; filePath?: string; error?: string }> {
  const resolved = resolveScopedTextPath(rootDir, relativePath);
  if ('error' in resolved) {
    return { success: false, error: resolved.error };
  }
  await fs.ensureDir(path.dirname(resolved.absolutePath));
  await fs.writeFile(resolved.absolutePath, content, 'utf8');
  return { success: true, filePath: resolved.absolutePath };
}

export async function readScopedTextFile(
  rootDir: string,
  relativePath: string,
): Promise<{
  success: boolean;
  content?: string;
  exists?: boolean;
  filePath?: string;
  error?: string;
}> {
  const resolved = resolveScopedTextPath(rootDir, relativePath);
  if ('error' in resolved) {
    return { success: false, error: resolved.error };
  }
  try {
    const exists = await fs.pathExists(resolved.absolutePath);
    if (!exists) {
      return {
        success: true,
        exists: false,
        content: '',
        filePath: resolved.absolutePath,
      };
    }
    const content = await fs.readFile(resolved.absolutePath, 'utf8');
    return {
      success: true,
      exists: true,
      content,
      filePath: resolved.absolutePath,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'read_failed',
    };
  }
}

/** @deprecated 使用 writeScopedTextFile */
export const resolveScopedMarkdownPath = resolveScopedTextPath;

/** @deprecated 使用 writeScopedTextFile */
export const writeScopedMarkdownFile = writeScopedTextFile;
