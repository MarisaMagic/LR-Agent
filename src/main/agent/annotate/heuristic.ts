/**
 * 启发式检测框 → 标签映射（无 LLM）。
 *
 * 移植自 `vendor/local-agent/app/agent/annotation/heuristic_map_service.py`。
 *
 * 三级优先级，命中即停：
 *   A. 检测类名**精确**匹配标签名
 *   B. 检测类名与标签名**唯一**部分匹配（双向子串；多命中则不选）
 *   C. OCR 文本**唯一**包含某标签名
 *
 * 注意各级的名字处理不一致（与 Python 一致，不要统一）：
 *   - 精确索引：候选名 `strip().lower()`
 *   - 部分匹配与 OCR：候选名**只 lower，不 strip**
 */

import { pyRepr } from './common';

export interface HeuristicBox {
  box_index?: number;
  class_name?: unknown;
  detection_label?: unknown;
  confidence?: unknown;
}

export interface HeuristicMapping {
  box_index: number;
  label_id: string;
  reason: string;
}

/** 无匹配时的理由文案。 */
export const NO_MATCH_REASON = '未能自动映射';

/**
 * 启发式映射。
 *
 * @param boxes 检测框（`class_name` 优先，falsy 时回退 `detection_label`）
 * @param labelCandidates 项目标签候选
 * @param ocrText 可选的 OCR 文本
 */
export function heuristicMapBoxes(
  boxes: HeuristicBox[],
  labelCandidates: Array<Record<string, unknown>>,
  ocrText = '',
): HeuristicMapping[] {
  // 精确索引：同名后者覆盖前者
  const byName = new Map<string, Record<string, unknown>>();
  for (const item of labelCandidates) {
    const name = String(item.name ?? '')
      .trim()
      .toLowerCase();
    if (name) byName.set(name, item);
  }

  // 部分匹配与 OCR 用的清单：浅拷贝，不去重不去空
  const flat = [...labelCandidates];
  const ocrLower = (ocrText ?? '').toLowerCase();

  const results: HeuristicMapping[] = [];

  boxes.forEach((box, idx) => {
    const det = String(box.class_name || box.detection_label || '').trim();
    let chosen: Record<string, unknown> | null = null;
    let reason = '';

    // 优先级 A：精确匹配
    if (det) {
      const hit = byName.get(det.toLowerCase());
      if (hit) {
        chosen = hit;
        reason = `检测类名 ${pyRepr(det)} 与标签匹配`;
      }
    }

    // 优先级 B：唯一部分匹配（双向子串）
    if (!chosen && det) {
      const detLower = det.toLowerCase();
      const partial = flat.filter((n) => {
        const name = String(n.name ?? '').toLowerCase();
        return detLower.includes(name) || name.includes(detLower);
      });
      if (partial.length === 1) {
        [chosen] = partial;
        reason = `检测类名与标签 ${pyRepr(chosen.name)} 部分匹配`;
      }
    }

    // 优先级 C：OCR 唯一命中
    if (!chosen && ocrLower) {
      const nameHits = flat.filter((n) =>
        ocrLower.includes(String(n.name ?? '').toLowerCase()),
      );
      if (nameHits.length === 1) {
        [chosen] = nameHits;
        reason = `OCR 含标签名 ${pyRepr(chosen.name)}`;
      }
    }

    results.push({
      box_index: box.box_index !== undefined ? Number(box.box_index) : idx,
      label_id: chosen ? String(chosen.id ?? '') : '',
      reason: reason || (chosen ? reason : NO_MATCH_REASON),
    });
  });

  return results;
}
