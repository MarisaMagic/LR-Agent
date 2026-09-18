/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import {
  ProposalStreamInterceptor,
  extractJsonString,
  type ToolCallChunkInput,
} from './proposalStreamer';
import { toSseDict } from '../sse';
import type { ClientContextLike } from '../tools/workspacePath';

/** 夹具工作区上下文：路径归一化需要一个根。 */
const CTX: ClientContextLike = {
  workspaceRoot: '/ws',
  projectDirectoryPath: null,
};

/** 把 args JSON 切成固定长度的分片，模拟流式 tool_call。 */
function fragment(
  index: number,
  id: string,
  name: string,
  argsJson: string,
  size: number,
): ToolCallChunkInput[] {
  const out: ToolCallChunkInput[] = [];
  for (let i = 0; i < argsJson.length; i += size) {
    out.push({
      index,
      // 首片带 id / name，与真实 provider 行为一致
      ...(i === 0 ? { id, name } : {}),
      argsFragment: argsJson.slice(i, i + size),
    });
  }
  return out;
}

/** 逐个分片喂给拦截器，收集全部事件（已序列化为线格式）。 */
function run(
  chunks: ToolCallChunkInput[],
  ctx: ClientContextLike | null = CTX,
): Array<Record<string, unknown>> {
  const interceptor = new ProposalStreamInterceptor(ctx);
  const events: Array<Record<string, unknown>> = [];
  for (const chunk of chunks) {
    for (const event of interceptor.onChunk([chunk])) {
      events.push(toSseDict(event));
    }
  }
  return events;
}

describe('extractJsonString：半截 JSON 解析', () => {
  it('完整字符串返回值并标记闭合', () => {
    expect(extractJsonString('{"a": "hi"}', 'a')).toEqual({
      value: 'hi',
      closed: true,
    });
  });

  it('未闭合时返回已累积部分', () => {
    expect(extractJsonString('{"a": "hi', 'a')).toEqual({
      value: 'hi',
      closed: false,
    });
  });

  it('key 未出现时返回 null', () => {
    expect(extractJsonString('{"b": "x"}', 'a')).toEqual({
      value: null,
      closed: false,
    });
  });

  it('key 出现但值尚未开始时返回 null', () => {
    expect(extractJsonString('{"a":', 'a')).toEqual({ value: null, closed: false });
  });

  it('解码标准转义', () => {
    const { value } = extractJsonString('{"a": "l1\\nl2\\tt\\"q\\"\\\\s"}', 'a');
    expect(value).toBe('l1\nl2\tt"q"\\s');
  });

  it('未知转义按字面输出下一个字符', () => {
    expect(extractJsonString('{"a": "x\\zy"}', 'a').value).toBe('xzy');
  });

  it('解码 \\uXXXX', () => {
    expect(extractJsonString('{"a": "\\u4f60\\u597d"}', 'a').value).toBe('你好');
  });

  it('\\u 序列不完整时暂停解析（返回未闭合）', () => {
    const result = extractJsonString('{"a": "\\u4f', 'a');
    expect(result.closed).toBe(false);
    // 未完整解码的转义不进入结果
    expect(result.value).toBeNull();
  });

  it('合成代理对（emoji）', () => {
    // U+1F600 = \uD83D\uDE00
    const result = extractJsonString('{"a": "\\ud83d\\ude00"}', 'a');
    expect(result.value).toBe('😀');
    expect(result.closed).toBe(true);
  });

  it('孤立低代理输出替换字符', () => {
    expect(extractJsonString('{"a": "\\udc00"}', 'a').value).toBe('\ufffd');
  });

  it('非法十六进制按字面 u 输出，不卡死', () => {
    expect(extractJsonString('{"a": "\\uZZZZ"}', 'a').value).toBe('uZZZZ');
  });

  it('空字符串值为空串而非 null', () => {
    expect(extractJsonString('{"a": ""}', 'a')).toEqual({ value: '', closed: true });
  });

  it('按码点解码，emoji 不丢字', () => {
    expect(extractJsonString('{"a": "😀x"}', 'a').value).toBe('😀x');
  });
});

