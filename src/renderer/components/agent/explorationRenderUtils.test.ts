import type { MessageBlock } from '../../shared/agentTypes';
import { buildAssistantRenderSegments } from './explorationRenderUtils';

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown> = {},
): MessageBlock {
  return {
    type: 'tool_call',
    id,
    name,
    arguments: JSON.stringify(args),
    status: 'done',
    collapsed: true,
  };
}

describe('buildAssistantRenderSegments', () => {
  it('merges consecutive exploration tool calls into one segment', () => {
    const blocks: MessageBlock[] = [
      toolCall('t1', 'grep_workspace', { pattern: 'Foo', path: 'src' }),
      toolCall('t2', 'read_workspace_file', {
        relative_path: 'main.py',
        start_line: 1,
        end_line: 20,
      }),
      { type: 'text', content: 'answer' },
    ];

    const segments = buildAssistantRenderSegments(blocks);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({
      kind: 'exploration',
      summary: 'Explored 1 file, 1 search',
    });
    if (segments[0].kind === 'exploration') {
      expect(segments[0].tools).toHaveLength(2);
    }
    expect(segments[1]).toMatchObject({ kind: 'block' });
  });

  it('does not merge exploration tools separated by other blocks', () => {
    const blocks: MessageBlock[] = [
      toolCall('t1', 'grep_workspace', { pattern: 'A' }),
      { type: 'text', content: 'mid' },
      toolCall('t2', 'read_workspace_file', { relative_path: 'b.ts' }),
    ];

    const segments = buildAssistantRenderSegments(blocks);
    expect(segments).toHaveLength(3);
    expect(segments[0].kind).toBe('exploration');
    expect(segments[1].kind).toBe('block');
    expect(segments[2].kind).toBe('exploration');
  });

  it('does not merge non-exploration tool calls', () => {
    const blocks: MessageBlock[] = [
      toolCall('t1', 'describe_client_context'),
      toolCall('t2', 'grep_workspace', { pattern: 'X' }),
    ];

    const segments = buildAssistantRenderSegments(blocks);
    expect(segments).toHaveLength(2);
    expect(segments[0].kind).toBe('block');
    expect(segments[1].kind).toBe('exploration');
  });
});
