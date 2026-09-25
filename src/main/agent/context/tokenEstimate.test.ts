/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import { estimateMessagesTokens } from './tokenEstimate';
import type { ChatMessage } from '../llm/client';

describe('estimateMessagesTokens', () => {
  it('按 chars/3 粗略估算，并计入 toolCalls', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'abcdef' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read_workspace_file', args: { a: 1 } }],
      },
    ];
    // 6 chars + 名称/参数 chars，再 /3 上取整
    expect(estimateMessagesTokens(messages)).toBeGreaterThanOrEqual(2);
  });

  it('多模态文本部件计入，图片按等效字符估算', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'abc' },
          { type: 'image_url', image_url: { url: 'data:...' } },
        ],
      },
    ];
    expect(estimateMessagesTokens(messages)).toBeGreaterThan(1000);
  });

  it('空消息为 0', () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });
});
