import { describe, expect, it } from '@jest/globals';
import {
  applyStreamEventToBlocks,
  normalizeAnnotationCardOrder,
  normalizeHistoricalAssistantMessage,
} from './agentChatStore';
import type { MessageBlock } from '../../shared/agentTypes';
import type { AnnotationBatchProposal } from '../../shared/annotationAgentTypes';

function textBlock(content: string): MessageBlock {
  return { type: 'text', content };
}

function reasoningBlock(content: string): MessageBlock {
  return { type: 'reasoning', content, collapsed: false };
}

function toolCallBlock(name: string): MessageBlock {
  return {
    type: 'tool_call',
    id: `tool-${name}`,
    name,
    arguments: '{}',
    status: 'done',
    result: 'done',
    collapsed: true,
  };
}

function pipelineBlock(
  overrides: Partial<
    Extract<MessageBlock, { type: 'annotation_pipeline' }>
  > = {},
): MessageBlock {
  return {
    type: 'annotation_pipeline',
    collapsed: true,
    steps: [
      { stage: 'prepare', label: 'prepare', message: 'ok', status: 'done' },
    ],
    pipelineKind: 'batch',
    ...overrides,
  };
}

function proposalBlock(): Extract<
  MessageBlock,
  { type: 'annotation_proposal' }
> {
  const proposal = {
    id: 'p1',
    projectId: 'proj-1',
    summary: '批量标注',
    changes: [
      {
        relativePath: '测试文本.txt',
        absolutePath: 'C:/proj/测试文本.txt',
        operation: 'append' as const,
        annotations: [],
      },
    ],
    stats: {
      kind: 'generic' as const,
      processed: 1,
      succeeded: 1,
      skipped: 0,
    },
    createdAt: Date.now(),
  } as AnnotationBatchProposal;
  return { type: 'annotation_proposal', proposal, status: 'pending' };
}

describe('applyStreamEventToBlocks annotation card ordering', () => {
  it('places late text_delta before an existing annotation_proposal', () => {
    let blocks: MessageBlock[] = [proposalBlock()];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'text_delta',
      content: '让我先查看项目结构。',
    });
    expect(blocks.map((b) => b.type)).toEqual(['text', 'annotation_proposal']);
    const text = blocks[0];
    if (text.type !== 'text') throw new Error('expected text');
    expect(text.content).toContain('让我先查看');
  });

  it('merges consecutive late text_delta into one text block before the card', () => {
    let blocks: MessageBlock[] = [pipelineBlock(), proposalBlock()];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'text_delta',
      content: '第一句。',
    });
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'text_delta',
      content: '第二句。',
    });
    expect(blocks.map((b) => b.type)).toEqual([
      'text',
      'annotation_pipeline',
      'annotation_proposal',
    ]);
    const text = blocks[0];
    if (text.type !== 'text') throw new Error('expected text');
    expect(text.content).toBe('第一句。第二句。');
  });

  it('inserts new tool_call before the card, and tool_result updates in place', () => {
    let blocks: MessageBlock[] = [pipelineBlock(), proposalBlock()];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'tool_start',
      toolCallId: 't-1',
      name: 'list_workspace_directory',
      arguments: '{}',
    });
    expect(blocks.map((b) => b.type)).toEqual([
      'tool_call',
      'annotation_pipeline',
      'annotation_proposal',
    ]);
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'tool_result',
      toolCallId: 't-1',
      result: 'Explored 1 file',
    });
    expect(blocks.map((b) => b.type)).toEqual([
      'tool_call',
      'annotation_pipeline',
      'annotation_proposal',
    ]);
    const tool = blocks[0];
    if (tool.type !== 'tool_call') throw new Error('expected tool_call');
    expect(tool.result).toContain('Explored');
  });

  it('inserts new reasoning block before the card', () => {
    let blocks: MessageBlock[] = [pipelineBlock(), proposalBlock()];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'reasoning_delta',
      content: '已思考',
    });
    expect(blocks.map((b) => b.type)).toEqual([
      'reasoning',
      'annotation_pipeline',
      'annotation_proposal',
    ]);
  });

  it('places annotation_proposal right after the batch pipeline', () => {
    let blocks: MessageBlock[] = [textBlock('开头叙述'), pipelineBlock()];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'annotation_proposal',
      proposal: proposalBlock().proposal,
    });
    expect(blocks.map((b) => b.type)).toEqual([
      'text',
      'annotation_pipeline',
      'annotation_proposal',
    ]);
  });

  it('appends annotation_proposal to end when no pipeline exists', () => {
    let blocks: MessageBlock[] = [textBlock('开头叙述')];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'annotation_proposal',
      proposal: proposalBlock().proposal,
    });
    expect(blocks.map((b) => b.type)).toEqual(['text', 'annotation_proposal']);
  });

  it('keeps original behavior (append) when no card exists', () => {
    let blocks: MessageBlock[] = [reasoningBlock('思考')];
    blocks = applyStreamEventToBlocks(blocks, {
      type: 'text_delta',
      content: '纯文本回答',
    });
    expect(blocks.map((b) => b.type)).toEqual(['reasoning', 'text']);
  });
});

describe('normalizeAnnotationCardOrder', () => {
  it('moves card blocks to the tail while preserving group structure', () => {
    const blocks: MessageBlock[] = [
      toolCallBlock('list_workspace_directory'),
      pipelineBlock(),
      proposalBlock(),
      textBlock('让我先查看…'),
      toolCallBlock('read_workspace_file'),
      textBlock('文件已读取。'),
    ];
    const out = normalizeAnnotationCardOrder(blocks);
    expect(out.map((b) => b.type)).toEqual([
      'tool_call',
      'text',
      'tool_call',
      'text',
      'annotation_pipeline',
      'annotation_proposal',
    ]);
  });

  it('returns input unchanged when no card exists', () => {
    const blocks: MessageBlock[] = [textBlock('a'), textBlock('b')];
    expect(normalizeAnnotationCardOrder(blocks)).toEqual(blocks);
  });
});

describe('normalizeHistoricalAssistantMessage', () => {
  it('reorders a persisted assistant message with card after narrative', () => {
    const message = {
      id: 'm1',
      sessionId: 's1',
      role: 'assistant' as const,
      status: 'done' as const,
      providerId: 'provider-1',
      model: 'model-1',
      createdAt: 1,
      updatedAt: 2,
      blocks: [
        pipelineBlock(),
        proposalBlock(),
        textBlock('让我先查看项目结构。'),
      ],
    };
    const out = normalizeHistoricalAssistantMessage(message);
    expect(out.blocks.map((b) => b.type)).toEqual([
      'text',
      'annotation_pipeline',
      'annotation_proposal',
    ]);
  });
});
