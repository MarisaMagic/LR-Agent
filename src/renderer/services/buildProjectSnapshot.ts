import type { AnnotationProjectSnapshot } from '../../shared/annotationAgentTypes';
import type { AnnotationProject } from '../types/annotation';
import type { PretrainedModelConfig } from '../types/pretrainedModel';
import { getEligiblePreAnnotModels } from '../utils/preAnnotModelFilter';
import { getAnnotationTypeLabel } from '../types/annotation';

export function buildAnnotationProjectSnapshot(
  project: AnnotationProject,
  detectionModels: PretrainedModelConfig[],
): AnnotationProjectSnapshot {
  const eligible = getEligiblePreAnnotModels('bbox', detectionModels);
  return {
    projectId: project.id,
    name: project.name,
    directoryPath: project.directoryPath,
    modality: project.modality,
    annotationType: project.annotationType,
    labels: project.labels,
    annotationTypeLabel: getAnnotationTypeLabel(
      project.modality,
      project.annotationType,
    ),
    detectionModels: eligible.map((m) => ({
      id: m.id,
      name: m.name,
      isDefault: m.isDefault,
    })),
  };
}
