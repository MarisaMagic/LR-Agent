/**
 * 实验汇总：把埋点 JSONL、评测指标 JSON 汇总成 Markdown 表格与 summary.json。
 *
 * 输入：
 *   experiments/runs/events.jsonl            埋点事件（LR_AGENT_EXPERIMENT_LOG）
 *   experiments/results/metrics/*.json       eval_bbox.py / diff_corrections.py 的输出
 *   experiments/runs/<run>/meta.json         快照脚本写入的运行元数据
 *
 * 输出：
 *   experiments/results/summary.md           人读表格（可直接摘进报告）
 *   experiments/results/summary.json         机读汇总
 *
 * 用法：
 *   node scripts/experiments/summarize.mjs
 *   node scripts/experiments/summarize.mjs --log experiments/runs/events.jsonl
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const options = {
    log: path.join(root, 'experiments', 'runs', 'events.jsonl'),
    runsDir: path.join(root, 'experiments', 'runs'),
    metricsDir: path.join(root, 'experiments', 'results', 'metrics'),
    out: path.join(root, 'experiments', 'results'),
    exclude: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--log') options.log = path.resolve(argv[++i]);
    else if (arg === '--runs-dir') options.runsDir = path.resolve(argv[++i]);
    else if (arg === '--metrics-dir') options.metricsDir = path.resolve(argv[++i]);
    else if (arg === '--out') options.out = path.resolve(argv[++i]);
    else if (arg === '--exclude') {
      options.exclude = String(argv[++i] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      console.error(`未知参数: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonLines(file) {
  if (!(await exists(file))) return [];
  const content = await fs.readFile(file, 'utf8');
  const events = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // 忽略损坏行
    }
  }
  return events;
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function stats(values) {
  if (values.length === 0) {
    return { n: 0, median: null, p25: null, p75: null, mean: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    median: quantile(sorted, 0.5),
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
    mean: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
  };
}

function formatMs(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatNum(value, digits = 3) {
  if (value == null || Number.isNaN(value)) return '-';
  return Number(value).toFixed(digits);
}

function round(value, digits = 4) {
  if (value == null || Number.isNaN(value)) return null;
  return Number(Number(value).toFixed(digits));
}

function buildRunSummaries(events) {
  const byRun = new Map();
  for (const event of events) {
    const run = event.run || '(untagged)';
    const bucket = byRun.get(run) ?? {
      run,
      firstTs: null,
      lastTs: null,
      openedImages: new Set(),
      savesByImage: new Map(),
      openByImage: new Map(),
      aiGenerate: [],
      preannot: [],
      llmUsage: [],
      events: [],
    };
    if (event.ts) {
      if (!bucket.firstTs || event.ts < bucket.firstTs) bucket.firstTs = event.ts;
      if (!bucket.lastTs || event.ts > bucket.lastTs) bucket.lastTs = event.ts;
      bucket.events.push(event);
    }
    if (event.type === 'image_open' && event.relativePath) {
      bucket.openedImages.add(event.relativePath);
      if (!bucket.openByImage.has(event.relativePath)) {
        bucket.openByImage.set(event.relativePath, event.ts);
      }
    } else if (event.type === 'image_save' && event.relativePath) {
      const list = bucket.savesByImage.get(event.relativePath) ?? [];
      list.push(event.ts);
      bucket.savesByImage.set(event.relativePath, list);
    } else if (event.type === 'ai_generate') {
      bucket.aiGenerate.push(event);
    } else if (event.type === 'preannot_run') {
      bucket.preannot.push(event);
    } else if (event.type === 'llm_usage') {
      bucket.llmUsage.push(event);
    }
    byRun.set(run, bucket);
  }

  const summaries = [];
  for (const bucket of byRun.values()) {
    const durations = [];
    const durationsByImage = {};
    for (const [relPath, openTs] of bucket.openByImage) {
      const saves = bucket.savesByImage.get(relPath);
      if (!saves || saves.length === 0) continue;
      const lastSave = saves[saves.length - 1];
      const ms = Date.parse(lastSave) - Date.parse(openTs);
      if (Number.isFinite(ms) && ms > 0) {
        durations.push(ms);
        durationsByImage[relPath] = Math.round(ms);
      }
    }

    // ── 墙钟口径 ──
    // 会话墙钟：该 run 首事件 → 末事件（条件总耗时，含 AI 等待）。
    const sessionSpanMs =
      bucket.firstTs && bucket.lastTs
        ? Date.parse(bucket.lastTs) - Date.parse(bucket.firstTs)
        : null;
    const imagesOpened = bucket.openedImages.size;
    const avgSpanPerImageMs =
      sessionSpanMs != null && imagesOpened > 0
        ? Math.round(sessionSpanMs / imagesOpened)
        : null;

    // AI 批次墙钟：ai_generate 事件在批量结束后统一落日志，
    // 每条带 elapsedMs，故单条区间 = [ts - elapsed, ts]；批次墙钟取最早开始 → 最晚结束。
    const aiIntervals = bucket.aiGenerate
      .filter((event) => typeof event.elapsedMs === 'number' && event.elapsedMs > 0)
      .map((event) => {
        const end = Date.parse(event.ts);
        return { start: end - event.elapsedMs, end };
      })
      .filter((item) => Number.isFinite(item.start) && Number.isFinite(item.end));
    const aiBatchWallMs =
      aiIntervals.length > 0
        ? Math.max(...aiIntervals.map((i) => i.end)) -
          Math.min(...aiIntervals.map((i) => i.start))
        : null;
    const aiGenerateSumMs =
      aiIntervals.length > 0
        ? aiIntervals.reduce((sum, i) => sum + (i.end - i.start), 0)
        : null;
    const concurrencyFactor =
      aiBatchWallMs != null && aiBatchWallMs > 0 && aiGenerateSumMs != null
        ? aiGenerateSumMs / aiBatchWallMs
        : null;

    // 人工时段：会话墙钟扣除并发 AI 批次（B 无 AI 批次，人工占满会话）。
    const humanSpanMs =
      sessionSpanMs == null
        ? null
        : aiBatchWallMs == null
          ? sessionSpanMs
          : Math.max(0, sessionSpanMs - aiBatchWallMs);
    const humanAvgPerImageMs =
      humanSpanMs != null && imagesOpened > 0
        ? Math.round(humanSpanMs / imagesOpened)
        : null;

    // 审阅时长（修「无编辑审阅不计时」）：按 image_open 序列，
    // 每次访问停留 = 下一次 open（或会话末）− 本次 open；按图汇总。
    const opens = bucket.events
      .filter((event) => event.type === 'image_open' && event.ts && event.relativePath)
      .sort((a, b) => a.ts.localeCompare(b.ts));
    const aiWindowStart =
      aiIntervals.length > 0 ? Math.min(...aiIntervals.map((i) => i.start)) : null;
    const aiWindowEnd =
      aiIntervals.length > 0 ? Math.max(...aiIntervals.map((i) => i.end)) : null;
    const reviewMsByImage = {};
    const reviewDwells = [];
    for (let index = 0; index < opens.length; index += 1) {
      const start = Date.parse(opens[index].ts);
      const end =
        index + 1 < opens.length
          ? Date.parse(opens[index + 1].ts)
          : Date.parse(bucket.lastTs);
      const dwell = end - start;
      if (!Number.isFinite(dwell) || dwell <= 0) continue;
      const inBatch =
        aiWindowStart != null &&
        start >= aiWindowStart - 1000 &&
        start <= aiWindowEnd + 1000;
      reviewDwells.push(dwell);
      const record = reviewMsByImage[opens[index].relativePath] ?? {
        totalMs: 0,
        visits: 0,
        inBatchVisits: 0,
      };
      record.totalMs += dwell;
      record.visits += 1;
      if (inBatch) record.inBatchVisits += 1;
      reviewMsByImage[opens[index].relativePath] = record;
    }

    const aiTotals = bucket.aiGenerate
      .map((event) => event.timing?.total_ms ?? event.elapsedMs)
      .filter((value) => typeof value === 'number' && value > 0);
    const aiDetect = bucket.aiGenerate
      .map((event) => event.timing?.detect_ms)
      .filter((value) => typeof value === 'number' && value > 0);
    const aiMap = bucket.aiGenerate
      .map((event) => event.timing?.map_ms)
      .filter((value) => typeof value === 'number' && value > 0);

    const promptTokens = bucket.llmUsage.reduce(
      (sum, event) => sum + (event.promptTokens ?? 0),
      0,
    );
    const completionTokens = bucket.llmUsage.reduce(
      (sum, event) => sum + (event.completionTokens ?? 0),
      0,
    );

    summaries.push({
      run: bucket.run,
      firstTs: bucket.firstTs,
      lastTs: bucket.lastTs,
      imagesOpened: bucket.openedImages.size,
      imagesTimed: durations.length,
      durationsMs: durations.map((value) => Math.round(value)),
      durationsByImage,
      durationMs: stats(durations),
      aiGenerateCount: bucket.aiGenerate.length,
      aiGenerateOk: bucket.aiGenerate.filter((event) => event.ok).length,
      aiTimingMs: {
        total: stats(aiTotals),
        detect: stats(aiDetect),
        map: stats(aiMap),
      },
      aiReasons: Object.fromEntries(
        Object.entries(
          bucket.aiGenerate.reduce((acc, event) => {
            if (event.ok || !event.reason) return acc;
            acc[event.reason] = (acc[event.reason] ?? 0) + 1;
            return acc;
          }, {}),
        ).sort((a, b) => b[1] - a[1]),
      ),
      preannotRuns: bucket.preannot.length,
      preannotBoxes: bucket.preannot.reduce(
        (sum, event) => sum + (event.boxCount ?? 0),
        0,
      ),
      llmCalls: bucket.llmUsage.length,
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      // 墙钟口径
      sessionSpanMs,
      avgSpanPerImageMs,
      aiBatchWallMs,
      aiGenerateSumMs,
      concurrencyFactor,
      humanSpanMs,
      humanAvgPerImageMs,
      reviewMsByImage,
      reviewDwellMs: stats(reviewDwells),
    });
  }
  return summaries.sort((a, b) => a.run.localeCompare(b.run));
}

function conditionOf(run) {
  const match = /^([ABC])-/.exec(run);
  return match ? match[1] : run;
}

async function loadMetrics(metricsDir) {
  if (!(await exists(metricsDir))) return [];
  const files = await fs.readdir(metricsDir);
  const metrics = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const data = JSON.parse(
        await fs.readFile(path.join(metricsDir, file), 'utf8'),
      );
      metrics.push({ file, data });
    } catch {
      // 忽略损坏指标文件
    }
  }
  return metrics.sort((a, b) => a.file.localeCompare(b.file));
}

function metricsTable(metrics) {
  const lines = [
    '| 文件 | mAP | AP50 | P@0.5 | R@0.5 | F1@0.5 | 标签正确率 | 采纳率 | 保留/改签/移动/删除/新增 |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const { file, data } of metrics) {
    const coco = data.coco ?? {};
    // 修正 diff 的指标文件没有 COCO/detection 字段，用修正后阶段的 GT 指标补位
    const detection =
      data.detection_class_agnostic ?? data.gt_final_stage ?? {};
    const totals = data.totals ?? {};
    const parts = [
      totals.kept,
      totals.relabeled,
      totals.moved,
      totals.deleted,
      totals.added,
    ].map((v) => (v == null ? '-' : v));
    lines.push(
      `| ${file} | ${formatNum(coco.mAP, 4)} | ${formatNum(coco.AP50, 4)} | ` +
        `${formatNum(detection.precision, 4)} | ${formatNum(detection.recall, 4)} | ` +
        `${formatNum(detection.f1, 4)} | ${formatNum(detection.label_accuracy, 4)} | ` +
        `${formatNum(totals.adoption_rate, 4)} | ${parts.join(' / ')} |`,
    );
  }
  return lines.join('\n');
}

function runTable(summaries) {
  const lines = [
    '| run | 图片数 | 会话墙钟 | 平均单图 | AI 批次墙钟 | 人工时段/图 | 并发因子 | 单图中位 [P25–P75]（辅助） | AI 生成 | 成功 | detect 中位 | map 中位 | LLM 调用 | tokens |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const summary of summaries) {
    lines.push(
      `| ${summary.run} | ${summary.imagesTimed} | ` +
        `${formatMs(summary.sessionSpanMs)} | ${formatMs(summary.avgSpanPerImageMs)} | ` +
        `${formatMs(summary.aiBatchWallMs)} | ${formatMs(summary.humanAvgPerImageMs)} | ` +
        `${summary.concurrencyFactor == null ? '-' : `${summary.concurrencyFactor.toFixed(1)}×`} | ` +
        `${formatMs(summary.durationMs.median)} [${formatMs(summary.durationMs.p25)}–${formatMs(summary.durationMs.p75)}] | ` +
        `${summary.aiGenerateCount} | ${summary.aiGenerateOk} | ` +
        `${formatMs(summary.aiTimingMs.detect.median)} | ${formatMs(summary.aiTimingMs.map.median)} | ` +
        `${summary.llmCalls} | ${summary.totalTokens} |`,
    );
  }
  return lines.join('\n');
}

function conditionTable(summaries) {
  const byCondition = new Map();
  for (const summary of summaries) {
    const condition = conditionOf(summary.run);
    const list = byCondition.get(condition) ?? [];
    list.push(summary);
    byCondition.set(condition, list);
  }
  const lines = [
    '| 条件 | 图片数 | 会话墙钟 | 平均单图 | AI 批次墙钟 | 人工时段/图 | 单图中位（辅助） | AI 生成成功/总 |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const [condition, list] of [...byCondition.entries()].sort()) {
    const durations = list.flatMap((summary) => summary.durationsMs ?? []);
    let imagesOpened = 0;
    let sessionSpan = 0;
    let aiBatch = 0;
    let hasAiBatch = false;
    let aiCount = 0;
    let aiOk = 0;
    for (const summary of list) {
      imagesOpened += summary.imagesOpened ?? 0;
      sessionSpan += summary.sessionSpanMs ?? 0;
      if (summary.aiBatchWallMs != null) {
        aiBatch += summary.aiBatchWallMs;
        hasAiBatch = true;
      }
      aiCount += summary.aiGenerateCount;
      aiOk += summary.aiGenerateOk;
    }
    const avgPerImage = imagesOpened > 0 ? sessionSpan / imagesOpened : null;
    const humanSpan = hasAiBatch ? Math.max(0, sessionSpan - aiBatch) : sessionSpan;
    const humanPerImage = imagesOpened > 0 ? humanSpan / imagesOpened : null;
    lines.push(
      `| ${condition} | ${imagesOpened} | ${formatMs(sessionSpan)} | ` +
        `${formatMs(avgPerImage)} | ${hasAiBatch ? formatMs(aiBatch) : '-'} | ` +
        `${formatMs(humanPerImage)} | ${formatMs(stats(durations).median)} | ${aiOk}/${aiCount} |`,
    );
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const excluded = new Set(options.exclude);
  const matchesExcluded = (name) =>
    [...excluded].some(
      (prefix) =>
        name === prefix ||
        name.startsWith(`${prefix}-`) ||
        name.startsWith(`${prefix}_`),
    );

  const events = (await readJsonLines(options.log)).filter(
    (event) => !matchesExcluded(event.run || '(untagged)'),
  );
  const summaries = buildRunSummaries(events);
  const metrics = (await loadMetrics(options.metricsDir)).filter(
    (item) => !matchesExcluded(item.file.replace(/\.[^.]+$/, '')),
  );

  const excludedNote = excluded.size
    ? `已排除：${[...excluded].join(', ')}（数据无效，见报告说明）`
    : null;

  const markdown = [
    '# LR-Agent bbox 实验汇总',
    '',
    `生成时间：${new Date().toISOString()}`,
    ...(excludedNote ? [excludedNote] : []),
    '',
    '## 运行概览（埋点）',
    '',
    summaries.length ? runTable(summaries) : '（暂无埋点事件）',
    '',
    '## 条件对比（同图配对请用原始 JSON 做检验）',
    '',
    summaries.length ? conditionTable(summaries) : '（暂无埋点事件）',
    '',
    '## 评测指标',
    '',
    metrics.length ? metricsTable(metrics) : '（暂无指标文件）',
    '',
    '> 注：本表为脚本聚合的原始数据；统计检验与效应量请按协议 §8 用',
    '> `summary.json` 中的逐图耗时做 Wilcoxon 符号秩检验。',
    '',
  ].join('\n');

  await fs.mkdir(options.out, { recursive: true });
  await fs.writeFile(path.join(options.out, 'summary.md'), markdown);
  await fs.writeFile(
    path.join(options.out, 'summary.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        excluded: [...excluded],
        runs: summaries,
        metrics,
      },
      null,
      2,
    ),
  );
  console.log(markdown);
  console.log(`已写入 ${path.join(options.out, 'summary.md')}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
