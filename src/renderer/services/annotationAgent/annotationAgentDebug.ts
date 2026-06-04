/**
 * 批量标注诊断日志（DevTools Console / Electron 终端可见）。
 * 过滤：annotation-agent
 */

import { formatDurationMs } from './annotationTiming';

const PREFIX = '[annotation-agent]';

function enabled(): boolean {
  if (typeof window === 'undefined') return true;
  const w = window as Window & { __LR_AGENT_ANNOTATION_DEBUG__?: boolean };
  return w.__LR_AGENT_ANNOTATION_DEBUG__ !== false;
}

export function logAnnotationDebug(
  stage: string,
  message: string,
  data?: Record<string, unknown>,
): void {
  if (!enabled()) return;
  const elapsed =
    data?.elapsed_ms != null ? Number(data.elapsed_ms) : undefined;
  const suffix =
    elapsed != null && !Number.isNaN(elapsed)
      ? ` (+${formatDurationMs(elapsed)})`
      : '';
  if (data !== undefined) {
    console.log(`${PREFIX} [${stage}] ${message}${suffix}`, data);
  } else {
    console.log(`${PREFIX} [${stage}] ${message}`);
  }
}

export function logAnnotationDebugPlan(plan: {
  use_vision_mapping?: boolean;
  label_strategy?: string;
  intent_summary?: string;
  annotation_scope?: Record<string, unknown>;
  detection_hints?: Record<string, unknown>;
  sub_agent_constraints?: Record<string, unknown>;
}): void {
  logAnnotationDebug('plan', '批量计划摘要', {
    use_vision_mapping: plan.use_vision_mapping,
    label_strategy: plan.label_strategy,
    intent_summary: plan.intent_summary,
    annotation_scope: plan.annotation_scope,
    detection_hints: plan.detection_hints,
    sub_agent_constraints: plan.sub_agent_constraints,
  });
}

export function logAnnotationDebugImageResult(
  relativePath: string,
  result: {
    ok: boolean;
    reason?: string;
    rawCount?: number;
    keptCount?: number;
    mappedCount?: number;
    unmappedCount?: number;
    method?: string;
    mapHint?: string;
    autoFinalized?: boolean;
  },
): void {
  logAnnotationDebug(
    result.ok ? 'image-ok' : 'image-skip',
    relativePath,
    {
      ok: result.ok,
      reason: result.reason,
      rawCount: result.rawCount,
      keptCount: result.keptCount,
      mappedCount: result.mappedCount,
      unmappedCount: result.unmappedCount,
      method: result.method,
      mapHint: result.mapHint,
      autoFinalized: result.autoFinalized,
    },
  );
}
