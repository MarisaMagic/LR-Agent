/**
 * 标注变更准备（改标签/删框，单次 LLM）。
 *
 * 移植自 `vendor/local-agent/app/agent/annotation/mutation_prepare_service.py`。
 *
 * 关键保真点：Python 用 `op.model_dump()` 输出操作对象，Pydantic 的 `model_dump()`
 * 会**递归展开嵌套模型并把未设值字段输出为 `null`**。若用 zod 解析后直接
 * `JSON.stringify`，未出现的可选键会被省略——前端拿到的形状就与 Python 不同。
 * 因此这里显式重建完整字段集（`dumpMutationOperation`）。
 */

import { z } from 'zod';
import type { LlmClient } from '../llm/client';
import { invokeJsonModel } from './common';
import type { ImageCandidate, AnnotationProjectSnapshot } from './schemas';

/** 变更准备系统提示词（行为契约，需原样保留）。 */
export const MUTATION_PREPARE_SYSTEM = `你是 LR-Agent 标注变更准备助手。用户希望修改或删除已有标注（非新增）。

支持全部标注类型：bbox、rotated_bbox、polygon、keypoint（骨架）、caption、cot、
text_classification、classification、span_ner、instruction、preference、conversation。
用户说「不要新增框/不要新增标注」时，只能改或删已有项，不要改用 auto_annotate。

输出 JSON（一次完成）：
{
  "selected_paths": ["data/7.jpg"],
  "intent_summary": "一句话摘要",
  "operations": [
    {
      "relative_path": "data/7.jpg",
      "mutation_kind": "patch_label|patch_geometry|patch_content|delete",
      "targets": [
        {"by": "all"},
        {"by": "id", "id": "uuid"},
        {"by": "label_name", "label_name": "person"},
        {"by": "index", "index": 1},
        {"by": "spatial", "hint": "leftmost"},
        {"by": "selected"},
        {"by": "unlabeled"},
        {"by": "granularity", "granularity": "brief"},
        {"by": "language", "language": "en"},
        {"by": "longest"},
        {"by": "shortest"},
        {"by": "duplicate_label"}
      ],
      "new_label_name": "worker",
      "x": 0.1, "y": 0.2, "width": 0.15, "height": 0.18,
      "cx": 0.5, "cy": 0.4, "angle": 30,
      "points": [{"x": 0.1, "y": 0.2}],
      "keypoints": [{"x": 0.1, "y": 0.2, "visibility": 2}],
      "text": "新的 caption",
      "granularity": "brief",
      "language": "zh",
      "steps": [{"description": "...", "conclusion": "..."}],
      "answer": "...",
      "instruction": "...",
      "input": "...", "output": "...",
      "start": 0, "end": 12,
      "prompt": "...", "chosen": "...", "rejected": "...",
      "turns": [{"role": "user", "content": "..."}],
      "note": "..."
    }
  ]
}

规则：
- patch_label：改已有标签（含多边形/分类空 labelId 补标）。必须给出 new_label_name（项目标签名之一）
- patch_geometry：改几何。
  bbox 填 x/y/width/height（0–1，左上角）；rotated_bbox 与 keypoint 骨架填 cx/cy/width/height（0–1，中心点），可带 angle（度）；
  keypoint 改关键点填 keypoints 整表替换（长度与骨架模板一致，visibility 0=不可见 1=遮挡 2=可见）；
  polygon 仅在用户明确给出新轮廓时填 points（至少 3 点），飘出的多边形优先 delete
- patch_content：改正文。
  caption 填 text/granularity/language；cot 填 steps（至少 2 步）+ answer 整表替换，可带 instruction；
  instruction 填 instruction/input/output；span_ner 改文本偏移填 start/end（字符索引，start < end）；
  preference 填 prompt/chosen/rejected；conversation 填 turns 整表替换（role 为 user/assistant）
- delete：删除目标；清空某文件全部标注时 targets=[{"by":"all"}]；去重分类用 {"by":"duplicate_label"}
- selected_paths 必须为候选列表中的 relative_path
- 优先使用摘要里的 id；无 id 时用 label_name/index/spatial/unlabeled/granularity
- 用户说「这个框」「当前选中」时加入 {"by":"selected"}
- 勿编造不在候选中的路径
`;

