/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import {
  mergeSummarySegments,
  parseContextSummary,
  serializeContextSummary,
  shouldMergeSummarySegments,
  summarySegmentsTotalChars,
} from './summarySegments';

describe('summarySegments', () => {
  it('round-trips structured segments', () => {
    const text = serializeContextSummary({
      legacyText: null,
      segments: [
        { summary: '第一段', fromMessageId: '*', toMessageId: 'a1' },
        { summary: '第二段', fromMessageId: 'u2', toMessageId: 'a3' },
      ],
    });
    expect(text).toContain('【摘要段 1｜覆盖 * ~ a1】');
    expect(text).toContain('【摘要段 2｜覆盖 u2 ~ a3】');
    const parsed = parseContextSummary(text);
    expect(parsed.legacyText).toBeNull();
    expect(parsed.segments).toEqual([
      { summary: '第一段', fromMessageId: '*', toMessageId: 'a1' },
      { summary: '第二段', fromMessageId: 'u2', toMessageId: 'a3' },
    ]);
  });

  it('treats plain text as legacy', () => {
    const parsed = parseContextSummary('旧摘要正文');
    expect(parsed.segments).toEqual([]);
    expect(parsed.legacyText).toBe('旧摘要正文');
  });

  it('parses legacy text followed by structured segments', () => {
    const parsed = parseContextSummary(
      '旧摘要正文\n\n【摘要段 1｜覆盖 u2 ~ a3】\n新段',
    );
    expect(parsed.legacyText).toBe('旧摘要正文');
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0].summary).toBe('新段');
  });

  it('returns empty parse for empty input', () => {
    expect(parseContextSummary(null)).toEqual({
      legacyText: null,
      segments: [],
    });
    expect(parseContextSummary('   ')).toEqual({
      legacyText: null,
      segments: [],
    });
  });

  it('merges when count or chars exceed limits', () => {
    const seg = (i: number) => ({
      summary: `s${i}`,
      fromMessageId: `u${i}`,
      toMessageId: `a${i}`,
    });
    expect(shouldMergeSummarySegments([1, 2, 3, 4].map(seg))).toBe(false);
    expect(shouldMergeSummarySegments([1, 2, 3, 4, 5].map(seg))).toBe(true);
    expect(
      shouldMergeSummarySegments([
        { summary: 'x'.repeat(6_001), fromMessageId: '*', toMessageId: 'a1' },
      ]),
    ).toBe(true);
    expect(summarySegmentsTotalChars([seg(1), seg(2)])).toBe(4);
  });

  it('merges segments keeping first/last range', () => {
    const merged = mergeSummarySegments(
      [
        { summary: 'a', fromMessageId: '*', toMessageId: 'a1' },
        { summary: 'b', fromMessageId: 'u2', toMessageId: 'a3' },
      ],
      '合并',
    );
    expect(merged).toEqual({
      summary: '合并',
      fromMessageId: '*',
      toMessageId: 'a3',
    });
  });
});
