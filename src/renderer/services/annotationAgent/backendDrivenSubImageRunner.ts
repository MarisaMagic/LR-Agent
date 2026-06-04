/**
 * 方案 C：后端驱动 ReAct 循环，客户端仅执行本地工具（detect / finalize）。
 * map 在服务端执行，减少 agent-turn 与 map HTTP 往返。
 */
import { API_BASE_URL } from '../../config';
import { apiFetch } from '../api';
import tokenHolder from '../tokenHolder';
import type {
  AnnotationBatchChange,
  BatchAnnotationPlan,
  ImageCandidate,
} from '../../../shared/annotationAgentTypes';
import type { PretrainedModelConfig } from '../../types/pretrainedModel';
import type { SubImageTimingBreakdown } from './annotationTiming';
import { tryAutoFinalizeFromMap } from './finalizeFromMappings';
import { logAnnotationDebug } from './annotationAgentDebug';
import type { FusionSubImageResult } from './fusionSubImageTypes';
import {
  applyServerDoneToContext,
  executeClientSubImageTool,
  type SubImageToolContext,
} from './fusionSubImageTools';

type SubImageSseEvent =
  | { type: 'session'; data: { run_id: string } }
  | { type: 'round'; data: { round: number; tools: string[] } }
  | {
      type: 'client_tool';
      data: {
        run_id: string;
        tool_call_id: string;
        name: string;
        args: Record<string, unknown>;
      };
    }
  | {
      type: 'done';
      data: {
        ok?: boolean;
        content?: string;
        raw_count?: number;
        kept_count?: number;
        mapped_count?: number;
        unmapped_count?: number;
        method?: string;
        map_hint?: string;
        boxes?: SubImageToolContext['boxes'];
        mappings?: SubImageToolContext['mappings'];
        captured_finalize?: boolean;
      };
    }
  | { type: 'error'; data: { message?: string } };

function parseSseChunk(buffer: string): { events: SubImageSseEvent[]; rest: string } {
  const events: SubImageSseEvent[] = [];
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  for (const part of parts) {
    const line = part
      .split('\n')
      .find((l) => l.startsWith('data:'));
    if (!line) continue;
    const jsonText = line.slice(5).trim();
    if (!jsonText) continue;
    try {
      events.push(JSON.parse(jsonText) as SubImageSseEvent);
    } catch {
      // ignore malformed chunk
    }
  }
  return { events, rest };
}

