import type { AnnotationScopePayload, BatchAnnotationPlan } from '../../../shared/annotationAgentTypes';

function normList(items: string[] | undefined): string[] {
  return (items ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** 合并 parse-task 与 create-plan 的范围；不在代码里推断任务类型 */
export function mergeEffectiveDetectionScope(
  taskScope: AnnotationScopePayload | undefined,
  planScope: AnnotationScopePayload | undefined,
): AnnotationScopePayload {
  const include = [
    ...new Set([
      ...normList(taskScope?.include_detection_labels),
      ...normList(planScope?.include_detection_labels),
    ]),
  ];

  const exclude = [
    ...new Set([
      ...normList(taskScope?.exclude_detection_labels),
      ...normList(planScope?.exclude_detection_labels),
    ]),
  ];

  const includeLabelNames = [
    ...new Set([
      ...(taskScope?.include_label_names ?? []).map((s) => s.trim()).filter(Boolean),
      ...(planScope?.include_label_names ?? []).map((s) => s.trim()).filter(Boolean),
    ]),
  ];

  const excludeLabelNames = [
    ...new Set([
      ...(taskScope?.exclude_label_names ?? []).map((s) => s.trim()).filter(Boolean),
      ...(planScope?.exclude_label_names ?? []).map((s) => s.trim()).filter(Boolean),
    ]),
  ];

  const scopeSummary =
    (planScope?.scope_summary || taskScope?.scope_summary || '').trim() ||
    (include.length ? `检测类白名单：${include.join(', ')}` : '') ||
    (exclude.length ? `检测类排除：${exclude.join(', ')}` : '');

  return {
    scope_summary: scopeSummary,
    include_detection_labels: include,
    exclude_detection_labels: exclude,
    include_label_names: includeLabelNames,
    exclude_label_names: excludeLabelNames,
  };
}

export function applyScopeToPlan(
  plan: BatchAnnotationPlan,
  effectiveScope: AnnotationScopePayload,
): BatchAnnotationPlan {
  return {
    ...plan,
    annotation_scope: {
      ...plan.annotation_scope,
      ...effectiveScope,
    },
  };
}

function detectionLabelMatches(label: string, patterns: string[]): boolean {
  const norm = label.trim().toLowerCase().replace(/_/g, ' ');
  if (!norm) return false;
  return patterns.some((p) => {
    const pn = p.trim().toLowerCase().replace(/_/g, ' ');
    return norm === pn || pn.includes(norm) || norm.includes(pn);
  });
}

function isScopeRestricted(scope: AnnotationScopePayload): boolean {
  return Boolean(
    scope.scope_summary?.trim() ||
      (scope.include_detection_labels?.length ?? 0) > 0 ||
      (scope.exclude_detection_labels?.length ?? 0) > 0,
  );
}

/** fusion filter_detection_boxes_by_scope（检测后、映射前） */
export function filterDetectionBoxesByScope<T extends { class_name: string }>(
  boxes: T[],
  scope: AnnotationScopePayload,
): { boxes: T[]; excluded: number; rawCount: number } {
  const rawCount = boxes.length;
  if (!isScopeRestricted(scope)) {
    return { boxes, excluded: 0, rawCount };
  }
  const include = normList(scope.include_detection_labels);
  const exclude = normList(scope.exclude_detection_labels);
  const kept: T[] = [];
  let excluded = 0;
  for (const box of boxes) {
    const cls = box.class_name.toLowerCase();
    if (exclude.length && detectionLabelMatches(cls, exclude)) {
      excluded += 1;
      continue;
    }
    if (include.length && !detectionLabelMatches(cls, include)) {
      excluded += 1;
      continue;
    }
    kept.push(box);
  }
  return { boxes: kept, excluded, rawCount };
}