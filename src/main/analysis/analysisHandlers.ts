import { ipcMain } from 'electron';
import { runAnalysisScript } from './analysisProcess';

export function registerAnalysisHandlers(): void {
  ipcMain.handle(
    'analysis:runScript',
    async (
      _event,
      payload: {
        script: string;
        dataFiles?: Record<string, unknown>;
        timeoutMs?: number;
      },
    ) => {
      return runAnalysisScript({
        script: payload.script,
        dataFiles: payload.dataFiles ?? {},
        timeoutMs: payload.timeoutMs,
      });
    },
  );
}
