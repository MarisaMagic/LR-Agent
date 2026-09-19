import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  readAnnotationDocJson,
  repairAnnotationDocFilePaths,
  writeAnnotationDocJson,
} from './annotationDataStore';

let projectDir: string;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-repair-'));
});

afterEach(() => {
  fs.rmSync(projectDir, { recursive: true, force: true });
});

describe('repairAnnotationDocFilePaths', () => {
  it('重写与存储键不符的 filePath', async () => {
    // 历史缺陷留下的状态：文档存在 data/1.jpg 的槽位，但内部 filePath 指向别的文件
    await writeAnnotationDocJson(projectDir, 'data/1.jpg', {
      projectId: 'p1',
      filePath: 'data/7.jpg',
      annotations: [{ id: 'a1' }],
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await repairAnnotationDocFilePaths(projectDir);

    expect(result.scanned).toBe(1);
    expect(result.repaired).toEqual([
      { relativePath: 'data/1.jpg', storedFilePath: 'data/7.jpg' },
    ]);

    const doc = (await readAnnotationDocJson(projectDir, 'data/1.jpg')) as {
      filePath?: string;
      annotations?: unknown[];
    };
    expect(doc.filePath).toBe('data/1.jpg');
    // 只改归属字段，标注内容必须原样保留
    expect(doc.annotations).toEqual([{ id: 'a1' }]);
  });

  it('补写缺失的 filePath', async () => {
    await writeAnnotationDocJson(projectDir, 'data/2.jpg', {
      projectId: 'p1',
      annotations: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await repairAnnotationDocFilePaths(projectDir);
    expect(result.repaired).toEqual([
      { relativePath: 'data/2.jpg', storedFilePath: null },
    ]);
  });

  it('幂等：已一致时不写盘也不上报', async () => {
    await writeAnnotationDocJson(projectDir, 'data/3.jpg', {
      projectId: 'p1',
      filePath: 'data/3.jpg',
      annotations: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const first = await repairAnnotationDocFilePaths(projectDir);
    expect(first.repaired).toEqual([]);

    const second = await repairAnnotationDocFilePaths(projectDir);
    expect(second).toEqual({ scanned: 1, repaired: [] });
  });

  it('无索引时安全返回空结果', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ann-empty-'));
    try {
      await expect(repairAnnotationDocFilePaths(empty)).resolves.toEqual({
        scanned: 0,
        repaired: [],
      });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('索引存在但文档缺失时跳过', async () => {
    await writeAnnotationDocJson(projectDir, 'data/4.jpg', {
      projectId: 'p1',
      filePath: 'data/9.jpg',
      annotations: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    const index = JSON.parse(
      await fs.readFile(
        path.join(projectDir, '.lr-agent', 'annotations', 'index.json'),
        'utf8',
      ),
    ) as { files: Record<string, { fileKey: string }> };
    // 手动把文档文件删掉，索引仍保留该条目
    await fs.remove(
      path.join(
        projectDir,
        '.lr-agent',
        'annotations',
        'files',
        `${index.files['data/4.jpg'].fileKey}.json`,
      ),
    );

    await expect(repairAnnotationDocFilePaths(projectDir)).resolves.toEqual({
      scanned: 0,
      repaired: [],
    });
  });
});
