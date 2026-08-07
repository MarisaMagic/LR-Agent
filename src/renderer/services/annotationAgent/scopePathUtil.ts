export interface InputPathEntry {
  relativePath: string;
  absolutePath: string;
}

export function scopeTokens(scopeHint?: string): string[] {
  if (!scopeHint) return [];
  return scopeHint
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(/[/\\]/).filter(Boolean).join('/');
}

export function filterPathsByScopeHint(
  allPaths: InputPathEntry[],
  scopeHint?: string,
): InputPathEntry[] {
  const tokens = scopeTokens(scopeHint);
  if (tokens.length === 0) return allPaths;
  return allPaths.filter((p) => {
    const relLower = p.relativePath.toLowerCase();
    return tokens.some((t) => {
      if (relLower.includes(t)) return true;
      if (t.endsWith('/') && relLower.startsWith(t)) return true;
      return false;
    });
  });
}

export function applyScopeWithFallback(
  allPaths: InputPathEntry[],
  scopeHint: string | undefined,
  maxFiles: number,
): InputPathEntry[] {
  const filtered = filterPathsByScopeHint(allPaths, scopeHint);
  const tokens = scopeTokens(scopeHint);
  if (tokens.length === 0) {
    return allPaths.slice(0, maxFiles);
  }
  if (filtered.length === 0 && allPaths.length > 0) {
    return allPaths.slice(0, maxFiles);
  }
  return filtered.slice(0, maxFiles);
}

export async function resolveScopeHintPaths(
  allPaths: InputPathEntry[],
  scopeHint: string | undefined,
  projectDir: string,
  maxFiles: number,
  resolveRelativeFile?: (
    relativePath: string,
  ) => Promise<InputPathEntry | null>,
): Promise<InputPathEntry[]> {
  const tokens = scopeTokens(scopeHint);
  if (tokens.length === 0) {
    return allPaths.slice(0, maxFiles);
  }

  let filtered = filterPathsByScopeHint(allPaths, scopeHint);
  const known = new Set(filtered.map((p) => p.relativePath.toLowerCase()));

  if (resolveRelativeFile) {
    for (const token of tokens) {
      const normalized = normalizeRelativePath(token.replace(/\/+$/, ''));
      if (!normalized || known.has(normalized.toLowerCase())) continue;
      const resolved = await resolveRelativeFile(normalized);
      if (resolved) {
        filtered.push(resolved);
        known.add(resolved.relativePath.toLowerCase());
      }
    }
  }

  if (filtered.length === 0 && allPaths.length > 0) {
    filtered = allPaths;
  }

  return filtered.slice(0, maxFiles);
}
