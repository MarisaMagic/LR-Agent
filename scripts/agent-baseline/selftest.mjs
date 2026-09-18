/**
 * 阶段 0 自检：验证 mock LLM 服务的输出契约。
 *
 * 不依赖任何 Agent 服务，只验证 mock 本身：
 *   1. 每个场景的流式响应都是合法的 OpenAI chunk 序列
 *   2. 分片的 tool_call arguments 能重组为合法 JSON，且与场景定义一致
 *   3. 非流式响应（tool_choice="any" 走这条）结构正确
 *   4. 轮次游标按序推进，reset 生效
 *
 * 用法：node scripts/agent-baseline/selftest.mjs [--port 8801]
 */

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from './scenarios.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const i = argv.indexOf('--port');
const PORT = i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : 8801;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(ok, label, detail = '') {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function waitReady() {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/__mock/scenarios`);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) throw new Error('mock 未就绪');
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** 解析 SSE 文本为 chunk 对象数组。 */
function parseChunks(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const p = t.slice(5).trim();
    if (!p || p === '[DONE]') continue;
    out.push(JSON.parse(p));
  }
  return out;
}

/** 把 chunk 序列重组为 { text, reasoning, toolCalls }。 */
function reassemble(chunks) {
  let text = '';
  let reasoning = '';
  const toolCalls = new Map();

  for (const c of chunks) {
    const delta = c.choices?.[0]?.delta ?? {};
    if (typeof delta.content === 'string') text += delta.content;
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    for (const tc of delta.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      if (!toolCalls.has(idx)) toolCalls.set(idx, { id: '', name: '', args: '' });
      const acc = toolCalls.get(idx);
      if (tc.id) acc.id = tc.id;
      if (tc.function?.name) acc.name = tc.function.name;
      if (typeof tc.function?.arguments === 'string') acc.args += tc.function.arguments;
    }
  }

  return {
    text,
    reasoning,
    toolCalls: [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v),
  };
}

async function callStream(scenarioId) {
  const res = await fetch(`${BASE}/scenario/${scenarioId}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mock-model', stream: true, messages: [] }),
  });
  return parseChunks(await res.text());
}

async function callNonStream(scenarioId) {
  const res = await fetch(`${BASE}/scenario/${scenarioId}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'mock-model', stream: false, messages: [] }),
  });
  return res.json();
}

async function main() {
  const proc = spawn(process.execPath, [path.join(here, 'mockLlmServer.mjs'), '--port', String(PORT)], {
    stdio: 'ignore',
  });

  try {
    await waitReady();

    console.log('— 流式 chunk 契约 —');
    for (const scenario of SCENARIOS) {
      await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
      const chunks = await callStream(scenario.id);
      const first = scenario.turns[0];

      const shapeOk = chunks.every(
        (c) =>
          c.object === 'chat.completion.chunk' &&
          Array.isArray(c.choices) &&
          c.choices.length === 1,
      );
      check(shapeOk, `${scenario.id}: chunk 结构合法`);

      const finish = chunks[chunks.length - 1];
      const expectedFinish = first.toolCalls?.length ? 'tool_calls' : 'stop';
      check(
        finish?.choices?.[0]?.finish_reason === expectedFinish,
        `${scenario.id}: finish_reason=${expectedFinish}`,
        `实际 ${finish?.choices?.[0]?.finish_reason}`,
      );

      const asm = reassemble(chunks);
      check(
        asm.text === (first.text ?? ''),
        `${scenario.id}: 正文重组一致`,
        `期望 ${JSON.stringify((first.text ?? '').slice(0, 30))} 实际 ${JSON.stringify(asm.text.slice(0, 30))}`,
      );
      check(
        asm.reasoning === (first.reasoning ?? ''),
        `${scenario.id}: reasoning 重组一致`,
      );

      const expectedCalls = first.toolCalls ?? [];
      check(
        asm.toolCalls.length === expectedCalls.length,
        `${scenario.id}: tool_call 数量一致`,
        `期望 ${expectedCalls.length} 实际 ${asm.toolCalls.length}`,
      );

      for (let n = 0; n < expectedCalls.length; n += 1) {
        const exp = expectedCalls[n];
        const got = asm.toolCalls[n];
        let parsedOk = true;
        let parsed = null;
        try {
          parsed = JSON.parse(got.args);
        } catch {
          parsedOk = false;
        }
        check(
          parsedOk &&
            got.id === exp.id &&
            got.name === exp.name &&
            JSON.stringify(parsed) === JSON.stringify(exp.args),
          `${scenario.id}: tool_call[${n}] ${exp.name} 分片 args 重组正确`,
          parsedOk ? `args 不一致` : `args 不是合法 JSON: ${got.args.slice(0, 60)}`,
        );
      }
    }

    console.log('\n— 非流式契约（tool_choice="any" 路径） —');
    await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
    const scenario = SCENARIOS.find((s) => s.id === 'tool-choice-any-fallback');
    // 第一轮是纯正文（会被强制重试），第二轮才是真实 tool_call
    await callNonStream(scenario.id);
    const completion = await callNonStream(scenario.id);
    check(completion.object === 'chat.completion', '非流式返回 chat.completion');
    check(
      Array.isArray(completion.choices?.[0]?.message?.tool_calls),
      '非流式 message.tool_calls 存在',
    );
    check(
      completion.choices?.[0]?.message?.tool_calls?.[0]?.function?.name === 'auto_annotate',
      '非流式 tool_call 名称正确',
    );

    console.log('\n— 轮次游标 —');
    await fetch(`${BASE}/__mock/reset`, { method: 'POST' });
    const t1 = reassemble(await callStream('multiple-rounds'));
    const t2 = reassemble(await callStream('multiple-rounds'));
    check(t1.toolCalls[0]?.name === 'describe_client_context', '第 1 轮消费正确');
    check(t2.toolCalls[0]?.name === 'get_lr_agent_help', '第 2 轮消费正确');

    const state = await (await fetch(`${BASE}/__mock/state`)).json();
    check(state.cursors['multiple-rounds'] === 2, 'state 反映已消费轮次');
  } finally {
    proc.kill();
  }

  console.log(failures ? `\n[selftest] 失败 ${failures} 项` : '\n[selftest] 全部通过');
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(`[selftest] ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
