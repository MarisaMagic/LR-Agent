/**
 * 标注质量报告 LLM 撰写（SSE 流式）。
 *
 * 移植自 `vendor/local-agent/app/agent/annotation/quality_report_compose_service.py`
 * 与 `app/api/v1/annotation_quality.py`。
 *
 * **注意本端点与 Assist 的 error 语义不同**：Assist 运行时从不发 `error` 事件
 * （由渲染层合成），但本端点在异常时**会**发 `error` 事件并结束流——
 * 因为报告撰写是一次性流，中途失败需要明确告知前端，否则会得到半截报告。
 *
 * payload 有两级截断：
 *   1. 请求体整体 > 512KB → 400 `compose_payload_too_large`（路由层校验）
 *   2. 序列化后 > 48000 字符 → 截断并追加提示（本模块内）
 */

import { DONE_FRAME, encodeSseFrame, sse, toSseDict } from '../sse';
import type { LlmClient } from '../llm/client';
import { sanitizeJsonValue } from './common';
import { contentToText } from './generate';

/** 报告撰写系统提示词（行为契约，需原样保留）。 */
export const QUALITY_REPORT_COMPOSE_SYSTEM = `你是 LR-Agent 标注质量报告撰写助手。根据提供的标注质量指标、一致性检查发现和图表路径，用中文 Markdown 撰写结构化质量报告。

要求：
- 固定章节：概览、覆盖率、标签分布、一致性问题、风险文件清单、改进建议
- 所有数字必须来自提供的 metrics / findings JSON，禁止编造
- 在合适章节嵌入图表，使用给定 chart_paths 中的相对路径，格式：![标题](charts/xxx.png)
- 对 critical / warning 级别发现给出明确复核建议
- 语言简洁专业，适合交付给标注团队或甲方
- 不要输出代码块包裹整篇报告
`;

/** payload 序列化后的字符上限。 */
const PAYLOAD_CHAR_LIMIT = 48_000;

/** 请求体字节上限（512KB）。 */
export const COMPOSE_PAYLOAD_MAX_BYTES = 512_000;

/**
 * 校验 `compose_payload` 的字节规模。
 *
 * 按 UTF-8 字节数计（与 Python 的 `len(json.dumps(...).encode("utf-8"))` 一致）。
 */
export function assertComposePayloadSize(composePayload: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(composePayload ?? {}), 'utf8');
  if (bytes > COMPOSE_PAYLOAD_MAX_BYTES) {
    throw new Error('compose_payload_too_large');
  }
}

/** 构造发送给 LLM 的消息（含 payload 截断）。 */
export function buildComposeMessages(composePayload: unknown): Array<{
  role: 'system' | 'user';
  content: string;
}> {
  let payloadJson = JSON.stringify(composePayload ?? {}, null, 2);
  if (payloadJson.length > PAYLOAD_CHAR_LIMIT) {
    payloadJson = `${payloadJson.slice(0, PAYLOAD_CHAR_LIMIT)}\n…（已截断）`;
  }

  const human =
    '【质量指标与发现 JSON】\n' +
    `${payloadJson}\n\n` +
    '请基于以上数据撰写完整 Markdown 质量报告。';

  return [
    { role: 'system', content: QUALITY_REPORT_COMPOSE_SYSTEM },
    { role: 'user', content: human },
  ];
}

/**
 * 流式撰写质量报告，产出 SSE 帧。
 *
 * 异常时发 `error` 事件并结束（与本端点的既有语义一致）。
 */
export async function* streamQualityReportCompose(
  llm: LlmClient,
  options: {
    composePayload: unknown;
    signal?: AbortSignal;
    /** 是否在 error 事件中附带 detail（对应 settings.debug）。 */
    debug?: boolean;
    onError?: (err: unknown) => void;
  },
): AsyncGenerator<string> {
  try {
    // 清洗孤立代理码元，避免下游 UTF-8 写盘失败
    const payload = sanitizeJsonValue(options.composePayload);
    const messages = buildComposeMessages(payload);

    for await (const delta of llm.streamChat({
      messages,
      signal: options.signal,
    })) {
      if (delta.content) {
        yield encodeSseFrame(toSseDict(sse.textDelta(delta.content)));
      }
    }
    yield DONE_FRAME;
  } catch (err) {
    options.onError?.(err);
    const event: Record<string, unknown> = {
      type: 'error',
      message: 'quality_report_compose_failed',
    };
    if (options.debug) event.detail = 'quality_report_compose_failed';
    yield encodeSseFrame(event);
  }
}

/** 供测试与路由复用：抽取单个 chunk 的文本。 */
export function chunkText(content: unknown): string {
  return contentToText(content);
}
