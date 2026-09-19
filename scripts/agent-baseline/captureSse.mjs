/**
 * 阶段 0 行为基线：从 Agent 服务抓取 golden SSE 事件序列。
 *
 * 对一个正在运行的 Agent 服务（Python 的 vendor/local-agent，或迁移后的 Node 运行时）
 * 逐个场景发起请求，收集并归一化 SSE 事件，落盘为可 diff 的 JSON。
 *
 * 用法：
 *   # 1) 先手动起 mock LLM（或让本脚本自动拉起）
 *   node scripts/agent-baseline/mockLlmServer.mjs --port 8799
 *
 *   # 2) 起 Agent 服务（Python 示例）
 *   cd vendor/local-agent && LR_AGENT_LOCAL_PORT=8765 python local_main.py
 *
 *   # 3) 抓取
 *   node scripts/agent-baseline/captureSse.mjs \
 *     --target http://127.0.0.1:8765/api/v1 \
 *     --token <optional-bearer> \
 *     --out .baseline/python
 *
 * 参数：
 *   --target    Agent 服务 base URL（含 /api/v1）
 *   --token     Bearer token（Python 直跑时通常不需要；为空则不带头）
 *   --out       输出目录
 *   --only      逗号分隔的场景 id 白名单
 *   --mock      已有 mock LLM 的地址；省略则自动拉起并随后关闭
 *   --label     写入 meta 的实现标签（如 python / node）
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SCENARIOS } from './scenarios.mjs';
import { normalizeEvents, parseSse } from './normalizeSse.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const argv = process.argv.slice(2);
function argOf(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}

const TARGET = argOf('--target', 'http://127.0.0.1:8765/api/v1').replace(/\/+$/, '');
const TOKEN = argOf('--token', '');
const OUT_DIR = path.resolve(repoRoot, argOf('--out', '.baseline/capture'));
const LABEL = argOf('--label', 'unknown');
const ONLY = argOf('--only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MOCK_URL = argOf('--mock', '');
const MOCK_PORT = Number(argOf('--mock-port', '8799'));
const MOCK_BASE = MOCK_URL || `http://127.0.0.1:${MOCK_PORT}`;

const WORKSPACE = path.resolve(repoRoot, '.baseline', 'fixture-workspace');

// ── 夹具工作区 ────────────────────────────────────────────────

function ensureFixtureWorkspace() {
  fs.mkdirSync(path.join(WORKSPACE, 'config'), { recursive: true });
  fs.mkdirSync(path.join(WORKSPACE, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(WORKSPACE, 'README.md'),
    '# 夹具工作区\n\n用于 Agent 协议基线抓取。\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(WORKSPACE, 'config', 'app.json'),
    '{\n  "timeout": 30,\n  "retries": 1\n}\n',
    'utf8',
  );
}

// ── mock LLM 生命周期 ─────────────────────────────────────────

let mockProc = null;

async function waitForMock() {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const res = await fetch(`${MOCK_BASE}/__mock/scenarios`);
      if (res.ok) return;
    } catch {
      // 未就绪
    }
    if (Date.now() > deadline) throw new Error(`mock LLM 未就绪: ${MOCK_BASE}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function startMock() {
  if (MOCK_URL) {
    await waitForMock();
    return;
  }
  mockProc = spawn(
    process.execPath,
    [path.join(here, 'mockLlmServer.mjs'), '--port', String(MOCK_PORT)],
    { stdio: 'ignore' },
  );
  await waitForMock();
}

function stopMock() {
  if (mockProc) {
    mockProc.kill();
    mockProc = null;
  }
}

// ── 请求构造 ──────────────────────────────────────────────────

function buildClientContext() {
  return {
    workspace_root: WORKSPACE,
    active_relative_path: 'README.md',
    agent_mode: 'annotation',
    work_mode: 'annotation',
    workspace_memory_enabled: false,
    skills_catalog: [],
    proposal_states: [],
    mcp_servers: [],
    selected_annotation_ids: [],
  };
}

function buildBody(scenarioId, userContent, clientToolResults) {
  return {
    api_key: 'mock-key',
    base_url: `${MOCK_BASE}/scenario/${scenarioId}/v1`,
    model: 'mock-model',
    supports_vision: false,
    messages: [{ role: 'user', content: userContent, message_id: 'm1' }],
    user_content: userContent,
    client_context: buildClientContext(),
    client_tool_results: clientToolResults ?? [],
    client_job_id: `job-${scenarioId}`,
  };
}

/** 伪造客户端工具执行结果（与渲染层 formatClientToolResult 的结构对齐）。 */
function fakeClientToolResult(call) {
  const name = call.name;
  if (name === 'auto_annotate') {
    return {
      ok: true,
      tool: name,
      status: 'done',
      summary: '已生成 1 个文件的标注提案',
      file_written: false,
      proposal_pending: true,
      user_request: String(call.arguments?.user_request ?? ''),
      files: ['data/1.jpg'],
    };
  }
  if (name === 'mutate_annotation') {
    return {
      ok: true,
      tool: name,
      status: 'done',
      summary: '已生成 1 处标注变更提案',
      file_written: false,
      proposal_pending: true,
      user_request: String(call.arguments?.user_request ?? ''),
      files: ['data/1.jpg'],
    };
  }
  if (name === 'start_terminal_command') {
    return {
      ok: true,
      tool: name,
      status: 'done',
      summary: '命令已执行',
      exit_code: 0,
      job_id: 'job-terminal-1',
      output_tail: 'ok\n',
    };
  }
  return { ok: true, tool: name, status: 'done', summary: '客户端工具已执行' };
}

