import { ipcMain, BrowserWindow } from 'electron';
import path from 'path';
import {
  readScopedTextFile,
  writeScopedTextFile,
  deleteScopedTextFile,
} from './workspaceWrite';

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

  ipcMain.handle(
    'workspace:deleteTextFile',
    async (_event, payload: { rootDir: string; relativePath: string }) => {
      const result = await deleteScopedTextFile(
        payload.rootDir,
        payload.relativePath,
      );
      if (result.success) {
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send(
            'file-system:changed',
            path.join(payload.rootDir, path.dirname(payload.relativePath)),
          );
        });
      }
      return result;
    },
  );
}
