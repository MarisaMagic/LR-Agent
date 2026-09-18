/**
 * 统一的检测框 → 标签映射服务（标注图像类主路径）。
 *
 * 移植自 `vendor/local-agent/app/agent/annotation/map_labels_service.py`。
 *
 * 两条策略（无纯文本 LLM 回退）：
 *   1. `vision_crop`：逐框裁剪 + 并发视觉 LLM 映射（可带校验重试）
 *   2. `heuristic`：检测类名 / OCR 与标签名匹配（见 `heuristic.ts`）
 *
 * 特殊快捷：`label_strategy === "single_label_for_all_boxes"` 时直接赋同一 label_id。
 *
 * 图像处理差异：Python 用 Pillow 在主进程内裁剪；Node 侧经 `imageService.cropBatch`
 * 走主进程的 `nativeImage`（utilityProcess 内不可用）。因此这里先本地算出像素矩形，
 * 再一次 RPC 批量裁剪——避免逐框往返。
 */

import type { ChatMessage, LlmClient } from '../llm/client';
import { extractJsonObject, pythonJsonDumps } from './common';
import { heuristicMapBoxes } from './heuristic';
import { labelsRequireVisionMapping } from './visionPolicy';
import {
  resolveEffectiveLabelCandidates,
  type LabelPoolResult,
} from './labelPool';
import { AnnotationScope, filterLabelCandidatesByScope } from './scope';
import {
  candidatesForRetryBox,
  formatIssuesForRetry,
  validateVisionMappings,
  type MappingIssue,
} from './validation';
import type { AgentSettings } from '../config';
import type { ImageService } from '../services/imageService';

/** 逐框视觉映射系统提示词（行为契约，需原样保留）。 */
export const CROP_VISION_SYSTEM = `你是视觉标注助手。你会收到一张裁剪后的目标区域图。
请根据图像内容与用户标注意图，从标签候选中选择最合适的 label_id。
若裁剪区域与任一候选标签语义不符，必须返回空 label_id。
只输出 JSON：{"label_id":"...","reason":"..."} ；无法确定或与任务无关时 label_id 必须为 ""。`;

/** 裁剪后送 LLM 的最长边。 */
const CROP_MAX_EDGE = 768;

/** 送 LLM 的候选标签上限。 */
const VISION_CANDIDATE_LIMIT = 40;

/** 单框视觉映射结果。 */
export interface BoxMapping {
  box_index: number;
  label_id: string;
  reason: string;
}

/** 归一化后的检测框。 */
interface NormalizedBox {
  box_index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  class_name?: unknown;
  detection_label?: unknown;
  confidence?: unknown;
}

interface CropRegion {
  box_index: number;
  data_url: string;
  box: NormalizedBox;
}

/**
 * 判断检测框坐标是否为 0~1 归一化格式。
 *
 * 任一维度 > 1.5 视为像素坐标；任一值无法转数字也视为像素（返回 false）。
 */
export function coordsAreNormalized(boxes: Array<Record<string, unknown>>): boolean {
  for (const b of boxes) {
    for (const key of ['x', 'y', 'width', 'height']) {
      const value = Number(b[key] ?? 0);
      if (!Number.isFinite(value)) return false;
      if (value > 1.5) return false;
    }
  }
  return boxes.length > 0;
}

/** 把归一化框转为像素矩形（不裁剪，仅换算）。 */
export function toPixelRect(
  box: NormalizedBox,
  imageWidth: number,
  imageHeight: number,
  normalized: boolean,
): { left: number; top: number; right: number; bottom: number } {
  let { x, y, width, height } = box;
  if (normalized) {
    x *= imageWidth;
    y *= imageHeight;
    width *= imageWidth;
    height *= imageHeight;
  }
  return {
    left: x,
    top: y,
    right: x + width,
    bottom: y + height,
  };
}

interface VisionMapBoxParams {
  llm: LlmClient;
  boxIndex: number;
  box: NormalizedBox;
  cropDataUrl: string;
  candidates: Array<Record<string, unknown>>;
  userRequest: string;
  intentSummary: string;
  scopeNote: string;
  retryNote: string;
  reservedLabelIds: string[] | null;
  signal?: AbortSignal;
}

