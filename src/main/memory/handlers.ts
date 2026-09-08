import { ipcMain, shell } from 'electron';
import { readProjectInstructions } from './instructionsReader';
import {
  createMemoryTopic,
  ensureMemoryDir,
  getActiveMemoryScope,
  isWorkspaceMemoryActive,
  listMemoryEntries,
  listMemoryTopics,
  readMemoryIndex,
  readMemoryTopic,
  resolveOpenableMemoryFile,
  setWorkspaceMemoryActive,
  writeMemoryTopic,
} from './memoryStore';
import {
  isMemoryOpenTarget,
  openMemoryFileWithTarget,
} from './openMemoryTarget';

function assertWritableMemoryScope(scopeKey: string): void {
  if (!isWorkspaceMemoryActive() || getActiveMemoryScope() !== scopeKey) {
    throw new Error('workspace_memory_inactive');
  }
}

export function registerMemoryHandlers(): void {
  ipcMain.handle(
    'agent:memory:readInstructions',
    (_event, directoryPath: string) => {
      return readProjectInstructions(directoryPath);
    },
  );

  // 读取索引时同步激活工作区记忆（MCP memory 工具使用同一作用域）
  ipcMain.handle('agent:memory:readIndex', (_event, scopeKey: string) => {
    setWorkspaceMemoryActive(true, scopeKey);
    return readMemoryIndex(scopeKey);
  });

  ipcMain.handle(
    'agent:memory:setActive',
    (_event, enabled: boolean, scopeKey?: string) => {
      setWorkspaceMemoryActive(Boolean(enabled), scopeKey);
    },
  );

  ipcMain.handle(
    'agent:memory:readTopic',
    (_event, scopeKey: string, topicFile: string) => {
      return readMemoryTopic(scopeKey, topicFile);
    },
  );

  ipcMain.handle('agent:memory:listTopics', (_event, scopeKey: string) => {
    return listMemoryTopics(scopeKey);
  });

  ipcMain.handle('agent:memory:listEntries', (_event, scopeKey: string) => {
    return listMemoryEntries(scopeKey);
  });

  ipcMain.handle(
    'agent:memory:writeTopic',
    (
      _event,
      options: {
        scopeKey: string;
        topicFile: string;
        content: string;
        indexLine?: string;
      },
    ) => {
      assertWritableMemoryScope(options.scopeKey);
      return writeMemoryTopic(options);
    },
  );

  ipcMain.handle(
    'agent:memory:createTopic',
    (
      _event,
      options: {
        scopeKey: string;
        topicFile: string;
        content: string;
        indexLine?: string;
      },
    ) => {
      assertWritableMemoryScope(options.scopeKey);
      return createMemoryTopic(options);
    },
  );

  ipcMain.handle('agent:memory:openDir', async (_event, scopeKey: string) => {
    const dir = await ensureMemoryDir(scopeKey);
    return shell.openPath(dir);
  });

  ipcMain.handle(
    'agent:memory:openFile',
    async (_event, scopeKey: string, relativePath: string, target?: string) => {
      const filePath = await resolveOpenableMemoryFile(scopeKey, relativePath);
      await openMemoryFileWithTarget(
        filePath,
        isMemoryOpenTarget(target) ? target : 'explorer',
      );
      return '';
    },
  );
}
