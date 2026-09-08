import { describe, expect, it } from '@jest/globals';
import {
  resolveWorkspaceAbsolutePath,
  resolveWorkspaceRoot,
} from './workspacePaths';

describe('workspacePaths', () => {
  it('prefers annotation project directory over workspace root', () => {
    expect(
      resolveWorkspaceRoot({ directoryPath: '/proj' } as never, '/ws'),
    ).toBe('/proj');
    expect(resolveWorkspaceRoot(null, '/ws')).toBe('/ws');
    expect(resolveWorkspaceRoot(null, null)).toBeNull();
  });

  it('joins relative path under resolved root', () => {
    expect(resolveWorkspaceAbsolutePath('src/main.ts', null, '/ws')).toBe(
      '/ws/src/main.ts',
    );
    expect(resolveWorkspaceAbsolutePath('/src/main.ts', null, '/ws')).toBe(
      '/ws/src/main.ts',
    );
    expect(resolveWorkspaceAbsolutePath('a.ts', null, null)).toBeNull();
  });
});