/** 对单个裁剪区域调用视觉 LLM。 */
async function visionMapBoxWithCrop(params: VisionMapBoxParams): Promise<BoxMapping> {
  const validIds = new Set(params.candidates.map((c) => String(c.id ?? '')));

  const retryBlock = params.retryNote.trim()
    ? `\n【校验反馈】${params.retryNote.trim()}\n`
    : '';
  const reservedBlock =
    params.reservedLabelIds && params.reservedLabelIds.length > 0
      ? `\n同图已被其它框占用的 label_id（请勿重复选择）：${pythonJsonDumps(params.reservedLabelIds)}\n`
      : '';

  const userText =
    `用户请求：${params.userRequest}\n意图：${params.intentSummary}\n` +
    `box_index=${params.boxIndex} 检测类名：${params.box.class_name || params.box.detection_label || ''}\n` +
    `${params.scopeNote}${retryBlock}${reservedBlock}\n\nlabel_candidates:\n` +
    `${pythonJsonDumps(params.candidates.slice(0, VISION_CANDIDATE_LIMIT))}`;

  const messages: ChatMessage[] = [
    { role: 'system', content: CROP_VISION_SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: params.cropDataUrl } },
      ],
    },
  ];

  let content = '';
  try {
    const turn = await params.llm.completeChat({ messages, signal: params.signal });
    content = typeof turn.content === 'string' ? turn.content : '';
  } catch {
    return { box_index: params.boxIndex, label_id: '', reason: '视觉调用失败' };
  }

  const parsed = extractJsonObject(content);
  let lid = String(parsed.label_id ?? '').trim();
  if (lid && !validIds.has(lid)) lid = '';
  return {
    box_index: params.boxIndex,
    label_id: lid,
    reason: String(parsed.reason ?? ''),
  };
}

interface RegionOverrides {
  candidates?: Array<Record<string, unknown>>;
  retryNote?: string;
  reservedLabelIds?: string[];
}

/** 并发执行多框视觉映射（信号量控制并发度）。 */
async function visionMapRegionsConcurrent(
  llm: LlmClient,
  regions: CropRegion[],
  options: {
    candidates: Array<Record<string, unknown>>;
    userRequest: string;
    intentSummary: string;
    scopeNote: string;
    concurrency: number;
    regionOverrides?: Map<number, RegionOverrides>;
    signal?: AbortSignal;
  },
): Promise<BoxMapping[]> {
  const limit = Math.max(1, options.concurrency);
  const overrides = options.regionOverrides ?? new Map();

  // 简化的并发闸门：按批执行（保持结果顺序与输入一致）
  const results: BoxMapping[] = [];
  for (let start = 0; start < regions.length; start += limit) {
    const batch = regions.slice(start, start + limit);
    // eslint-disable-next-line no-await-in-loop
    const mapped = await Promise.all(
      batch.map((region) => {
        const extra = overrides.get(region.box_index);
        return visionMapBoxWithCrop({
          llm,
          boxIndex: region.box_index,
          box: region.box,
          cropDataUrl: region.data_url,
          candidates: extra?.candidates ?? options.candidates,
          userRequest: options.userRequest,
          intentSummary: options.intentSummary,
          scopeNote: options.scopeNote,
          retryNote: extra?.retryNote ?? '',
          reservedLabelIds: extra?.reservedLabelIds ?? null,
          signal: options.signal,
        });
      }),
    );
    results.push(...mapped);
  }
  return results;
}

/** 候选标签名列表（丢弃空名）。 */
function candidateNames(candidates: Array<Record<string, unknown>>): string[] {
  return candidates
    .map((c) => String(c.name ?? ''))
    .filter((n) => n.trim().length > 0);
}

/** 标签候选池调试信息（供 Electron DevTools 展示）。 */
export function labelPoolDebug(params: {
  allCandidates: Array<Record<string, unknown>>;
  scopedCandidates: Array<Record<string, unknown>>;
  effectiveCandidates: Array<Record<string, unknown>>;
  source: string;
  excludedNames?: string[];
  preflightLabelIds?: string[] | null;
}): Record<string, unknown> {
  return {
    source: params.source,
    project_count: params.allCandidates.length,
    scoped_count: params.scopedCandidates.length,
    effective_count: params.effectiveCandidates.length,
    project_names: candidateNames(params.allCandidates),
    scoped_names: candidateNames(params.scopedCandidates),
    effective_names: candidateNames(params.effectiveCandidates),
    excluded_names: [...(params.excludedNames ?? [])],
    preflight_label_ids: [...(params.preflightLabelIds ?? [])],
  };
}

