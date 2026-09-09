export type AgentFilePreviewSession = {
  absolutePath: string;
  relativePath: string;
  oldContent: string;
  newContent: string;
  operation: 'write' | 'delete';
};

type Listener = () => void;

let session: AgentFilePreviewSession | null = null;
const listeners = new Set<Listener>();

export function normalizeFsPath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function pathsEqual(left: string, right: string): boolean {
  return normalizeFsPath(left) === normalizeFsPath(right);
}

export function getFilePreviewSession(): AgentFilePreviewSession | null {
  return session;
}

export function setFilePreviewSession(
  next: AgentFilePreviewSession | null,
): void {
  session = next;
  listeners.forEach((listener) => listener());
}

export function clearFilePreviewSession(): void {
  setFilePreviewSession(null);
}

export function clearFilePreviewIfPathChanged(filePath: string): void {
  if (session && !pathsEqual(session.absolutePath, filePath)) {
    clearFilePreviewSession();
  }
}

export function dispatchWorkspaceTextFilesChanged(paths: string[]): void {
  if (typeof window === 'undefined') return;
  const unique = [...new Set(paths.filter(Boolean))];
  if (unique.length === 0) return;
  window.dispatchEvent(
    new CustomEvent('lr-agent:workspace-text-files-changed', {
      detail: { paths: unique },
    }),
  );
}

export function subscribeFilePreview(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
