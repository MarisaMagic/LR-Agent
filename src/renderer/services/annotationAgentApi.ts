import { API_BASE_URL } from '../config';
import type {
  AnnotationProjectSnapshot,
  AnnotationTaskParseResult,
  BatchAnnotationPlan,
  BatchPrepareResult,
  ImageCandidate,
} from '../../shared/annotationAgentTypes';
import tokenHolder from './tokenHolder';
import type { AgentTurnMessage, AgentTurnResponse } from './annotationAgent/agentTurnTypes';

interface ApiSuccess<T> {
  code?: number;
  data: T;
}

async function postAnnotationLlm<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const accessToken = tokenHolder.getAccessToken();
  if (!accessToken) {
    throw new Error('请先登录后再使用标注 Agent');
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const errBody = (await response.json()) as { detail?: string; msg?: string };
      detail = errBody.detail ?? errBody.msg ?? detail;
    } catch {
      // ignore
    }
    throw new Error(detail || '请求失败');
  }

  const json = (await response.json()) as ApiSuccess<T>;
  return json.data;
}

export async function parseAnnotationTask(
  providerId: string,
  userRequest: string,
  project: AnnotationProjectSnapshot | null,
): Promise<AnnotationTaskParseResult> {
  return postAnnotationLlm<AnnotationTaskParseResult>(
    '/agent/annotation/parse-task',
    {
      provider_id: providerId,
      user_request: userRequest,
      interaction_mode: 'annotation',
      project: project
        ? {
            project_id: project.projectId,
            name: project.name,
            modality: project.modality,
            annotation_type: project.annotationType,
            labels: project.labels.map((l) => ({
              id: l.id,
              name: l.name,
              color: l.color,
            })),
          }
        : null,
    },
  );
}

/** @deprecated use parseAnnotationTask */
export async function classifyAnnotationIntent(
  providerId: string,
  userRequest: string,
  project: AnnotationProjectSnapshot | null,
): Promise<AnnotationTaskParseResult> {
  return parseAnnotationTask(providerId, userRequest, project);
}

export async function resolveAnnotationScope(
  providerId: string,
  options: {
    userRequest: string;
    currentRelativePath: string;
    candidates: ImageCandidate[];
  },
): Promise<{ selected_paths: string[]; reason: string; source?: string }> {
  return postAnnotationLlm('/agent/annotation/parse-scope', {
    provider_id: providerId,
    user_request: options.userRequest,
    current_relative_path: options.currentRelativePath,
    candidates: options.candidates.map((c) => ({
      relative_path: c.relativePath,
      name: c.name,
      parent: c.parent,
      index: c.index,
    })),
  });
}

/** @deprecated use resolveAnnotationScope */
export const parseAnnotationScope = resolveAnnotationScope;

export async function prepareBatchAnnotation(
  providerId: string,
  options: {
    userRequest: string;
    currentRelativePath: string;
    candidates: ImageCandidate[];
    labelCandidates: Array<{ id: string; name: string }>;
    detectionModels: Array<{ id: string; name: string; isDefault?: boolean }>;
    project: AnnotationProjectSnapshot | null;
    defaultConfThreshold?: number;
    defaultIouThreshold?: number;
  },
): Promise<BatchPrepareResult> {
  return postAnnotationLlm<BatchPrepareResult>('/agent/annotation/batch-prepare', {
    provider_id: providerId,
    user_request: options.userRequest,
    current_relative_path: options.currentRelativePath,
    candidates: options.candidates.map((c) => ({
      relative_path: c.relativePath,
      name: c.name,
      parent: c.parent,
      index: c.index,
    })),
    label_candidates: options.labelCandidates,
    detection_models: options.detectionModels,
    default_conf_threshold: options.defaultConfThreshold ?? 0.25,
    default_iou_threshold: options.defaultIouThreshold ?? 0.45,
    project: options.project
      ? {
          project_id: options.project.projectId,
          name: options.project.name,
          modality: options.project.modality,
          annotation_type: options.project.annotationType,
          labels: options.project.labels.map((l) => ({
            id: l.id,
            name: l.name,
            color: l.color,
          })),
        }
      : null,
  });
}

export async function createAnnotationBatchPlan(
  providerId: string,
  options: {
    userRequest: string;
    intentSummary: string;
    annotationScope: Record<string, unknown>;
    labelCandidates: Array<{ id: string; name: string }>;
    detectionModels: Array<{ id: string; name: string; isDefault?: boolean }>;
    imageCount: number;
    defaultConfThreshold?: number;
    defaultIouThreshold?: number;
  },
): Promise<BatchAnnotationPlan> {
  return postAnnotationLlm<BatchAnnotationPlan>('/agent/annotation/create-plan', {
    provider_id: providerId,
    user_request: options.userRequest,
    intent_summary: options.intentSummary,
    annotation_scope: options.annotationScope,
    label_candidates: options.labelCandidates,
    detection_models: options.detectionModels,
    image_count: options.imageCount,
    default_conf_threshold: options.defaultConfThreshold ?? 0.25,
    default_iou_threshold: options.defaultIouThreshold ?? 0.45,
  });
}

