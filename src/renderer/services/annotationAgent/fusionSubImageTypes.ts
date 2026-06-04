import type { AnnotationBatchChange } from '../../../shared/annotationAgentTypes';
import type { SubImageTimingBreakdown } from './annotationTiming';

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
  autoFinalized?: boolean;
  method?: string;
  mapHint?: string;
  elapsedMs?: number;
  timing?: SubImageTimingBreakdown;
}
