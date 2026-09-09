import { describe, expect, it } from '@jest/globals';
import { pathsEqual } from './agentFilePreviewStore';

describe('pathsEqual', () => {
  it('treats slash variants as the same path', () => {
    expect(pathsEqual('D:\\proj\\notes.md', 'D:/proj/notes.md')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(pathsEqual('D:/proj/Notes.md', 'd:/proj/notes.md')).toBe(true);
  });

  it('rejects different files', () => {
    expect(pathsEqual('D:/proj/a.md', 'D:/proj/b.md')).toBe(false);
  });
});
