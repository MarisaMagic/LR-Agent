import { describe, expect, it } from '@jest/globals';
import {
  applyScopeWithFallback,
  filterPathsByScopeHint,
  resolveScopeHintPaths,
  type InputPathEntry,
} from './scopePathUtil';

const samplePaths: InputPathEntry[] = [
  { relativePath: 'business_math.txt', absolutePath: '/p/business_math.txt' },
  { relativePath: 'pool_problem.txt', absolutePath: '/p/pool_problem.txt' },
  { relativePath: 'data/algebra.txt', absolutePath: '/p/data/algebra.txt' },
];

describe('filterPathsByScopeHint', () => {
  it('returns all paths when scope_hint is empty', () => {
    expect(filterPathsByScopeHint(samplePaths)).toEqual(samplePaths);
  });

  it('filters by substring match', () => {
    const filtered = filterPathsByScopeHint(samplePaths, 'pool');
    expect(filtered.map((p) => p.relativePath)).toEqual(['pool_problem.txt']);
  });

  it('filters by comma-separated tokens', () => {
    const filtered = filterPathsByScopeHint(
      samplePaths,
      'business_math.txt, algebra',
    );
    expect(filtered.map((p) => p.relativePath)).toEqual([
      'business_math.txt',
      'data/algebra.txt',
    ]);
  });

  it('matches directory prefix token', () => {
    const filtered = filterPathsByScopeHint(samplePaths, 'data/');
    expect(filtered.map((p) => p.relativePath)).toEqual(['data/algebra.txt']);
  });
});

describe('applyScopeWithFallback', () => {
  it('falls back to all paths when scope_hint misses', () => {
    const result = applyScopeWithFallback(samplePaths, 'nonexistent', 100);
    expect(result).toEqual(samplePaths);
  });

  it('respects maxFiles cap without scope_hint', () => {
    const result = applyScopeWithFallback(samplePaths, undefined, 2);
    expect(result).toHaveLength(2);
  });
});

describe('resolveScopeHintPaths', () => {
  it('resolves exact paths via resolver when not in catalog', async () => {
    const resolved = await resolveScopeHintPaths(
      samplePaths,
      'extra/new.txt',
      '/p',
      100,
      async (relativePath) =>
        relativePath === 'extra/new.txt'
          ? { relativePath, absolutePath: '/p/extra/new.txt' }
          : null,
    );
    expect(resolved.map((p) => p.relativePath)).toEqual(['extra/new.txt']);
  });

  it('falls back when filtered and resolver find nothing', async () => {
    const result = await resolveScopeHintPaths(
      samplePaths,
      'missing-file',
      '/p',
      100,
    );
    expect(result).toEqual(samplePaths);
  });
});