/** 映射按 box_index 建索引。 */
function mappingByIndex(mappings: BoxMapping[]): Map<number, BoxMapping> {
  const map = new Map<number, BoxMapping>();
  for (const m of mappings) map.set(Number(m.box_index ?? 0), m);
  return map;
}

/** 已占用的 label_id 集合（可排除某个框）。 */
function usedLabelIds(
  mappings: BoxMapping[],
  options: { excludeBox?: number } = {},
): Set<string> {
  const used = new Set<string>();
  for (const m of mappings) {
    const idx = Number(m.box_index ?? 0);
    if (options.excludeBox !== undefined && idx === options.excludeBox) continue;
    const lid = String(m.label_id ?? '').trim();
    if (lid) used.add(lid);
  }
  return used;
}

interface ValidationRetryParams {
  llm: LlmClient;
  regions: CropRegion[];
  candidates: Array<Record<string, unknown>>;
  allCandidates: Array<Record<string, unknown>>;
  userRequest: string;
  intentSummary: string;
  scopeNote: string;
  concurrency: number;
  instanceLabels: boolean;
  maxRetries: number;
  validate: boolean;
  signal?: AbortSignal;
}

/** 逐框映射 + 校验失败则带上下文重试（仅重跑失败框）。 */
async function visionMapWithValidationRetry(
  params: ValidationRetryParams,
): Promise<{ mappings: BoxMapping[]; retryRounds: number }> {
  const validIds = new Set(params.allCandidates.map((c) => String(c.id ?? '')));

  let mappings = await visionMapRegionsConcurrent(params.llm, params.regions, {
    candidates: params.candidates,
    userRequest: params.userRequest,
    intentSummary: params.intentSummary,
    scopeNote: params.scopeNote,
    concurrency: params.concurrency,
    signal: params.signal,
  });

  let retryRounds = 0;
  if (!params.validate || params.maxRetries <= 0) return { mappings, retryRounds };

  const regionByIndex = new Map(params.regions.map((r) => [r.box_index, r]));

  for (let attempt = 0; attempt < params.maxRetries; attempt += 1) {
    const result = validateVisionMappings({
      mappings: mappings as unknown as Array<Record<string, unknown>>,
      candidates: params.allCandidates,
      instanceLabels: params.instanceLabels,
      validIds,
    });
    if (result.ok) break;

    const retryIndices = [...new Set(result.issues.map((i) => i.boxIndex))].sort(
      (a, b) => a - b,
    );
    if (retryIndices.length === 0) break;

    retryRounds += 1;
    const overrides = new Map<number, RegionOverrides>();
    const byIndex = mappingByIndex(mappings);

    for (const boxIndex of retryIndices) {
      const used = usedLabelIds(mappings, { excludeBox: boxIndex });
      const currentLid = String(byIndex.get(boxIndex)?.label_id ?? '');
      const boxCandidates = candidatesForRetryBox(params.candidates, used, currentLid);
      const boxIssues: MappingIssue[] = result.issuesForBox(boxIndex);
      overrides.set(boxIndex, {
        candidates: boxCandidates,
        retryNote: formatIssuesForRetry(boxIssues),
        reservedLabelIds: [...used].sort(),
      });
    }

    const retryRegions = retryIndices
      .map((i) => regionByIndex.get(i))
      .filter((r): r is CropRegion => r !== undefined);

    // 重试并发度固定 1（对齐 Python）
    // eslint-disable-next-line no-await-in-loop
    const retried = await visionMapRegionsConcurrent(params.llm, retryRegions, {
      candidates: params.candidates,
      userRequest: params.userRequest,
      intentSummary: params.intentSummary,
      scopeNote: params.scopeNote,
      concurrency: 1,
      regionOverrides: overrides,
      signal: params.signal,
    });

    for (const item of retried) {
      byIndex.set(Number(item.box_index), item);
    }
    mappings = params.regions.map(
      (r) => byIndex.get(r.box_index) as BoxMapping,
    );
  }

  return { mappings, retryRounds };
}

