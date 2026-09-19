import type { MessageBlock, PipelineKind } from '../../../shared/agentTypes';
import { isFileProposalBlock } from '../../../shared/agentTypes';
import type { AnnotationBatchProposal } from '../../../shared/annotationAgentTypes';

/**
 * 按提案内容推断来源类型。
 *
 * 判定依据：标注编辑（`mutate_annotation`）只产生 `delete` / `patch`；
 * 批量标注（`auto_annotate`）使用 `append` / `replace` / `replace_bboxes`。
 *
 * 该推断同时用于两处：
 *   - 给提案块设置 `sourceKind`（`agentChatStore`）
 *   - 免确认改造中筛选可自动应用的提案（`agentProposalApply`）
 * 因此放在本模块共用，避免两处逻辑漂移。
 */
export function inferAnnotationProposalKind(
  proposal: AnnotationBatchProposal,
): 'batch' | 'mutation' {
  const mutationOps = new Set(['delete', 'patch']);
  if (
    proposal.changes.length > 0 &&
    proposal.changes.every((change) => mutationOps.has(change.operation))
  ) {
    return 'mutation';
  }
  return 'batch';
}

export const PIPELINE_TITLES: Record<
  PipelineKind,
  { active: string; failed: string; idle: string }
> = {
  batch: {
    active: '批量标注进行中…',
    failed: '批量标注未完成',
    idle: '批量标注步骤',
  },
  mutation: {
    active: '标注变更进行中…',
    failed: '标注变更未完成',
    idle: '标注变更步骤',
  },
  report: {
    active: '报告生成进行中…',
    failed: '报告生成未完成',
    idle: '报告生成步骤',
  },
};

/** 根据消息块推断 pipelineKind（兼容历史数据缺字段）。 */
export function inferPipelineKindFromBlocks(
  blocks: MessageBlock[],
): PipelineKind {
  if (blocks.some(isFileProposalBlock)) {
    return 'report';
  }

  const proposal = blocks.find((b) => b.type === 'annotation_proposal');
  if (proposal?.type === 'annotation_proposal') {
    const changes = proposal.proposal.changes ?? [];
    if (
      changes.length > 0 &&
      changes.every((c) => c.operation === 'patch' || c.operation === 'delete')
    ) {
      return 'mutation';
    }
  }

  for (const block of blocks) {
    if (block.type !== 'annotation_pipeline') continue;
    if (block.pipelineKind && block.pipelineKind !== 'batch') {
      return block.pipelineKind;
    }
    const stages = new Set(block.steps.map((s) => s.stage));
    if (stages.has('resolve') && !stages.has('workers')) return 'mutation';
    if (
      stages.has('collect') &&
      !stages.has('workers') &&
      !stages.has('execute')
    ) {
      return 'report';
    }
  }

  return 'batch';
}

export function normalizePipelineKindsInBlocks(
  blocks: MessageBlock[],
): MessageBlock[] {
  const inferred = inferPipelineKindFromBlocks(blocks);
  if (inferred === 'batch') {
    return blocks;
  }
  return blocks.map((block) => {
    if (block.type !== 'annotation_pipeline') return block;
    if (block.pipelineKind && block.pipelineKind !== 'batch') return block;
    return { ...block, pipelineKind: inferred };
  });
}
