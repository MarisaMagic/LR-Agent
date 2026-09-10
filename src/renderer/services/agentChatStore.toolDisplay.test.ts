import { applyStreamEventToBlocks } from './agentChatStore';
import type { MessageBlock } from '../../shared/agentTypes';
import {
  formatToolCallLabel,
  isExplorationTool,
  summarizeToolArgumentsForDisplay,
  summarizeToolResultForDisplay,
} from './toolDisplayUtils';

describe('isExplorationTool', () => {
  it('recognizes exploration tools', () => {
    expect(isExplorationTool('grep_workspace')).toBe(true);
    expect(isExplorationTool('read_workspace_file')).toBe(true);
    expect(isExplorationTool('write_workspace_file')).toBe(false);
    expect(isExplorationTool('delete_workspace_file')).toBe(false);
    expect(isExplorationTool('mutate_annotation')).toBe(false);
  });
});

describe('formatToolCallLabel', () => {
  it('formats read with line range', () => {
    const label = formatToolCallLabel(
      'read_workspace_file',
      JSON.stringify({
        relative_path: 'src/Foo.tsx',
        start_line: 1,
        end_line: 80,
      }),
    );
    expect(label).toBe('Read src/Foo.tsx L1-80');
  });

  it('formats grep', () => {
    const label = formatToolCallLabel(
      'grep_workspace',
      JSON.stringify({ pattern: 'AgentMode', path: 'src' }),
    );
    expect(label).toBe('Grepped AgentMode in src');
  });

  it('formats list directory', () => {
    const label = formatToolCallLabel(
      'list_workspace_directory',
      JSON.stringify({ relative_dir: 'src' }),
    );
    expect(label).toBe('Listed src');
  });
});

describe('summarizeToolResultForDisplay', () => {
  it('truncates long grep results', () => {
    const long = `${'line\n'.repeat(500)}tail`;
    const display = summarizeToolResultForDisplay('grep_workspace', long);
    expect(display.length).toBeLessThan(long.length);
    expect(display).toContain('字符');
  });
});

describe('summarizeToolArgumentsForDisplay', () => {
  it('replaces write_workspace_file content with size summary', () => {
    const raw = JSON.stringify({
      relative_path: 'algo/dijkstra.cpp',
      content: 'line1\nline2\nline3',
    });
    const display = summarizeToolArgumentsForDisplay(
      'write_workspace_file',
      raw,
    );
    expect(display).toContain('algo/dijkstra.cpp');
    expect(display).toContain('字符');
    expect(display).not.toContain('line1');
  });
});

describe('applyStreamEventToBlocks tool_start', () => {
  it('stores summarized arguments and defaults collapsed to true', () => {
    const args = JSON.stringify({
      relative_path: 'a.cpp',
      content: 'int x = 1;',
    });
    const blocks = applyStreamEventToBlocks([], {
      type: 'tool_start',
      toolCallId: 'id-1',
      name: 'write_workspace_file',
      arguments: args,
    });
    expect(blocks).toHaveLength(1);
    const tool = blocks[0];
    if (tool.type !== 'tool_call') throw new Error('expected tool_call');
    expect(tool.collapsed).toBe(true);
    expect(tool.arguments).not.toContain('int x = 1');
    expect(tool.arguments).toContain('a.cpp');
  });
});

describe('applyStreamEventToBlocks annotation tool_result', () => {
  const runningPipeline: MessageBlock = {
    type: 'annotation_pipeline',
    collapsed: false,
    pipelineKind: 'batch',
    steps: [
      { stage: 'collect', label: '收集', message: '', status: 'done' },
      { stage: 'workers', label: '处理', message: '', status: 'running' },
    ],
  };

  function seedBlocks(): MessageBlock[] {
    return [
      runningPipeline,
      {
        type: 'tool_call',
        id: 't-1',
        name: 'auto_annotate',
        arguments: '{}',
        status: 'running',
        collapsed: true,
      },
    ];
  }

  it('settles running pipeline steps when auto_annotate finishes', () => {
    const blocks = applyStreamEventToBlocks(seedBlocks(), {
      type: 'tool_result',
      toolCallId: 't-1',
      result: '{"status":"completed"}',
    } as unknown as Parameters<typeof applyStreamEventToBlocks>[1]);
    const pipeline = blocks[0];
    if (pipeline.type !== 'annotation_pipeline') throw new Error('pipeline');
    expect(pipeline.steps.every((s) => s.status === 'done')).toBe(true);
  });

  it('marks running steps as error on phase_blocked', () => {
    const blocks = applyStreamEventToBlocks(seedBlocks(), {
      type: 'tool_result',
      toolCallId: 't-1',
      result: '{"status":"phase_blocked","summary":"no"}',
    } as unknown as Parameters<typeof applyStreamEventToBlocks>[1]);
    const pipeline = blocks[0];
    if (pipeline.type !== 'annotation_pipeline') throw new Error('pipeline');
    expect(pipeline.steps[1].status).toBe('error');
  });

  it('settles mutation pipeline when mutate_annotation finishes', () => {
    const blocks: MessageBlock[] = [
      {
        type: 'annotation_pipeline',
        collapsed: false,
        pipelineKind: 'mutation',
        steps: [
          { stage: 'resolve', label: '解析', message: '', status: 'running' },
        ],
      },
      {
        type: 'tool_call',
        id: 't-2',
        name: 'mutate_annotation',
        arguments: '{}',
        status: 'running',
        collapsed: true,
      },
    ];
    const next = applyStreamEventToBlocks(blocks, {
      type: 'tool_result',
      toolCallId: 't-2',
      result: '{"status":"completed"}',
    } as unknown as Parameters<typeof applyStreamEventToBlocks>[1]);
    const pipeline = next[0];
    if (pipeline.type !== 'annotation_pipeline') throw new Error('pipeline');
    expect(pipeline.steps[0].status).toBe('done');
  });
});
