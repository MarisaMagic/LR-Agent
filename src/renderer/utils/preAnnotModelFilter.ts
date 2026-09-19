import type { ImageAnnotationType } from '../types/annotation';
import type { PretrainedModelConfig } from '../types/pretrainedModel';
import { inferDetectionMode } from '../../shared/preAnnotTypes';

export function getEligiblePreAnnotModels(
  annotationType: ImageAnnotationType,
  models: PretrainedModelConfig[],
  activeTemplateId?: string,
): PretrainedModelConfig[] {
  const enabled = models.filter((m) => m.enabled);

  switch (annotationType) {
    case 'bbox':
      return enabled.filter(
        (m) =>
          m.modelType === 'object_detection' &&
          inferDetectionMode(m) === 'detect',
      );
    case 'rotated_bbox':
      return enabled.filter(
        (m) =>
          m.modelType === 'object_detection' && inferDetectionMode(m) === 'obb',
      );
    case 'polygon':
      return enabled.filter((m) => m.modelType === 'image_segmentation');
    case 'keypoint':
      return enabled.filter(
        (m) =>
          m.modelType === 'keypoint_estimation' &&
          (!activeTemplateId ||
            m.keypointTemplateIds?.includes(activeTemplateId)),
      );
    default:
      return [];
  }
}

export function pickDefaultPreAnnotModel(
  annotationType: ImageAnnotationType,
  models: PretrainedModelConfig[],
  activeTemplateId?: string,
): PretrainedModelConfig | null {
  const eligible = getEligiblePreAnnotModels(
    annotationType,
    models,
    activeTemplateId,
  );
  if (eligible.length === 0) return null;
  return eligible.find((m) => m.isDefault) ?? eligible[0];
}

const STORAGE_PREFIX = 'lr-agent-preannot-model:';

/**
 * 「无可用模型」时的人类可读原因。
 *
 * 下拉框的筛选条件同时包含模型类型、检测模式与骨架模板绑定，任一不匹配都会让
 * 模型消失；其中检测模式最容易踩坑（模型在左侧列表里完全正常，却因
 * `detectionMode` 被写成了另一种模式而无法在对应标注类型下使用）。这里把原因
 * 讲清楚，避免用户只看到一个空下拉框而无从排查。
 */
export function describeNoEligibleModelReason(
  annotationType: ImageAnnotationType,
  models: PretrainedModelConfig[],
  activeTemplateId?: string,
): string | null {
  // 有可用模型时本函数不适用（调用方只应在空态下询问），提前返回保证语义自洽
  if (
    getEligiblePreAnnotModels(annotationType, models, activeTemplateId).length >
    0
  ) {
    return null;
  }

  const enabled = models.filter((m) => m.enabled);
  if (enabled.length === 0) {
    return models.length > 0
      ? '预训练模型均已停用，请在左侧「预训练模型」面板中启用。'
      : '尚未配置预训练模型，请在左侧「预训练模型」面板中添加。';
  }

  const detectionModels = enabled.filter(
    (m) => m.modelType === 'object_detection',
  );
  const detectCount = detectionModels.filter(
    (m) => inferDetectionMode(m) === 'detect',
  ).length;
  const obbCount = detectionModels.length - detectCount;

  switch (annotationType) {
    case 'bbox':
      return obbCount > 0
        ? '已启用的目标检测模型都是「旋转框 (OBB)」。矩形框标注需要普通检测 (Detect) 权重，请在模型配置中改选检测模式，或补充 Detect 权重。'
        : '未启用目标检测 (YOLO) 模型，请在左侧「预训练模型」面板中配置。';
    case 'rotated_bbox':
      return detectCount > 0
        ? '已启用的目标检测模型都是「普通矩形框 (Detect)」。旋转框标注需要 OBB 权重，请在模型配置中改选检测模式，或补充 OBB 权重。'
        : '未启用目标检测 (YOLO) 模型，请在左侧「预训练模型」面板中配置。';
    case 'polygon':
      return '未启用 SAM2 分割模型，请在左侧「预训练模型」面板中配置。';
    case 'keypoint': {
      const hasKeypointModel = enabled.some(
        (m) => m.modelType === 'keypoint_estimation',
      );
      if (!hasKeypointModel) {
        return '未启用关键点估计模型，请在左侧「预训练模型」面板中配置。';
      }
      return activeTemplateId
        ? '已启用的关键点模型未绑定当前骨架模板，请检查模型的模板绑定，或切换骨架模板。'
        : null;
    }
    default:
      return null;
  }
}

export function loadSavedPreAnnotModelId(projectId: string): string | null {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${projectId}`);
  } catch {
    return null;
  }
}

export function savePreAnnotModelId(projectId: string, modelId: string): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${projectId}`, modelId);
  } catch {
    // ignore quota errors
  }
}
