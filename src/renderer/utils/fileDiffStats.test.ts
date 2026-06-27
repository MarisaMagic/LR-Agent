import { computeLineDiff, pickCollapsedDiffLines } from './fileDiffStats';

describe('computeLineDiff', () => {
  it('counts all lines as additions for new file', () => {
    const result = computeLineDiff('', 'line1\nline2\nline3');
    expect(result.additions).toBe(3);
    expect(result.deletions).toBe(0);
    expect(result.lines.every((l) => l.kind === 'added')).toBe(true);
  });

  it('counts modifications', () => {
    const oldText = 'alpha\nbeta\ngamma';
    const newText = 'alpha\nBETA\ngamma\ndelta';
    const result = computeLineDiff(oldText, newText);
    expect(result.additions).toBeGreaterThan(0);
    expect(result.deletions).toBeGreaterThan(0);
  });

  it('returns zero changes for identical content', () => {
    const text = 'same\ncontent';
    const result = computeLineDiff(text, text);
    expect(result.additions).toBe(0);
    expect(result.deletions).toBe(0);
  });
});

describe('pickCollapsedDiffLines', () => {
  it('includes context around changed lines', () => {
    const lines = [
      { kind: 'unchanged' as const, text: 'a' },
      { kind: 'unchanged' as const, text: 'b' },
      { kind: 'removed' as const, text: 'old' },
      { kind: 'added' as const, text: 'new' },
      { kind: 'unchanged' as const, text: 'c' },
    ];
    const picked = pickCollapsedDiffLines(lines, 1);
    expect(picked.lines.some((l) => l.text === 'old')).toBe(true);
    expect(picked.lines.some((l) => l.text === 'new')).toBe(true);
  });
});
