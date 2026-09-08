import { ipcMain, BrowserWindow } from 'electron';
import path from 'path';
import { readScopedTextFile, writeScopedTextFile } from './workspaceWrite';

export function registerWorkspaceHandlers(): void {
  ipcMain.handle(
    'workspace:writeTextFile',
    async (
      _event,
      payload: { rootDir: string; relativePath: string; content: string },
    ) => {
      const result = await writeScopedTextFile(
        payload.rootDir,
        payload.relativePath,
        payload.content,
      );
      if (result.success && result.filePath) {
        const parentDir = path.dirname(result.filePath);
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send('file-system:changed', parentDir);
        });
      }
      return result;
    },
  );

  ipcMain.handle(
    'workspace:readTextFile',
    async (_event, payload: { rootDir: string; relativePath: string }) => {
      return readScopedTextFile(payload.rootDir, payload.relativePath);
    },
  );
}
