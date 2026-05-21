import { getExtension } from '../types/file';

const EXT_ICON: Record<string, string> = {
  ts: 'file-code',
  tsx: 'react',
  js: 'file-code',
  jsx: 'react',
  json: 'json',
  md: 'markdown',
  markdown: 'markdown',
  css: 'css',
  scss: 'css',
  html: 'html',
  pdf: 'file-pdf',
  png: 'file-media',
  jpg: 'file-media',
  jpeg: 'file-media',
  gif: 'file-media',
  svg: 'file-media',
  webp: 'file-media',
};

export default function getFileCodicon(fileName: string): string {
  const ext = getExtension(fileName);
  return EXT_ICON[ext] ?? 'file';
}
