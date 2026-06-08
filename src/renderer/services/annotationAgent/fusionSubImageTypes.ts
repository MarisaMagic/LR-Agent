import type { AnnotationBatchChange } from '../../../shared/annotationAgentTypes';
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
  autoFinalized?: boolean;
  method?: string;
  mapHint?: string;
  mapMappings?: MapMappingRow[];
  elapsedMs?: number;
  timing?: SubImageTimingBreakdown;
}
