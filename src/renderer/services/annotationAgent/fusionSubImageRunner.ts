/**
 * Fusion 单图子 Agent 入口：默认走后端驱动（方案 C），可回退客户端 ReAct 循环。
 */
import { mapDetectionBoxesUnified, postAnnotationAgentTurn } from '../annotationAgentApi';
import {
  ANNOTATION_SUB_AGENT_MAX_ROUNDS,
  isBackendDrivenSubImageAgentEnabled,
  isDeterministicSubImageFastPathEnabled,
} from './fusionConfig';
import { runBackendDrivenSubImageAgent } from './backendDrivenSubImageRunner';
import { runDeterministicSubImageAgent } from './deterministicSubImageRunner';
import type { BatchAnnotationPlan, ImageCandidate } from '../../../shared/annotationAgentTypes';
import type { FusionSubImageResult } from './fusionSubImageTypes';
import type { PretrainedModelConfig } from '../../types/pretrainedModel';
import type { AgentTurnMessage } from './agentTurnTypes';
import { tryAutoFinalizeFromMap } from './finalizeFromMappings';
import { logAnnotationDebug } from './annotationAgentDebug';
import {
  executeClientSubImageTool,
  normalizeToolBoxes,
  type SubImageToolContext,
} from './fusionSubImageTools';

export type { FusionSubImageResult } from './fusionSubImageTypes';

export async function runFusionSubImageAgent(options: {
  providerId: string;
  userRequest: string;
  plan: BatchAnnotationPlan;
  image: ImageCandidate;
  detectionModel: PretrainedModelConfig;
  labelCandidates: Array<{ id: string; name: string }>;
}): Promise<FusionSubImageResult> {
  if (isDeterministicSubImageFastPathEnabled()) {
    return runDeterministicSubImageAgent(options);
  }
  if (isBackendDrivenSubImageAgentEnabled()) {
    return runBackendDrivenSubImageAgent(options);
  }
  return runClientReActSubImageAgent(options);
}

/** @deprecated 客户端多轮 agent-turn；用 window.__LR_AGENT_BACKEND_SUB_IMAGE__ = false 启用 */
async function runClientReActSubImageAgent(options: {
  providerId: string;
  userRequest: string;
  plan: BatchAnnotationPlan;
  image: ImageCandidate;
  detectionModel: PretrainedModelConfig;
  labelCandidates: Array<{ id: string; name: string }>;
}): Promise<FusionSubImageResult> {
  const { image, plan } = options;
  const base = {
    ok: false as const,
    relativePath: image.relativePath,
    absolutePath: image.absolutePath,
  };
  const minLabeled = plan.sub_agent_constraints.min_labeled_box_count ?? 1;
  const useVision = Boolean(plan.use_vision_mapping);
  const totalStarted = performance.now();
  let roundCount = 0;
  const withElapsed = (result: FusionSubImageResult): FusionSubImageResult => ({
    ...result,
    elapsedMs: Math.round(performance.now() - totalStarted),
    timing: {
      total_ms: Math.round(performance.now() - totalStarted),
      round_count: roundCount,
    },
  });

  logAnnotationDebug('sub-agent-start', image.relativePath, {
    mode: 'client-react',
    provider_id: options.providerId,
    use_vision_mapping: useVision,
    label_names: options.labelCandidates.map((l) => l.name),
    detection_model: options.detectionModel.id,
  });
  const ctx: SubImageToolContext = {
    boxes: [],
    rawCount: 0,
    keptCount: 0,
    excludedCount: 0,
    mappings: [],
    mapMethod: '',
    mapHint: '',
  };

  const brief = {
    intent_summary: plan.intent_summary,
    label_strategy: plan.label_strategy,
    use_vision_mapping: useVision,
    detection_hints: plan.detection_hints,
    annotation_scope: plan.annotation_scope,
    sub_agent_constraints: plan.sub_agent_constraints,
    detection_model_id: options.detectionModel.id,
  };

  const messages: AgentTurnMessage[] = [
    {
      role: 'human',
      content: JSON.stringify({
        question: `请为图片 ${image.relativePath} 生成可应用的矩形框标注。`,
        user_request: options.userRequest,
        brief,
        label_candidates: options.labelCandidates,
        file_path: image.absolutePath,
      }),
    },
  ];

  for (let round = 0; round < ANNOTATION_SUB_AGENT_MAX_ROUNDS; round += 1) {
    let turn;
    const tRound = performance.now();
    try {
      turn = await postAnnotationAgentTurn(options.providerId, 'image', messages);
    } catch (err) {
      return withElapsed({
        ...base,
        reason: err instanceof Error ? err.message : 'Sub-Agent LLM 调用失败',
        rawCount: ctx.rawCount,
        keptCount: ctx.keptCount,
      });
    }
    roundCount += 1;
    logAnnotationDebug('sub-agent-round', image.relativePath, {
      round,
      elapsed_ms: Math.round(performance.now() - tRound),
      tools: turn.tool_calls?.map((t) => t.name) ?? [],
    });

    if (!turn.tool_calls?.length) break;

    const normalizedCalls = turn.tool_calls.map((call, idx) => ({
      ...call,
      id: call.id?.trim() || `fusion-${round}-${call.name}-${idx}`,
    }));

    messages.push({
      role: 'assistant',
      content: turn.content ?? '',
      tool_calls: normalizedCalls,
    });

    for (const call of normalizedCalls) {
      const toolResult = await executeLegacyFusionTool(options, call, ctx);
      messages.push({
        role: 'tool',
        content: toolResult,
        tool_call_id: call.id,
      });
    }

    if (ctx.change) {
      return withElapsed({
        ok: true,
        relativePath: image.relativePath,
        absolutePath: image.absolutePath,
        change: ctx.change,
        rawCount: ctx.rawCount,
        keptCount: ctx.keptCount,
        mappedCount: ctx.change.annotations.length,
        unmappedCount: Math.max(0, ctx.keptCount - ctx.change.annotations.length),
        autoFinalized: true,
        method: ctx.mapMethod,
      });
    }
  }

  const auto = tryAutoFinalizeFromMap({
    plan,
    imageRelativePath: image.relativePath,
    imageAbsolutePath: image.absolutePath,
    boxes: ctx.boxes,
    mappings: ctx.mappings,
    labelCandidates: options.labelCandidates,
  });
  if (auto.ok && auto.change) {
    return withElapsed({
      ok: true,
      relativePath: image.relativePath,
      absolutePath: image.absolutePath,
      change: auto.change,
      rawCount: ctx.rawCount,
      keptCount: ctx.keptCount,
      mappedCount: auto.mappedCount,
      unmappedCount: Math.max(0, ctx.keptCount - auto.mappedCount),
      autoFinalized: true,
      method: ctx.mapMethod,
    });
  }

  const mappedCount = ctx.mappings.filter((m) => m.label_id).length;
  return withElapsed({
    ...base,
    reason: auto.reason || ctx.mapHint || `成功映射 ${mappedCount} 框，不足 ${minLabeled}`,
    rawCount: ctx.rawCount,
    keptCount: ctx.keptCount,
    mappedCount,
    unmappedCount: Math.max(0, ctx.keptCount - mappedCount),
    method: ctx.mapMethod,
    mapHint: ctx.mapHint,
  });
}

