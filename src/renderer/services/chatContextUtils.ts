import type { AgentSession } from '../../shared/agentTypes';
import {
  parseContextSummary,
  serializeContextSummary,
  type SummarySegment,
} from '../../shared/summarySegments';

export interface SummaryEditResolution {
  /** 是否发生了摘要回退 */
  changed: boolean;
  /** 回退后剩余的摘要文本；无剩余时为 undefined */
  contextSummary?: string;
  /** 回退后的覆盖点；无剩余时为 undefined */
  summaryUpToMessageId?: string;
}

type CoverageItem =
  | { kind: 'legacy'; toMessageId: string | undefined }
  | { kind: 'segment'; segment: SummarySegment };

/**
 * 编辑某条历史消息后，按摘要段覆盖区间回退摘要：
 * 丢弃「覆盖该消息的段」及其之后的所有段，保留更早的段。
 *
 * 旧格式纯文本摘要（无段头）视为覆盖 `[会话起点, summaryUpToMessageId]`，
 * 命中时与旧行为一致地整体清空。
 */
export function resolveSummaryOnEdit(
  session: AgentSession,
  messageIds: string[],
  editMessageId: string,
): SummaryEditResolution {
  const existing = session.contextSummary?.trim();
  if (!existing) return { changed: false };

  const parsed = parseContextSummary(existing);
  const items: CoverageItem[] = [];
  if (parsed.legacyText) {
    items.push({ kind: 'legacy', toMessageId: session.summaryUpToMessageId });
  }
  parsed.segments.forEach((segment) =>
    items.push({ kind: 'segment', segment }),
  );
  if (items.length === 0) return { changed: false };

  const editIndex = messageIds.indexOf(editMessageId);
  const covers = (
    fromMessageId: string,
    toMessageId: string | undefined,
  ): boolean => {
    if (!toMessageId) return true; // 覆盖点缺失：保守视为覆盖
    const toIndex = messageIds.indexOf(toMessageId);
    // 覆盖点或编辑点无法定位：保守视为覆盖（宁可丢弃）
    if (toIndex < 0 || editIndex < 0) return true;
    if (editIndex > toIndex) return false;
    if (fromMessageId === '*') return true;
    const fromIndex = messageIds.indexOf(fromMessageId);
    if (fromIndex < 0) return true; // 区间起点缺失：内容不可定位，保守视为覆盖
    return editIndex >= fromIndex;
  };

  let cut = -1;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const covered =
      item.kind === 'legacy'
        ? covers('*', item.toMessageId)
        : covers(item.segment.fromMessageId, item.segment.toMessageId);
    if (covered) {
      cut = i;
      break;
    }
  }
  if (cut < 0) return { changed: false };

  const kept = items.slice(0, cut);
  const segments = kept
    .filter(
      (item): item is Extract<CoverageItem, { kind: 'segment' }> =>
        item.kind === 'segment',
    )
    .map((item) => item.segment);
  const keepLegacy = kept.some((item) => item.kind === 'legacy');
  const contextSummary = serializeContextSummary({
    legacyText: keepLegacy ? parsed.legacyText : null,
    segments,
  });
  const last = kept[kept.length - 1];
  const summaryUpToMessageId = last
    ? last.kind === 'legacy'
      ? session.summaryUpToMessageId
      : last.segment.toMessageId
    : undefined;

  return { changed: true, contextSummary, summaryUpToMessageId };
}