// ── LLM 输出模型 ────────────────────────────────────────────────────

const MutationPointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

const MutationCotStepSchema = z.object({
  description: z.string(),
  conclusion: z.string(),
});

const MutationKeypointSchema = z.object({
  x: z.number(),
  y: z.number(),
  // 0=不可见 1=遮挡 2=可见
  visibility: z.number().int().default(2),
});

const MutationTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});

const TARGET_BY_VALUES = [
  'id',
  'label_name',
  'index',
  'spatial',
  'selected',
  'all',
  'unlabeled',
  'granularity',
  'language',
  'longest',
  'shortest',
  'duplicate_label',
] as const;

const MutationTargetSchema = z.object({
  by: z.enum(TARGET_BY_VALUES).default('id'),
  id: z.string().nullish(),
  label_name: z.string().nullish(),
  index: z.number().int().nullish(),
  hint: z.string().nullish(),
  granularity: z.string().nullish(),
  language: z.string().nullish(),
});

const MUTATION_KIND_VALUES = [
  'patch_label',
  'patch_geometry',
  'patch_content',
  'delete',
] as const;

const MutationOperationSchema = z.object({
  relative_path: z.string().min(1),
  mutation_kind: z.enum(MUTATION_KIND_VALUES).default('patch_label'),
  targets: z.array(MutationTargetSchema).default([]),
  new_label_name: z.string().nullish(),
  x: z.number().nullish(),
  y: z.number().nullish(),
  width: z.number().nullish(),
  height: z.number().nullish(),
  // rotated_bbox / keypoint 骨架：中心点 + 旋转角（度）
  cx: z.number().nullish(),
  cy: z.number().nullish(),
  angle: z.number().nullish(),
  points: z.array(MutationPointSchema).nullish(),
  // keypoint 骨架关键点（整表替换）
  keypoints: z.array(MutationKeypointSchema).nullish(),
  text: z.string().nullish(),
  granularity: z.string().nullish(),
  language: z.string().nullish(),
  steps: z.array(MutationCotStepSchema).nullish(),
  answer: z.string().nullish(),
  instruction: z.string().nullish(),
  input: z.string().nullish(),
  output: z.string().nullish(),
  // span_ner 文本偏移（字符索引）
  start: z.number().int().min(0).nullish(),
  end: z.number().int().min(0).nullish(),
  // preference
  prompt: z.string().nullish(),
  chosen: z.string().nullish(),
  rejected: z.string().nullish(),
  // conversation（整表替换）
  turns: z.array(MutationTurnSchema).nullish(),
  note: z.string().nullish(),
});

const MutationPrepareLlmResultSchema = z.object({
  selected_paths: z.array(z.string()).default([]),
  intent_summary: z.string().default(''),
  operations: z.array(MutationOperationSchema).default([]),
});

type MutationOperation = z.infer<typeof MutationOperationSchema>;

/**
 * 等价于 Pydantic 的 `model_dump()`：**输出全部字段**，未设值者为 `null`，
 * 嵌套模型递归展开为普通对象。
 */
export function dumpMutationOperation(
  op: MutationOperation,
): Record<string, unknown> {
  return {
    relative_path: op.relative_path,
    mutation_kind: op.mutation_kind,
    targets: (op.targets ?? []).map((t) => ({
      by: t.by,
      id: t.id ?? null,
      label_name: t.label_name ?? null,
      index: t.index ?? null,
      hint: t.hint ?? null,
      granularity: t.granularity ?? null,
      language: t.language ?? null,
    })),
    new_label_name: op.new_label_name ?? null,
    x: op.x ?? null,
    y: op.y ?? null,
    width: op.width ?? null,
    height: op.height ?? null,
    cx: op.cx ?? null,
    cy: op.cy ?? null,
    angle: op.angle ?? null,
    points: op.points ? op.points.map((p) => ({ x: p.x, y: p.y })) : null,
    keypoints: op.keypoints
      ? op.keypoints.map((k) => ({
          x: k.x,
          y: k.y,
          visibility: k.visibility ?? 2,
        }))
      : null,
    text: op.text ?? null,
    granularity: op.granularity ?? null,
    language: op.language ?? null,
    steps: op.steps
      ? op.steps.map((s) => ({
          description: s.description,
          conclusion: s.conclusion,
        }))
      : null,
    answer: op.answer ?? null,
    instruction: op.instruction ?? null,
    input: op.input ?? null,
    output: op.output ?? null,
    start: op.start ?? null,
    end: op.end ?? null,
    prompt: op.prompt ?? null,
    chosen: op.chosen ?? null,
    rejected: op.rejected ?? null,
    turns: op.turns
      ? op.turns.map((t) => ({ role: t.role, content: t.content }))
      : null,
    note: op.note ?? null,
  };
}