async function executeLegacyFusionTool(
  options: {
    providerId: string;
    userRequest: string;
    plan: BatchAnnotationPlan;
    image: ImageCandidate;
    detectionModel: PretrainedModelConfig;
    labelCandidates: Array<{ id: string; name: string }>;
  },
  call: { id: string; name: string; args: Record<string, unknown> },
  ctx: SubImageToolContext,
): Promise<string> {
  const { plan, image } = options;

  if (call.name === 'map_detection_boxes_to_labels') {
    const argBoxes = call.args.boxes;
    if (Array.isArray(argBoxes) && argBoxes.length > 0) {
      ctx.boxes = normalizeToolBoxes(argBoxes);
      ctx.keptCount = ctx.boxes.length;
    }
    if (ctx.boxes.length === 0) {
      return JSON.stringify({ ok: false, error: '无检测框；请先 run_object_detection' });
    }

    const imageB64 = '';
    const singleLabelId =
      plan.label_strategy === 'single_label_for_all_boxes' && options.labelCandidates.length === 1
        ? options.labelCandidates[0].id
        : null;

    try {
      const result = await mapDetectionBoxesUnified(options.providerId, {
        userRequest: options.userRequest,
        intentSummary: plan.intent_summary,
        labelCandidates: options.labelCandidates,
        boxes: ctx.boxes.map((b) => ({
          box_index: b.box_index,
          x: b.x,
          y: b.y,
          width: b.width,
          height: b.height,
          class_name: b.class_name,
          confidence: b.confidence,
        })),
        useVision: Boolean(plan.use_vision_mapping),
        labelStrategy: plan.label_strategy,
        singleLabelId,
        annotationScope: { ...plan.annotation_scope },
        imageAbsolutePath: image.absolutePath,
        imageBase64: imageB64,
      });
      ctx.mappings = result.mappings ?? [];
      ctx.mapMethod = result.method ?? '';
      ctx.mapHint = result.hint ?? '';
      const auto = tryAutoFinalizeFromMap({
        plan,
        imageRelativePath: image.relativePath,
        imageAbsolutePath: image.absolutePath,
        boxes: ctx.boxes,
        mappings: ctx.mappings,
        labelCandidates: options.labelCandidates,
      });
      if (auto.ok && auto.change) ctx.change = auto.change;
      const mapped = ctx.mappings.filter((m) => m.label_id).length;
      return JSON.stringify({
        ok: result.ok !== false,
        method: result.method,
        mapped_count: mapped,
        unmapped_count: ctx.boxes.length - mapped,
        hint: result.hint,
        auto_finalized: Boolean(ctx.change),
      });
    } catch (err) {
      return JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : 'map 失败',
      });
    }
  }

  return executeClientSubImageTool(options, call, ctx);
}
