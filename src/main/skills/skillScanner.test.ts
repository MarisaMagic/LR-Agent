import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  MAX_CATALOG_ENTRIES,
  MAX_DESCRIPTION_CHARS,
  MAX_SKILL_CHARS,
  clearSkillsCache,
  parseSkillFrontmatter,
  readSkillMarkdown,
  scanSkillsCatalog,
} from './skillScanner';

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => os.tmpdir()),
  },
}));

describe('parseSkillFrontmatter', () => {
  it('parses single-line name and description', () => {
    const content = `---
name: caveman
description: Ultra-compressed communication mode.
---
Body here`;
    expect(parseSkillFrontmatter(content)).toEqual({
      name: 'caveman',
      description: 'Ultra-compressed communication mode.',
      disableModelInvocation: undefined,
    });
  });

  it('parses folded (> ) description as a single line', () => {
    const content = `---
name: folded-skill
description: >
  Ultra-compressed communication mode.
  Keep technical accuracy.
---
Body here`;
    expect(parseSkillFrontmatter(content)?.description).toBe(
      'Ultra-compressed communication mode. Keep technical accuracy.',
    );
  });

  it('parses literal (|) description preserving newlines', () => {
    const content = `---
name: literal-skill
description: |
  line one
  line two
---
Body here`;
    expect(parseSkillFrontmatter(content)?.description).toBe(
      'line one\nline two',
    );
  });

  it('returns null when frontmatter is missing', () => {
    expect(parseSkillFrontmatter('# Just a heading')).toBeNull();
  });

  it('parses disable-model-invocation flag', () => {
    const content = `---
name: hidden-skill
description: internal only
disable-model-invocation: true
---`;
    expect(parseSkillFrontmatter(content)?.disableModelInvocation).toBe(true);
  });
});

describe('scanSkillsCatalog', () => {
  let tmpDir: string;

  beforeEach(() => {
    clearSkillsCache();
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.remove(tmpDir);
    }
  });

  it('collects valid skill directories only', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    await fs.outputFile(
      path.join(tmpDir, 'caveman', 'SKILL.md'),
      '---\nname: caveman\ndescription: Talk like caveman.\n---\nBody',
    );
    await fs.outputFile(
      path.join(tmpDir, 'not-a-skill', 'readme.txt'),
      'no skill here',
    );
    await fs.outputFile(
      path.join(tmpDir, '.hidden', 'SKILL.md'),
      '---\nname: hidden\ndescription: skipped hidden dir\n---\n',
    );

    const catalog = await scanSkillsCatalog(tmpDir);
    expect(catalog).toEqual([
      { name: 'caveman', description: 'Talk like caveman.', scope: 'user' },
    ]);
  });

  it('excludes skills with disable-model-invocation', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    await fs.outputFile(
      path.join(tmpDir, 'internal', 'SKILL.md'),
      '---\nname: internal\ndescription: do not invoke\ndisable-model-invocation: true\n---\n',
    );
    await fs.outputFile(
      path.join(tmpDir, 'public', 'SKILL.md'),
      '---\nname: public\ndescription: invoke me\n---\n',
    );

    const catalog = await scanSkillsCatalog(tmpDir);
    expect(catalog.map((s) => s.name)).toEqual(['public']);
  });

  it('falls back to directory name when name is missing, drops entries without description', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    await fs.outputFile(
      path.join(tmpDir, 'nameless', 'SKILL.md'),
      '---\ndescription: has description only\n---\n',
    );
    await fs.outputFile(
      path.join(tmpDir, 'no-desc', 'SKILL.md'),
      '---\nname: no-desc\n---\n',
    );

    const catalog = await scanSkillsCatalog(tmpDir);
    expect(catalog).toEqual([
      { name: 'nameless', description: 'has description only', scope: 'user' },
    ]);
  });

  it('caps catalog at MAX_CATALOG_ENTRIES and truncates description', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    for (let i = 0; i < MAX_CATALOG_ENTRIES + 5; i += 1) {
      await fs.outputFile(
        path.join(tmpDir, `skill-${i}`, 'SKILL.md'),
        `---\nname: skill-${i}\ndescription: ${'d'.repeat(400)}\n---\n`,
      );
    }

    const catalog = await scanSkillsCatalog(tmpDir);
    expect(catalog).toHaveLength(MAX_CATALOG_ENTRIES);
    expect(catalog[0]!.description.length).toBe(MAX_DESCRIPTION_CHARS);
  });
});

describe('readSkillMarkdown', () => {
  let tmpDir: string;

  beforeEach(() => {
    clearSkillsCache();
  });

  afterEach(async () => {
    if (tmpDir) {
      await fs.remove(tmpDir);
    }
  });

  it('reads full SKILL.md content', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    await fs.outputFile(
      path.join(tmpDir, 'caveman', 'SKILL.md'),
      '---\nname: caveman\ndescription: Talk like caveman.\n---\nRespond terse.',
    );

    const content = await readSkillMarkdown('caveman', tmpDir);
    expect(content).toContain('Respond terse.');
  });

  it('rejects invalid skill names (path traversal)', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    expect(await readSkillMarkdown('..', tmpDir)).toBeNull();
    expect(await readSkillMarkdown('a/b', tmpDir)).toBeNull();
    expect(await readSkillMarkdown('../secret', tmpDir)).toBeNull();
  });

  it('returns null for missing skill', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    expect(await readSkillMarkdown('nonexistent', tmpDir)).toBeNull();
  });

  it('truncates oversized SKILL.md content', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lr-skills-'));
    await fs.outputFile(
      path.join(tmpDir, 'big', 'SKILL.md'),
      'x'.repeat(MAX_SKILL_CHARS + 10_000),
    );

    const content = await readSkillMarkdown('big', tmpDir);
    expect(content!.length).toBeLessThanOrEqual(MAX_SKILL_CHARS + 20);
    expect(content).toContain('…（内容过长已截断）');
  });
});
