import { ipcMain, shell } from 'electron';
import { readProjectInstructions } from './instructionsReader';
import {
  ensureMemoryDir,
  listMemoryTopics,
  readMemoryIndex,
  readMemoryTopic,
  setActiveMemoryScope,
  writeMemoryTopic,
} from './memoryStore';

export function registerMemoryHandlers(): void {
  ipcMain.handle(
    'agent:memory:readInstructions',
    (_event, directoryPath: string) => {
      return readProjectInstructions(directoryPath);
    },
  );

  // 读取索引时同步设置活动作用域（MCP memory 工具使用同一作用域）
  ipcMain.handle('agent:memory:readIndex', (_event, scopeKey: string) => {
    setActiveMemoryScope(scopeKey);
    return readMemoryIndex(scopeKey);
  });

  ipcMain.handle(
    'agent:memory:readTopic',
    (_event, scopeKey: string, topicFile: string) => {
      return readMemoryTopic(scopeKey, topicFile);
    },
  );

  ipcMain.handle('agent:memory:listTopics', (_event, scopeKey: string) => {
    return listMemoryTopics(scopeKey);
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
      return writeMemoryTopic(options);
    },
  );

  ipcMain.handle('agent:memory:openDir', async (_event, scopeKey: string) => {
    const dir = await ensureMemoryDir(scopeKey);
    return shell.openPath(dir);
  });
}
