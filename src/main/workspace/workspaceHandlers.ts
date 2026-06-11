import { ipcMain } from 'electron';
import { writeScopedMarkdownFile } from './workspaceWrite';

export function registerWorkspaceHandlers(): void {
  ipcMain.handle(
    'workspace:writeMarkdownFile',
    async (
      _event,
      payload: { rootDir: string; relativePath: string; content: string },
    ) => {
      return writeScopedMarkdownFile(
        payload.rootDir,
        payload.relativePath,
        payload.content,
      );
    },
  );
}
