import type { MessageBlock } from '../../types/agent';
import { isFileProposalBlock } from '../../../shared/agentTypes';

/** 与后端 tool_registry_meta 中 PROPOSAL runner 对齐 */
export const PROPOSAL_TOOL_NAMES = new Set([
  'write_workspace_file',
  'str_replace_workspace_file',
  'delete_workspace_file',
]);

/** 会生成 pipeline / proposal 的客户端工具 */
export const CLIENT_PIPELINE_TOOL_NAMES = new Set([
  'auto_annotate',
  'mutate_annotation',
]);

export function findFileProposalBlock(
  blocks: MessageBlock[],
): Extract<MessageBlock, { type: 'file_proposal' }> | undefined {
  return blocks.find(
    (b): b is Extract<MessageBlock, { type: 'file_proposal' }> =>
      isFileProposalBlock(b),
  );
}

function normalizeForCompare(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 工具调用一律展示；提案卡与工具行并存。 */
export function shouldHideToolCallInChat(
  _block: Extract<MessageBlock, { type: 'tool_call' }>,
  _blocks: MessageBlock[],
): boolean {
  return false;
}

/** @deprecated 使用 shouldHideToolCallInChat */
export function shouldHideClientToolCall(
  block: Extract<MessageBlock, { type: 'tool_call' }>,
  blocks: MessageBlock[],
): boolean {
  return shouldHideToolCallInChat(block, blocks);
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
  return shouldSkipRedundantFileText(content, blocks);
}
