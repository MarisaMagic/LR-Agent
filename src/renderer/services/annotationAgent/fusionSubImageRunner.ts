/**
 * 单图子 Agent 入口：几何流水线（含 bbox）。
 */
import type {
  BatchAnnotationPlan,
  ImageCandidate,
} from '../../../shared/annotationAgentTypes';
import type { FusionSubImageResult } from './fusionSubImageTypes';
import type { PretrainedModelConfig } from '../../types/pretrainedModel';
import { runGeometrySubImageAgent } from './geometrySubImageRunner';
import { getGeometryAdapter } from './geometryPipelineAdapter';

export type { FusionSubImageResult } from './fusionSubImageTypes';

export async function runFusionSubImageAgent(options: {
  providerId: string;
  userRequest: string;
  plan: BatchAnnotationPlan;
  image: ImageCandidate;
  detectionModel: PretrainedModelConfig;
  labelCandidates: Array<{ id: string; name: string }>;
  onProgress?: (event: {
    stage: string;
    message: string;
    status?: 'running' | 'done' | 'error';
    detail?: string;
    imagePath?: string;
  }) => void;
  providerApiKey?: string;
  providerBaseUrl?: string;
  providerModel?: string;
  providerSupportsVision?: boolean;
  signal?: AbortSignal;
}): Promise<FusionSubImageResult> {
  const adapter = getGeometryAdapter('bbox');
  const secondaryModel = adapter?.pickSecondaryModel?.([], {
    keypointTemplateId: undefined,
    labelCount: options.labelCandidates.length,
    labels: options.labelCandidates,
  });

  return runGeometrySubImageAgent({
    annotationType: 'bbox',
    providerId: options.providerId,
    userRequest: options.userRequest,
    plan: options.plan,
    image: options.image,
    primaryModel: options.detectionModel,
    secondaryModel,
    labelCandidates: options.labelCandidates,
    adapterContext: {
      labelCount: options.labelCandidates.length,
      labels: options.labelCandidates,
    },
    onProgress: options.onProgress,
    providerApiKey: options.providerApiKey,
    providerBaseUrl: options.providerBaseUrl,
    providerModel: options.providerModel,
    providerSupportsVision: options.providerSupportsVision,
    signal: options.signal,
  });
}
