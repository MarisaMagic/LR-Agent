/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import { repairOrphanToolCalls } from './orphanRepair';
import type { ChatMessage } from '../llm/client';

function assistantWithCall(
  id: string,
  name = 'read_workspace_file',
): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    toolCalls: [{ id, name, args: { relative_path: 'a.md' } }],
  };
}

describe('repairOrphanToolCalls', () => {
  it('已配对的调用不补', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      assistantWithCall('c1'),
      { role: 'tool', content: '结果', toolCallId: 'c1' },
    ];
    const before = messages.length;
    repairOrphanToolCalls(messages);
    expect(messages.length).toBe(before);
  });

  it('孤立调用补一条合成 tool_result', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      assistantWithCall('c1'),
      assistantWithCall('c2'),
      { role: 'tool', content: '结果', toolCallId: 'c1' },
    ];
    repairOrphanToolCalls(messages);
    const repaired = messages.at(-1);
    expect(repaired?.role).toBe('tool');
    expect(repaired?.toolCallId).toBe('c2');
    expect(String(repaired?.content)).toContain('未执行');
  });

  it('孤立调用位于历史中段时，合成结果紧跟其 assistant（而非追加到尾部）', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'u0' },
      assistantWithCall('c1'),
      { role: 'user', content: 'u1' },
    ];
    repairOrphanToolCalls(messages);
    expect(messages).toHaveLength(4);
    expect(messages[1].role).toBe('assistant');
    expect(messages[2].role).toBe('tool');
    expect(messages[2].toolCallId).toBe('c1');
    expect(messages[3].role).toBe('user');
  });

  it('幂等：重复调用不重复补', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      assistantWithCall('c1'),
    ];
    repairOrphanToolCalls(messages);
    const afterFirst = messages.length;
    repairOrphanToolCalls(messages);
    expect(messages.length).toBe(afterFirst);
  });
});
