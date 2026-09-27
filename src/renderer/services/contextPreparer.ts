/**
 * 发消息前的上下文准备：窗口裁剪 + 级联压缩（软线本地清理 → 超线摘要）。
 *
 * - 始终应用 maxTurnsInWindow 硬窗口裁剪（含已有摘要覆盖点之后的消息）
 * - 估算真实的对外 payload（含工具消息）；超过预算 × 软线（0.70）时，
 *   先做零 API 的本地微压缩（可重取工具结果占位符化）并重新估算
 * - 清理后仍超过预算 × summarizeTriggerRatio 且轮数足够时，把即将被挤出的
 *   旧消息交给 LLM 生成增量摘要
 * - 摘要失败时降级为纯裁剪，不阻塞发消息
 */

import {
  DEFAULT_CHAT_CONTEXT_CONFIG,
  type AgentSession,
  type ChatContextConfig,
  type ChatMessage,
} from '../../shared/agentTypes';
import { MICRO_COMPACT_SOFT_RATIO } from '../../shared/microCompact';
import {
  mergeSummarySegments,
  parseContextSummary,
  serializeContextSummary,
  shouldMergeSummarySegments,
} from '../../shared/summarySegments';
import { buildTurnContextFromState, formatTurnLine } from './turnContext';
import {
  summarizeConversation,
  type SummarizeConversationOptions,
} from './contextSummarizer';
import {
  buildBackendMessages,
  type BackendChatMessage,
} from './backendChatClient';
import {
  estimatePayloadTokens,
  microCompactPayload,
} from './payloadCompaction';

export interface PreparedChatContext {
  /** 实际发送给 LLM 的消息 id 列表（窗口裁剪后） */
  windowedMessageIds: string[];
  /** 发请求的完整消息（含工具消息；已应用软线清理） */
  messages: BackendChatMessage[];
  /** 新生成的摘要（仅 summarized=true 时有值） */
  contextSummary?: string;
  /** 摘要覆盖到的最后一条消息 id（仅 summarized=true 时有值） */
  summaryUpToMessageId?: string;
  /** 本次发送上下文的 token 估算值 */
  tokenEstimate: number;
  /** 本次是否生成了新摘要 */
  summarized: boolean;
  /** 本次是否执行了软线本地清理（微压缩） */
  compacted: boolean;
  /** 有效会话预算（tokens），供运行时软线复用 */
  budgetTokens: number;
}

/** 粗略 token 估算：中英混合场景按 chars/3 折算 */
export function estimateTokens(text: string): number {
  return estimateTokensFromChars(text.length);
}

function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 3);
}

export type SummarizeFn = (
  options: SummarizeConversationOptions,
) => Promise<string>;

export interface PrepareChatContextOptions {
  session: AgentSession;
  /** 本次发送的全量消息 id（含新用户消息与助手占位） */
  messageIds: string[];
  sessionMessages: Record<string, ChatMessage>;
  currentUserContent: string;
  provider: { baseUrl: string; apiKey: string; model: string };
  /** 排除的消息 id（如流式中的助手占位消息） */
  excludeMessageIds?: Set<string>;
  config?: ChatContextConfig;
  /** 模型上下文窗口（tokens）；已知时按比例推导预算，未知沿用默认配置 */
  modelContextWindowTokens?: number | null;
  /** 可注入的摘要实现（测试用） */
  summarizeFn?: SummarizeFn;
  signal?: AbortSignal;
}

/** 从模型窗口推导会话预算：取窗口 10%，钳制在 [8K, 48K] */
export function deriveMaxContextTokens(
  modelContextWindowTokens: number | null | undefined,
): number | null {
  if (
    typeof modelContextWindowTokens !== 'number' ||
    !Number.isFinite(modelContextWindowTokens) ||
    modelContextWindowTokens <= 0
  ) {
    return null;
  }
  const MIN_BUDGET_TOKENS = 8_000;
  const MAX_BUDGET_TOKENS = 48_000;
  const derived = Math.round(modelContextWindowTokens * 0.1);
  return Math.min(MAX_BUDGET_TOKENS, Math.max(MIN_BUDGET_TOKENS, derived));
}

/** 摘要覆盖点之后的消息 id 列表 */
function eligibleIdsAfterSummary(
  messageIds: string[],
  summaryUpToMessageId: string | undefined,
): string[] {
  if (!summaryUpToMessageId) return messageIds;
  const cutoff = messageIds.indexOf(summaryUpToMessageId);
  if (cutoff < 0) return messageIds;
  return messageIds.slice(cutoff + 1);
}

