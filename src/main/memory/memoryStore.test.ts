import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import {
  createMemoryTopic,
  listMemoryEntries,
  resolveOpenableMemoryFile,
} from './memoryStore';

let userDataDir: string;

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => userDataDir),
  },
}));

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-store-'));
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

describe('listMemoryEntries', () => {
  it('includes MEMORY.md and topic cards with excerpts', async () => {
    const scopeKey = 'projects/demo-task';
    await createMemoryTopic({
      scopeKey,
      topicFile: 'annotated-files.md',
      content: '# 已标文件\n',
      indexLine: '- [已标文件](topics/annotated-files.md)：已标 3 张',
    });

    const entries = await listMemoryEntries(scopeKey);
    expect(entries.map((item) => item.relativePath)).toEqual([
      'MEMORY.md',
      'topics/annotated-files.md',
    ]);
    expect(entries[1]?.excerpt).toContain('已标 3 张');
    expect(entries[0]?.absolutePath).toContain(
      path.join('agent-memory', 'projects', 'demo-task'),
    );
  });
});

describe('resolveOpenableMemoryFile', () => {
  const scopeKey = 'projects/demo-task';

  it('resolves MEMORY.md and topic files inside the scope', async () => {
    await createMemoryTopic({
      scopeKey,
      topicFile: 'annotated-files.md',
      content: '# 已标文件\n',
      indexLine: '- [已标文件](topics/annotated-files.md)',
    });
    const indexPath = await resolveOpenableMemoryFile(scopeKey, 'MEMORY.md');
    const topicPath = await resolveOpenableMemoryFile(
      scopeKey,
      'topics/annotated-files.md',
    );
    expect(indexPath.endsWith('MEMORY.md')).toBe(true);
    expect(topicPath.endsWith('annotated-files.md')).toBe(true);
  });

  it('rejects traversal and other scopes', async () => {
    await expect(
      resolveOpenableMemoryFile(scopeKey, '../other.md'),
    ).rejects.toThrow('invalid_memory_path');
    await expect(
      resolveOpenableMemoryFile(scopeKey, 'topics/../MEMORY.md'),
    ).rejects.toThrow('invalid_memory_path');
    await expect(
      resolveOpenableMemoryFile(scopeKey, 'notes.txt'),
    ).rejects.toThrow('invalid_memory_path');
  });

  it('rejects missing files', async () => {
    await expect(
      resolveOpenableMemoryFile(scopeKey, 'MEMORY.md'),
    ).rejects.toThrow('memory_file_not_found');
  });
});
