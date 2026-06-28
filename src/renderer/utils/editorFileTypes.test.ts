import { describe, expect, it } from '@jest/globals';
import { isMonacoEditableFile } from './editorFileTypes';

describe('isMonacoEditableFile', () => {
  it('accepts common text/code extensions', () => {
    expect(isMonacoEditableFile('/ws/src/main.py')).toBe(true);
    expect(isMonacoEditableFile('/ws/readme.md')).toBe(true);
    expect(isMonacoEditableFile('/ws/app.ts')).toBe(true);
  });

  it('rejects binary-like extensions', () => {
    expect(isMonacoEditableFile('/ws/image.png')).toBe(false);
    expect(isMonacoEditableFile('/ws/doc.pdf')).toBe(false);
  });
});
