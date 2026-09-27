/**
 * 分段摘要的序列化 / 解析 / 合并判定（共享存储格式）。
 *
 * 复用会话的 `contextSummary` 文本字段存储（零 DB 迁移）：
 *
 * ```
 * 【摘要段 1｜覆盖 m100 ~ m148】
 * ...正文...
 *
 * 【摘要段 2｜覆盖 m152 ~ m190】
 * ...正文...
 * ```
 *
 * `fromMessageId` 为 `'*'` 表示覆盖从会话起点开始（旧格式摘要迁移、整段合并时出现）。
 * 旧版本的纯文本摘要首次追加新段时会被迁移为「段 1（覆盖 * ~ 旧覆盖点）」。
 */

export interface SummarySegment {
  summary: string;
  fromMessageId: string;
  toMessageId: string;
}

export interface ParsedContextSummary {
  /** 无结构的历史摘要正文（旧格式）；无则为 null */
  legacyText: string | null;
  segments: SummarySegment[];
}

export const SUMMARY_SEGMENT_MAX_COUNT = 4;
export const SUMMARY_SEGMENT_MAX_CHARS = 6_000;

const HEADER_RE = /【摘要段 (\d+)｜覆盖 (\S+) ~ (\S+)】/g;

export function parseContextSummary(
  text: string | null | undefined,
): ParsedContextSummary {
  const raw = (text ?? '').trim();
  if (!raw) return { legacyText: null, segments: [] };

  const matches: Array<{
    index: number;
    end: number;
    from: string;
    to: string;
  }> = [];
  const re = new RegExp(HEADER_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    matches.push({
      index: match.index,
      end: match.index + match[0].length,
      from: match[2],
      to: match[3],
    });
  }
  if (matches.length === 0) return { legacyText: raw, segments: [] };

  const legacyText = raw.slice(0, matches[0].index).trim() || null;
  const segments = matches.map((item, i) => {
    const bodyStart = item.end;
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].index : raw.length;
    return {
      summary: raw.slice(bodyStart, bodyEnd).trim(),
      fromMessageId: item.from,
      toMessageId: item.to,
    };
  });
  return { legacyText, segments };
}

export function serializeContextSummary(
  parsed: ParsedContextSummary,
): string | undefined {
  const parts: string[] = [];
  if (parsed.legacyText?.trim()) parts.push(parsed.legacyText.trim());
  parsed.segments.forEach((segment, i) => {
    parts.push(
      `【摘要段 ${i + 1}｜覆盖 ${segment.fromMessageId} ~ ${segment.toMessageId}】\n${segment.summary.trim()}`,
    );
  });
  const text = parts.join('\n\n').trim();
  return text || undefined;
}

export function summarySegmentsTotalChars(segments: SummarySegment[]): number {
  return segments.reduce((sum, segment) => sum + segment.summary.length, 0);
}

/** 段数或总正文长度超限时需要合并为单段。 */
export function shouldMergeSummarySegments(
  segments: SummarySegment[],
): boolean {
  return (
    segments.length > SUMMARY_SEGMENT_MAX_COUNT ||
    summarySegmentsTotalChars(segments) > SUMMARY_SEGMENT_MAX_CHARS
  );
}

/** 把多段合并为一段（区间取首尾），正文由调用方用 LLM 生成。 */
export function mergeSummarySegments(
  segments: SummarySegment[],
  mergedSummary: string,
): SummarySegment {
  return {
    summary: mergedSummary,
    fromMessageId: segments[0]?.fromMessageId ?? '*',
    toMessageId: segments[segments.length - 1]?.toMessageId ?? '',
  };
}
