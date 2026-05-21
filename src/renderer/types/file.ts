export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'folder';
  children?: FileNode[];
  isLoading?: boolean;
}

export function basename(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() || filePath;
}

export function getExtension(filePath: string): string {
  const name = basename(filePath);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot + 1).toLowerCase();
}
