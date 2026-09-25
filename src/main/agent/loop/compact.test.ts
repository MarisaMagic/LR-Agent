/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import { reactiveCompact } from './compact';
import { DEFAULT_AGENT_SETTINGS } from '../config';
import type { ChatMessage, LlmClient } from '../llm/client';

function stubLlm(summary = '结构化摘要'): LlmClient {
  return {
    completeChat: async () => ({
      content: summary,
      reasoning: '',
      toolCalls: [],
    }),
  } as unknown as LlmClient;
}

describe('reactiveCompact', () => {
  it('保留 system 块并把旧对话摘进 system，切分点落在 user 边界', async () => {
    const conversation: ChatMessage[] = Array.from({ length: 6 }, (_, i) => ({
      role: 'user' as const,
      content: `消息${i}`,
    }));
    const messages: ChatMessage[] = [
      { role: 'system', content: 'SYS' },
      ...conversation,
    ];

    const out = await reactiveCompact({
      messages,
      llm: stubLlm('历史要点'),
      settings: { ...DEFAULT_AGENT_SETTINGS, reactiveCompactKeepTurns: 2 },
    });

    expect(out[0].role).toBe('system');
    expect(String(out[0].content)).toContain('SYS');
    expect(String(out[0].content)).toContain('历史要点');
    // keepTurns=2 → 保留 4 条对话，均以 user 开头
    expect(out.length).toBe(1 + 4);
    expect(out[1].role).toBe('user');
  });

  it('朴素切点落在轮内时向后找 user 边界，不因首个 user 而放弃压缩', async () => {
    // 朴素 cut=1 落在 assistant 上；向后应找到 index 7 的 user
    const conversation: ChatMessage[] = [
      { role: 'user', content: 'u0' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read_workspace_file', args: {} }],
      },
      { role: 'tool', content: 'A', toolCallId: 'c1' },
      { role: 'tool', content: 'B', toolCallId: 'c1' },
      { role: 'tool', content: 'C', toolCallId: 'c1' },
      { role: 'tool', content: 'D', toolCallId: 'c1' },
      { role: 'tool', content: 'E', toolCallId: 'c1' },
      { role: 'user', content: 'u7' },
      { role: 'assistant', content: 'a8' },
    ];

    const out = await reactiveCompact({
      messages: conversation,
      llm: stubLlm('摘要X'),
      settings: { ...DEFAULT_AGENT_SETTINGS, reactiveCompactKeepTurns: 4 },
    });

    // 保留 [u7, a8] + 前插的一条 system 摘要
    expect(out).toHaveLength(3);
    expect(out[0].role).toBe('system');
    expect(out[1]).toMatchObject({ role: 'user', content: 'u7' });
    expect(out[2]).toMatchObject({ role: 'assistant', content: 'a8' });
  });

  it('没有可挤出的完整轮次时原样返回', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: '只有一条' }];
    const out = await reactiveCompact({
      messages,
      llm: stubLlm(),
      settings: DEFAULT_AGENT_SETTINGS,
    });
    expect(out).toBe(messages);
  });
});
