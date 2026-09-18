/**
 * 标注编排端点（第 1 批）：`llm-generate`、`mutation-prepare`、质量报告撰写。
 *
 * 移植自 `vendor/local-agent/app/api/v1/annotation_agent.py` 与 `annotation_quality.py`。
 *
 * 响应格式与错误语义对齐 FastAPI：
 *   - 成功 → `{ data: ... }`
 *   - `HTTPException(detail)` → `{ detail: ... }` + 对应状态码
 *
 * `map-detection-boxes` 在下一个文件中（它依赖视觉裁剪，体量更大）。
 */

import { LlmClient } from '../llm/client';
import { AGENT_ROUTE_PATHS } from '../routes';
import type { RouteHandler, RouteResult } from '../server';
import {
  AnnotateHttpError,
  httpFromLlmError,
  requireCredentials,
} from '../annotate/common';
import {
  formatZodError,
  LlmGenerateRequestSchema,
  MutationPrepareRequestSchema,
  QualityReportComposeRequestSchema,
} from '../annotate/schemas';
import {
  labelNamesOf,
  prepareMutationAnnotation,
} from '../annotate/mutation';
import { llmGenerate } from '../annotate/generate';
import {
  assertComposePayloadSize,
  streamQualityReportCompose,
} from '../annotate/quality';
import { resolveImageService, type RuntimeDeps } from './deps';

/** 把路由层异常统一转成 `{detail}` 响应。 */
function toErrorResult(err: unknown): RouteResult {
  if (err instanceof AnnotateHttpError) {
    return { kind: 'json', status: err.status, body: { detail: err.message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { kind: 'json', status: 500, body: { detail: message } };
}

/** 构造一个指向标注端点的 LLM 客户端（每次请求独立）。 */
function makeLlm(params: {
  deps: RuntimeDeps;
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
}): LlmClient {
  return new LlmClient({
    apiKey: params.apiKey,
    baseUrl: params.baseUrl,
    model: params.model,
    temperature: params.temperature,
    fetchImpl: params.deps.fetchImpl,
    timeoutMs: params.deps.llmTimeoutMs,
  });
}

/** `POST /agent/annotation/llm-generate` */
export function createLlmGenerateHandler(deps: RuntimeDeps): RouteHandler {
  return async (req) => {
    let body;
    try {
      body = LlmGenerateRequestSchema.parse(JSON.parse(req.rawBody || '{}'));
    } catch (err) {
      return {
        kind: 'json',
        status: 400,
        body: { detail: formatZodError(err as never) },
      };
    }

    try {
      requireCredentials(body);
      const llm = makeLlm({
        deps,
        apiKey: body.api_key,
        baseUrl: body.base_url,
        model: body.model,
        // 温度由请求体控制（生成类 pipeline 各自传值）
        temperature: body.temperature,
      });
      const content = await llmGenerate({
        llm,
        body,
        settings: deps.settings,
        imageService: resolveImageService(deps),
      });
      return { kind: 'json', body: { data: { ok: true, content } } };
    } catch (err) {
      return toErrorResult(httpFromLlmError(err));
    }
  };
}

/** `POST /agent/annotation/mutation-prepare` */
export function createMutationPrepareHandler(deps: RuntimeDeps): RouteHandler {
  return async (req) => {
    // 功能开关：关闭时返回 403（对齐 Python）
    if (!deps.settings.mutationEnabled) {
      return { kind: 'json', status: 403, body: { detail: 'agent_mutation_disabled' } };
    }

    let body;
    try {
      body = MutationPrepareRequestSchema.parse(JSON.parse(req.rawBody || '{}'));
    } catch (err) {
      return {
        kind: 'json',
        status: 400,
        body: { detail: formatZodError(err as never) },
      };
    }

    try {
      requireCredentials(body);
      const llm = makeLlm({
        deps,
        apiKey: body.api_key,
        baseUrl: body.base_url,
        model: body.model,
        temperature: deps.settings.annotationPrepareTemperature,
      });

      const result = await prepareMutationAnnotation({
        llm,
        userRequest: body.user_request,
        currentRelativePath: (body.current_relative_path ?? '').trim(),
        candidates: body.candidates,
        labelNames: labelNamesOf(body.project),
        selectedAnnotationIds: body.selected_annotation_ids,
        conversationTranscript: body.conversation_transcript,
      });

      return {
        kind: 'json',
        body: {
          data: {
            selected_paths: result.selected_paths,
            intent_summary: result.intent_summary,
            operations: result.operations,
            resolved_user_request: body.user_request,
          },
        },
      };
    } catch (err) {
      return toErrorResult(httpFromLlmError(err));
    }
  };
}

/** `POST /agent/annotation-quality/report/compose/stream` */
export function createQualityComposeHandler(deps: RuntimeDeps): RouteHandler {
  return (req) => {
    let body;
    try {
      body = QualityReportComposeRequestSchema.parse(
        JSON.parse(req.rawBody || '{}'),
      );
    } catch (err) {
      return {
        kind: 'json',
        status: 400,
        body: { detail: formatZodError(err as never) },
      };
    }

    try {
      assertComposePayloadSize(body.compose_payload);
      requireCredentials(body);
    } catch (err) {
      if (err instanceof AnnotateHttpError) {
        return { kind: 'json', status: err.status, body: { detail: err.message } };
      }
      return {
        kind: 'json',
        status: 400,
        body: { detail: err instanceof Error ? err.message : String(err) },
      };
    }

    const llm = makeLlm({
      deps,
      apiKey: body.api_key,
      baseUrl: body.base_url,
      model: body.model,
      // 报告撰写温度固定 0.2（对齐 Python）
      temperature: 0.2,
    });

    return {
      kind: 'sse',
      frames: streamQualityReportCompose(llm, {
        composePayload: body.compose_payload,
      }),
    };
  };
}

/** 路由键（供装配使用）。 */
export const ANNOTATION_HANDLER_KEYS = {
  llmGenerate: `POST ${AGENT_ROUTE_PATHS.annotationLlmGenerate}`,
  mutationPrepare: `POST ${AGENT_ROUTE_PATHS.annotationMutationPrepare}`,
  qualityCompose: `POST ${AGENT_ROUTE_PATHS.qualityReportComposeStream}`,
} as const;
