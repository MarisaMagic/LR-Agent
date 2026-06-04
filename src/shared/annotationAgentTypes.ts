import type { AnnotationType, LabelDefinition, Modality } from '../renderer/types/annotation';
import type { BboxAnnotation } from '../renderer/types/annotationDocument';

export interface ImageCandidate {
  relativePath: string;
  name: string;
  parent: string;
  absolutePath: string;
  index: number;
}

export interface AnnotationScopePayload {
  scope_summary?: string;
  include_detection_labels?: string[];
  exclude_detection_labels?: string[];
  include_label_names?: string[];
  exclude_label_names?: string[];
}

export interface AnnotationTaskParseResult {
  intent_summary: string;
  needs_object_detection?: boolean;
  annotation_scope: AnnotationScopePayload;
}

/** @deprecated use AnnotationTaskParseResult */
export type AnnotationIntentResult = AnnotationTaskParseResult;

export interface DetectionHints {
  needs_object_detection?: boolean;
  model_id?: string | null;
  conf_threshold?: number;
  iou_threshold?: number;
  notes?: string;
}

export interface SubAgentConstraints {
  require_per_box_mapping?: boolean;
  allow_unlabeled_boxes?: boolean;
  min_labeled_box_count?: number;
}

export interface BatchAnnotationPlan {
  intent_summary: string;
  label_strategy: 'map_each_box_to_label' | 'single_label_for_all_boxes';
  use_vision_mapping?: boolean;
  detection_hints: DetectionHints;
  sub_agent_constraints: SubAgentConstraints;
  annotation_scope: AnnotationScopePayload;
  plan_steps: string[];
}

/** Single-shot batch prepare: scope + plan (replaces parse-task + parse-scope + create-plan). */
export interface BatchPrepareResult extends BatchAnnotationPlan {
  selected_paths: string[];
  scope_reason: string;
}

export interface AnnotationBatchChange {
  relativePath: string;
  absolutePath: string;
  operation: 'append' | 'replace';
  annotations: BboxAnnotation[];
}

export interface AnnotationBatchProposal {
  id: string;
  projectId: string;
  summary: string;
  changes: AnnotationBatchChange[];
  stats: {
    processed: number;
    succeeded: number;
    skipped: number;
    totalBoxes: number;
  };
  plan?: BatchAnnotationPlan;
  createdAt: number;
}

export interface AnnotationProjectSnapshot {
  projectId: string;
  name: string;
  directoryPath: string;
  modality: Modality;
  annotationType: AnnotationType;
  /** Human-readable label for annotationType */
  annotationTypeLabel?: string;
  labels: LabelDefinition[];
  detectionModels?: DetectionModelSummary[];
}

export type AgentInteractionMode = 'chat' | 'annotation';

export interface DetectionModelSummary {
  id: string;
  name: string;
  isDefault?: boolean;
}

export const ANNOTATION_BATCH_MAX_FILES = 100;
export const ANNOTATION_BATCH_CONCURRENCY = 4;
