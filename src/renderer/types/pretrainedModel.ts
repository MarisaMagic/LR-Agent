export type PretrainedModelType = 'object_detection' | 'image_segmentation';

export interface PretrainedModelParams {
  device?: 'auto' | 'cuda' | 'cpu';
  confThreshold?: number;
  iouThreshold?: number;
  minArea?: number;
  epsilonRatio?: number;
}

export interface PretrainedModelConfig {
  id: string;
  name: string;
  modelType: PretrainedModelType;
  enabled: boolean;
  isDefault: boolean;
  checkpointPath: string;
  configPath?: string;
  params?: PretrainedModelParams;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PretrainedModelValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface Sam2ScanResult {
  variant: string;
  name: string;
  checkpointPath: string;
  configPath: string;
}

export const PRETRAINED_MODEL_TYPE_LABELS: Record<PretrainedModelType, string> =
  {
    object_detection: '目标检测 (YOLO)',
    image_segmentation: '图像分割 (SAM2)',
  };

export const DEFAULT_YOLO_PARAMS: Required<
  Pick<PretrainedModelParams, 'confThreshold' | 'iouThreshold'>
> = {
  confThreshold: 0.25,
  iouThreshold: 0.45,
};

export const DEFAULT_SAM2_PARAMS: Required<
  Pick<PretrainedModelParams, 'minArea' | 'epsilonRatio'>
> = {
  minArea: 100,
  epsilonRatio: 0.006,
};

export function createModelId(name?: string): string {
  const slug = (name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-')
    .replace(/^-+|-+$/g, '');
  const suffix = Date.now().toString(36);
  return slug ? `${slug}-${suffix}` : `model-${suffix}`;
}

function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

export function getModelDisplayName(model: PretrainedModelConfig): string {
  if (model.name.trim()) return model.name.trim();
  if (model.checkpointPath.trim()) {
    return basename(model.checkpointPath).replace(/\.pt$/i, '');
  }
  return PRETRAINED_MODEL_TYPE_LABELS[model.modelType];
}

export function defaultParamsForType(
  modelType: PretrainedModelType,
): PretrainedModelParams {
  if (modelType === 'object_detection') {
    return { ...DEFAULT_YOLO_PARAMS, device: 'auto' };
  }
  return { ...DEFAULT_SAM2_PARAMS, device: 'auto' };
}

export function normalizeModelsOnSave(
  models: PretrainedModelConfig[],
  changed?: PretrainedModelConfig,
): PretrainedModelConfig[] {
  const next = models.map((m) => ({ ...m }));

  if (changed?.isDefault) {
    for (const model of next) {
      if (
        model.modelType === changed.modelType &&
        model.id !== changed.id
      ) {
        model.isDefault = false;
      }
    }
  }

  const byType = new Map<PretrainedModelType, PretrainedModelConfig[]>();
  for (const model of next) {
    const list = byType.get(model.modelType) ?? [];
    list.push(model);
    byType.set(model.modelType, list);
  }

  for (const list of byType.values()) {
    const enabledDefaults = list.filter((m) => m.enabled && m.isDefault);
    if (enabledDefaults.length === 1) continue;
    const pick =
      enabledDefaults[0] ??
      list.find((m) => m.enabled) ??
      list[0];
    if (!pick) continue;
    for (const model of list) {
      model.isDefault = model.id === pick.id;
    }
  }

  return next;
}
