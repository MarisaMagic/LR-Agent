import type { ImageCandidate } from '../../../shared/annotationAgentTypes';

function normalizeKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

/** 将 Agent 返回的路径列表映射为目录中的图片条目（无规则推断）。 */
export function imagesFromAgentPaths(
  candidates: ImageCandidate[],
  selectedPaths: string[],
  maxFiles: number,
): { images: ImageCandidate[]; missing: string[] } {
  const byRel = new Map(
    candidates.map((c) => [normalizeKey(c.relativePath), c]),
  );
  const images: ImageCandidate[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();

  for (const raw of selectedPaths) {
    const key = normalizeKey(raw);
    if (!key) continue;
    const hit = byRel.get(key);
    if (!hit) {
      missing.push(key);
      continue;
    }
    if (seen.has(hit.relativePath)) continue;
    seen.add(hit.relativePath);
    images.push(hit);
  }

  return { images: images.slice(0, maxFiles), missing };
}
