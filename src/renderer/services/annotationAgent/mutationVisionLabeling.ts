/**
 * mutation 逐框视觉补标。
 *
 * 变更管线本身是纯文本规划（不喂图像），因此无法为「无标签的已有框」逐框判定标签。
 * 这里复用 auto_annotate 同一套能力（整图 + 逐框裁剪 + 视觉映射接口
 * `map-detection-boxes`），把目标框交给视觉 LLM 逐框映射，产出一框一标签的 patch。
 */

import type { AnnotationProjectSnapshot } from '../../../shared/annotationAgentTypes';
import type { AnnotationInstance } from '../../types/annotationDocument';
import { mapDetectionBoxesUnified } from '../annotationAgentApi';
import { readImageBase64 } from './fusionSubImageTools';
import { normalizeImageForCrop, prepareMapImageSource } from './imageNormalize';
import { obbToAabb, pointsToAabb, type NormBox } from './geometryTypes';

export interface VisionLabelBox {
  box_index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  class_name: string;
  confidence?: number;
}

/** 取出标注的归一化 AABB（仅几何类标注有）。 */
function annotationToAabb(ann: AnnotationInstance): NormBox | null {
  switch (ann.kind) {
    case 'bbox':
      return { x: ann.x, y: ann.y, width: ann.width, height: ann.height };
    case 'rotated_bbox':
    case 'pose':
      return obbToAabb(ann.cx, ann.cy, ann.width, ann.height, ann.angle);
    case 'polygon':
      return pointsToAabb(ann.points);
    default:
      return null;
  }
}

/**
 * 把目标标注转成 map 接口的 boxes，并给出 box_index → annotationId 的回映。
 * 非几何标注（caption/classification 等）会被跳过。
 */
export function buildBoxesFromAnnotations(
  annotations: AnnotationInstance[],
  ids: string[],
  labelNameById: Map<string, string>,
): { boxes: VisionLabelBox[]; idByBoxIndex: Map<number, string> } {
  const byId = new Map(annotations.map((a) => [a.id, a] as const));
  const boxes: VisionLabelBox[] = [];
  const idByBoxIndex = new Map<number, string>();

  for (const id of ids) {
    const ann = byId.get(id);
    if (!ann) continue;
    const aabb = annotationToAabb(ann);
    if (!aabb || aabb.width <= 0 || aabb.height <= 0) continue;
    const boxIndex = boxes.length;
    idByBoxIndex.set(boxIndex, id);
    boxes.push({
      box_index: boxIndex,
      x: aabb.x,
      y: aabb.y,
      width: aabb.width,
      height: aabb.height,
      class_name: ann.labelId ? (labelNameById.get(ann.labelId) ?? '') : '',
    });
  }

  return { boxes, idByBoxIndex };
}

export interface VisionLabelingParams {
  providerId: string;
  userRequest: string;
  intentSummary: string;
  imageAbsolutePath: string;
  annotations: AnnotationInstance[];
  ids: string[];
  labels: AnnotationProjectSnapshot['labels'];
  providerApiKey?: string;
  providerBaseUrl?: string;
  providerModel?: string;
  signal?: AbortSignal;
}

export interface VisionLabelingResult {
  labelsById: Map<string, string>;
  unmappedCount: number;
  error?: string;
}

/**
 * 逐框视觉判定标签。返回「annotationId → labelId」；判定为空或非法 id 的框计入
 * `unmappedCount`（调用方应让其保持留空，而不是写入空标签）。
 */
export async function labelBoxesByVision(
  params: VisionLabelingParams,
): Promise<VisionLabelingResult> {
  const labelsById = new Map<string, string>();
  const labelNameById = new Map<string, string>();
  const validLabelIds = new Set<string>();
  for (const label of params.labels) {
    const id = String(label.id ?? '').trim();
    const name = String(label.name ?? '').trim();
    if (id) validLabelIds.add(id);
    if (id && name) labelNameById.set(id, name);
  }

  const { boxes, idByBoxIndex } = buildBoxesFromAnnotations(
    params.annotations,
    params.ids,
    labelNameById,
  );
  if (boxes.length === 0) {
    return { labelsById, unmappedCount: 0, error: '无可用几何框' };
  }

  const call = (
    imageAbsolutePath: string,
    imageBase64: string,
  ): Promise<Awaited<ReturnType<typeof mapDetectionBoxesUnified>>> =>
    mapDetectionBoxesUnified(params.providerId, {
      userRequest: params.userRequest,
      intentSummary: params.intentSummary,
      labelCandidates: params.labels.map((l) => ({
        id: String(l.id ?? ''),
        name: String(l.name ?? ''),
      })),
      boxes,
      useVision: true,
      labelStrategy: 'map_each_box_to_label',
      // 类别型标签：允许同类多实例共用标签
      labelUniqueness: 'allow',
      annotationScope: {},
      imageAbsolutePath,
      imageBase64,
      providerApiKey: params.providerApiKey ?? '',
      providerBaseUrl: params.providerBaseUrl ?? '',
      providerModel: params.providerModel ?? '',
      providerSupportsVision: true,
      signal: params.signal,
    });

  const source = await prepareMapImageSource(params.imageAbsolutePath);
  let result = await call(source.absolutePath, source.base64);

  // 图像不可读：改用原始字节重试一次
  if (
    result.ok === false &&
    result.error === 'image_unavailable' &&
    !source.base64
  ) {
    const fallback = await readImageBase64(params.imageAbsolutePath);
    if (fallback) result = await call('', fallback);
  }

  // 主进程解不出像素（WebP/BMP/ICO）：转码后重试一次
  if (result.ok === false && result.error === 'crop_unavailable') {
    const normalized = await normalizeImageForCrop(params.imageAbsolutePath);
    if (normalized) result = await call('', normalized);
  }

  let unmappedCount = 0;
  for (const mapping of result.mappings ?? []) {
    const annotationId = idByBoxIndex.get(Number(mapping.box_index));
    if (!annotationId) continue;
    const labelId = String(mapping.label_id ?? '').trim();
    if (!labelId || !validLabelIds.has(labelId)) {
      unmappedCount += 1;
      continue;
    }
    labelsById.set(annotationId, labelId);
  }

  return {
    labelsById,
    unmappedCount,
    error: result.ok === false ? result.error : undefined,
  };
}
