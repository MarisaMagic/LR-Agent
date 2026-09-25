/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import { maybePreviewLargeResult } from './resultOffload';
import { DEFAULT_AGENT_SETTINGS } from '../config';

const settings = {
  ...DEFAULT_AGENT_SETTINGS,
  toolResultPreviewBytes: 100,
  toolResultPreviewChars: 20,
};

describe('maybePreviewLargeResult', () => {
  it('小于阈值时原样返回', () => {
    const result = 'x'.repeat(50);
    expect(
      maybePreviewLargeResult({
        toolName: 'read_workspace_file',
        result,
        settings,
      }),
    ).toBe(result);
  });

  it('可重取工具超阈值时折叠为预览 + 重取提示', () => {
    const result = 'x'.repeat(500);
    const out = maybePreviewLargeResult({
      toolName: 'read_workspace_file',
      result,
      settings,
    });
    expect(out).not.toBe(result);
    expect(out.startsWith('x'.repeat(20))).toBe(true);
    expect(out).toContain('结果过大已截断');
    expect(out).toContain('offset / limit');
  });

  it('不可重取工具即使很大也不折叠', () => {
    const result = 'y'.repeat(500);
    expect(
      maybePreviewLargeResult({
        toolName: 'auto_annotate',
        result,
        settings,
      }),
    ).toBe(result);
  });

  it('阈值为 0 时关闭', () => {
    const result = 'z'.repeat(500);
    expect(
      maybePreviewLargeResult({
        toolName: 'grep_workspace',
        result,
        settings: { ...settings, toolResultPreviewBytes: 0 },
      }),
    ).toBe(result);
  });
});
