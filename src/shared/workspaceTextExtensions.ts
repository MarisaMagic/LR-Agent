/**
 * 工作区文件策略：二进制/富媒体黑名单 + 默认文本可编辑。
 * 须与 LR-Agent-backend/app/agent/tools/workspace_text_extensions.py 保持同步。
 */

function fileBaseName(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() || filePath;
}

function fileExtension(filePath: string): string {
  const name = fileBaseName(filePath);
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  if (dot === 0) {
    return name.slice(1).toLowerCase();
  }
  return name.slice(dot + 1).toLowerCase();
}

/** 禁止 Monaco 编辑、禁止 write_workspace_file / Electron 写盘的扩展名。 */
export const TEXT_WRITE_BLOCKLIST = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.svg',
  '.pdf',
  '.docx',
  '.doc',
  '.zip',
  '.rar',
  '.7z',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.mp3',
  '.mp4',
  '.avi',
  '.mov',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
]);

/** FileViewer 专用预览扩展名（与写盘黑名单一致）。 */
export const SPECIAL_PREVIEW_EXTENSIONS = TEXT_WRITE_BLOCKLIST;

function getDottedExtension(filePath: string): string {
  const ext = fileExtension(filePath);
  if (!ext) return '';
  return `.${ext.toLowerCase()}`;
}

export function isBlockedTextExtension(ext: string): boolean {
  const normalized = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return TEXT_WRITE_BLOCKLIST.has(normalized);
}

export function isSpecialPreviewFile(filePath: string): boolean {
  const dotted = getDottedExtension(filePath);
  if (!dotted) return false;
  return SPECIAL_PREVIEW_EXTENSIONS.has(dotted);
}

/** 默认 true；仅命中黑名单时不可 Monaco 编辑 / 写盘。 */
export function isTextEditableFile(filePath: string): boolean {
  return !isSpecialPreviewFile(filePath);
}

/** @deprecated 使用 isTextEditableFile / isBlockedTextExtension */
export function isAllowedTextFileExtension(ext: string): boolean {
  return !isBlockedTextExtension(ext);
}

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);

export function isMarkdownExtension(ext: string): boolean {
  return MARKDOWN_EXTENSIONS.has(ext.toLowerCase().replace(/^\./, ''));
}

export function isMarkdownFile(filePath: string): boolean {
  return isMarkdownExtension(fileExtension(filePath));
}

/** 图片扩展名（不含点），供 FileViewer 路由。 */
export const IMAGE_PREVIEW_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'bmp',
  'ico',
]);

export function isImagePreviewFile(filePath: string): boolean {
  return IMAGE_PREVIEW_EXTENSIONS.has(fileExtension(filePath));
}

export function isPdfPreviewFile(filePath: string): boolean {
  return fileExtension(filePath) === 'pdf';
}

export function isDocxPreviewFile(filePath: string): boolean {
  const ext = fileExtension(filePath);
  return ext === 'docx' || ext === 'doc';
}

export function getFileBaseName(filePath: string): string {
  return fileBaseName(filePath);
}
