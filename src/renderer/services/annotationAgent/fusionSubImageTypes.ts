import type {
  AnnotationBatchChange,
  AnnotationJudgeSummary,
} from '../../../shared/annotationAgentTypes';
import type { SubImageTimingBreakdown } from './annotationTiming';
import type { MapMappingRow } from './annotationAgentDebug';

export interface FusionSubImageResult {
  ok: boolean;
  relativePath: string;
  absolutePath: string;
  change?: AnnotationBatchChange;
  reason?: string;
  rawCount?: number;
  keptCount?: number;
  mappedCount?: number;
  unmappedCount?: number;
  unlabeledInProposal?: number;
  /** 标签候选池来源：full / scope / preflight */
  labelPoolSource?: string;
  /** 实际参与映射的候选标签数 */
  labelPoolEffective?: number;
  /** 留空原因分桶：模型判定无匹配 */
  unmappedNoMatch?: number;
  /** 留空原因分桶：视觉调用失败/裁剪不可用 */
  unmappedFailed?: number;
  autoFinalized?: boolean;
  method?: string;
  mapHint?: string;
  mapMappings?: MapMappingRow[];
  judge?: AnnotationJudgeSummary;
  judgeAttempts?: number;
  judgeRetryRounds?: number;
  weakAccepted?: boolean;
  rejectedByJudge?: boolean;
  elapsedMs?: number;
  timing?: SubImageTimingBreakdown;
}
