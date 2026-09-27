/**
 * `experiment:*` IPC：渲染层实验事件 → 主进程 JSONL 日志。
 *
 * - `experiment:log`：追加一条事件；未启用埋点时静默 no-op（渲染层不用分支）。
 * - `experiment:status`：返回启用状态与文件路径（调试/排障用）。
 */
import { ipcMain } from 'electron';
import {
  appendExperimentEvent,
  isExperimentLogEnabled,
  resolveExperimentLogFile,
} from './logger';

/** 单条事件序列化后的大小上限，避免异常调用写爆日志。 */
const MAX_EVENT_BYTES = 64 * 1024;

function isValidEvent(event: unknown): event is Record<string, unknown> {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  const { type } = event as { type?: unknown };
  if (typeof type !== 'string' || !type.trim()) return false;
  try {
    return Buffer.byteLength(JSON.stringify(event), 'utf8') <= MAX_EVENT_BYTES;
  } catch {
    return false;
  }
}

export function registerExperimentHandlers(): void {
  ipcMain.handle('experiment:log', (_event, payload: unknown) => {
    if (!isValidEvent(payload)) return;
    if (!isExperimentLogEnabled()) return;
    appendExperimentEvent(payload);
  });

  ipcMain.handle('experiment:status', () => ({
    enabled: isExperimentLogEnabled(),
    file: resolveExperimentLogFile(),
  }));
}
