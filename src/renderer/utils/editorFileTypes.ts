import { getExtension } from '../types/file';
import { isAllowedTextFileExtension } from '../../shared/workspaceTextExtensions';

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);

export function isMonacoEditableFile(filePath: string): boolean {
  const ext = getExtension(filePath);
  if (!ext) return false;
  const dotted = `.${ext.toLowerCase()}`;
  if (isAllowedTextFileExtension(dotted)) return true;
  return MARKDOWN_EXTENSIONS.has(ext.toLowerCase());
}

export function isMarkdownFile(filePath: string): boolean {
  const ext = getExtension(filePath);
  return MARKDOWN_EXTENSIONS.has(ext.toLowerCase());
}
