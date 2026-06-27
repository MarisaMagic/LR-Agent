import type { ChatMessage, MessageBlock } from '../../types/agent';
import { isFileProposalBlock } from '../../../shared/agentTypes';

const ANALYSIS_TEXT_PREFIX = /^\[数据分析\]/;

/** 与后端 tool_registry_meta 中 PROPOSAL runner 对齐 */
export const PROPOSAL_TOOL_NAMES = new Set(['write_workspace_file']);

/** 会生成 pipeline / proposal 的客户端工具 */
export const CLIENT_PIPELINE_TOOL_NAMES = new Set([
  'analyze_data',
  'execute_batch_annotation',
  'mutate_annotation',
]);

export function findAnalysisPipelineBlock(
  blocks: MessageBlock[],
): Extract<MessageBlock, { type: 'annotation_pipeline' }> | undefined {
  return blocks.find(
    (b): b is Extract<MessageBlock, { type: 'annotation_pipeline' }> =>
      b.type === 'annotation_pipeline' &&
      (b.pipelineKind === 'analysis' || b.steps.some((s) => s.stage === 'execute')),
  );
}

export function findFileProposalBlock(
  blocks: MessageBlock[],
): Extract<MessageBlock, { type: 'file_proposal' }> | undefined {
  return blocks.find(
    (b): b is Extract<MessageBlock, { type: 'file_proposal' }> =>
      isFileProposalBlock(b),
  );
}

export function findAnalysisScriptProposal(
  blocks: MessageBlock[],
): Extract<MessageBlock, { type: 'analysis_script_proposal' }> | undefined {
  return blocks.find((b) => b.type === 'analysis_script_proposal');
}

export function messageHasEmbeddedAnalysisPipeline(message: ChatMessage): boolean {
  return (
    findAnalysisPipelineBlock(message.blocks) != null &&
    findAnalysisScriptProposal(message.blocks) != null
  );
}

function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 提案类 tool_call 在消息流中隐藏（详情由 Keep All 栏承接）。 */
export function shouldHideToolCallInChat(
  block: Extract<MessageBlock, { type: 'tool_call' }>,
  blocks: MessageBlock[],
): boolean {
  if (PROPOSAL_TOOL_NAMES.has(block.name)) {
    return findFileProposalBlock(blocks) != null;
  }

  if (!CLIENT_PIPELINE_TOOL_NAMES.has(block.name)) {
    return false;
  }

  const pipeline = findAnalysisPipelineBlock(blocks);
  if (block.name === 'analyze_data') {
    return pipeline != null || findAnalysisScriptProposal(blocks) != null;
  }

  if (block.name === 'execute_batch_annotation' || block.name === 'mutate_annotation') {
    return (
      blocks.some((b) => b.type === 'annotation_proposal') ||
      blocks.some(
        (b) =>
          b.type === 'annotation_pipeline' &&
          (b.pipelineKind ?? 'batch') === 'batch',
      )
    );
  }

  return false;
}

/** @deprecated 使用 shouldHideToolCallInChat */
export function shouldHideClientToolCall(
  block: Extract<MessageBlock, { type: 'tool_call' }>,
  blocks: MessageBlock[],
): boolean {
  return shouldHideToolCallInChat(block, blocks);
}

export function shouldSkipRedundantAnalysisText(
  content: string,
  blocks: MessageBlock[],
): boolean {
  if (!ANALYSIS_TEXT_PREFIX.test(content.trim())) return false;
  return findAnalysisPipelineBlock(blocks) != null;
}

/** file_proposal 已存在时，跳过与文件正文高度重合的 text 块。 */
export function shouldSkipRedundantFileText(
  content: string,
  blocks: MessageBlock[],
): boolean {
  const fileBlock = findFileProposalBlock(blocks);
  if (!fileBlock?.content) return false;

  const textNorm = normalizeForCompare(content);
  if (textNorm.length < 40) return false;

  const fileNorm = normalizeForCompare(fileBlock.content);
  if (fileNorm.includes(textNorm) || textNorm.includes(fileNorm)) {
    return true;
  }

  const sample = textNorm.slice(0, Math.min(240, textNorm.length));
  if (sample.length >= 80 && fileNorm.includes(sample)) {
    return true;
  }

  return false;
}

export function shouldSkipRedundantProposalText(
  content: string,
  blocks: MessageBlock[],
): boolean {
  return (
    shouldSkipRedundantAnalysisText(content, blocks) ||
    shouldSkipRedundantFileText(content, blocks)
  );
}

export type ProposalSummaryLine = {
  key: string;
  text: string;
  tone?: 'default' | 'error';
};

export function proposalBlockSummaryLine(
  block: MessageBlock,
  blockIndex: number,
): ProposalSummaryLine | null {
  if (block.type === 'annotation_proposal') {
    if (block.status === 'applied') {
      const fileCount = new Set(
        block.proposal.changes.map((c) => c.relativePath),
      ).size;
      return {
        key: `annotation-applied-${blockIndex}`,
        text: `已应用标注变更（${fileCount} 个文件）`,
      };
    }
    return null;
  }

  if (isFileProposalBlock(block)) {
    if (block.status === 'applied') {
      return {
        key: `file-applied-${blockIndex}`,
        text: `已写入 ${block.suggestedRelativePath}`,
      };
    }
    return null;
  }

  if (block.type === 'analysis_script_proposal') {
    if (block.status === 'done') {
      return {
        key: `analysis-done-${blockIndex}`,
        text: '分析脚本已执行',
      };
    }
    if (block.status === 'error') {
      return {
        key: `analysis-error-${blockIndex}`,
        text: block.error ? `分析失败：${block.error}` : '分析失败',
        tone: 'error',
      };
    }
    return null;
  }

  return null;
}

/** file / annotation 由专用内联组件展示；analysis 非 pending 时仍用一行摘要。 */
export function shouldRenderProposalSummaryOnly(block: MessageBlock): boolean {
  if (block.type === 'annotation_proposal' || isFileProposalBlock(block)) {
    return false;
  }
  if (block.type === 'analysis_script_proposal') {
    return block.status !== 'pending';
  }
  return false;
}
