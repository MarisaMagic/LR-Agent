import type { MessageBlock } from '../../types/agent';
import { shouldHideToolCallInChat } from './agentAssistantRenderUtils';
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

function isVisibleExplorationTool(
  block: MessageBlock,
  blocks: MessageBlock[],
): block is ToolCallBlock {
  return (
    block.type === 'tool_call' &&
    isExplorationTool(block.name) &&
    !shouldHideToolCallInChat(block, blocks)
  );
}

export function buildAssistantRenderSegments(
  blocks: MessageBlock[],
): AssistantRenderSegment[] {
  const segments: AssistantRenderSegment[] = [];
  let index = 0;

  while (index < blocks.length) {
    const block = blocks[index];

    if (isVisibleExplorationTool(block, blocks)) {
      const group: ToolCallBlock[] = [];
      while (index < blocks.length) {
        const current = blocks[index];
        if (!isVisibleExplorationTool(current, blocks)) {
          break;
        }
        group.push(current);
        index += 1;
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
    index += 1;
  }

  return segments;
}
