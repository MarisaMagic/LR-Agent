/**
 * Client-side sub-agent tools (YOLO detect, finalize) shared by ReAct runners.
 */
import {
  assertPreAnnotResult,
  runPreAnnot,
} from '../preAnnotService';
import type {
  AnnotationBatchChange,
  BatchAnnotationPlan,
  ImageCandidate,
} from '../../../shared/annotationAgentTypes';
import type { PretrainedModelConfig } from '../../types/pretrainedModel';
import { isDetectResult } from '../../../shared/preAnnotTypes';
import { filterDetectionBoxesByScope } from './detectionScope';
import { tryAutoFinalizeFromMap } from './finalizeFromMappings';
import { logAnnotationDebug } from './annotationAgentDebug';
import type { AgentToolCall } from './agentTurnTypes';

export type DetectBox = {
  box_index: number;
  class_name: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export interface SubImageToolContext {
  boxes: DetectBox[];
  rawCount: number;
  keptCount: number;
  excludedCount: number;
  mappings: Array<{ box_index: number; label_id: string; reason?: string }>;
  mapMethod: string;
  mapHint: string;
  change?: AnnotationBatchChange;
}

export async function readImageBase64(absolutePath: string): Promise<string> {
  const buf = await window.electron?.fileSystem?.readFileBuffer(absolutePath);
  if (!buf || buf.byteLength === 0) return '';
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function runObjectDetectionForSubAgent(
  image: ImageCandidate,
  plan: BatchAnnotationPlan,
  detectionModel: PretrainedModelConfig,
  args: Record<string, unknown>,
): Promise<{ rawCount: number; keptCount: number; excludedCount: number; boxes: DetectBox[] }> {
  const hints = plan.detection_hints;
  const conf =
    typeof args.conf_threshold === 'number' ? args.conf_threshold : hints.conf_threshold;
  const iou =
    typeof args.iou_threshold === 'number' ? args.iou_threshold : hints.iou_threshold;

  const response = await runPreAnnot('yolo_detect', image.absolutePath, detectionModel, {
    overrides: { confThreshold: conf, iouThreshold: iou },
  });
  const detResult = assertPreAnnotResult(response, isDetectResult, '检测');
  const rawItems = detResult.items.map((item, idx) => {
    const g = item.geometry;
    const x = 'x' in g ? g.x : g.cx - g.width / 2;
    const y = 'y' in g ? g.y : g.cy - g.height / 2;
    return {
      box_index: idx,
      class_name: item.className,
      confidence: item.confidence,
      x,
      y,
      width: g.width,
      height: g.height,
    };
  });
  const rawCount = rawItems.length;
  const scoped = filterDetectionBoxesByScope(rawItems, plan.annotation_scope);
  const boxes = scoped.boxes.map((b, i) => ({ ...b, box_index: i }));
  logAnnotationDebug('detect', image.relativePath, {
    raw_count: rawCount,
    kept_count: boxes.length,
    excluded_count: scoped.excluded,
    detection_classes: [...new Set(boxes.map((b) => b.class_name))].slice(0, 8),
    scope: plan.annotation_scope,
    conf,
    iou,
  });
  return {
    rawCount,
    keptCount: boxes.length,
    excludedCount: scoped.excluded,
    boxes,
  };
}

export function normalizeToolBoxes(raw: unknown[]): DetectBox[] {
  return raw.map((item, idx) => {
    const b = item as Record<string, unknown>;
    return {
      box_index: Number(b.box_index ?? idx),
      class_name: String(b.class_name ?? b.detection_label ?? ''),
      confidence: Number(b.confidence ?? 0),
      x: Number(b.x ?? 0),
      y: Number(b.y ?? 0),
      width: Number(b.width ?? 0),
      height: Number(b.height ?? 0),
    };
  });
}

export async function executeClientSubImageTool(
  options: {
    userRequest: string;
    plan: BatchAnnotationPlan;
    image: ImageCandidate;
    detectionModel: PretrainedModelConfig;
    labelCandidates: Array<{ id: string; name: string }>;
  },
  call: Pick<AgentToolCall, 'name' | 'args'>,
  ctx: SubImageToolContext,
): Promise<string> {
  const { plan, image } = options;

  if (call.name === 'run_object_detection') {
    const det = await runObjectDetectionForSubAgent(
      image,
      plan,
      options.detectionModel,
      (call.args ?? {}) as Record<string, unknown>,
    );
    ctx.rawCount = det.rawCount;
    ctx.keptCount = det.keptCount;
    ctx.excludedCount = det.excludedCount;
    ctx.boxes = det.boxes;
    return JSON.stringify({
      ok: true,
      raw_count: det.rawCount,
      kept_count: det.keptCount,
      excluded_count: det.excludedCount,
      boxes: det.boxes,
      scope_summary: plan.annotation_scope.scope_summary,
    });
  }

  if (call.name === 'finalize_image_change') {
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
      return JSON.stringify({
        ok: true,
        box_count: auto.mappedCount,
        captured: true,
      });
    }
    return JSON.stringify({
      ok: false,
      error: auto.reason ?? 'finalize 失败',
    });
  }

  return JSON.stringify({ ok: false, error: `未知客户端工具: ${call.name}` });
}

export function applyServerDoneToContext(
  ctx: SubImageToolContext,
  data: {
    boxes?: DetectBox[];
    mappings?: Array<{ box_index: number; label_id: string; reason?: string }>;
    raw_count?: number;
    kept_count?: number;
    method?: string;
    map_hint?: string;
  },
): void {
  if (Array.isArray(data.boxes) && data.boxes.length > 0) {
    ctx.boxes = data.boxes;
  }
  if (Array.isArray(data.mappings)) {
    ctx.mappings = data.mappings;
  }
  if (typeof data.raw_count === 'number') ctx.rawCount = data.raw_count;
  if (typeof data.kept_count === 'number') ctx.keptCount = data.kept_count;
  if (data.method) ctx.mapMethod = data.method;
  if (data.map_hint) ctx.mapHint = data.map_hint;
}
