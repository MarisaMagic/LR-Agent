/**
 * @jest-environment jsdom
 */
import { describe, expect, it } from '@jest/globals';
import {
  applySoftLineBudget,
  estimatePayloadTokens,
  microCompactPayload,
} from './payloadCompaction';

type TestMessage = {
  role: string;
  content: string;
  tool_calls?: Array<{
    id: string;
    name: string;
    args: Record<string, unknown>;
  }>;
  tool_call_id?: string;
};

function history(): TestMessage[] {
  return [
    { role: 'user', content: '读文件' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'c1',
          name: 'read_workspace_file',
          args: { relative_path: 'a' },
        },
      ],
    },
    { role: 'tool', content: 'A'.repeat(900), tool_call_id: 'c1' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'c2',
          name: 'read_document_file',
          args: { relative_path: 'b.pdf' },
        },
      ],
    },
    { role: 'tool', content: 'B'.repeat(900), tool_call_id: 'c2' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'c3', name: 'auto_annotate', args: {} }],
    },
    { role: 'tool', content: 'C'.repeat(900), tool_call_id: 'c3' },
  ];
}

/** 7 条工具结果：前 3 条可重取、后 4 条不可重取，用于软线（默认保留 5 条）用例。 */
function longHistory(): TestMessage[] {
  const messages: TestMessage[] = [{ role: 'user', content: '读文件' }];
  const tools: Array<[string, string]> = [
    ['c1', 'read_workspace_file'],
    ['c2', 'read_document_file'],
    ['c3', 'grep_workspace'],
    ['c4', 'auto_annotate'],
    ['c5', 'auto_annotate'],
    ['c6', 'read_workspace_file'],
    ['c7', 'mutate_annotation'],
  ];
  tools.forEach(([id, name], i) => {
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id, name, args: {} }],
    });
    messages.push({
      role: 'tool',
      content: String.fromCharCode(65 + i).repeat(300),
      tool_call_id: id,
    });
  });
  return messages;
}

describe('estimatePayloadTokens', () => {
  it('计入工具结果与调用参数', () => {
    const messages = history();
    const estimate = estimatePayloadTokens(messages);
    // 约 (3 + 900*3 + 调用参数与工具名) / 3
    expect(estimate).toBeGreaterThan(900);
    expect(estimate).toBeLessThan(1100);
  });
});

describe('microCompactPayload', () => {
  it('只清理较旧的可重取结果，保留最近一条与不可重取结果', () => {
    const messages = history();
    const out = microCompactPayload(messages, { keepRecent: 1 });
    expect(out.replaced).toBe(2);
    expect(out.messages[2].content).toContain('已清理');
    expect(out.messages[4].content).toContain('已清理');
    expect(out.messages[6].content).toBe('C'.repeat(900));
    // 调用配对与参数保持不动
    expect(out.messages[1].tool_calls?.[0].id).toBe('c1');
  });

  it('幂等：已是占位符时不重复替换', () => {
    const once = microCompactPayload(history(), { keepRecent: 1 });
    const twice = microCompactPayload(once.messages, { keepRecent: 1 });
    expect(twice.replaced).toBe(0);
  });

  it('keepRecent 大于结果数时不清理', () => {
    const messages = history();
    const out = microCompactPayload(messages);
    expect(out.replaced).toBe(0);
    expect(out.messages).toBe(messages);
  });
});

describe('applySoftLineBudget', () => {
  it('低于软线时原引用返回', () => {
    const messages = history();
    expect(applySoftLineBudget(messages, 100_000)).toBe(messages);
  });

  it('超过软线时清理旧结果（保留最近 5 条）', () => {
    const messages = longHistory();
    const out = applySoftLineBudget(messages, 300);
    expect(out).not.toBe(messages);
    expect(out[2].content).toContain('已清理');
    expect(out[4].content).toContain('已清理');
    // 第 3 条已落入「最近 5 条」保留区
    expect(out[6].content).toBe('C'.repeat(300));
    expect(out[14].content).toBe('G'.repeat(300));
  });

  it('无预算（0/undefined）时原样返回', () => {
    const messages = history();
    expect(applySoftLineBudget(messages, undefined)).toBe(messages);
    expect(applySoftLineBudget(messages, 0)).toBe(messages);
  });
});
