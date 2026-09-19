/**
 * @jest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import crypto from 'node:crypto';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { readFileAnnotationTool } from './annotationDoc';
import type { ClientContextLike } from './workspacePath';

let projectDir: string;

beforeEach(async () => {
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-ann-doc-'));
});

afterEach(async () => {
  await fs.remove(projectDir);
});

/** 与 annotationDataStore 完全一致的寻址算法。 */
function fileKeyOf(relativePath: string): string {
  const normalized = relativePath.split(/[/\\]/).filter(Boolean).join('/');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** 在磁盘写入一份标注文档。 */
async function writeDoc(relativePath: string, doc: unknown): Promise<void> {
  const dir = path.join(projectDir, '.lr-agent', 'annotations', 'files');
  await fs.ensureDir(dir);
  await fs.writeJson(path.join(dir, `${fileKeyOf(relativePath)}.json`), doc, {
    spaces: 2,
  });
}

const ctx = (): ClientContextLike => ({
  workspaceRoot: projectDir,
  projectDirectoryPath: projectDir,
});

describe('readFileAnnotationTool：返回权威归属路径', () => {
  it('文档内 filePath 正确时原样返回', async () => {
    await writeDoc('data/1.jpg', {
      schemaVersion: 1,
      projectId: 'p1',
      filePath: 'data/1.jpg',
      annotations: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const raw = await readFileAnnotationTool(ctx(), 'data/1.jpg');
    expect(JSON.parse(raw).filePath).toBe('data/1.jpg');
  });

  it('文档内 filePath 错位时按请求路径修正（历史脏数据兜底）', async () => {
    // 模拟防抖错配历史遗留：data/1.jpg 的槽位里存着 data/7.jpg 的归属路径
    await writeDoc('data/1.jpg', {
      schemaVersion: 1,
      projectId: 'p1',
      filePath: 'data/7.jpg',
      annotations: [],
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const raw = await readFileAnnotationTool(ctx(), 'data/1.jpg');
    const parsed = JSON.parse(raw);

    expect(parsed.filePath).toBe('data/1.jpg');
    // 其它字段不应被改动
    expect(parsed.projectId).toBe('p1');
    expect(parsed.schemaVersion).toBe(1);
  });

  it('缺失 filePath 字段时补齐为请求路径', async () => {
    await writeDoc('data/2.jpg', {
      schemaVersion: 1,
      projectId: 'p1',
      annotations: [],
    });

    const raw = await readFileAnnotationTool(ctx(), 'data/2.jpg');
    expect(JSON.parse(raw).filePath).toBe('data/2.jpg');
  });

  it('反斜杠路径归一后仍能命中同一文档', async () => {
    await writeDoc('data/3.jpg', {
      schemaVersion: 1,
      projectId: 'p1',
      filePath: 'data/3.jpg',
      annotations: [],
    });

    const raw = await readFileAnnotationTool(ctx(), 'data\\3.jpg');
    expect(JSON.parse(raw).filePath).toBe('data/3.jpg');
  });

  it('文档不存在时给出中文提示', async () => {
    const raw = await readFileAnnotationTool(ctx(), 'data/nope.jpg');
    expect(raw).toContain('未找到');
  });

  it('未绑定项目目录时提示', async () => {
    const raw = await readFileAnnotationTool(null, 'data/1.jpg');
    expect(raw).toContain('未绑定项目目录');
  });

  it('分页提示与切片同时生效', async () => {
    await writeDoc('data/4.jpg', {
      schemaVersion: 1,
      projectId: 'p1',
      filePath: 'data/4.jpg',
      annotations: Array.from({ length: 5 }, (_unused, i) => ({ id: `a${i}` })),
    });

    const raw = await readFileAnnotationTool(ctx(), 'data/4.jpg', {
      offset: 1,
      limit: 2,
    });
    expect(raw).toContain('共 5 条标注');
    expect(JSON.parse(raw.slice(raw.indexOf('{'))).annotations).toEqual([
      { id: 'a1' },
      { id: 'a2' },
    ]);
  });
});
