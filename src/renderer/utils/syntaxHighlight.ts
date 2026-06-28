import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { getExtension } from '../types/file';

const EXT_TO_LANGUAGE: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  pyw: 'python',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'css',
  sass: 'css',
  less: 'css',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  swift: 'swift',
  dockerfile: 'bash',
  ini: 'plaintext',
  toml: 'plaintext',
  env: 'plaintext',
  txt: 'plaintext',
  log: 'plaintext',
};

const MARKDOWN_LANGUAGE_ALIASES: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  console: 'bash',
  zsh: 'bash',
  dockerfile: 'bash',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  pyw: 'python',
  yml: 'yaml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  vue: 'xml',
  md: 'markdown',
  rs: 'rust',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  rb: 'ruby',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  h: 'c',
  jsonc: 'json',
  scss: 'css',
  sass: 'css',
  less: 'css',
};

let registered = false;

function ensureLanguagesRegistered(): void {
  if (registered) return;
  registered = true;

  hljs.registerLanguage('javascript', javascript);
  hljs.registerLanguage('typescript', typescript);
  hljs.registerLanguage('python', python);
  hljs.registerLanguage('json', json);
  hljs.registerLanguage('css', css);
  hljs.registerLanguage('xml', xml);
  hljs.registerLanguage('markdown', markdown);
  hljs.registerLanguage('bash', bash);
  hljs.registerLanguage('yaml', yaml);
  hljs.registerLanguage('sql', sql);
  hljs.registerLanguage('go', go);
  hljs.registerLanguage('rust', rust);
  hljs.registerLanguage('java', java);
  hljs.registerLanguage('kotlin', kotlin);
  hljs.registerLanguage('c', c);
  hljs.registerLanguage('cpp', cpp);
  hljs.registerLanguage('csharp', csharp);
  hljs.registerLanguage('php', php);
  hljs.registerLanguage('ruby', ruby);
  hljs.registerLanguage('swift', swift);
}

export function getHighlightLanguage(filePath: string): string | null {
  const ext = getExtension(filePath);
  if (!ext) return null;
  return EXT_TO_LANGUAGE[ext] ?? null;
}

export function highlightCode(content: string, filePath: string): string {
  ensureLanguagesRegistered();

  const language = getHighlightLanguage(filePath);
  if (language && hljs.getLanguage(language)) {
    return hljs.highlight(content, { language }).value;
  }

  return hljs.highlightAuto(content).value;
}

export function normalizeMarkdownLanguage(lang: string): string | null {
  const trimmed = lang.trim().toLowerCase();
  if (!trimmed || trimmed === 'text' || trimmed === 'plaintext') {
    return null;
  }
  const aliased = MARKDOWN_LANGUAGE_ALIASES[trimmed] ?? trimmed;
  return aliased;
}

export function highlightMarkdownCode(
  content: string,
  language?: string | null,
): string {
  ensureLanguagesRegistered();

  const normalized = language ? normalizeMarkdownLanguage(language) : null;
  if (normalized && hljs.getLanguage(normalized)) {
    return hljs.highlight(content, { language: normalized }).value;
  }

  return hljs.highlightAuto(content).value;
}
