/**
 * 阶段 0 行为基线：golden SSE 序列 diff。
 *
 * 比较两份抓取结果（如 `.baseline/python` 与 `.baseline/node`），逐场景逐事件报告差异。
 * 差异存在时以非零码退出，可直接用作迁移的硬性验收 gate。
 *
 * 用法：
 *   node scripts/agent-baseline/diffSse.mjs --baseline .baseline/python --candidate .baseline/node
 *
 * 参数：
 *   --baseline   基准目录（迁移前 Python 抓取）
 *   --candidate  候选目录（迁移后 Node 抓取）
 *   --only       逗号分隔的场景 id 白名单
 *   --max-diffs  每个场景最多展示的差异条数（默认 8）
 *   --quiet      只输出总结
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const argv = process.argv.slice(2);
function argOf(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const hasFlag = (flag) => argv.includes(flag);

const BASELINE = path.resolve(repoRoot, argOf('--baseline', '.baseline/python'));
const CANDIDATE = path.resolve(repoRoot, argOf('--candidate', '.baseline/node'));
const MAX_DIFFS = Number(argOf('--max-diffs', '8'));
const QUIET = hasFlag('--quiet');
const ONLY = argOf('--only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function readScenarios(dir) {
  if (!fs.existsSync(dir)) throw new Error(`目录不存在: ${dir}`);
  const out = new Map();
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.json') || file === 'meta.json') continue;
    if (file.endsWith('.error.json')) continue;
    const id = file.replace(/\.json$/, '');
    out.set(id, JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')));
  }
  return out;
}

/** 取事件的可读摘要，用于差异上下文。 */
function brief(event) {
  const t = event.type ?? '?';
  if (event.content !== undefined) return `${t} content=${JSON.stringify(String(event.content).slice(0, 40))}`;
  if (event.name !== undefined) return `${t} name=${event.name}`;
  if (event.summary !== undefined) return `${t} summary=${JSON.stringify(String(event.summary).slice(0, 40))}`;
  if (event.stage !== undefined) return `${t} stage=${event.stage}`;
  if (event.status !== undefined) return `${t} status=${event.status}`;
  return t;
}

function canonical(event) {
  return JSON.stringify(event);
}

/** 逐字段比较两个事件，返回字段级差异描述。 */
function fieldDiffs(a, b) {
  const diffs = [];
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const key of [...keys].sort()) {
    const va = JSON.stringify(a?.[key]);
    const vb = JSON.stringify(b?.[key]);
    if (va !== vb) diffs.push(`${key}: ${va} → ${vb}`);
  }
  return diffs;
}

function diffScenario(id, base, cand) {
  if (!Array.isArray(base) || !Array.isArray(cand)) {
    return [`非事件数组（baseline=${typeof base}, candidate=${typeof cand}）`];
  }
  const diffs = [];
  const max = Math.max(base.length, cand.length);

  for (let i = 0; i < max; i += 1) {
    const a = base[i];
    const b = cand[i];
    if (!a) {
      diffs.push(`[${i}] 候选多出事件: ${brief(b)}`);
      continue;
    }
    if (!b) {
      diffs.push(`[${i}] 候选缺少事件: ${brief(a)}`);
      continue;
    }
    if (canonical(a) !== canonical(b)) {
      const fd = fieldDiffs(a, b);
      const head = a.type !== b.type
        ? `事件类型不同: ${a.type} → ${b.type}`
        : `事件内容不同: ${brief(a)}`;
      diffs.push(`[${i}] ${head}\n      ${fd.join('\n      ')}`);
    }
    if (diffs.length >= MAX_DIFFS) {
      diffs.push('…（已达展示上限）');
      break;
    }
  }
  return diffs;
}

function main() {
  const base = readScenarios(BASELINE);
  const cand = readScenarios(CANDIDATE);

  let ids = [...new Set([...base.keys(), ...cand.keys()])].sort();
  if (ONLY.length) ids = ids.filter((id) => ONLY.includes(id));

  let failed = 0;
  let passed = 0;

  for (const id of ids) {
    const a = base.get(id);
    const b = cand.get(id);
    if (!a) {
      console.log(`\n✗ ${id}  基准缺失（候选有，基准无）`);
      failed += 1;
      continue;
    }
    if (!b) {
      console.log(`\n✗ ${id}  候选缺失`);
      failed += 1;
      continue;
    }
    const diffs = diffScenario(id, a, b);
    if (diffs.length === 0) {
      passed += 1;
      if (!QUIET) console.log(`✓ ${id}  (${a.length} events)`);
    } else {
      failed += 1;
      console.log(`\n✗ ${id}  (${a.length} → ${b.length} events)`);
      for (const d of diffs) console.log(`    ${d}`);
    }
  }

  console.log(`\n[diff] 通过 ${passed} / 失败 ${failed} / 共 ${ids.length}`);
  console.log(`       基准: ${BASELINE}`);
  console.log(`       候选: ${CANDIDATE}`);
  if (failed) process.exitCode = 1;
}

try {
  main();
} catch (err) {
  console.error(`[diff] ${err instanceof Error ? err.message : err}`);
  process.exitCode = 2;
}
