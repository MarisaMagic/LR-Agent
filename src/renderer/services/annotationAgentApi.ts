import { API_BASE_URL } from '../config';
import type {
  AnnotationProjectSnapshot,
  BatchPrepareResult,
  ImageCandidate,
} from '../../shared/annotationAgentTypes';
import tokenHolder from './tokenHolder';

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

export async function prepareBatchAnnotation(
  providerId: string,
  options: {
    userRequest: string;
    preselectedPaths?: string[];
    sessionId?: string;
    currentRelativePath: string;
    candidates: ImageCandidate[];
    labelCandidates: Array<{ id: string; name: string }>;
    detectionModels: Array<{ id: string; name: string; isDefault?: boolean }>;
    project: AnnotationProjectSnapshot | null;
    defaultConfThreshold?: number;
    defaultIouThreshold?: number;
  },
): Promise<BatchPrepareResult> {
  const body: Record<string, unknown> = {
    provider_id: providerId,
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

