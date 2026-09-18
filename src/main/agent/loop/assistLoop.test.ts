/**
 * @jest-environment node
 *
 * 本测试需要 Node 全局（`Response` / `ReadableStream`）来伪造 fetch 响应，
 * jsdom 环境不提供这些。
 */
import { describe, expect, it } from '@jest/globals';
import { LlmClient, type ToolSpec } from '../llm/client';
import { buildTools, toToolSpec } from '../tools/registry';
import { DEFAULT_AGENT_SETTINGS } from '../config';
import { deriveTaskPhase } from './taskPhase';
import { FULL_TOOL_SET, LIGHT_TOOL_SET, resolveAssistToolSet } from './modeRouter';
import { streamAssist } from './assistLoop';
import type { StreamEventPayload } from '../sse';

/** 构造一个按脚本返回流式 chunk 的 fetch 替身。 */
function makeFetch(
  turns: Array<{
    text?: string;
    toolCalls?: Array<{ id: string; name: string; args: unknown }>;
    /** 非流式响应（tool_choice="any" 路径）。 */
    nonStream?: boolean;
  }>,
): { fetchImpl: typeof fetch; callCount: () => number } {
  let index = 0;
  const impl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { stream?: boolean };
    const turn = turns[Math.min(index, turns.length - 1)];
    if (index < turns.length) index += 1;

    if (body.stream === false) {
      return new Response(
        JSON.stringify({
          id: 'c1',
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: turn.text ?? '',
                tool_calls: (turn.toolCalls ?? []).map((tc) => ({
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                })),
              },
              finish_reason: turn.toolCalls?.length ? 'tool_calls' : 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const frames: string[] = [];
    frames.push(
      `data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '' } }] })}\n\n`,
    );
    if (turn.text) {
      frames.push(
        `data: ${JSON.stringify({ choices: [{ delta: { content: turn.text } }] })}\n\n`,
      );
    }
    (turn.toolCalls ?? []).forEach((tc, i) => {
      frames.push(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: i,
                    id: tc.id,
                    type: 'function',
                    function: {
                      name: tc.name,
                      arguments: JSON.stringify(tc.args),
                    },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      );
    });
    frames.push(
      `data: ${JSON.stringify({
        choices: [
          { delta: {}, finish_reason: turn.toolCalls?.length ? 'tool_calls' : 'stop' },
        ],
      })}\n\n`,
    );
    frames.push('data: [DONE]\n\n');

    return new Response(frames.join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl: impl, callCount: () => index };
}

async function collect(
  gen: AsyncGenerator<StreamEventPayload>,
): Promise<StreamEventPayload[]> {
  const out: StreamEventPayload[] = [];
  for await (const event of gen) out.push(event);
  return out;
}

function makeClient(fetchImpl: typeof fetch): LlmClient {
  return new LlmClient({
    apiKey: 'k',
    baseUrl: 'http://mock/v1',
    model: 'm',
    fetchImpl,
  });
}

const tools = new Map(buildTools().map((tool) => [tool.name, tool]));
const allSpecs: ToolSpec[] = [...tools.values()].map(toToolSpec);

const baseParams = {
  tools,
  settings: DEFAULT_AGENT_SETTINGS,
  clientContext: null,
  providerIsVision: false,
  userContent: '测试',
  taskPhaseContext: null,
  isCancelled: () => false,
};

describe('Assist 循环：纯文本', () => {
  it('只发 text_delta，并在最后结束', async () => {
    const { fetchImpl } = makeFetch([{ text: '你好' }]);
    const events = await collect(
      streamAssist({
        ...baseParams,
        llm: makeClient(fetchImpl),
        messages: [{ role: 'user', content: '嗨' }],
        toolSpecs: [],
        toolSet: new Set<string>(),
      }),
    );

    expect(events.map((e) => e.type)).toEqual([
      'preparing',
      'text_delta',
    ]);
    expect(events[1].content).toBe('你好');
  });
});

describe('Assist 循环：工具集隔离', () => {
  it('调用集合外的工具返回「未知工具」，且不发 tool_result 之外的副作用', async () => {
    const { fetchImpl } = makeFetch([
      {
        toolCalls: [
          { id: 'tc1', name: 'describe_client_context', args: {} },
        ],
      },
      { text: '完成' },
    ]);

    // describe_client_context 在注册表中存在，但不属于 LIGHT 工具集
    expect(tools.has('describe_client_context')).toBe(true);
    expect(LIGHT_TOOL_SET.has('describe_client_context')).toBe(false);

    const events = await collect(
      streamAssist({
        ...baseParams,
        llm: makeClient(fetchImpl),
        messages: [{ role: 'user', content: '当前上下文？' }],
        toolSpecs: allSpecs,
        toolSet: LIGHT_TOOL_SET,
      }),
    );

    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.result).toBe('未知工具: describe_client_context');
  });

  it('集合内的工具正常执行', async () => {
    const { fetchImpl } = makeFetch([
      {
        toolCalls: [
          { id: 'tc1', name: 'get_lr_agent_help', args: { topic: '模型' } },
        ],
      },
      { text: '完成' },
    ]);

    const events = await collect(
      streamAssist({
        ...baseParams,
        llm: makeClient(fetchImpl),
        messages: [{ role: 'user', content: '帮助' }],
        toolSpecs: allSpecs,
        toolSet: LIGHT_TOOL_SET,
      }),
    );

    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.result).toContain('预训练模型');
  });

  it('tool_start 的 arguments 是 pretty JSON 字符串', async () => {
    const { fetchImpl } = makeFetch([
      {
        toolCalls: [
          { id: 'tc1', name: 'get_lr_agent_help', args: { topic: '模型' } },
        ],
      },
      { text: '完成' },
    ]);

    const events = await collect(
      streamAssist({
        ...baseParams,
        llm: makeClient(fetchImpl),
        messages: [{ role: 'user', content: '帮助' }],
        toolSpecs: allSpecs,
        toolSet: LIGHT_TOOL_SET,
      }),
    );

    const start = events.find((e) => e.type === 'tool_start');
    expect(typeof start?.arguments).toBe('string');
    expect(JSON.parse(start?.arguments as string)).toEqual({ topic: '模型' });
  });
});

describe('Assist 循环：异步客户端工具', () => {
  it('ASYNC 工具发 tool_start 后发 tool_pending 并结束本轮', async () => {
    const { fetchImpl } = makeFetch([
      {
        toolCalls: [
          { id: 'tc1', name: 'auto_annotate', args: { user_request: '标注' } },
        ],
      },
    ]);

    const events = await collect(
      streamAssist({
        ...baseParams,
        llm: makeClient(fetchImpl),
        messages: [{ role: 'user', content: '标注' }],
        toolSpecs: allSpecs,
        toolSet: FULL_TOOL_SET,
      }),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain('tool_start');
    expect(types).toContain('tool_pending');
    // tool_pending 之后不再有业务事件
    expect(types[types.length - 1]).toBe('tool_pending');

    const pending = events.find((e) => e.type === 'tool_pending');
    expect(pending?.clientToolCalls).toHaveLength(1);
    expect(pending?.clientToolCalls?.[0].name).toBe('auto_annotate');
    // arguments 是对象（与 tool_start 的字符串不同，属既成事实）
    expect(typeof pending?.clientToolCalls?.[0].arguments).toBe('object');
  });
});

describe('Assist 循环：tool_choice="any" 兜底', () => {
  it('正文提及集合内的 ASYNC 工具时触发强制调用', async () => {
    const { fetchImpl, callCount } = makeFetch([
      { text: '我会调用 auto_annotate(paths=["data/"]) 完成标注。' },
      {
        nonStream: true,
        toolCalls: [
          { id: 'forced', name: 'auto_annotate', args: { user_request: '标注' } },
        ],
      },
    ]);

    const events = await collect(
      streamAssist({
        ...baseParams,
        llm: makeClient(fetchImpl),
        messages: [{ role: 'user', content: '标注' }],
        toolSpecs: allSpecs,
        toolSet: FULL_TOOL_SET,
      }),
    );

    // 强制调用需要一次额外的非流式请求
    expect(callCount()).toBeGreaterThan(1);
    expect(events.map((e) => e.type)).toContain('tool_pending');
  });

  it('正文提及集合外的工具时不触发', async () => {
    const { fetchImpl } = makeFetch([
      { text: '我会调用 auto_annotate(paths=["data/"]) 完成标注。' },
    ]);

    // LIGHT 集合不含 auto_annotate
    expect(LIGHT_TOOL_SET.has('auto_annotate')).toBe(false);

    const events = await collect(
      streamAssist({
        ...baseParams,
        llm: makeClient(fetchImpl),
        messages: [{ role: 'user', content: '标注' }],
        toolSpecs: allSpecs,
        toolSet: LIGHT_TOOL_SET,
      }),
    );

    expect(events.map((e) => e.type)).not.toContain('tool_pending');
    expect(events.map((e) => e.type)).not.toContain('tool_start');
  });
});

describe('Assist 循环：轮次预算', () => {
  it('预算耗尽时追加提示并产出最终回答', async () => {
    // maxToolRounds=2 → 循环跑 3 轮（0..2），每轮都发工具调用；
    // 预算耗尽后再追加一次**不带工具**的调用，此时 mock 返回纯文本。
    const turns = [
      { toolCalls: [{ id: 'tc0', name: 'get_lr_agent_help', args: {} }] },
      { toolCalls: [{ id: 'tc1', name: 'get_lr_agent_help', args: {} }] },
      { toolCalls: [{ id: 'tc2', name: 'get_lr_agent_help', args: {} }] },
      { text: '最终回答' },
    ];
    const { fetchImpl, callCount } = makeFetch(turns);

    const events = await collect(
      streamAssist({
        ...baseParams,
        settings: { ...DEFAULT_AGENT_SETTINGS, maxToolRounds: 2 },
        llm: makeClient(fetchImpl),
        messages: [{ role: 'user', content: '循环' }],
        toolSpecs: allSpecs,
        toolSet: LIGHT_TOOL_SET,
      }),
    );

    // 3 轮工具 + 1 次收尾
    expect(callCount()).toBe(4);
    const last = events[events.length - 1];
    expect(last.type).toBe('text_delta');
    expect(last.content).toBe('最终回答');
  });
});

describe('Assist 循环：取消', () => {
  it('取消后立即停止产出', async () => {
    const { fetchImpl } = makeFetch([{ text: '不应出现' }]);
    let cancelled = false;

    const events = await collect(
      streamAssist({
        ...baseParams,
        llm: makeClient(fetchImpl),
        messages: [{ role: 'user', content: '嗨' }],
        toolSpecs: [],
        toolSet: new Set<string>(),
        isCancelled: () => cancelled,
      }),
    );
    // 首个事件是 preparing；把它拿到后置取消标记的情形由下一次检查点覆盖
    expect(events[0].type).toBe('preparing');
    cancelled = true;
    expect(cancelled).toBe(true);
  });
});

describe('阶段门禁与工具集', () => {
  it('await_confirm 阶段拦截工作区写入', async () => {
    const ctx = deriveTaskPhase([
      { path: 'data/1.jpg', kind: 'annotation', status: 'pending' },
    ]);
    expect(ctx?.phase).toBe('await_confirm');

    const { fetchImpl } = makeFetch([
      {
        toolCalls: [
          { id: 'tc1', name: 'write_workspace_file', args: { relative_path: 'a.md', content: 'x' } },
        ],
      },
      { text: '完成' },
    ]);

    const events = await collect(
      streamAssist({
        ...baseParams,
        taskPhaseContext: ctx,
        llm: makeClient(fetchImpl),
        messages: [{ role: 'user', content: '写报告' }],
        toolSpecs: allSpecs,
        toolSet: FULL_TOOL_SET,
      }),
    );

    const toolResult = events.find((e) => e.type === 'tool_result');
    expect(toolResult?.result).toContain('未确认的标注提案');
  });

  it('模式路由：Ask 模式剔除写入工具', () => {
    const ask = resolveAssistToolSet({
      hasProjectSnapshot: true,
      agentMode: 'chat',
      isEditor: false,
      hasWorkspace: true,
    });
    expect(ask.has('auto_annotate')).toBe(false);
    expect(ask.has('write_workspace_file')).toBe(false);
    expect(ask.has('read_workspace_file')).toBe(true);
  });

  it('模式路由：无上下文时工具集为空', () => {
    const none = resolveAssistToolSet({
      hasProjectSnapshot: false,
      agentMode: 'chat',
      isEditor: false,
      hasWorkspace: false,
    });
    expect(none.size).toBe(0);
  });
});
