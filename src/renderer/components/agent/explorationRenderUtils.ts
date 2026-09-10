import type { MessageBlock } from '../../types/agent';
import {
  buildExplorationSummary,
  isExplorationTool,
} from '../../services/toolDisplayUtils';

export type ToolCallBlock = Extract<MessageBlock, { type: 'tool_call' }>;

export type AssistantRenderSegment =
  | {
      kind: 'exploration';
      key: string;
      tools: ToolCallBlock[];
      summary: string;
    }
  | {
      kind: 'block';
      block: MessageBlock;
      index: number;
    };

function isVisibleExplorationTool(block: MessageBlock): block is ToolCallBlock {
  return (
    block.type === 'tool_call' &&
    block.name !== 'explore_readonly' &&
    isExplorationTool(block.name)
  );
}

export function buildAssistantRenderSegments(
  blocks: MessageBlock[],
  indexOrder?: number[],
): AssistantRenderSegment[] {
  const order = indexOrder ?? blocks.map((_, index) => index);
  const segments: AssistantRenderSegment[] = [];
  let cursor = 0;

  while (cursor < order.length) {
    const index = order[cursor];
    const block = blocks[index];
    if (!block) {
      cursor += 1;
      continue;
    }

    if (isVisibleExplorationTool(block)) {
      const group: ToolCallBlock[] = [];
      while (cursor < order.length) {
        const currentIndex = order[cursor];
        const current = blocks[currentIndex];
        if (!current || !isVisibleExplorationTool(current)) {
          break;
        }
        group.push(current);
        cursor += 1;
      }
      segments.push({
        kind: 'exploration',
        key: `exploration-${group[0]?.id ?? index}`,
        tools: group,
        summary: buildExplorationSummary(group),
      });
      continue;
    }

    segments.push({ kind: 'block', block, index });
    cursor += 1;
  }

  return segments;
}
