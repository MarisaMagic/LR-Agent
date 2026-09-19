import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { writeAnnotationDocJson } from '../annotation/annotationDataStore';
import { writeScopedTextFile } from '../workspace/workspaceWrite';
import {
  captureCheckpoint,
  hashContent,
  hasCheckpoint,
  recordCheckpointAfter,
  restoreCheckpoint,
} from './turnCheckpointStore';

let userDataDir: string;

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => userDataDir),
  },
}));

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-store-'));
});

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

const ref = {
  sessionId: 'sess-1',
  messageId: 'msg-1',
  blockIndex: 0,
};

describe('turnCheckpointStore', () => {
  it('restores a file to its pre-apply content', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-ws-'));
    try {
      await writeScopedTextFile(root, 'notes.md', 'before');
      await captureCheckpoint(
        ref,
        'file',
        { workspaceRoot: root },
        {
          filePaths: ['notes.md'],
        },
      );
      await writeScopedTextFile(root, 'notes.md', 'after');
      await recordCheckpointAfter(ref, { workspaceRoot: root });

      const restored = await restoreCheckpoint(ref, { workspaceRoot: root });
      expect(restored.ok).toBe(true);
      const text = await fs.readFile(path.join(root, 'notes.md'), 'utf8');
      expect(text).toBe('before');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses restore when the file is dirty', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-dirty-'));
    try {
      await writeScopedTextFile(root, 'notes.md', 'before');
      await captureCheckpoint(
        ref,
        'file',
        { workspaceRoot: root },
        {
          filePaths: ['notes.md'],
        },
      );
      await writeScopedTextFile(root, 'notes.md', 'after');
      await recordCheckpointAfter(ref, { workspaceRoot: root });
      await writeScopedTextFile(root, 'notes.md', 'hand-edit');

      const restored = await restoreCheckpoint(ref, { workspaceRoot: root });
      expect(restored).toEqual({
        ok: false,
        error: 'checkpoint_dirty',
        dirtyPaths: ['notes.md'],
      });
      const text = await fs.readFile(path.join(root, 'notes.md'), 'utf8');
      expect(text).toBe('hand-edit');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores annotation docs and rejects dirty annotation hashes', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-ann-'));
    try {
      await writeAnnotationDocJson(projectDir, 'img/a.jpg', {
        projectId: 'p1',
        annotations: [{ id: '1' }],
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      await captureCheckpoint(
        ref,
        'annotation',
        { projectDir },
        { annotationPaths: ['img/a.jpg'] },
      );
      await writeAnnotationDocJson(projectDir, 'img/a.jpg', {
        projectId: 'p1',
        annotations: [{ id: '1' }, { id: '2' }],
        updatedAt: '2026-01-01T00:00:01.000Z',
      });
      await recordCheckpointAfter(ref, { projectDir });

      const dirty = await restoreCheckpoint(
        { ...ref, blockIndex: 0 },
        { projectDir },
      );
      expect(dirty.ok).toBe(true);

      await writeAnnotationDocJson(projectDir, 'img/a.jpg', {
        projectId: 'p1',
        annotations: [{ id: '1' }, { id: '2' }],
        updatedAt: '2026-01-01T00:00:01.000Z',
      });
      await recordCheckpointAfter(ref, { projectDir });
      await writeAnnotationDocJson(projectDir, 'img/a.jpg', {
        projectId: 'p1',
        annotations: [{ id: 'x' }],
        updatedAt: '2026-01-01T00:00:02.000Z',
      });
      const refused = await restoreCheckpoint(ref, { projectDir });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error).toBe('checkpoint_dirty');
      }
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('hashes content stably', () => {
    expect(hashContent('abc')).toBe(hashContent('abc'));
    expect(hashContent('abc')).not.toBe(hashContent('abd'));
  });

  /**
   * 免确认改造把每会话上限从 20 提到 50：一轮对话内可能有更多次直接落盘，
   * 上限过低会把最早、也最可能需要回滚的快照先行清掉。
   *
   * 这里只验证「不清掉 40 个」这一关键边界，避免逐次建 51 个快照拖慢测试。
   */
  it('keeps up to 40 checkpoints in a session (limit raised to 50)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-prune-'));
    try {
      await writeScopedTextFile(root, 'notes.md', 'v0');
      // 同一 session 下建 40 个不同的 blockIndex 快照
      for (let i = 0; i < 40; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await captureCheckpoint(
          { ...ref, blockIndex: i },
          'file',
          { workspaceRoot: root },
          { filePaths: ['notes.md'] },
        );
      }
      const sessionDir = path.join(userDataDir, 'agent-checkpoints', 'sess-1');
      const msgDirs = await fs.readdir(sessionDir);
      let blocks = 0;
      for (const msgDir of msgDirs) {
        // eslint-disable-next-line no-await-in-loop
        blocks += (await fs.readdir(path.join(sessionDir, msgDir))).length;
      }
      expect(blocks).toBe(40);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * 回归：`recordAfter` 失败（未写入 afterHash）时快照必须仍然可用。
   *
   * 历史实现会在 recordAfter 抛错时 discard 快照，于是一次瞬时失败就让 Undo
   * 入口永久消失且无法补救。还原只需要 `beforeMissing` + blob，`afterHash`
   * 仅服务于脏检查，因此「无 afterHash」不该等于「无快照」。
   */
  it('treats a snapshot without afterHash as existing and force-restorable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-force-'));
    try {
      await writeScopedTextFile(root, 'notes.md', 'before');
      await captureCheckpoint(
        ref,
        'file',
        { workspaceRoot: root },
        { filePaths: ['notes.md'] },
      );
      await writeScopedTextFile(root, 'notes.md', 'after');
      // 故意不调用 recordCheckpointAfter：模拟 recordAfter 失败

      await expect(hasCheckpoint(ref)).resolves.toBe(true);

      // 默认仍拒绝（快照不完整），但提供强制通道
      const refused = await restoreCheckpoint(ref, { workspaceRoot: root });
      expect(refused).toEqual({ ok: false, error: 'checkpoint_incomplete' });

      const forced = await restoreCheckpoint(
        ref,
        { workspaceRoot: root },
        { force: true },
      );
      expect(forced.ok).toBe(true);
      expect(await fs.readFile(path.join(root, 'notes.md'), 'utf8')).toBe(
        'before',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * 回归：文件在应用之后又被改动（脏），强制回滚应能覆盖。
   *
   * 「脏」的常见成因是正常操作而非用户手改 —— 例如加载流水线修正文档内陈旧的
   * `filePath` 后写回。若不允许覆盖，Undo 会因这类良性写入而永久失效。
   */
  it('force restore overrides the dirty check', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-force-dirty-'));
    try {
      await writeScopedTextFile(root, 'notes.md', 'before');
      await captureCheckpoint(
        ref,
        'file',
        { workspaceRoot: root },
        { filePaths: ['notes.md'] },
      );
      await writeScopedTextFile(root, 'notes.md', 'after');
      await recordCheckpointAfter(ref, { workspaceRoot: root });
      await writeScopedTextFile(root, 'notes.md', 'benign-rewrite');

      const refused = await restoreCheckpoint(ref, { workspaceRoot: root });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error).toBe('checkpoint_dirty');
        expect(refused.dirtyPaths).toEqual(['notes.md']);
      }

      const forced = await restoreCheckpoint(
        ref,
        { workspaceRoot: root },
        { force: true },
      );
      expect(forced.ok).toBe(true);
      expect(await fs.readFile(path.join(root, 'notes.md'), 'utf8')).toBe(
        'before',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
