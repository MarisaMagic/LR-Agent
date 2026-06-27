import { diffLines } from 'diff';

export type DiffLineKind = 'unchanged' | 'added' | 'removed';

export interface DiffDisplayLine {
  kind: DiffLineKind;
  text: string;
}

export interface LineDiffResult {
  additions: number;
  deletions: number;
  lines: DiffDisplayLine[];
}

const MAX_DIFF_LINES = 500;

export function computeLineDiff(
  oldText: string,
  newText: string,
): LineDiffResult {
  const parts = diffLines(oldText, newText);
  const lines: DiffDisplayLine[] = [];
  let additions = 0;
  let deletions = 0;

  for (const part of parts) {
    const partLines = part.value.replace(/\n$/, '').split('\n');
    if (part.value.endsWith('\n') && partLines.length === 1 && partLines[0] === '') {
      partLines.pop();
    }
    for (const line of partLines) {
      if (part.added) {
        additions += 1;
        lines.push({ kind: 'added', text: line });
      } else if (part.removed) {
        deletions += 1;
        lines.push({ kind: 'removed', text: line });
      } else {
        lines.push({ kind: 'unchanged', text: line });
      }
    }
  }

  if (lines.length > MAX_DIFF_LINES) {
    const changed = lines.filter((l) => l.kind !== 'unchanged');
    const head = changed.slice(0, Math.floor(MAX_DIFF_LINES / 2));
    const tail = changed.slice(-Math.floor(MAX_DIFF_LINES / 2));
    return {
      additions,
      deletions,
      lines: [
        ...head,
        { kind: 'unchanged', text: `… 省略 ${lines.length - head.length - tail.length} 行 …` },
        ...tail,
      ],
    };
  }

  return { additions, deletions, lines };
}

/** 折叠视图：优先展示变更行及前后各 contextLines 行上下文。 */
export function pickCollapsedDiffLines(
  lines: DiffDisplayLine[],
  contextLines = 2,
): { lines: DiffDisplayLine[]; hasMore: boolean } {
  if (lines.every((l) => l.kind === 'unchanged')) {
    return { lines: lines.slice(0, 8), hasMore: lines.length > 8 };
  }

  const indices = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind !== 'unchanged') {
      for (
        let i = Math.max(0, index - contextLines);
        i <= Math.min(lines.length - 1, index + contextLines);
        i += 1
      ) {
        indices.add(i);
      }
    }
  });

  const sorted = [...indices].sort((a, b) => a - b);
  const picked: DiffDisplayLine[] = [];
  let last = -2;
  for (const index of sorted) {
    if (index > last + 1) {
      picked.push({ kind: 'unchanged', text: '…' });
    }
    picked.push(lines[index]);
    last = index;
  }

  return {
    lines: picked,
    hasMore: sorted.length < lines.filter((l) => l.kind !== 'unchanged').length + sorted.length,
  };
}

export function proposalAnchorId(messageId: string, blockIndex: number): string {
  return `proposal-${messageId}-${blockIndex}`;
}

export function scrollToProposalAnchor(messageId: string, blockIndex: number): void {
  const id = proposalAnchorId(messageId, blockIndex);
  document
    .querySelector(`[data-proposal-id="${id}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
