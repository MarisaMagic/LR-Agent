import { describe, expect, it } from 'vitest';
import { formatAnalysisStdout } from './analysisOutputFormat';

describe('formatAnalysisStdout', () => {
  it('decodes unicode escape sequences', () => {
    expect(formatAnalysisStdout('{"label": "\\u4eba\\u7269"}')).toContain('人物');
  });

  it('pretty-prints json objects', () => {
    const out = formatAnalysisStdout('{"a":1,"b":2}');
    expect(out).toContain('"a": 1');
  });
});
