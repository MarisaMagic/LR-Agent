/**
 * 标签是否需要视觉映射的判定。
 *
 * 移植自 `vendor/local-agent/app/agent/annotation/label_vision_policy.py`。
 *
 * 用途：当项目标签名与 YOLO/COCO 标准检测类名**完全无交集**时（如球员姓名
 * Curry / James vs `person`），检测器输出的类名无法直接对应项目标签，
 * 必须靠视觉模型逐框判断。
 */

/** COCO 80 类 + `face`（逐字对齐 Python 的 frozenset，共 81 项）。 */
export const YOLO_COCO_CLASS_NAMES: ReadonlySet<string> = new Set([
  'person',
  'bicycle',
  'car',
  'motorcycle',
  'airplane',
  'bus',
  'train',
  'truck',
  'boat',
  'traffic light',
  'fire hydrant',
  'stop sign',
  'parking meter',
  'bench',
  'bird',
  'cat',
  'dog',
  'horse',
  'sheep',
  'cow',
  'elephant',
  'bear',
  'zebra',
  'giraffe',
  'backpack',
  'umbrella',
  'handbag',
  'tie',
  'suitcase',
  'frisbee',
  'skis',
  'snowboard',
  'sports ball',
  'kite',
  'baseball bat',
  'baseball glove',
  'skateboard',
  'surfboard',
  'tennis racket',
  'bottle',
  'wine glass',
  'cup',
  'fork',
  'knife',
  'spoon',
  'bowl',
  'banana',
  'apple',
  'sandwich',
  'orange',
  'broccoli',
  'carrot',
  'hot dog',
  'pizza',
  'donut',
  'cake',
  'chair',
  'couch',
  'potted plant',
  'bed',
  'dining table',
  'toilet',
  'tv',
  'laptop',
  'mouse',
  'remote',
  'keyboard',
  'cell phone',
  'microwave',
  'oven',
  'toaster',
  'sink',
  'refrigerator',
  'book',
  'clock',
  'vase',
  'scissors',
  'teddy bear',
  'hair drier',
  'toothbrush',
  'face',
]);

/**
 * 标签名归一化。
 *
 * 注意与 `scope.normalizeDetectionLabel` 的差异：这里**不折叠内部连续空白**。
 */
export function normLabel(name: string): string {
  return (name ?? '').trim().toLowerCase().replace(/_/g, ' ');
}

/**
 * 是否必须依赖视觉映射。
 *
 * 规则：全部候选名都**未精确命中**标准类名集合 → `true`；
 * 任一命中 → `false`；无有效标签名 → `false`。
 */
export function labelsRequireVisionMapping(
  labelCandidates: Array<Record<string, unknown>>,
): boolean {
  const names = labelCandidates
    .map((c) => normLabel(String(c.name ?? '')))
    .filter((n) => n.length > 0);

  if (names.length === 0) return false;
  return !names.some((n) => YOLO_COCO_CLASS_NAMES.has(n));
}
