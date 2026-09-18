import { describe, expect, it } from '@jest/globals';
import {
  DONE_FRAME,
  encodeSseFrame,
  toSseDict,
  type StreamEventPayload,
} from './sse';

/**
 * 契约测试。
 *
 * 这些断言直接对应 `vendor/local-agent/app/schemas/agent.py` 的 `to_sse_dict`
 * 与 `docs/agent-protocol.md` §2。任何一条失败都意味着渲染层会静默降级。
 */
describe('SSE 契约：字段序列化', () => {
  describe('规则 1：仅当值非 null/undefined 时输出', () => {
    it('未设值的字段不出现在输出中', () => {
      const out = toSseDict({ type: 'text_delta' });
      expect(out).toEqual({ type: 'text_delta' });
    });

    it('空字符串需要输出（与 null 区别对待）', () => {
      const out = toSseDict({ type: 'tool_result', result: '' });
      expect(out).toEqual({ type: 'tool_result', result: '' });
    });

    it('null 与 undefined 都不输出', () => {
      const out = toSseDict({
        type: 'text_delta',
        content: 'x',
        status: null,
        stage: undefined,
      });
      expect(out).toEqual({ type: 'text_delta', content: 'x' });
      expect('status' in out).toBe(false);
      expect('stage' in out).toBe(false);
    });

    it('数字 0 需要输出', () => {
      const out = toSseDict({ type: 'context_updated', tokenEstimate: 0 });
      expect(out.tokenEstimate).toBe(0);
    });
  });

  describe('规则 2：imagePath 的改名', () => {
    it.each([
      'file_proposal_start',
      'file_proposal_delta',
      'file_proposal',
      'document_proposal',
    ])('%s 下输出为 suggestedRelativePath', (type) => {
      const out = toSseDict({ type, imagePath: 'a/b.md' });
      expect(out.suggestedRelativePath).toBe('a/b.md');
      expect('imagePath' in out).toBe(false);
    });

    it('其它类型下仍为 imagePath', () => {
      const out = toSseDict({ type: 'tool_start', imagePath: 'a/b.md' });
      expect(out.imagePath).toBe('a/b.md');
      expect('suggestedRelativePath' in out).toBe(false);
    });
  });

  describe('规则 3：mode 恒输出，提案类额外输出 operation', () => {
    it('提案类事件同时输出 mode 与同值 operation', () => {
      const out = toSseDict({ type: 'file_proposal', mode: 'write' });
      expect(out.mode).toBe('write');
      expect(out.operation).toBe('write');
    });

    it('非提案类事件只输出 mode', () => {
      const out = toSseDict({ type: 'text_delta', mode: 'x' });
      expect(out.mode).toBe('x');
      expect('operation' in out).toBe(false);
    });
  });

  describe('规则 4：oldPath 仅在特定类型下输出', () => {
    it.each(['file_proposal_start', 'file_proposal'])(
      '%s 下输出 oldPath',
      (type) => {
        const out = toSseDict({ type, oldPath: 'old.md' });
        expect(out.oldPath).toBe('old.md');
      },
    );

    it('file_proposal_delta 下不输出 oldPath', () => {
      const out = toSseDict({
        type: 'file_proposal_delta',
        oldPath: 'old.md',
        content: 'x',
      });
      expect('oldPath' in out).toBe(false);
    });
  });

  describe('规则 5：派生 title', () => {
    it.each(['file_proposal_start', 'file_proposal', 'document_proposal'])(
      '%s 下 title 取 summary，且 summary 仍保留',
      (type) => {
        const out = toSseDict({ type, summary: '标题', detail: '99' });
        expect(out.title).toBe('标题');
        expect(out.summary).toBe('标题');
        expect(out.detail).toBe('99');
      },
    );

    it('无 summary 时 title 回落到 detail', () => {
      const out = toSseDict({ type: 'file_proposal_start', detail: '42' });
      expect(out.title).toBe('42');
    });

    it('detail 为空字符串时也参与回落（detail 非 null）', () => {
      const out = toSseDict({ type: 'file_proposal_start', detail: '' });
      expect(out.title).toBe('');
    });

    it('两者皆无时不产生 title', () => {
      const out = toSseDict({ type: 'file_proposal_start', imagePath: 'a.md' });
      expect('title' in out).toBe(false);
    });

    it('非提案类事件不派生 title', () => {
      const out = toSseDict({ type: 'text_delta', summary: 'x' });
      expect('title' in out).toBe(false);
    });
  });

  describe('规则 6：clientToolCalls 双写', () => {
    it('同时写出 clientToolCalls 与 toolCalls 且值相同', () => {
      const out = toSseDict({
        type: 'tool_pending',
        clientToolCalls: [
          {
            toolCallId: 'c1',
            name: 'auto_annotate',
            arguments: { paths: ['data/'] },
          },
        ],
      });
      expect(out.clientToolCalls).toEqual(out.toolCalls);
      expect(out.clientToolCalls).toEqual([
        {
          toolCallId: 'c1',
          name: 'auto_annotate',
          arguments: { paths: ['data/'] },
        },
      ]);
    });

    it('arguments 保持为对象（与 tool_start 的字符串不同，这是既成事实）', () => {
      const out = toSseDict({
        type: 'tool_pending',
        clientToolCalls: [{ toolCallId: 'c1', name: 'x', arguments: { a: 1 } }],
      });
      const calls = out.toolCalls as Array<{ arguments: unknown }>;
      expect(typeof calls[0].arguments).toBe('object');
    });

    it('空数组也输出（非 null）', () => {
      const out = toSseDict({ type: 'tool_pending', clientToolCalls: [] });
      expect(out.clientToolCalls).toEqual([]);
      expect(out.toolCalls).toEqual([]);
    });
  });

  describe('field 命名转换', () => {
    it('camelCase 转换覆盖全部下划线字段', () => {
      const out = toSseDict({
        type: 'context_updated',
        summaryUpToMessageId: 'm1',
        tokenEstimate: 5,
        toolCallId: 'tc1',
        focusPath: 'a.md',
        innerToolCallId: 'i1',
        oldDelta: 'o',
        newDelta: 'n',
      });
      expect(out).toMatchObject({
        summaryUpToMessageId: 'm1',
        tokenEstimate: 5,
        toolCallId: 'tc1',
        focusPath: 'a.md',
        innerToolCallId: 'i1',
        oldDelta: 'o',
        newDelta: 'n',
      });
    });

    it('未转换的字段名保持原样', () => {
      const out = toSseDict({
        type: 'subagent_start',
        query: 'q',
        name: 'n',
        status: 's',
      });
      expect(out).toMatchObject({ query: 'q', name: 'n', status: 's' });
    });
  });
});

