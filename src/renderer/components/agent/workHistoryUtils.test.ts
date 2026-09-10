import { describe, expect, it } from '@jest/globals';
import type { MessageBlock } from '../../../shared/agentTypes';
import type { AnnotationBatchProposal } from '../../../shared/annotationAgentTypes';
import {
  collectThoughtContent,
  formatThoughtLabel,
  formatWorkedDuration,
  splitWorkHistory,
  workHistoryDurationMs,
} from './workHistoryUtils';

function textBlock(content: string): MessageBlock {
  return { type: 'text', content };
}

function reasoningBlock(content: string): MessageBlock {
  return { type: 'reasoning', content, collapsed: false };
}

function toolCallBlock(name: string, id = `tool-${name}`): MessageBlock {
  return {
    type: 'tool_call',
    id,
    name,
    arguments: '{}',
    status: 'done',
    collapsed: true,
  };
}

function pipelineBlock(): MessageBlock {
  return {
    type: 'annotation_pipeline',
    collapsed: true,
    steps: [
      { stage: 'prepare', label: 'prepare', message: 'ok', status: 'done' },
    ],
    pipelineKind: 'batch',
  };
}

function proposalBlock(): MessageBlock {
  return {
    type: 'annotation_proposal',
    proposal: {
      id: 'p1',
      projectId: 'proj-1',
      summary: '批量标注',
      changes: [],
      stats: {
        kind: 'generic',
        processed: 1,
        succeeded: 1,
        skipped: 0,
      },
      createdAt: 1,
    } as AnnotationBatchProposal,
    status: 'pending',
  };
}

function fileProposalBlock(): MessageBlock {
  return {
    type: 'file_proposal',
    title: 'doc.md',
    content: '# hi',
    suggestedRelativePath: 'doc.md',
    status: 'pending',
  };
}

describe('splitWorkHistory', () => {
  it('returns no history when there are only answer blocks', () => {
    const blocks = [textBlock('你好')];
    const { history, rest } = splitWorkHistory(blocks);
    expect(history).toHaveLength(0);
    expect(rest.map((item) => item.block.type)).toEqual(['text']);
  });

  it('keeps commentary text inside history and trailing answer outside', () => {
    const blocks = [
      textBlock('先读文件'),
      toolCallBlock('read_workspace_file'),
      textBlock('这是最终回答'),
    ];
    const { history, rest } = splitWorkHistory(blocks);
    expect(history.map((item) => item.block.type)).toEqual([
      'text',
      'tool_call',
    ]);
    expect(rest.map((item) => item.block.type)).toEqual(['text']);
    expect(rest[0]?.block).toEqual(textBlock('这是最终回答'));
  });

  it('keeps pipeline, proposal and write tools on the main timeline', () => {
    const blocks = [
      textBlock('先读目录'),
      toolCallBlock('list_workspace_directory'),
      textBlock('开始标注'),
      toolCallBlock('auto_annotate'),
      textBlock('已完成 3 张图'),
      pipelineBlock(),
      proposalBlock(),
    ];
    const { history, rest } = splitWorkHistory(blocks);
    expect(history.map((item) => item.block.type)).toEqual([
      'text',
      'tool_call',
    ]);
    expect(rest.map((item) => item.block.type)).toEqual([
      'text',
      'tool_call',
      'text',
      'annotation_pipeline',
      'annotation_proposal',
    ]);
  });

  it('extracts reasoning out of work history', () => {
    const blocks = [
      reasoningBlock('想一下'),
      toolCallBlock('list_workspace_directory'),
      pipelineBlock(),
      proposalBlock(),
      textBlock('完成'),
    ];
    const { history, rest } = splitWorkHistory(blocks);
    expect(history.map((item) => item.block.type)).toEqual(['tool_call']);
    expect(rest.map((item) => item.block.type)).toEqual([
      'annotation_pipeline',
      'annotation_proposal',
      'text',
    ]);
    expect(collectThoughtContent(blocks)).toBe('想一下');
  });

  it('keeps write tools and file proposals on the main timeline', () => {
    const blocks = [
      toolCallBlock('write_workspace_file'),
      fileProposalBlock(),
      textBlock('已写好'),
    ];
    const { history, rest } = splitWorkHistory(blocks);
    expect(history).toHaveLength(0);
    expect(rest.map((item) => item.block.type)).toEqual([
      'tool_call',
      'file_proposal',
      'text',
    ]);
  });

  it('keeps delete tools and file proposals on the main timeline', () => {
    const blocks = [
      toolCallBlock('delete_workspace_file'),
      {
        type: 'file_proposal',
        title: '删除 notes.md',
        content: '',
        suggestedRelativePath: 'notes.md',
        status: 'pending',
        operation: 'delete',
      } satisfies MessageBlock,
      textBlock('已删除'),
    ];
    const { history, rest } = splitWorkHistory(blocks);
    expect(history).toHaveLength(0);
    expect(rest.map((item) => item.block.type)).toEqual([
      'tool_call',
      'file_proposal',
      'text',
    ]);
  });
});

describe('formatWorkedDuration', () => {
  it('uses at least one second', () => {
    expect(formatWorkedDuration(120)).toBe('Worked for 1s');
  });

  it('formats seconds under a minute', () => {
    expect(formatWorkedDuration(12_400)).toBe('Worked for 12s');
  });

  it('formats minutes and leftover seconds', () => {
    expect(formatWorkedDuration(72_000)).toBe('Worked for 1m 12s');
  });

  it('omits zero leftover seconds', () => {
    expect(formatWorkedDuration(120_000)).toBe('Worked for 2m');
  });
});

describe('workHistoryDurationMs', () => {
  it('prefers finishedAt over now', () => {
    expect(workHistoryDurationMs(1000, 3500, 9999)).toBe(2500);
  });
});

describe('formatThoughtLabel', () => {
  it('uses Thinking while streaming', () => {
    expect(formatThoughtLabel(12_000, { streaming: true })).toBe('Thinking…');
  });

  it('uses Thought briefly when tools ran', () => {
    expect(formatThoughtLabel(12_000, { hasToolCall: true })).toBe(
      'Thought briefly',
    );
  });

  it('uses Thought briefly under two seconds', () => {
    expect(formatThoughtLabel(800)).toBe('Thought briefly');
  });

  it('uses Thought for when only thinking took longer', () => {
    expect(formatThoughtLabel(8000)).toBe('Thought for 8s');
  });
});

describe('collectThoughtContent', () => {
  it('joins multiple reasoning blocks', () => {
    expect(
      collectThoughtContent([
        reasoningBlock('第一轮'),
        toolCallBlock('grep_workspace'),
        reasoningBlock('第二轮'),
      ]),
    ).toBe('第一轮\n\n第二轮');
  });
});
