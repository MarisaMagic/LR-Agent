export type Modality = 'text' | 'image';

export type ImageAnnotationType =
  | 'bbox'
  | 'polygon'
  | 'keypoint'
  | 'rotated_bbox';

export type TextAnnotationType = 'span_ner';

export type AnnotationType = ImageAnnotationType | TextAnnotationType;

export interface LabelDefinition {
  id: string;
  name: string;
  color: string;
}

export interface AnnotationProject {
  id: string;
  name: string;
  directoryPath: string;
  modality: Modality;
  annotationType: AnnotationType;
  labels: LabelDefinition[];
  description?: string;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt?: string;
}

export interface CreateAnnotationProjectInput {
  directoryPath: string;
  name: string;
  modality: Modality;
  annotationType: AnnotationType;
  labels: LabelDefinition[];
  description?: string;
}

export interface UpdateAnnotationProjectInput {
  name: string;
  description?: string;
  labels: LabelDefinition[];
}

export interface AnnotationTypeOption {
  value: AnnotationType;
  label: string;
}

export interface ModalityConfig {
  label: string;
  types: AnnotationTypeOption[];
}

export const TASK_TYPE_CONFIG: Record<Modality, ModalityConfig> = {
  image: {
    label: '图片',
    types: [
      { value: 'bbox', label: '矩形框' },
      { value: 'polygon', label: '多边形框' },
      { value: 'keypoint', label: '关键点标注' },
      { value: 'rotated_bbox', label: '旋转矩形框' },
    ],
  },
  text: {
    label: '文本',
    types: [{ value: 'span_ner', label: '实体识别（片段标注）' }],
  },
};

export const LABEL_COLOR_PRESETS = [
  '#F44336',
  '#E91E63',
  '#9C27B0',
  '#673AB7',
  '#2196F3',
  '#03A9F4',
  '#009688',
  '#4CAF50',
  '#FF9800',
  '#FF5722',
  '#795548',
  '#607D8B',
] as const;

export function getAnnotationTypeLabel(
  modality: Modality,
  annotationType: AnnotationType,
): string {
  const option = TASK_TYPE_CONFIG[modality].types.find(
    (item) => item.value === annotationType,
  );
  return option?.label ?? annotationType;
}

export function getDefaultAnnotationType(modality: Modality): AnnotationType {
  return TASK_TYPE_CONFIG[modality].types[0].value;
}