export interface MapUnifiedParams {
  llm: LlmClient | null;
  userRequest: string;
  intentSummary: string;
  labelCandidates: Array<Record<string, unknown>>;
  boxes: Array<Record<string, unknown>>;
  useVision: boolean;
  ocrText: string;
  scope: AnnotationScope | Record<string, unknown> | null;
  labelStrategy: string;
  singleLabelId: string | null;
  imageAbsolutePath: string;
  imageBase64: string;
  mimeType: string;
  settings: AgentSettings;
  imageService: ImageService;
  /** 图像是否可读（对应 Python 的 `image_bytes is not None`）。 */
  imageAvailable: boolean;
  signal?: AbortSignal;
}

/** 统一映射入口。 */
export async function mapDetectionBoxesToLabelsUnified(
  params: MapUnifiedParams,
): Promise<Record<string, unknown>> {
  const scopeModel =
    params.scope instanceof AnnotationScope
      ? params.scope
      : AnnotationScope.fromPayload(params.scope);
  const settings = params.settings;

  const scopedCandidates = filterLabelCandidatesByScope(
    [...params.labelCandidates],
    scopeModel,
  );
  let validIds = new Set(scopedCandidates.map((c) => String(c.id ?? '')));

  const concurrency = settings.annotationVisionMapConcurrency;

  if (params.boxes.length === 0) {
    return { ok: false, error: 'boxes 不能为空', method: 'none' };
  }

  // ── 快捷：所有框同一标签 ──────────────────────────────────────────
  if (
    params.labelStrategy === 'single_label_for_all_boxes' &&
    params.singleLabelId &&
    validIds.has(params.singleLabelId)
  ) {
    const mappings = params.boxes.map((b, i) => ({
      box_index: b.box_index !== undefined ? Number(b.box_index) : i,
      label_id: params.singleLabelId,
      reason: 'single_label_for_all_boxes',
    }));
    return {
      ok: true,
      method: 'single_label',
      mappings,
      unmapped_indices: [],
    };
  }

  // ── 归一化检测框 ────────────────────────────────────────────────
  const normalizedBoxes: NormalizedBox[] = params.boxes.map((b, i) => ({
    box_index: b.box_index !== undefined ? Number(b.box_index) : i,
    x: Number(b.x ?? 0),
    y: Number(b.y ?? 0),
    width: Number(b.width ?? 0),
    height: Number(b.height ?? 0),
    class_name: b.class_name || b.detection_label,
    detection_label: b.detection_label || b.class_name,
    confidence: b.confidence,
  }));

  // ── 路径 1：逐框裁剪视觉映射 ─────────────────────────────────────
  if (params.useVision && params.llm !== null) {
    if (!params.imageAvailable) {
      return {
        ok: false,
        error: 'image_unavailable',
        method: 'vision_crop',
        hint: '视觉映射需要可读本地 image_absolute_path 或 image_base64',
      };
    }

    let scopeNote = '';
    if (scopeModel.isRestricted()) {
      const summary =
        scopeModel.scope_summary ||
        pythonJsonDumps(scopeModel.toPayload());
      scopeNote = `\n用户标注范围：${summary}`;
    }

    const pool: LabelPoolResult = await resolveEffectiveLabelCandidates({
      llm: params.llm,
      allCandidates: scopedCandidates,
      scope: scopeModel,
      userRequest: params.userRequest,
      intentSummary: params.intentSummary,
      boxCount: normalizedBoxes.length,
      settings,
      imageService: params.imageService,
      imageAvailable: params.imageAvailable,
      imageAbsolutePath: params.imageAbsolutePath,
      imageBase64: params.imageBase64,
      signal: params.signal,
    });

    const candidates = pool.candidates;
    validIds = new Set(candidates.map((c) => String(c.id ?? '')));

    const normalized = coordsAreNormalized(normalizedBoxes as never);

    // 只探测一次图片尺寸，然后一次性批量裁剪（避免逐框 RPC 往返）。
    // 与 Python 一致：w/h <= 0 或坐标非法的框**不产生裁剪区域**，
    // 因而也不会有对应的映射条目。
    const probed = await params.imageService.probe({
      absolutePath: params.imageAbsolutePath || undefined,
      base64: params.imageBase64 || undefined,
    });

    const regions: CropRegion[] = [];
    if (probed.ok && probed.width != null && probed.height != null) {
      const usable: Array<{
        box: NormalizedBox;
        rect: { left: number; top: number; right: number; bottom: number };
      }> = [];
      for (const box of normalizedBoxes) {
        if (
          !Number.isFinite(box.x) ||
          !Number.isFinite(box.y) ||
          !Number.isFinite(box.width) ||
          !Number.isFinite(box.height)
        ) {
          continue;
        }
        if (box.width <= 0 || box.height <= 0) continue;
        usable.push({
          box,
          rect: toPixelRect(box, probed.width, probed.height, normalized),
        });
      }

      const cropped = await params.imageService.cropBatch({
        absolutePath: params.imageAbsolutePath || undefined,
        base64: params.imageBase64 || undefined,
        boxes: usable.map((u) => u.rect),
        maxEdge: CROP_MAX_EDGE,
        quality: settings.annotationLlmImageJpegQuality,
      });

      if (cropped.ok && cropped.images) {
        cropped.images.forEach((dataUrl, index) => {
          const entry = usable[index];
          if (!entry || !dataUrl) return;
          regions.push({
            box_index: entry.box.box_index,
            data_url: dataUrl,
            box: entry.box,
          });
        });
      }
    }

    const instanceLabels = labelsRequireVisionMapping(params.labelCandidates);
    const { mappings, retryRounds } = await visionMapWithValidationRetry({
      llm: params.llm,
      regions,
      candidates,
      allCandidates: scopedCandidates,
      userRequest: params.userRequest,
      intentSummary: params.intentSummary,
      scopeNote,
      concurrency,
      instanceLabels,
      maxRetries: settings.annotationVisionMapMaxRetries,
      validate: settings.annotationVisionMapValidate,
      signal: params.signal,
    });

    const unmapped = mappings
      .filter((m) => !m.label_id)
      .map((m) => m.box_index);

    return {
      ok: true,
      method: 'vision_crop',
      mappings,
      unmapped_indices: unmapped,
      label_candidates: candidates,
      label_pool_source: pool.source,
      label_pool_debug: labelPoolDebug({
        allCandidates: params.labelCandidates,
        scopedCandidates,
        effectiveCandidates: candidates,
        source: pool.source,
        excludedNames: pool.excludedNames,
        preflightLabelIds: pool.preflightLabelIds,
      }),
      vision_map_retry_rounds: retryRounds,
      next_step: 'finalize_image_change',
    };
  }

  // ── 路径 2：启发式映射（无 LLM）──────────────────────────────────
  const candidates = scopedCandidates;
  const heuristicRaw = heuristicMapBoxes(
    normalizedBoxes.map((b) => ({
      box_index: b.box_index,
      class_name: b.class_name,
      detection_label: b.detection_label,
      confidence: b.confidence,
    })),
    candidates,
    params.ocrText,
  );

  const mappings = heuristicRaw.map((m) => ({
    box_index: Number(m.box_index ?? 0),
    label_id: String(m.label_id ?? ''),
    reason: m.reason ?? '',
  }));

  const unmapped = mappings.filter((m) => !m.label_id).map((m) => m.box_index);
  const hint =
    unmapped.length > 0
      ? '当前未启用视觉模型或未提供图像，多人物/实例标签无法可靠区分；' +
        '请使用通过视觉探针的多模态模型，并确保 use_vision_mapping=true'
      : '';

  const poolSource =
    scopedCandidates.length < params.labelCandidates.length ? 'scope' : 'full';

  return {
    ok: unmapped.length < mappings.length,
    method: 'heuristic',
    mappings,
    unmapped_indices: unmapped,
    label_candidates: candidates,
    label_pool_source: poolSource,
    label_pool_debug: labelPoolDebug({
      allCandidates: params.labelCandidates,
      scopedCandidates,
      effectiveCandidates: candidates,
      source: poolSource,
    }),
    hint,
    next_step: 'finalize_image_change',
  };
}