export async function postAnnotationAgentTurn(
  providerId: string,
  kind: 'scope' | 'image',
  messages: AgentTurnMessage[],
): Promise<AgentTurnResponse> {
  return postAnnotationLlm<AgentTurnResponse>('/agent/annotation/agent-turn', {
    provider_id: providerId,
    kind,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      tool_call_id: m.tool_call_id ?? null,
      tool_calls: m.tool_calls?.map((t) => ({
        id: t.id,
        name: t.name,
        args: t.args,
      })),
    })),
  });
}

export interface MapDetectionBoxesUnifiedResult {
  ok?: boolean;
  error?: string;
  method?: string;
  mappings: Array<{ box_index: number; label_id: string; reason?: string }>;
  unmapped_indices?: number[];
  hint?: string;
  next_step?: string;
}

export async function mapDetectionBoxesUnified(
  providerId: string,
  options: {
    userRequest: string;
    intentSummary: string;
    labelCandidates: Array<{ id: string; name: string }>;
    boxes: Array<{
      box_index: number;
      x: number;
      y: number;
      width: number;
      height: number;
      class_name: string;
      confidence?: number;
    }>;
    useVision: boolean;
    labelStrategy: string;
    singleLabelId?: string | null;
    annotationScope: Record<string, unknown>;
    imageAbsolutePath?: string;
    imageBase64?: string;
    ocrText?: string;
  },
): Promise<MapDetectionBoxesUnifiedResult> {
  return postAnnotationLlm<MapDetectionBoxesUnifiedResult>(
    '/agent/annotation/map-detection-boxes',
    {
      provider_id: providerId,
      user_request: options.userRequest,
      intent_summary: options.intentSummary,
      label_candidates: options.labelCandidates,
      boxes: options.boxes,
      use_vision: options.useVision,
      label_strategy: options.labelStrategy,
      single_label_id: options.singleLabelId ?? null,
      annotation_scope: options.annotationScope,
      image_absolute_path: options.imageAbsolutePath ?? '',
      image_base64: options.imageBase64 ?? '',
      ocr_text: options.ocrText ?? '',
    },
  );
}

export async function mapDetectionBoxesHeuristic(
  providerId: string,
  options: {
  boxes: Array<{ box_index: number; class_name: string; confidence: number }>;
  labelCandidates: Array<{ id: string; name: string }>;
  ocrText?: string;
},
): Promise<{ mappings: Array<{ box_index: number; label_id: string; reason?: string }> }> {
  return postAnnotationLlm('/agent/annotation/map-heuristic', {
    provider_id: providerId,
    boxes: options.boxes,
    label_candidates: options.labelCandidates,
    ocr_text: options.ocrText ?? '',
  });
}

export async function mapSingleBoxCrop(
  providerId: string,
  options: {
    userRequest: string;
    intentSummary: string;
    labelCandidates: Array<{ id: string; name: string }>;
    boxIndex: number;
    className: string;
    cropBase64: string;
    mimeType?: string;
  },
): Promise<{ box_index: number; label_id: string }> {
  return postAnnotationLlm('/agent/annotation/map-box-crop', {
    provider_id: providerId,
    user_request: options.userRequest,
    intent_summary: options.intentSummary,
    label_candidates: options.labelCandidates,
    box_index: options.boxIndex,
    class_name: options.className,
    crop_base64: options.cropBase64,
    mime_type: options.mimeType ?? 'image/jpeg',
    confidence: 0,
  });
}

export async function mapDetectionBoxesVision(
  providerId: string,
  options: {
    userRequest: string;
    intentSummary: string;
    labelCandidates: Array<{ id: string; name: string }>;
    boxes: Array<{ box_index: number; class_name: string; confidence: number }>;
    imageBase64: string;
    mimeType?: string;
  },
): Promise<{ mappings: Array<{ box_index: number; label_id: string }> }> {
  return postAnnotationLlm('/agent/annotation/map-boxes-vision', {
    provider_id: providerId,
    user_request: options.userRequest,
    intent_summary: options.intentSummary,
    label_candidates: options.labelCandidates,
    boxes: options.boxes,
    image_base64: options.imageBase64,
    mime_type: options.mimeType ?? 'image/jpeg',
    label_strategy: 'map_each_box_to_label',
  });
}

/** @deprecated 批量 fusion 路径请用 mapDetectionBoxesUnified（无纯文本 LLM 映射） */
export async function mapDetectionBoxesToLabels(
  providerId: string,
  options: {
    userRequest: string;
    intentSummary: string;
    labelCandidates: Array<{ id: string; name: string }>;
    boxes: Array<{ box_index: number; class_name: string; confidence: number }>;
    labelStrategy: string;
    singleLabelId?: string | null;
  },
): Promise<{ mappings: Array<{ box_index: number; label_id: string }> }> {
  return postAnnotationLlm('/agent/annotation/map-boxes', {
    provider_id: providerId,
    user_request: options.userRequest,
    intent_summary: options.intentSummary,
    label_candidates: options.labelCandidates,
    boxes: options.boxes,
    label_strategy: options.labelStrategy,
    single_label_id: options.singleLabelId ?? null,
  });
}
