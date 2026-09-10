import { isFileProposalBlock } from '../../../shared/agentTypes';
import type { MessageBlock } from '../../types/agent';
import { isExplorationTool } from '../../services/toolDisplayUtils';

export interface IndexedBlock {
  block: MessageBlock;
  index: number;
}

export function isWorkProcessBlock(block: MessageBlock): boolean {
  return block.type === 'tool_call' && isExplorationTool(block.name);
}

export function isDeliverableBlock(block: MessageBlock): boolean {
  return (
    isFileProposalBlock(block) ||
    block.type === 'annotation_proposal' ||
    block.type === 'annotation_pipeline'
  );
}

export function collectThoughtContent(blocks: MessageBlock[]): string {
  return blocks
    .filter(
      (block): block is Extract<MessageBlock, { type: 'reasoning' }> =>
        block.type === 'reasoning' && Boolean(block.content.trim()),
    )
    .map((block) => block.content.trim())
    .join('\n\n');
}

/** 探索工具及其之前的叙述进 Worked for；写文件/标注工具与提案留在主时间线。 */
export function splitWorkHistory(blocks: MessageBlock[]): {
  history: IndexedBlock[];
  rest: IndexedBlock[];
} {
  let lastExplorationIdx = -1;
  for (let i = 0; i < blocks.length; i += 1) {
    if (isWorkProcessBlock(blocks[i])) {
      lastExplorationIdx = i;
    }
  }

  if (lastExplorationIdx < 0) {
    return {
      history: [],
      rest: blocks
        .map((block, index) => ({ block, index }))
        .filter((item) => item.block.type !== 'reasoning'),
    };
  }

  const history: IndexedBlock[] = [];
  const rest: IndexedBlock[] = [];
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (block.type === 'reasoning') {
      continue;
    }
    const inExplorationPrefix = i <= lastExplorationIdx;
    if (
      inExplorationPrefix &&
      (isWorkProcessBlock(block) || block.type === 'text')
    ) {
      history.push({ block, index: i });
      continue;
    }
    rest.push({ block, index: i });
  }
  return { history, rest };
}

function formatClockDuration(durationMs: number): string {
  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) {
    return `${minutes}m`;
  }
  return `${minutes}m ${seconds}s`;
}

export function formatWorkedDuration(durationMs: number): string {
  return `Worked for ${formatClockDuration(durationMs)}`;
}

export function formatThoughtLabel(
  durationMs: number,
  options: { streaming?: boolean; hasToolCall?: boolean } = {},
): string {
  if (options.streaming) {
    return 'Thinking…';
  }
  if (options.hasToolCall || durationMs < 2000) {
    return 'Thought briefly';
  }
  return `Thought for ${formatClockDuration(durationMs)}`;
}

export function workHistoryDurationMs(
  createdAt: number,
  finishedAt: number | undefined,
  now = Date.now(),
): number {
  return Math.max(0, (finishedAt ?? now) - createdAt);
}
