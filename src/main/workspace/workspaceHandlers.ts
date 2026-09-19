import { ipcMain } from 'electron';
import {
  deleteWorkspaceTextFile,
  moveWorkspaceTextFile,
  readWorkspaceTextFile,
  writeWorkspaceTextFile,
} from './workspaceOperations';

/**
 * 渲染层工作区文件 IPC。
 *
 * 实现体已抽到 `workspaceOperations.ts`，与 Agent 运行时的 RPC 桥共用，
 * 保证两条入口的行为完全一致（含授权根校验与 file-system:changed 广播）。
 */
export function registerWorkspaceHandlers(): void {
  ipcMain.handle(
    'workspace:writeTextFile',
    async (
      _event,
      payload: { rootDir: string; relativePath: string; content: string },
    ) => writeWorkspaceTextFile(payload),
  );

  ipcMain.handle(
    'workspace:readTextFile',
    async (_event, payload: { rootDir: string; relativePath: string }) =>
      readWorkspaceTextFile(payload),
  );

  ipcMain.handle(
    'workspace:deleteTextFile',
    async (_event, payload: { rootDir: string; relativePath: string }) =>
      deleteWorkspaceTextFile(payload),
  );

  ipcMain.handle(
    'workspace:moveTextFile',
    async (
      _event,
      payload: {
        rootDir: string;
        relativePath: string;
        newRelativePath: string;
      },
    ) => moveWorkspaceTextFile(payload),
  );
}
