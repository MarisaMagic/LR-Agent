/**
 * 标注编排的请求/响应 schema。
 *
 * 用 zod 重建 `vendor/local-agent/app/schemas/annotation_agent.py` 与
 * `annotation_quality.py` 的 Pydantic 模型。**约束必须逐条对齐**，因为它们决定
 * 前端能传什么、以及越界时的错误形态。
 *
 * 解析策略与 FastAPI 一致：忽略多余字段（Pydantic 默认 `extra="ignore"`），
 * 缺失的可选字段取默认值，必填缺失或越界则报 400。
 */

import { z } from 'zod';

/** 图片候选（前端列举出的可选文件）。 */
export const ImageCandidateSchema = z.object({
  relative_path: z.string(),
  name: z.string().default(''),
  parent: z.string().default(''),
  index: z.number().int().default(0),
});

export type ImageCandidate = z.infer<typeof ImageCandidateSchema>;

/** 标注项目快照。 */
export const AnnotationProjectSnapshotSchema = z.object({
  project_id: z.string().min(1).max(64),
  name: z.string().default(''),
  modality: z.string().default('image'),
  annotation_type: z.string().default('bbox'),
  labels: z.array(z.record(z.string(), z.unknown())).default([]),
});

export type AnnotationProjectSnapshot = z.infer<
  typeof AnnotationProjectSnapshotSchema
>;

/**
 * 标注 LLM 请求的公共基座。
 *
 * 注意 `api_key` / `base_url` / `model` 默认空串（不是必填）——与 Python 一致：
 * 校验推迟到 `requireCredentials`，这样错误码是统一的
 * `provider_credentials_required`（400）而不是字段缺失。
 */
const AnnotationLlmBase = z.object({
  provider_id: z.string().min(1).max(64),
  api_key: z.string().default(''),
  base_url: z.string().default(''),
  model: z.string().default(''),
  supports_vision: z.boolean().default(false),
});

/** `POST /agent/annotation/mutation-prepare` */
export const MutationPrepareRequestSchema = AnnotationLlmBase.extend({
  user_request: z.string().min(1).max(20_000),
  session_id: z.string().max(64).nullish(),
  conversation_transcript: z.string().max(24_000).default(''),
  current_relative_path: z.string().default(''),
  candidates: z.array(ImageCandidateSchema).default([]),
  label_candidates: z.array(z.record(z.string(), z.unknown())).default([]),
  selected_annotation_ids: z.array(z.string()).default([]),
  project: AnnotationProjectSnapshotSchema.nullish(),
});

export type MutationPrepareRequest = z.infer<
  typeof MutationPrepareRequestSchema
>;

/** `POST /agent/annotation/map-detection-boxes` */
export const MapDetectionBoxesRequestSchema = AnnotationLlmBase.extend({
  user_request: z.string().max(20_000).default(''),
  intent_summary: z.string().default(''),
  label_candidates: z.array(z.record(z.string(), z.unknown())).default([]),
  boxes: z.array(z.record(z.string(), z.unknown())).default([]),
  use_vision: z.boolean().default(false),
  label_strategy: z.string().default('map_each_box_to_label'),
  single_label_id: z.string().nullish(),
  annotation_scope: z.record(z.string(), z.unknown()).default({}),
  ocr_text: z.string().default(''),
  image_absolute_path: z.string().max(1024).default(''),
  image_base64: z.string().max(16_000_000).default(''),
  mime_type: z.string().default('image/jpeg'),
});

export type MapDetectionBoxesRequest = z.infer<
  typeof MapDetectionBoxesRequestSchema
>;

/** `POST /agent/annotation/llm-generate` */
export const LlmGenerateRequestSchema = AnnotationLlmBase.extend({
  system_prompt: z.string().max(20_000).default(''),
  user_prompt: z.string().max(20_000).default(''),
  temperature: z.number().min(0).max(2).default(0.3),
  max_tokens: z.number().int().min(1).max(128_000).default(4096),
  image_absolute_path: z.string().max(1024).default(''),
  image_base64: z.string().max(16_000_000).default(''),
  image_mime_type: z.string().default('image/jpeg'),
});

export type LlmGenerateRequest = z.infer<typeof LlmGenerateRequestSchema>;

/** `POST /agent/annotation-quality/report/compose/stream` */
export const QualityReportComposeRequestSchema = AnnotationLlmBase.extend({
  compose_payload: z.record(z.string(), z.unknown()).default({}),
});

export type QualityReportComposeRequest = z.infer<
  typeof QualityReportComposeRequestSchema
>;

/** 把 JSON 文本解析为指定 schema；失败时抛出 zod 错误。 */
export function parseRequest<T>(rawBody: string, schema: z.ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    throw new z.ZodError([
      {
        code: 'custom',
        path: [],
        message: '请求体不是合法 JSON',
        input: rawBody,
      },
    ]);
  }
  return schema.parse(parsed);
}

/** 把 zod 错误整理成可读的中文提示（与 FastAPI 的 detail 形态对齐）。 */
export function formatZodError(err: z.ZodError): string {
  const first = err.issues[0];
  if (!first) return 'invalid_request';
  const path = first.path.join('.');
  return path ? `${path}: ${first.message}` : first.message;
}
