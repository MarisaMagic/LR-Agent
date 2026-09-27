/**
 * 实验埋点日志（JSONL）。
 *
 * 仅在设置 `LR_AGENT_EXPERIMENT_LOG` 时启用（值为目录或 .jsonl 文件路径），
 * 未设置时所有写入静默跳过——默认运行行为与无埋点完全一致。
 *
 * `LR_AGENT_EXPERIMENT_RUN` 可选，作为 run 标签写进每条事件（如 `C-s1`），
 * 用于把同一 session 的渲染层与主进程事件关联起来。
 *
 * 写入串行化（promise 链）避免并发 append 交错；任何写入失败都不向上抛，
 * 埋点不能影响正常功能。
 */
import path from 'path';
import fs from 'fs-extra';

let writeChain: Promise<void> = Promise.resolve();

export function isExperimentLogEnabled(): boolean {
  const raw = process.env.LR_AGENT_EXPERIMENT_LOG;
  return typeof raw === 'string' && raw.trim().length > 0;
}

/** 解析事件文件路径；未启用时返回 null。目录 → `<dir>/events.jsonl`。 */
export function resolveExperimentLogFile(): string | null {
  const raw = process.env.LR_AGENT_EXPERIMENT_LOG;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = raw.trim();
  return /\.jsonl$/i.test(value) ? value : path.join(value, 'events.jsonl');
}

/** 追加一条事件（异步、串行、失败静默）。 */
export function appendExperimentEvent(event: Record<string, unknown>): void {
  const file = resolveExperimentLogFile();
  if (!file) return;

  const run = process.env.LR_AGENT_EXPERIMENT_RUN?.trim() || null;
  const record = {
    ts: new Date().toISOString(),
    run,
    ...event,
  };

  let line: string;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch {
    return;
  }

  writeChain = writeChain
    .then(async () => {
      await fs.ensureDir(path.dirname(file));
      await fs.appendFile(file, line, 'utf8');
    })
    .catch(() => undefined);
}

/** 等待已排队的写入完成（测试与退出前使用）。 */
export function flushExperimentLog(): Promise<void> {
  return writeChain;
}
