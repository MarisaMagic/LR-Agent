export interface InputPathEntry {
  relativePath: string;
  absolutePath: string;
}

export type AnnotationScopeRequest = {
  paths?: string[];
  allFiles?: boolean;
  /** @deprecated comma-separated relative paths; prefer `paths` */
  scopeHint?: string;
};

export type AnnotationScopeResult = {
  paths: InputPathEntry[];
  error?: string;
};

export function scopeTokens(scopeHint?: string): string[] {
  if (!scopeHint) return [];
  return scopeHint
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(/[/\\]/).filter(Boolean).join('/');
}

export function collectScopeTokens(request: AnnotationScopeRequest): string[] {
  const fromPaths = (request.paths ?? []).map((s) => s.trim()).filter(Boolean);
  if (fromPaths.length > 0) return fromPaths;
  return scopeTokens(request.scopeHint);
}

export function filterPathsByScopeHint(
  allPaths: InputPathEntry[],
  scopeHint?: string,
): InputPathEntry[] {
  const tokens = scopeTokens(scopeHint);
  if (tokens.length === 0) return allPaths;
  const lowered = tokens.map((t) => t.toLowerCase());
  return allPaths.filter((p) => {
    const relLower = p.relativePath.toLowerCase();
    return lowered.some((t) => {
      if (relLower.includes(t)) return true;
      if (t.endsWith('/') && relLower.startsWith(t)) return true;
      return false;
    });
  });
}

export function resolveAnnotationScope(
  allPaths: InputPathEntry[],
  request: AnnotationScopeRequest,
  maxFiles: number,
): AnnotationScopeResult {
  const tokens = collectScopeTokens(request);
  if (tokens.length > 0) {
    const filtered = filterPathsByScopeHint(allPaths, tokens.join(','));
    if (filtered.length === 0) {
      return {
        paths: [],
        error: `未命中任何文件：${tokens.join(', ')}。请用 list_workspace_directory 核对 relativePath，或将 all_files 设为 true。`,
      };
    }
    return { paths: filtered.slice(0, maxFiles) };
  }
  if (request.allFiles) {
    if (allPaths.length === 0) {
      return { paths: [], error: '项目内没有可标注文件。' };
    }
    return { paths: allPaths.slice(0, maxFiles) };
  }
  return {
    paths: [],
    error:
      '请提供 paths（相对路径或目录前缀），或将 all_files 设为 true（仅当用户明确要求全部文件）。',
  };
}

export async function resolveAnnotationScopePaths(
  allPaths: InputPathEntry[],
  request: AnnotationScopeRequest,
  maxFiles: number,
  resolveRelativeFile?: (
    relativePath: string,
  ) => Promise<InputPathEntry | null>,
): Promise<AnnotationScopeResult> {
  const tokens = collectScopeTokens(request);
  if (tokens.length === 0) {
    return resolveAnnotationScope(allPaths, request, maxFiles);
  }

  const filtered = filterPathsByScopeHint(allPaths, tokens.join(','));
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

  if (filtered.length === 0) {
    return {
      paths: [],
      error: `未命中任何文件：${tokens.join(', ')}。请用 list_workspace_directory 核对 relativePath，或将 all_files 设为 true。`,
    };
  }
  return { paths: filtered.slice(0, maxFiles) };
}