async function postStream(body) {
  const headers = { 'Content-Type': 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${TARGET}/agent/chat/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 400)}`);
  }
  return res.text();
}

/**
 * 跑完一个场景：含 tool_pending → resume 的循环。
 *
 * @returns {Promise<Array<Record<string, unknown>>>} 累积的全部事件
 */
async function runScenario(scenario) {
  const userContent = `【基线场景 ${scenario.id}】请按预定流程处理。`;
  const collected = [];
  let clientToolResults = [];

  for (let hop = 0; hop < 8; hop += 1) {
    const text = await postStream(buildBody(scenario.id, userContent, clientToolResults));
    const events = parseSse(text);
    collected.push(...events);

    const pending = events.find((e) => e.type === 'tool_pending');
    if (!pending) break;

    const calls = pending.clientToolCalls ?? pending.toolCalls ?? [];
    if (!calls.length) break;

    clientToolResults = calls.map((call) => ({
      tool_call_id: call.toolCallId,
      name: call.name,
      result: JSON.stringify(fakeClientToolResult(call)),
    }));
  }

  return collected;
}

// ── 主流程 ────────────────────────────────────────────────────

async function main() {
  ensureFixtureWorkspace();
  await startMock();

  const targets = ONLY.length
    ? SCENARIOS.filter((s) => ONLY.includes(s.id))
    : SCENARIOS;

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 先确认目标可达。注意 /health 挂在**根路径**，不在 /api/v1 前缀下。
  const origin = new URL(TARGET).origin;
  const healthUrl = `${origin}/health`;
  try {
    const probe = await fetch(healthUrl);
    if (!probe.ok) throw new Error(`health ${probe.status}`);
  } catch (err) {
    throw new Error(
      `Agent 服务不可达: ${healthUrl} — ${err instanceof Error ? err.message : err}`,
    );
  }

  const results = {};
  for (const scenario of targets) {
    // 清理该场景的历史产物，避免上一轮失败留下的 .error.json 造成误读
    fs.rmSync(path.join(OUT_DIR, `${scenario.id}.json`), { force: true });
    fs.rmSync(path.join(OUT_DIR, `${scenario.id}.error.json`), { force: true });

    // 每个场景前重置 mock 轮次游标
    await fetch(`${MOCK_BASE}/__mock/reset`, { method: 'POST' });

    try {
      const raw = await runScenario(scenario);
      const normalized = normalizeEvents(raw);
      results[scenario.id] = normalized;
      fs.writeFileSync(
        path.join(OUT_DIR, `${scenario.id}.json`),
        `${JSON.stringify(normalized, null, 2)}\n`,
        'utf8',
      );
      console.log(`  ✓ ${scenario.id} (${normalized.length} events)`);
    } catch (err) {
      results[scenario.id] = { error: err instanceof Error ? err.message : String(err) };
      fs.writeFileSync(
        path.join(OUT_DIR, `${scenario.id}.error.json`),
        `${JSON.stringify(results[scenario.id], null, 2)}\n`,
        'utf8',
      );
      console.error(`  ✗ ${scenario.id}: ${results[scenario.id].error}`);
    }
  }

  fs.writeFileSync(
    path.join(OUT_DIR, 'meta.json'),
    `${JSON.stringify(
      {
        label: LABEL,
        target: TARGET,
        capturedAt: new Date().toISOString(),
        scenarios: targets.map((s) => s.id),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const failed = Object.values(results).filter((r) => r && r.error).length;
  console.log(
    `\n[capture] ${targets.length - failed}/${targets.length} 场景成功 → ${OUT_DIR}`,
  );
  if (failed) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(`[capture] ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => {
    stopMock();
  });
