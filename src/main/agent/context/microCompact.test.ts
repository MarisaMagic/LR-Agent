/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import {
  microCompactMessages,
  MICRO_COMPACT_PLACEHOLDER,
} from './microCompact';
import type { ChatMessage } from '../llm/client';

function history(): ChatMessage[] {
  return [
    { role: 'user', content: '读文件' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'c1', name: 'read_workspace_file', args: { relative_path: 'a' } },
      ],
    },
    { role: 'tool', content: 'A'.repeat(1000), toolCallId: 'c1' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'c2', name: 'auto_annotate', args: { user_request: 'x' } },
      ],
    },
    { role: 'tool', content: 'B'.repeat(1000), toolCallId: 'c2' },
  ];
}

describe('microCompactMessages', () => {
  it('只清理较旧的可重取结果，保留最近 N 条', () => {
    const messages = history();
    const replaced = microCompactMessages(messages, { keepRecent: 1 });
    // toolIndexes=[2,4]，keepRecent=1 → 只清理索引 2（读文件）
    expect(replaced).toBe(1);
    expect(messages[2].content).toBe(MICRO_COMPACT_PLACEHOLDER);
    // 最近的 auto_annotate 结果与调用配对保持不动
    expect(messages[4].content).toBe('B'.repeat(1000));
    expect(messages[1].toolCalls?.[0].id).toBe('c1');
  });

  it('不可重取的工具结果不被清理', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'auto_annotate', args: {} }],
      },
      { role: 'tool', content: 'C'.repeat(1000), toolCallId: 'c1' },
    ];
    expect(microCompactMessages(messages, { keepRecent: 0 })).toBe(0);
    expect(messages[1].content).toBe('C'.repeat(1000));
  });

  it('幂等：已是占位符则不重复替换计数', () => {
    const messages = history();
    microCompactMessages(messages, { keepRecent: 1 });
    expect(microCompactMessages(messages, { keepRecent: 1 })).toBe(0);
  });

  it('keepRecent 大于结果数时不清理', () => {
    const messages = history();
    expect(microCompactMessages(messages, { keepRecent: 5 })).toBe(0);
  });
});
