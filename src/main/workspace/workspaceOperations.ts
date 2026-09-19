/**
 * 工作区文本文件操作的共享实现。
 *
 * 抽出来的目的：渲染层 IPC（`workspaceHandlers.ts`）与 Agent 运行时的 RPC 桥
 * （`agent/ipcSurface.ts`）需要**完全一致**的行为——同样的授权根校验、同样的
 * 路径约束、同样的 `file-system:changed` 广播。两者都在主进程内，因此可以共用
 * 这一段带 Electron 副作用的实现，避免逻辑分叉。
 *
 * 安全语义来自 `workspaceWrite.ts`（路径穿越、.lr-agent 禁写、扩展名黑名单、
 * realpath 符号链接逃逸检测），授权根校验来自 `authorizedRoots.ts`。
 */

import path from 'path';
import { BrowserWindow } from 'electron';
import { isWithinAuthorizedRoot } from '../security/authorizedRoots';
import {
  deleteScopedTextFile,
  moveScopedTextFile,
  readScopedTextFile,
  writeScopedTextFile,
} from './workspaceWrite';

export const WORKSPACE_FORBIDDEN = {
  success: false,
  error: 'forbidden_root',
} as const;

export interface WorkspaceWriteResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

export interface WorkspaceReadResult {
  success: boolean;
  content?: string;
  exists?: boolean;
  filePath?: string;
  error?: string;
}

/** 通知渲染层某些目录内容已变化（驱动文件树/编辑器刷新）。 */
function broadcastFileSystemChanged(...dirs: string[]): void {
  for (const dir of dirs) {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('file-system:changed', dir);
    }
  }
}

export async function writeWorkspaceTextFile(payload: {
  rootDir: string;
  relativePath: string;
  content: string;
}): Promise<WorkspaceWriteResult> {
  if (!isWithinAuthorizedRoot(payload?.rootDir))
    return { ...WORKSPACE_FORBIDDEN };
  const result = await writeScopedTextFile(
    payload.rootDir,
    payload.relativePath,
    payload.content,
  );
  if (result.success && result.filePath) {
    broadcastFileSystemChanged(path.dirname(result.filePath));
  }
  return result;
}

export async function readWorkspaceTextFile(payload: {
  rootDir: string;
  relativePath: string;
}): Promise<WorkspaceReadResult> {
  if (!isWithinAuthorizedRoot(payload?.rootDir))
    return { ...WORKSPACE_FORBIDDEN };
  return readScopedTextFile(payload.rootDir, payload.relativePath);
}

export async function deleteWorkspaceTextFile(payload: {
  rootDir: string;
  relativePath: string;
}): Promise<WorkspaceWriteResult> {
  if (!isWithinAuthorizedRoot(payload?.rootDir))
    return { ...WORKSPACE_FORBIDDEN };
  const result = await deleteScopedTextFile(
    payload.rootDir,
    payload.relativePath,
  );
  if (result.success) {
    broadcastFileSystemChanged(
      path.join(payload.rootDir, path.dirname(payload.relativePath)),
    );
  }
  return result;
}

export async function moveWorkspaceTextFile(payload: {
  rootDir: string;
  relativePath: string;
  newRelativePath: string;
}): Promise<WorkspaceWriteResult> {
  if (!isWithinAuthorizedRoot(payload?.rootDir))
    return { ...WORKSPACE_FORBIDDEN };
  const result = await moveScopedTextFile(
    payload.rootDir,
    payload.relativePath,
    payload.newRelativePath,
  );
  if (result.success) {
    broadcastFileSystemChanged(
      path.join(payload.rootDir, path.dirname(payload.relativePath)),
      path.join(payload.rootDir, path.dirname(payload.newRelativePath)),
    );
  }
  return result;
}