export async function prepareChatContext(
  options: PrepareChatContextOptions,
): Promise<PreparedChatContext> {
  const config = options.config ?? DEFAULT_CHAT_CONTEXT_CONFIG;
  const summarizeFn = options.summarizeFn ?? summarizeConversation;
  const derivedBudget = deriveMaxContextTokens(
    options.modelContextWindowTokens,
  );
  const effectiveConfig: ChatContextConfig = derivedBudget
    ? { ...config, maxContextTokens: derivedBudget }
    : config;
  const budgetTokens = effectiveConfig.maxContextTokens;

  const eligibleIds = eligibleIdsAfterSummary(
    options.messageIds,
    options.session.summaryUpToMessageId,
  );

  const messagesBySession = {
    [options.session.id]: Object.values(options.sessionMessages),
  };
  const turnCtx = buildTurnContextFromState(
    options.session,
    eligibleIds,
    messagesBySession,
    {
      currentUserContent: options.currentUserContent,
      excludeMessageIds: options.excludeMessageIds,
      maxTurnsInWindow: config.maxTurnsInWindow,
    },
  );

  // 硬窗口裁剪：从窗口内第一条内容消息开始截取（保留其后的非内容消息）
  const windowStartId = turnCtx.windowedLines[0]?.messageId;
  const hardWindowedIds = windowStartId
    ? eligibleIds.slice(eligibleIds.indexOf(windowStartId))
    : eligibleIds;

  const buildPayload = (ids: string[]): BackendChatMessage[] =>
    buildBackendMessages(ids, options.sessionMessages, {
      excludeMessageIds: options.excludeMessageIds,
    });

  const existingSummaryChars = options.session.contextSummary?.length ?? 0;
  let payload = buildPayload(hardWindowedIds);
  let tokenEstimate =
    estimatePayloadTokens(payload) +
    estimateTokensFromChars(existingSummaryChars);

  // 软线：先做零 API 的本地清理，再重新估算（级联第一档）
  let compacted = false;
  if (tokenEstimate > budgetTokens * MICRO_COMPACT_SOFT_RATIO) {
    const micro = microCompactPayload(payload);
    if (micro.replaced > 0) {
      payload = micro.messages;
      compacted = true;
      tokenEstimate =
        estimatePayloadTokens(payload) +
        estimateTokensFromChars(existingSummaryChars);
    }
  }

  const fallback: PreparedChatContext = {
    windowedMessageIds: hardWindowedIds,
    messages: payload,
    tokenEstimate,
    summarized: false,
    compacted,
    budgetTokens,
  };

  // 级联第二档：清理后仍超摘要线，且轮数足够，才调 LLM 摘要
  const shouldSummarize =
    tokenEstimate >
      effectiveConfig.maxContextTokens * config.summarizeTriggerRatio &&
    turnCtx.lines.length >= config.minTurnsBeforeSummarize * 2;
  if (!shouldSummarize) return fallback;
  // 触发摘要：仅保留最近一半窗口的轮次，其余压入摘要
  const keepTurns = Math.max(2, Math.ceil(config.maxTurnsInWindow / 2));
  const keepCount = keepTurns * 2;
  const evictedLines = turnCtx.lines.slice(
    0,
    Math.max(0, turnCtx.lines.length - keepCount),
  );
  if (evictedLines.length === 0) return fallback;

  const evictedTranscript = evictedLines
    .map((line) => formatTurnLine(line.role, line.content))
    .join('\n');

  const fromMessageId = evictedLines[0]!.messageId;
  const toMessageId = evictedLines[evictedLines.length - 1]!.messageId;

  // 新段：只总结本次被挤出的轮次（旧段内容由已注入的摘要文本承载，不重复合并）
  let newSummary: string;
  try {
    newSummary = await summarizeFn({
      baseUrl: options.provider.baseUrl,
      apiKey: options.provider.apiKey,
      model: options.provider.model,
      existingSummary: null,
      evictedTranscript,
      signal: options.signal,
    });
  } catch (err) {
    console.warn('[contextPreparer] 摘要生成失败，降级为纯窗口裁剪:', err);
    return fallback;
  }

  // 覆盖区间记账：旧格式纯文本摘要首次追加时迁移为「覆盖 * ~ 旧覆盖点」的段
  const parsed = parseContextSummary(options.session.contextSummary);
  let { segments } = parsed;
  if (parsed.legacyText) {
    segments = [
      {
        summary: parsed.legacyText,
        fromMessageId: '*',
        toMessageId: options.session.summaryUpToMessageId ?? fromMessageId,
      },
      ...segments,
    ];
  }
  segments = [...segments, { summary: newSummary, fromMessageId, toMessageId }];

  // 段数 / 总长超限：用 LLM 合并为单段（失败时保留多段，不阻塞发送）
  if (shouldMergeSummarySegments(segments)) {
    try {
      const mergedSummary = await summarizeFn({
        baseUrl: options.provider.baseUrl,
        apiKey: options.provider.apiKey,
        model: options.provider.model,
        existingSummary: segments
          .map((segment) => segment.summary)
          .join('\n\n'),
        evictedTranscript: '',
        signal: options.signal,
      });
      segments = [mergeSummarySegments(segments, mergedSummary)];
    } catch (err) {
      console.warn('[contextPreparer] 摘要段合并失败，保留多段:', err);
    }
  }

  const contextSummary =
    serializeContextSummary({ legacyText: null, segments }) ?? newSummary;
  const summaryUpToMessageId = toMessageId;
  const summaryCutoff = eligibleIds.indexOf(summaryUpToMessageId);
  const windowedMessageIds =
    summaryCutoff >= 0 ? eligibleIds.slice(summaryCutoff + 1) : eligibleIds;

  // 摘要后重建 payload；若仍超软线再清一次（幂等，通常不会触发）
  payload = buildPayload(windowedMessageIds);
  const after = microCompactPayload(payload);
  if (after.replaced > 0) {
    payload = after.messages;
    compacted = true;
  }
  tokenEstimate =
    estimatePayloadTokens(payload) +
    estimateTokensFromChars(contextSummary.length);

  return {
    windowedMessageIds,
    messages: payload,
    contextSummary,
    summaryUpToMessageId,
    tokenEstimate,
    summarized: true,
    compacted,
    budgetTokens,
  };
}
