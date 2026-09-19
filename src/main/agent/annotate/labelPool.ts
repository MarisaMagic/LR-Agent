/**
 * 标签候选池解析（可选整图 preflight 缩池）。
 *
 * 移植自 `vendor/local-agent/app/agent/annotation/label_candidate_resolver.py`。
 *
 * 流程：先用 scope 过滤 → 满足条件时让视觉模型看**整图**判断「本图实际可能出现哪些
 * 标签」→ 依此缩小候选池。
 *
 * 设计意图（不要扩权）：文档字符串明确说明，`user_request` / `intent_summary` /
 * `box_count` **本身不参与候选池缩小**，只作为 preflight 的提示输入——避免
 * 「prepare 摘要里举例提到的标签」误伤候选池。
 *
 * preflight 只在**同时**满足以下条件时执行：
 *   - 有 LLM 且有图像
 *   - `_should_run_preflight` 为真（见下）
 *
 * 失败与不确定一律静默保持原候选池（`uncertain=true` 时不缩池）。
 */

import type { ChatMessage, LlmClient } from '../llm/client';
import { extractJsonObject, pythonJsonDumps } from './common';
import type { AnnotationScope } from './scope';
import { filterLabelCandidatesByScope } from './scope';
import type { AgentSettings } from '../config';
import type { ImageService } from '../services/imageService';

export type PreflightMode = 'off' | 'auto' | 'always';

/** 整图 preflight 系统提示词（行为契约，需原样保留）。 */
export const PREFLIGHT_SYSTEM = `你是视觉标注准备助手。根据整图与用户意图，从标签候选中选出本图实际可能出现的 label_id。
不要猜测图中没有的目标。若无法可靠判断，present_label_ids 必须为空并设置 uncertain=true。
只输出 JSON：{"present_label_ids":["..."], "uncertain": false}`;

export interface LabelPoolResult {
  candidates: Array<Record<string, unknown>>;
  /** `full` | `scope` | `preflight`。 */
  source: 'full' | 'scope' | 'preflight';
  excludedNames: string[];
  preflightLabelIds: string[] | null;
}

/**
 * 是否值得跑整图 preflight。
 *
 * - `off`：恒不跑
 * - `always`：只要框数 > 0 就跑
 * - `auto`：候选数需比框数多出至少 `minExtra` 个才跑
 */
export function shouldRunPreflight(
  mode: PreflightMode,
  params: { candidateCount: number; boxCount: number; minExtra: number },
): boolean {
  if (mode === 'off' || params.boxCount <= 0) return false;
  if (mode === 'always') return true;
  const extra = params.candidateCount - params.boxCount;
  return extra >= params.minExtra;
}

export interface PreflightParams {
  llm: LlmClient;
  candidates: Array<Record<string, unknown>>;
  boxCount: number;
  userRequest: string;
  intentSummary: string;
  settings: AgentSettings;
  imageService: ImageService;
  imageAbsolutePath?: string;
  imageBase64?: string;
  signal?: AbortSignal;
}

/**
 * 让视觉模型看整图，判断本图实际可能出现的标签。
 *
 * @returns `[presentLabelIds, uncertain]`
 */
export async function preflightLabelPool(
  params: PreflightParams,
): Promise<[string[], boolean]> {
  const validIds = new Set(params.candidates.map((c) => String(c.id ?? '')));

  // 只送前 80 个，且保留原值（不转字符串）
  const payload = params.candidates.slice(0, 80).map((c) => ({
    id: c.id,
    name: c.name,
  }));

  const userText =
    `用户请求：${params.userRequest}\n` +
    `意图：${params.intentSummary}\n` +
    `检测框数量：${params.boxCount}\n\n` +
    `标签候选：\n${pythonJsonDumps(payload)}`;

  const encoded = await params.imageService.toJpegDataUrl({
    absolutePath: params.imageAbsolutePath,
    base64: params.imageBase64,
    maxEdge: params.settings.chatVisionMaxEdge,
    quality: params.settings.chatVisionJpegQuality,
  });
  if (!encoded.ok || !encoded.dataUrl) return [[], true];

  const messages: ChatMessage[] = [
    { role: 'system', content: PREFLIGHT_SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: encoded.dataUrl } },
      ],
    },
  ];

  let content: unknown;
  try {
    const turn = await params.llm.completeChat({
      messages,
      signal: params.signal,
    });
    content = turn.content;
  } catch {
    // 任何异常 → 不确定（不缩池）
    return [[], true];
  }

  const data = extractJsonObject(String(content ?? ''));
  const uncertain = Boolean(data.uncertain ?? false);

  const rawIds = data.present_label_ids ?? data.label_ids ?? [];
  if (!Array.isArray(rawIds)) return [[], true];

  const present = rawIds
    .map((id) => String(id).trim())
    .filter((id) => validIds.has(id));

  if (uncertain || present.length === 0) return [[], true];
  return [present, false];
}

export interface ResolvePoolParams {
  llm: LlmClient | null;
  allCandidates: Array<Record<string, unknown>>;
  scope: AnnotationScope;
  userRequest: string;
  intentSummary: string;
  boxCount: number;
  settings: AgentSettings;
  imageService: ImageService;
  /** 是否有可读图像（对应 Python 的 `image_bytes` 真值判断）。 */
  imageAvailable: boolean;
  imageAbsolutePath?: string;
  imageBase64?: string;
  signal?: AbortSignal;
}

/** 解析出实际用于映射的候选池。 */
export async function resolveEffectiveLabelCandidates(
  params: ResolvePoolParams,
): Promise<LabelPoolResult> {
  const scoped = filterLabelCandidatesByScope(
    [...params.allCandidates],
    params.scope,
  );
  const source: LabelPoolResult['source'] =
    scoped.length < params.allCandidates.length ? 'scope' : 'full';

  const excluded: string[] = [];
  let preflightIds: string[] | null = null;

  const mode = params.settings.annotationLabelPoolPreflight;
  const shouldRun =
    params.llm !== null &&
    params.imageAvailable &&
    shouldRunPreflight(mode, {
      candidateCount: scoped.length,
      boxCount: params.boxCount,
      minExtra: params.settings.annotationLabelPoolPreflightMinExtra,
    });

  if (shouldRun && params.llm) {
    const [present, uncertain] = await preflightLabelPool({
      llm: params.llm,
      candidates: scoped,
      boxCount: params.boxCount,
      userRequest: params.userRequest,
      intentSummary: params.intentSummary,
      settings: params.settings,
      imageService: params.imageService,
      imageAbsolutePath: params.imageAbsolutePath,
      imageBase64: params.imageBase64,
      signal: params.signal,
    });

    if (!uncertain && present.length > 0) {
      const idSet = new Set(present);
      const prefFiltered = scoped.filter((c) => idSet.has(String(c.id ?? '')));
      if (prefFiltered.length > 0) {
        preflightIds = present;
        for (const c of scoped) {
          if (!idSet.has(String(c.id ?? ''))) {
            excluded.push(String(c.name ?? ''));
          }
        }
        return {
          candidates: prefFiltered,
          source: 'preflight',
          excludedNames: excluded.filter((n) => n.length > 0),
          preflightLabelIds: preflightIds,
        };
      }
    }
  }

  return {
    candidates: scoped,
    source,
    excludedNames: excluded.filter((n) => n.length > 0),
    preflightLabelIds: preflightIds,
  };
}
