/**
 * 阶段 0 行为基线：mock OpenAI 兼容 LLM 服务。
 *
 * 用途：让 Agent 运行时（Python 或 Node）在**不依赖真实模型**的情况下跑出可复现的
 * SSE 事件序列，用于 golden diff。
 *
 * 用法：
 *   node scripts/agent-baseline/mockLlmServer.mjs [--port 8799] [--host 127.0.0.1]
 *
 * 场景选择：把 LLM 的 base_url 指向
 *   http://127.0.0.1:<port>/scenario/<scenarioId>/v1
 * 服务会自行剥掉前缀并按场景消费轮次。
 *
 * 辅助端点：
 *   GET  /__mock/scenarios  列出全部场景 id
 *   POST /__mock/reset      重置所有场景的轮次游标（每次捕获前调用）
 *   GET  /__mock/state      查看各场景已消费轮次
 *
 * 支持的响应形态：
 *   - stream=true  → SSE，逐片下发 content / reasoning_content / tool_call arguments
 *   - stream=false → 普通 chat.completion JSON（tool_choice="any" 的兜底调用走这条）
 */

import http from 'node:http';
import { SCENARIOS, SCENARIOS_BY_ID } from './scenarios.mjs';

const argv = process.argv.slice(2);
function argOf(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const PORT = Number(argOf('--port', process.env.MOCK_LLM_PORT || '8799'));
const HOST = argOf('--host', '127.0.0.1');

/** 正文分片粒度（字符）。 */
const TEXT_FRAGMENT_SIZE = 8;

/** 每个场景的轮次游标。 */
const cursors = new Map();

function cursorOf(scenarioId) {
  return cursors.get(scenarioId) ?? 0;
}

/**
 * 解析请求路径，取出场景 id。
 * `/scenario/<id>/v1/chat/completions` → `<id>`
 * 也接受 header `x-mock-scenario` 覆盖。
 */
function resolveScenarioId(req, url) {
  const fromHeader = req.headers['x-mock-scenario'];
  if (typeof fromHeader === 'string' && fromHeader.trim()) {
    return fromHeader.trim();
  }
  const m = /^\/scenario\/([^/]+)\//.exec(url.pathname);
  return m ? decodeURIComponent(m[1]) : null;
}

/** 把字符串切成固定长度的片段。 */
function slice(text, size) {
  if (!text) return [];
  if (!size || size <= 0) return [text];
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** 构造一个流式 chunk。 */
function chunk(delta, finishReason = null) {
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function sse(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

/**
 * 把一轮场景轮次展开成流式 delta 序列。
 *
 * 顺序：role → reasoning → content → tool_calls（分片）→ finish
 */
function buildDeltas(turn) {
  const deltas = [chunk({ role: 'assistant', content: '' })];

  if (turn.reasoning) {
    for (const piece of slice(turn.reasoning, TEXT_FRAGMENT_SIZE)) {
      deltas.push(chunk({ reasoning_content: piece }));
    }
  }

  if (turn.text) {
    for (const piece of slice(turn.text, TEXT_FRAGMENT_SIZE)) {
      deltas.push(chunk({ content: piece }));
    }
  }

  const toolCalls = turn.toolCalls ?? [];
  toolCalls.forEach((call, index) => {
    const argsJson = JSON.stringify(call.args ?? {});
    const pieces = slice(argsJson, call.argFragmentSize ?? 0);
    // 首片带 id / type / name
    deltas.push(
      chunk({
        tool_calls: [
          {
            index,
            id: call.id,
            type: 'function',
            function: { name: call.name, arguments: pieces[0] ?? '' },
          },
        ],
      }),
    );
    for (let i = 1; i < pieces.length; i += 1) {
      deltas.push(
        chunk({
          tool_calls: [{ index, function: { arguments: pieces[i] } }],
        }),
      );
    }
  });

  const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
  deltas.push(chunk({}, finishReason));
  return deltas;
}

/** 非流式响应体（tool_choice="any" 的 ainvoke 走这里）。 */
function buildCompletion(turn) {
  const message = { role: 'assistant', content: turn.text ?? '' };
  if (turn.reasoning) message.reasoning_content = turn.reasoning;
  if (turn.toolCalls?.length) {
    message.tool_calls = turn.toolCalls.map((call) => ({
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
    }));
  }
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 0,
    model: 'mock-model',
    choices: [
      {
        index: 0,
        message,
        finish_reason: turn.toolCalls?.length ? 'tool_calls' : 'stop',
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  // ── 辅助端点 ──────────────────────────────────────────────
  if (url.pathname === '/__mock/scenarios') {
    return sendJson(
      res,
      200,
      SCENARIOS.map((s) => ({ id: s.id, description: s.description, turns: s.turns.length })),
    );
  }
  if (url.pathname === '/__mock/reset') {
    cursors.clear();
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname === '/__mock/state') {
    return sendJson(res, 200, {
      cursors: Object.fromEntries(cursors),
    });
  }

  // ── 仅处理 chat/completions ───────────────────────────────
  if (!url.pathname.endsWith('/chat/completions')) {
    return sendJson(res, 404, { error: { message: `unexpected path ${url.pathname}` } });
  }

  const scenarioId = resolveScenarioId(req, url);
  const scenario = scenarioId ? SCENARIOS_BY_ID.get(scenarioId) : null;
  if (!scenario) {
    return sendJson(res, 400, {
      error: {
        message: `unknown scenario: ${scenarioId ?? '(none)'}. Use base_url .../scenario/<id>/v1`,
      },
    });
  }

  const raw = await readBody(req);
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    return sendJson(res, 400, { error: { message: 'invalid json body' } });
  }

  const idx = cursorOf(scenario.id);
  const turn = scenario.turns[idx];
  cursors.set(scenario.id, idx + 1);

  if (!turn) {
    return sendJson(res, 500, {
      error: {
        message: `scenario ${scenario.id} exhausted at turn ${idx}; call POST /__mock/reset`,
      },
    });
  }

  if (payload.stream === false) {
    return sendJson(res, 200, buildCompletion(turn));
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const c of buildDeltas(turn)) res.write(sse(c));
  res.write('data: [DONE]\n\n');
  res.end();
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-llm] listening on http://${HOST}:${PORT}`);
  console.log(`[mock-llm] base_url 形如 http://${HOST}:${PORT}/scenario/<id>/v1`);
  console.log(`[mock-llm] scenarios: ${SCENARIOS.map((s) => s.id).join(', ')}`);
});