export interface MutationPrepareResult {
  selected_paths: string[];
  intent_summary: string;
  operations: Array<Record<string, unknown>>;
  resolved_user_request: string;
}

/** 过滤出确实存在于候选列表中的路径（正斜杠归一后比对）。 */
export function filterPaths(
  rawPaths: unknown,
  candidates: ImageCandidate[],
): string[] {
  const byPath = new Map<string, ImageCandidate>();
  for (const c of candidates) {
    const key = String(c.relative_path ?? '')
      .trim()
      .replace(/\\/g, '/');
    if (key) byPath.set(key, c);
  }

  const selected: string[] = [];
  if (Array.isArray(rawPaths)) {
    for (const raw of rawPaths) {
      const key = String(raw).trim().replace(/\\/g, '/');
      if (byPath.has(key)) selected.push(key);
    }
  }
  return selected;
}

export interface PrepareMutationParams {
  llm: LlmClient;
  userRequest: string;
  currentRelativePath: string;
  candidates: ImageCandidate[];
  labelNames: string[];
  selectedAnnotationIds?: string[];
  conversationTranscript?: string;
  signal?: AbortSignal;
}

/** 单次 LLM 解析 mutate 意图与目标。 */
export async function prepareMutationAnnotation(
  params: PrepareMutationParams,
): Promise<MutationPrepareResult> {
  if (params.candidates.length === 0) {
    return {
      selected_paths: [],
      intent_summary: '无文件候选',
      operations: [],
      resolved_user_request: params.userRequest,
    };
  }

  const catalog = JSON.stringify(
    params.candidates.slice(0, 80).map((c) => ({
      relative_path: c.relative_path,
      name: c.name,
      parent: c.parent,
    })),
  );
  const labels = params.labelNames.slice(0, 50).join(', ') || '（无）';
  const selectedIds =
    (params.selectedAnnotationIds ?? []).join(', ') || '（无）';
  const transcript =
    (params.conversationTranscript ?? '').trim() || '（无历史）';

  const human =
    `【对话上下文】\n${transcript}\n\n` +
    `【用户请求】\n${params.userRequest.trim()}\n\n` +
    `current_relative_path: ${params.currentRelativePath || '（无）'}\n` +
    `selected_annotation_ids: ${selectedIds}\n` +
    `项目标签: ${labels}\n` +
    `候选文件: ${catalog}\n`;

  const parsed = await invokeJsonModel(
    params.llm,
    [
      { role: 'system', content: MUTATION_PREPARE_SYSTEM },
      { role: 'user', content: human },
    ],
    { schema: MutationPrepareLlmResultSchema, signal: params.signal },
  );

  let selected = filterPaths(parsed.selected_paths, params.candidates);
  if (selected.length === 0 && parsed.operations.length > 0) {
    const candidatePaths = new Set(
      params.candidates.map((c) => String(c.relative_path ?? '')),
    );
    const opPaths = new Set(
      parsed.operations.map((op) =>
        String(op.relative_path).trim().replace(/\\/g, '/'),
      ),
    );
    selected = [...opPaths].filter((p) => candidatePaths.has(p));
  }

  return {
    selected_paths: selected,
    intent_summary: parsed.intent_summary || params.userRequest.slice(0, 200),
    operations: parsed.operations.map(dumpMutationOperation),
    resolved_user_request: params.userRequest,
  };
}

/** 标注项目快照里的标签名（供 mutation-prepare 使用）。 */
export function labelNamesOf(
  project: AnnotationProjectSnapshot | null | undefined,
): string[] {
  if (!project) return [];
  return (project.labels ?? [])
    .map((label) => String(label.name ?? ''))
    .filter((name) => name.trim().length > 0);
}