describe('提案拦截器：write 工具', () => {
  const ARGS = JSON.stringify({
    relative_path: 'reports/summary.md',
    content: '# 标题\n正文内容',
  });

  it('先发 start 再发 content 增量', () => {
    const events = run(fragment(0, 'tc1', 'write_workspace_file', ARGS, 7));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('file_proposal_start');
    expect(types.filter((t) => t === 'file_proposal_delta').length).toBeGreaterThan(0);
  });

  it('增量拼接后等于完整内容', () => {
    const events = run(fragment(0, 'tc1', 'write_workspace_file', ARGS, 5));
    const content = events
      .filter((e) => e.type === 'file_proposal_delta')
      .map((e) => e.content as string)
      .join('');
    expect(content).toBe('# 标题\n正文内容');
  });

  it('start 带 detail="0"，write 不输出 mode/operation', () => {
    const events = run(fragment(0, 'tc1', 'write_workspace_file', ARGS, 7));
    const start = events.find((e) => e.type === 'file_proposal_start');
    expect(start?.detail).toBe('0');
    expect(start?.suggestedRelativePath).toBe('reports/summary.md');
    expect(start?.title).toBe('reports/summary.md');
    expect('mode' in (start ?? {})).toBe(false);
    expect('operation' in (start ?? {})).toBe(false);
  });

  it('delta 携带 suggestedRelativePath 但不带 mode', () => {
    const events = run(fragment(0, 'tc1', 'write_workspace_file', ARGS, 7));
    const delta = events.find((e) => e.type === 'file_proposal_delta');
    expect(delta?.suggestedRelativePath).toBe('reports/summary.md');
    expect('mode' in (delta ?? {})).toBe(false);
  });

  it('每个分片最多产生一条 delta', () => {
    const chunks = fragment(0, 'tc1', 'write_workspace_file', ARGS, 7);
    const interceptor = new ProposalStreamInterceptor(CTX);
    for (const chunk of chunks) {
      const events = interceptor.onChunk([chunk]);
      expect(events.filter((e) => e.type === 'file_proposal_delta').length)
        .toBeLessThanOrEqual(1);
    }
  });

  it('含 emoji 的内容增量拼接后完整还原', () => {
    const args = JSON.stringify({ relative_path: 'a.md', content: '前😀后🎉尾' });
    const events = run(fragment(0, 'tc1', 'write_workspace_file', args, 3));
    const content = events
      .filter((e) => e.type === 'file_proposal_delta')
      .map((e) => e.content as string)
      .join('');
    expect(content).toBe('前😀后🎉尾');
    // 不应出现半个代理对（孤立代理会渲染成替换字符）
    expect(content).not.toContain('\ufffd');
  });
});

describe('提案拦截器：edit 工具', () => {
  const ARGS = JSON.stringify({
    relative_path: 'config/app.json',
    old_string: '"timeout": 30',
    new_string: '"timeout": 120',
  });

  it('start 带 mode/operation = edit', () => {
    const events = run(fragment(0, 'tc1', 'str_replace_workspace_file', ARGS, 6));
    const start = events.find((e) => e.type === 'file_proposal_start');
    expect(start?.mode).toBe('edit');
    expect(start?.operation).toBe('edit');
  });

  it('file_edit_delta 的 old/new 增量可拼接还原', () => {
    const events = run(fragment(0, 'tc1', 'str_replace_workspace_file', ARGS, 4));
    const deltas = events.filter((e) => e.type === 'file_edit_delta');
    expect(deltas.length).toBeGreaterThan(0);

    const oldJoined = deltas.map((e) => (e.oldDelta as string) ?? '').join('');
    const newJoined = deltas.map((e) => (e.newDelta as string) ?? '').join('');
    expect(oldJoined).toBe('"timeout": 30');
    expect(newJoined).toBe('"timeout": 120');
  });

  it('不发 file_proposal_delta（edit 走 edit_delta）', () => {
    const events = run(fragment(0, 'tc1', 'str_replace_workspace_file', ARGS, 4));
    expect(events.some((e) => e.type === 'file_proposal_delta')).toBe(false);
  });

  it('oldDelta/newDelta 至少一个非空才发事件', () => {
    const events = run(fragment(0, 'tc1', 'str_replace_workspace_file', ARGS, 4));
    for (const event of events.filter((e) => e.type === 'file_edit_delta')) {
      const hasDelta = Boolean(event.oldDelta) || Boolean(event.newDelta);
      expect(hasDelta).toBe(true);
    }
  });
});

describe('提案拦截器：.lr-agent 抑制', () => {
  it('路径落入 .lr-agent 时不发任何提案事件', () => {
    const args = JSON.stringify({
      relative_path: '.lr-agent/scratch.md',
      content: '内部草稿',
    });
    expect(run(fragment(0, 'tc1', 'write_workspace_file', args, 5))).toHaveLength(0);
  });

  it('被抑制的调用不出现在 streamedPathsByCallId', () => {
    const args = JSON.stringify({ relative_path: '.lr-agent/scratch.md', content: 'x' });
    const interceptor = new ProposalStreamInterceptor(CTX);
    for (const chunk of fragment(0, 'tc1', 'write_workspace_file', args, 5)) {
      interceptor.onChunk([chunk]);
    }
    expect(interceptor.streamedPathsByCallId().size).toBe(0);
  });
});

