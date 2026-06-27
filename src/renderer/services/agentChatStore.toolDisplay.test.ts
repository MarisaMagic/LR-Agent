import { applyStreamEventToBlocks } from './agentChatStore';
import { summarizeToolArgumentsForDisplay } from './toolDisplayUtils';

describe('summarizeToolArgumentsForDisplay', () => {
  it('replaces write_workspace_file content with size summary', () => {
    const raw = JSON.stringify({
      relative_path: 'algo/dijkstra.cpp',
      content: 'line1\nline2\nline3',
    });
    const display = summarizeToolArgumentsForDisplay('write_workspace_file', raw);
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
