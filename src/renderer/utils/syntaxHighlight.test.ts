import {
  highlightMarkdownCode,
  normalizeMarkdownLanguage,
} from './syntaxHighlight';

describe('normalizeMarkdownLanguage', () => {
  it('maps shell aliases to bash', () => {
    expect(normalizeMarkdownLanguage('shell')).toBe('bash');
    expect(normalizeMarkdownLanguage('sh')).toBe('bash');
    expect(normalizeMarkdownLanguage('console')).toBe('bash');
    expect(normalizeMarkdownLanguage('zsh')).toBe('bash');
  });

  it('returns null for plain text markers', () => {
    expect(normalizeMarkdownLanguage('text')).toBeNull();
    expect(normalizeMarkdownLanguage('plaintext')).toBeNull();
    expect(normalizeMarkdownLanguage('')).toBeNull();
  });

  it('passes through registered languages', () => {
    expect(normalizeMarkdownLanguage('python')).toBe('python');
    expect(normalizeMarkdownLanguage('js')).toBe('javascript');
  });
});

describe('highlightMarkdownCode', () => {
  it('highlights bash fenced code with hljs spans', () => {
    const html = highlightMarkdownCode('echo hi', 'bash');
    expect(html).toMatch(/hljs-/);
    expect(html).toContain('echo');
  });

  it('falls back to highlightAuto for unknown languages', () => {
    expect(() =>
      highlightMarkdownCode('const x = 1', 'not-a-real-language'),
    ).not.toThrow();
    const html = highlightMarkdownCode('const x = 1', 'not-a-real-language');
    expect(html).toContain('const');
  });

  it('uses highlightAuto when language is null', () => {
    const html = highlightMarkdownCode('print("hi")', null);
    expect(html).toContain('print');
  });
});
