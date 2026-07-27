import { API_BASE_URL } from '../config';
import type {
  AnnotationJudgeSummary,
  AnnotationJudgeVerdict,
  AnnotationProjectSnapshot,
  BatchPrepareResult,
  ImageCandidate,
} from '../../shared/annotationAgentTypes';
import { authFetch, parseApiError } from './authenticatedFetch';
import { requireCloudAuth } from './cloudAuthGuard';

interface ApiSuccess<T> {
  code?: number;
  data: T;
}

async function postAnnotationLlm<T>(
  path: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  requireCloudAuth();

  const response = await authFetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw await parseApiError(response);
  }

  const json = (await response.json()) as ApiSuccess<T>;
  return json.data;
}

export async function prepareBatchAnnotation(
  providerId: string,
  options: {
    userRequest: string;
    /** 仅 UI 显式指定；勿用回合理解的 referenced_relative_paths */
    preselectedPaths?: string[];
    sessionId?: string;
    currentRelativePath: string;
    candidates: ImageCandidate[];
    labelCandidates: Array<{ id: string; name: string }>;
    detectionModels: Array<{ id: string; name: string; isDefault?: boolean }>;
    project: AnnotationProjectSnapshot | null;
    defaultConfThreshold?: number;
    defaultIouThreshold?: number;
    providerApiKey?: string;
    providerBaseUrl?: string;
    providerModel?: string;
    providerSupportsVision?: boolean;
    signal?: AbortSignal;
  },
): Promise<BatchPrepareResult> {
  const body: Record<string, unknown> = {
    provider_id: providerId,
    api_key: options.providerApiKey ?? '',
    base_url: options.providerBaseUrl ?? '',
    model: options.providerModel ?? '',
    supports_vision: options.providerSupportsVision ?? false,
    user_request: options.userRequest,
    session_id: options.sessionId ?? null,
    current_relative_path: options.currentRelativePath,
    candidates: options.candidates.map((c) => ({
      relative_path: c.relativePath,
      name: c.name,
      parent: c.parent,
      index: c.index,
    })),
    label_candidates: options.labelCandidates,
    detection_models: options.detectionModels,
    default_conf_threshold: options.defaultConfThreshold ?? 0.7,
    default_iou_threshold: options.defaultIouThreshold ?? 0.5,
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
  };
  const preselected = options.preselectedPaths?.filter(Boolean) ?? [];
  if (preselected.length) {
    body.preselected_paths = preselected;
  }
  return postAnnotationLlm<BatchPrepareResult>(
    '/agent/annotation/batch-prepare',
    body,
    options.signal,
  );
}

export interface MutationPrepareResult {
  selected_paths: string[];
  intent_summary: string;
  operations: Array<Record<string, unknown>>;
  resolved_user_request?: string;
}

export async function prepareMutationAnnotation(
  providerId: string,
  options: {
    userRequest: string;
    sessionId?: string;
    currentRelativePath: string;
    candidates: ImageCandidate[];
    labelCandidates: Array<{ id: string; name: string }>;
    project: AnnotationProjectSnapshot | null;
    selectedAnnotationIds?: string[];
    providerApiKey?: string;
    providerBaseUrl?: string;
    providerModel?: string;
  },
): Promise<MutationPrepareResult> {
  return postAnnotationLlm<MutationPrepareResult>(
    '/agent/annotation/mutation-prepare',
    {
      provider_id: providerId,
      api_key: options.providerApiKey ?? '',
      base_url: options.providerBaseUrl ?? '',
      model: options.providerModel ?? '',
      user_request: options.userRequest,
      session_id: options.sessionId ?? null,
      current_relative_path: options.currentRelativePath,
      candidates: options.candidates.map((c) => ({
        relative_path: c.relativePath,
        name: c.name,
        parent: c.parent,
        index: c.index,
      })),
      label_candidates: options.labelCandidates,
      selected_annotation_ids: options.selectedAnnotationIds ?? [],
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
    },
  );
}

