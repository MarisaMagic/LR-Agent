import type {
  AnnotationExportOptions,
  AnnotationExportRequest,
  AnnotationExportResult,
} from '../../shared/annotationExportTypes';
import type { AnnotationProject } from '../types/annotation';
import { KEYPOINT_TEMPLATES } from '../types/keypointTemplate';

export async function exportAnnotationProject(
  project: AnnotationProject,
  options: AnnotationExportOptions,
): Promise<AnnotationExportResult> {
  const request: AnnotationExportRequest = {
    project: {
      id: project.id,
      name: project.name,
      directoryPath: project.directoryPath,
      modality: project.modality,
      annotationType: project.annotationType,
      labels: project.labels,
    },
    options,
    ...(project.annotationType === 'keypoint' && {
      keypointTemplates: KEYPOINT_TEMPLATES.map((t) => ({
        id: t.id,
        name: t.name,
        keypoints: t.keypoints.map((k) => ({ name: k.name })),
      })),
    }),
  };

  return window.electron.annotation.exportAnnotations(request);
}
