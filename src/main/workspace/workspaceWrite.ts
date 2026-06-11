import fs from 'fs-extra';
import path from 'path';

const MARKDOWN_EXT = '.md';

export function resolveScopedMarkdownPath(
  rootDir: string,
  relativePath: string,
): { absolutePath: string; relativePath: string } | { error: string } {
  const root = path.resolve(rootDir);
  const rel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (rel.includes('..')) {
    return { error: 'path_traversal_forbidden' };
  }
  if (!rel.toLowerCase().endsWith(MARKDOWN_EXT)) {
    return { error: 'extension_not_allowed' };
  }
  const absolutePath = path.resolve(root, rel);
  const relToRoot = path.relative(root, absolutePath);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
    return { error: 'path_outside_root' };
  }
  return { absolutePath, relativePath: rel.replace(/\\/g, '/') };
}

export async function writeScopedMarkdownFile(
  rootDir: string,
  relativePath: string,
  content: string,
): Promise<{ success: boolean; filePath?: string; error?: string }> {
  const resolved = resolveScopedMarkdownPath(rootDir, relativePath);
  if ('error' in resolved) {
    return { success: false, error: resolved.error };
  }
  await fs.ensureDir(path.dirname(resolved.absolutePath));
  await fs.writeFile(resolved.absolutePath, content, 'utf8');
  return { success: true, filePath: resolved.absolutePath };
}