export interface MapDetectionBoxesUnifiedResult {
  ok?: boolean;
  error?: string;
  method?: string;
  mappings: Array<{ box_index: number; label_id: string; reason?: string }>;
  unmapped_indices?: number[];
  hint?: string;
  next_step?: string;
  label_pool_source?: string;
  label_pool_debug?: LabelPoolDebugInfo;
  vision_map_retry_rounds?: number;
  label_candidates?: Array<{ id: string; name: string }>;
}

export interface JudgeDetectionLabelsResult extends AnnotationJudgeSummary {
  ok?: boolean;
  error?: string;
  verdict: AnnotationJudgeVerdict;
}

/** 标签候选池各阶段调试信息（与后端 map 响应一致） */
export interface LabelPoolDebugInfo {
  source: string;
  project_count: number;
  scoped_count: number;
  effective_count: number;
  project_names: string[];
  scoped_names: string[];
  effective_names: string[];
  excluded_names: string[];
  preflight_label_ids: string[];
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
    judgeFeedback?: string;
    previousMappings?: Array<{ box_index: number; label_id: string; reason?: string }>;
    attempt?: number;
    providerApiKey?: string;
    providerBaseUrl?: string;
    providerModel?: string;
    providerSupportsVision?: boolean;
    signal?: AbortSignal;
  },
): Promise<MapDetectionBoxesUnifiedResult> {
  return postAnnotationLlm<MapDetectionBoxesUnifiedResult>(
    '/agent/annotation/map-detection-boxes',
    {
      provider_id: providerId,
      api_key: options.providerApiKey ?? '',
      base_url: options.providerBaseUrl ?? '',
      model: options.providerModel ?? '',
      supports_vision: options.providerSupportsVision ?? false,
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
      judge_feedback: options.judgeFeedback ?? '',
      previous_mappings: options.previousMappings ?? [],
      attempt: options.attempt ?? 0,
    },
    options.signal,
  );
}

export async function judgeDetectionLabels(
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
    mappings: Array<{ box_index: number; label_id: string; reason?: string }>;
    annotations: Array<Record<string, unknown>>;
    imageAbsolutePath?: string;
    imageBase64?: string;
    attempt?: number;
    maxRetries?: number;
    providerApiKey?: string;
    providerBaseUrl?: string;
    providerModel?: string;
    providerSupportsVision?: boolean;
    signal?: AbortSignal;
  },
): Promise<JudgeDetectionLabelsResult> {
  const result = await postAnnotationLlm<{
    ok?: boolean;
    error?: string;
    verdict?: AnnotationJudgeVerdict;
    confidence?: number;
    summary?: string;
    issues?: Array<{
      box_index?: number;
      boxIndex?: number;
      code?: string;
      message?: string;
      expected_label_id?: string;
      expectedLabelId?: string;
      actual_label_id?: string;
      actualLabelId?: string;
    }>;
    retry_feedback?: string;
    retryFeedback?: string;
    checked_boxes?: number;
    checkedBoxes?: number;
  }>('/agent/annotation/judge-detection-labels', {
    provider_id: providerId,
    api_key: options.providerApiKey ?? '',
    base_url: options.providerBaseUrl ?? '',
    model: options.providerModel ?? '',
    supports_vision: options.providerSupportsVision ?? false,
    user_request: options.userRequest,
    intent_summary: options.intentSummary,
    label_candidates: options.labelCandidates,
    boxes: options.boxes,
    mappings: options.mappings,
    annotations: options.annotations,
    image_absolute_path: options.imageAbsolutePath ?? '',
    image_base64: options.imageBase64 ?? '',
    attempt: options.attempt ?? 0,
    max_retries: options.maxRetries ?? 1,
  },
  options.signal,
  );
  return {
    ok: result.ok,
    error: result.error,
    verdict: result.verdict ?? 'weak_accept',
    confidence: result.confidence,
    summary: result.summary,
    issues: (result.issues ?? []).map((issue) => ({
      boxIndex: issue.boxIndex ?? issue.box_index,
      code: issue.code,
      message: issue.message ?? '',
      expectedLabelId: issue.expectedLabelId ?? issue.expected_label_id,
      actualLabelId: issue.actualLabelId ?? issue.actual_label_id,
    })),
    retryFeedback: result.retryFeedback ?? result.retry_feedback,
    checkedBoxes: result.checkedBoxes ?? result.checked_boxes,
  };
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