describe('提案拦截器：状态重置与 provider 兼容', () => {
  it('同一 tc_idx 上换 id 时重置状态（避免残留 rel_path 错标）', () => {
    const interceptor = new ProposalStreamInterceptor(CTX);
    const first = JSON.stringify({ relative_path: 'a.md', content: 'AAA' });
    for (const chunk of fragment(0, 'tc1', 'write_workspace_file', first, 100)) {
      interceptor.onChunk([chunk]);
    }

    const second = JSON.stringify({ relative_path: 'b.md', content: 'BBB' });
    let sawSecondStart = false;
    for (const chunk of fragment(0, 'tc2', 'write_workspace_file', second, 100)) {
      for (const event of interceptor.onChunk([chunk])) {
        const dict = toSseDict(event);
        if (
          dict.type === 'file_proposal_start' &&
          dict.suggestedRelativePath === 'b.md'
        ) {
          sawSecondStart = true;
        }
      }
    }
    expect(sawSecondStart).toBe(true);
  });

  it('kind 从 write 变为 edit 时重置状态', () => {
    const interceptor = new ProposalStreamInterceptor(CTX);
    const writeArgs = JSON.stringify({ relative_path: 'a.md', content: 'x' });
    for (const chunk of fragment(0, 'tc1', 'write_workspace_file', writeArgs, 100)) {
      interceptor.onChunk([chunk]);
    }
    const editArgs = JSON.stringify({
      relative_path: 'a.md',
      old_string: 'x',
      new_string: 'y',
    });
    const events = interceptor.onChunk([
      {
        index: 0,
        id: 'tc1',
        name: 'str_replace_workspace_file',
        argsFragment: editArgs,
      },
    ]);
    expect(events.some((e) => e.mode === 'edit')).toBe(true);
  });

  it('累积式 provider（重复投递完整 args）幂等', () => {
    const args = JSON.stringify({ relative_path: 'a.md', content: 'hello' });
    const interceptor = new ProposalStreamInterceptor(CTX);
    const collected: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      for (const event of interceptor.onChunk([
        { index: 0, id: 'tc1', name: 'write_workspace_file', argsFragment: args },
      ])) {
        if (event.type === 'file_proposal_delta') {
          collected.push(event.content as string);
        }
      }
    }
    expect(collected.join('')).toBe('hello');
  });

  it('增量式 provider（逐字符）也能正确累积', () => {
    const args = JSON.stringify({ relative_path: 'a.md', content: 'hello' });
    const events = run(fragment(0, 'tc1', 'write_workspace_file', args, 1));
    const content = events
      .filter((e) => e.type === 'file_proposal_delta')
      .map((e) => e.content as string)
      .join('');
    expect(content).toBe('hello');
  });
});

describe('提案拦截器：streamedPathsByCallId', () => {
  it('返回已出卡的 callId → 显示路径', () => {
    const args = JSON.stringify({ relative_path: 'dir/x.md', content: 'c' });
    const interceptor = new ProposalStreamInterceptor(CTX);
    for (const chunk of fragment(0, 'call-abc', 'write_workspace_file', args, 5)) {
      interceptor.onChunk([chunk]);
    }
    expect(interceptor.streamedPathsByCallId().get('call-abc')).toBe('dir/x.md');
    expect(interceptor.collectedPaths().has('dir/x.md')).toBe(true);
  });

  it('路径未闭合时不出现在映射中', () => {
    const interceptor = new ProposalStreamInterceptor(CTX);
    interceptor.onChunk([
      {
        index: 0,
        id: 'tc1',
        name: 'write_workspace_file',
        argsFragment: '{"relative_path": "dir/x',
      },
    ]);
    expect(interceptor.streamedPathsByCallId().size).toBe(0);
  });

  it('多轮场景：新实例不携带上一轮状态', () => {
    const args = JSON.stringify({ relative_path: 'a.md', content: 'x' });
    const round1 = new ProposalStreamInterceptor(CTX);
    for (const chunk of fragment(0, 'tc1', 'write_workspace_file', args, 100)) {
      round1.onChunk([chunk]);
    }
    expect(round1.streamedPathsByCallId().size).toBe(1);

    // 每轮新建实例 → 状态清空
    const round2 = new ProposalStreamInterceptor(CTX);
    expect(round2.streamedPathsByCallId().size).toBe(0);
  });
});
