/**
 * 单图子 Agent 入口：确定性快路径 detect → map → finalize。
 */
import { runDeterministicSubImageAgent } from './deterministicSubImageRunner';
import type { BatchAnnotationPlan, ImageCandidate } from '../../../shared/annotationAgentTypes';
import type { FusionSubImageResult } from './fusionSubImageTypes';
import type { PretrainedModelConfig } from '../../types/pretrainedModel';

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
}): Promise<FusionSubImageResult> {
  return runDeterministicSubImageAgent(options);
}