async function postSubImageToolResult(
  runId: string,
  toolCallId: string,
  content: string,
): Promise<void> {
  await apiFetch<{ ok: boolean }>('/agent/annotation/sub-image-run/tool-result', {
    method: 'POST',
    body: JSON.stringify({
      run_id: runId,
      tool_call_id: toolCallId,
      content,
    }),
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function runBackendDrivenSubImageAgent(options: {
  providerId: string;
  userRequest: string;
  plan: BatchAnnotationPlan;
  image: ImageCandidate;
  detectionModel: PretrainedModelConfig;
  labelCandidates: Array<{ id: string; name: string }>;
}): Promise<FusionSubImageResult> {
  const { image, plan } = options;
  const base = {
    ok: false as const,
    relativePath: image.relativePath,
    absolutePath: image.absolutePath,
  };
  const minLabeled = plan.sub_agent_constraints.min_labeled_box_count ?? 1;
  const useVision = Boolean(plan.use_vision_mapping);
  const totalStarted = performance.now();
  const timing: SubImageTimingBreakdown = { total_ms: 0 };
  let roundCount = 0;

  logAnnotationDebug('sub-agent-start', image.relativePath, {
    mode: 'backend-driven',
    provider_id: options.providerId,
    use_vision_mapping: useVision,
    detection_model: options.detectionModel.id,
  });

  const ctx: SubImageToolContext = {
    boxes: [],
    rawCount: 0,
    keptCount: 0,
    excludedCount: 0,
    mappings: [],
    mapMethod: '',
    mapHint: '',
  };

  let imageBase64 = '';

  const accessToken = tokenHolder.getAccessToken();
  if (!accessToken) {
    return { ...base, reason: '未登录' };
  }

  const tStream = performance.now();
  const response = await fetch(`${API_BASE_URL}/agent/annotation/sub-image-run/stream`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      provider_id: options.providerId,
      user_request: options.userRequest,
      plan,
      image_relative_path: image.relativePath,
      image_absolute_path: image.absolutePath,
      label_candidates: options.labelCandidates,
      detection_model_id: options.detectionModel.id,
      image_base64: imageBase64,
      mime_type: 'image/jpeg',
    }),
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const errBody = (await response.json()) as { detail?: string };
      detail = errBody.detail ?? detail;
    } catch {
      // ignore
    }
    return { ...base, reason: detail || '子 Agent 流启动失败' };
  }

  if (!response.body) {
    return { ...base, reason: '子 Agent 响应体为空' };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let runId = '';
  let donePayload: SubImageSseEvent & { type: 'done' } | null = null;
  let streamError: string | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseChunk(buffer);
      buffer = parsed.rest;

      for (const event of parsed.events) {
        if (event.type === 'session') {
          runId = event.data.run_id;
        } else if (event.type === 'round') {
          roundCount += 1;
          logAnnotationDebug('sub-agent-round', image.relativePath, {
            round: event.data.round,
            tools: event.data.tools,
          });
        } else if (event.type === 'client_tool') {
          const tTool = performance.now();
          const toolContent = await executeClientSubImageTool(
            options,
            { name: event.data.name, args: event.data.args },
            ctx,
          );
          const toolMs = Math.round(performance.now() - tTool);
          if (event.data.name === 'run_object_detection') {
            timing.detect_ms = (timing.detect_ms ?? 0) + toolMs;
            logAnnotationDebug('detect', image.relativePath, {
              elapsed_ms: toolMs,
              raw_count: ctx.rawCount,
              kept_count: ctx.keptCount,
            });
          } else if (event.data.name === 'finalize_image_change') {
            timing.finalize_ms = (timing.finalize_ms ?? 0) + toolMs;
            logAnnotationDebug('finalize', image.relativePath, { elapsed_ms: toolMs });
          }
          await postSubImageToolResult(
            event.data.run_id || runId,
            event.data.tool_call_id,
            toolContent,
          );
        } else if (event.type === 'done') {
          donePayload = event;
        } else if (event.type === 'error') {
          streamError = event.data.message ?? '子 Agent 失败';
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  timing.stream_ms = Math.round(performance.now() - tStream);
  timing.round_count = roundCount;
  timing.total_ms = Math.round(performance.now() - totalStarted);

  const withTiming = (result: FusionSubImageResult): FusionSubImageResult => ({
    ...result,
    elapsedMs: timing.total_ms,
    timing,
  });

  if (streamError) {
    logAnnotationDebug('sub-agent-error', image.relativePath, {
      elapsed_ms: timing.total_ms,
      reason: streamError,
      timing,
    });
    return withTiming({
      ...base,
      reason: streamError,
      rawCount: ctx.rawCount,
      keptCount: ctx.keptCount,
    });
  }

  if (!donePayload) {
    return withTiming({
      ...base,
      reason: '子 Agent 未返回完成事件',
      rawCount: ctx.rawCount,
      keptCount: ctx.keptCount,
    });
  }

  applyServerDoneToContext(ctx, donePayload.data);

  if (!ctx.change) {
    const auto = tryAutoFinalizeFromMap({
      plan,
      imageRelativePath: image.relativePath,
      imageAbsolutePath: image.absolutePath,
      boxes: ctx.boxes,
      mappings: ctx.mappings,
      labelCandidates: options.labelCandidates,
    });
    if (auto.ok && auto.change) {
      ctx.change = auto.change;
    }
  }

  const mappedCount =
    donePayload.data.mapped_count ??
    ctx.mappings.filter((m) => m.label_id).length;
  const kept = donePayload.data.kept_count ?? ctx.keptCount;

  if (ctx.change) {
    logAnnotationDebug('sub-agent-done', image.relativePath, {
      elapsed_ms: timing.total_ms,
      ok: true,
      timing,
      method: ctx.mapMethod,
    });
    return withTiming({
      ok: true,
      relativePath: image.relativePath,
      absolutePath: image.absolutePath,
      change: ctx.change,
      rawCount: donePayload.data.raw_count ?? ctx.rawCount,
      keptCount: kept,
      mappedCount: ctx.change.annotations.length,
      unmappedCount: Math.max(0, kept - ctx.change.annotations.length),
      autoFinalized: true,
      method: ctx.mapMethod,
    });
  }

  const failReason =
    ctx.mapHint ||
    donePayload.data.content ||
    `成功映射 ${mappedCount} 框，不足最少要求 ${minLabeled}`;

  logAnnotationDebug('sub-agent-fail', image.relativePath, {
    mode: 'backend-driven',
    elapsed_ms: timing.total_ms,
    reason: failReason,
    mapped_count: mappedCount,
    method: ctx.mapMethod,
    timing,
  });

  return withTiming({
    ...base,
    reason: failReason,
    rawCount: donePayload.data.raw_count ?? ctx.rawCount,
    keptCount: kept,
    mappedCount,
    unmappedCount: donePayload.data.unmapped_count ?? Math.max(0, kept - mappedCount),
    method: ctx.mapMethod,
    mapHint: ctx.mapHint,
  });
}