describe('SSE 契约：帧编码', () => {
  it('编码为 data: 前缀 + 双换行，且无 event: 行', () => {
    const frame = encodeSseFrame({ type: 'text_delta', content: 'hi' });
    expect(frame).toBe('data: {"type":"text_delta","content":"hi"}\n\n');
    expect(frame).not.toContain('event:');
  });

  it('中文不转义（对齐 ensure_ascii=False）', () => {
    const frame = encodeSseFrame({ type: 'text_delta', content: '你好' });
    expect(frame).toContain('你好');
    expect(frame).not.toContain('\\u');
  });

  it('done 帧是裸对象，只有 type 字段', () => {
    expect(DONE_FRAME).toBe('data: {"type": "done"}\n\n');
    const parsed = JSON.parse(DONE_FRAME.slice(5).trim());
    expect(parsed).toEqual({ type: 'done' });
    expect(Object.keys(parsed)).toHaveLength(1);
  });
});

describe('SSE 契约：真实基准样本', () => {
  // 取自 .baseline/python/proposal-write.json，逐字复核序列化结果
  it('file_proposal_start 的完整输出与基准一致', () => {
    const out = toSseDict({
      type: 'file_proposal_start',
      summary: 'reports/summary.md',
      imagePath: 'reports/summary.md',
      detail: '0',
      mode: null,
    } as StreamEventPayload);
    // 归一化会排序键，这里比对集合而非顺序
    expect(out).toEqual({
      type: 'file_proposal_start',
      summary: 'reports/summary.md',
      suggestedRelativePath: 'reports/summary.md',
      title: 'reports/summary.md',
      detail: '0',
    });
    expect('mode' in out).toBe(false);
    expect('operation' in out).toBe(false);
  });

  it('file_proposal_delta 带 mode 时输出 operation', () => {
    const out = toSseDict({
      type: 'file_proposal_delta',
      content: '# 汇总报告\\',
      imagePath: 'reports/summary.md',
      mode: 'write',
    });
    expect(out).toEqual({
      type: 'file_proposal_delta',
      content: '# 汇总报告\\',
      suggestedRelativePath: 'reports/summary.md',
      mode: 'write',
      operation: 'write',
    });
  });

  it('file_proposal 的定稿输出与基准一致', () => {
    const out = toSseDict({
      type: 'file_proposal',
      summary: 'Summary',
      content: 'body',
      imagePath: 'reports/summary.md',
      mode: 'write',
      oldPath: null,
      status: null,
    });
    expect(out).toEqual({
      type: 'file_proposal',
      summary: 'Summary',
      title: 'Summary',
      content: 'body',
      suggestedRelativePath: 'reports/summary.md',
      mode: 'write',
      operation: 'write',
    });
  });

  it('tool_start 的 arguments 是 pretty JSON 字符串', () => {
    const args = { relative_path: 'reports/summary.md', content: '# x' };
    const out = toSseDict({
      type: 'tool_start',
      toolCallId: 'tc1',
      name: 'write_workspace_file',
      arguments: JSON.stringify(args, null, 2),
    });
    expect(typeof out.arguments).toBe('string');
    expect((out.arguments as string).includes('\n')).toBe(true);
  });
});
