import fs from 'fs-extra';
import path from 'path';
import { listProjectImages, type ImageCatalogEntry } from './catalog';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico']);

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(/[/\\]/).filter(Boolean).join('/');
}

function isImageFile(filePath: string): boolean {
  const base = path.basename(filePath);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return IMAGE_EXT.has(base.slice(dot + 1).toLowerCase());
}

interface GlobProjectImagesOptions {
  parentFolder?: string;
  namePattern?: string;
  limit?: number;
}

export async function globProjectImages(
  projectDir: string,
  options: GlobProjectImagesOptions = {},
): Promise<{ count: number; images: ImageCatalogEntry[] }> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const parent = normalizeRelativePath(options.parentFolder ?? '').replace(
    /\/$/,
    '',
  );
  const pattern = (options.namePattern ?? '').trim().toLowerCase();

  const catalog = await listProjectImages(projectDir, limit * 4);
  const matched: ImageCatalogEntry[] = [];

  for (const item of catalog) {
    if (matched.length >= limit) break;
    const rel = item.relativePath;
    const par = item.parent;
    if (parent && par !== parent && !rel.startsWith(`${parent}/`)) {
      continue;
    }
    if (pattern) {
      const name = item.name.toLowerCase();
      const relLower = rel.toLowerCase();
      if (!name.includes(pattern) && !relLower.includes(pattern)) {
        continue;
      }
    }
    matched.push(item);
  }

  return { count: matched.length, images: matched };
}

interface DirEntry {
  name: string;
  relativePath: string;
  kind: 'file' | 'directory';
  isImage: boolean;
}

export async function listProjectDirectory(
  projectDir: string,
  relativeDir = '',
  maxEntries = 80,
): Promise<{ relativeDir: string; entries: DirEntry[] }> {
  const root = path.resolve(projectDir);
  const relDir = normalizeRelativePath(relativeDir);
  const target = relDir ? path.join(root, relDir) : root;
  const targetResolved = path.resolve(target);
  if (
    targetResolved !== root &&
    !targetResolved.startsWith(`${root}${path.sep}`)
  ) {
    return { relativeDir: relDir, entries: [] };
  }

  if (!(await fs.pathExists(targetResolved))) {
    return { relativeDir: relDir, entries: [] };
  }

  const stat = await fs.stat(targetResolved);
  if (!stat.isDirectory()) {
    return { relativeDir: relDir, entries: [] };
  }

  let dirents: fs.Dirent[];
  try {
    dirents = await fs.readdir(targetResolved, { withFileTypes: true });
  } catch {
    return { relativeDir: relDir, entries: [] };
  }

  dirents.sort((a, b) => a.name.localeCompare(b.name));
  const entries: DirEntry[] = [];
  const cap = Math.min(Math.max(maxEntries, 1), 300);

  for (const entry of dirents) {
    if (entries.length >= cap) break;
    if (entry.name.startsWith('.')) continue;
    const abs = path.join(targetResolved, entry.name);
    const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
    const relPath = normalizeRelativePath(childRel);
    if (entry.isDirectory()) {
      entries.push({
        name: entry.name,
        relativePath: relPath,
        kind: 'directory',
        isImage: false,
      });
      continue;
    }
    if (!entry.isFile()) continue;
    entries.push({
      name: entry.name,
      relativePath: relPath,
      kind: 'file',
      isImage: isImageFile(abs),
    });
  }

  return { relativeDir: relDir, entries };
}

export async function resolveProjectRelativeFile(
  projectDir: string,
  relativePath: string,
): Promise<{ relativePath: string; absolutePath: string } | null> {
  const root = path.resolve(projectDir);
  const norm = normalizeRelativePath(relativePath);
  if (!norm || norm.includes('..')) return null;
  const abs = path.resolve(root, norm);
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) return null;
  if (!(await fs.pathExists(abs))) return null;
  const stat = await fs.stat(abs);
  if (!stat.isFile()) return null;
  return { relativePath: norm, absolutePath: abs };
}
