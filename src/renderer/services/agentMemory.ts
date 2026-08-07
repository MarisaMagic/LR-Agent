/**
 * Auto Memory 前端服务：作用域计算 + MEMORY.md 索引读取（经主进程 IPC）。
 *
 * 作用域：
 * - 标注项目：projects/{annotationProjectId}
 * - 工作区（编辑器模式）：projects/ws-{workspaceRoot 哈希}
 * - 无项目上下文：user
 */

type MemoryBridge = {
  electron?: {
    memory?: {
      readIndex?: (scopeKey: string) => Promise<string | null>;
      openDir?: (scopeKey: string) => Promise<string>;
    };
  };
};

function getBridge() {
  return (window as Window & typeof globalThis & MemoryBridge).electron?.memory;
}

/** djb2 哈希，用于把工作区路径映射为稳定目录名 */
function hashString(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function sanitizeScopeSegment(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._-]/g, '-');
}

export function computeMemoryScopeKey(options: {
  annotationProjectId?: string | null;
  workspaceRoot?: string | null;
}): string {
  if (options.annotationProjectId?.trim()) {
    return `projects/${sanitizeScopeSegment(options.annotationProjectId.trim())}`;
  }
  if (options.workspaceRoot?.trim()) {
    return `projects/ws-${hashString(options.workspaceRoot.trim())}`;
  }
  return 'user';
}

/**
 * 读取当前作用域的 MEMORY.md 索引（主进程已截断）。
 * 同时会把该作用域设为活动记忆作用域（MCP memory 工具使用）。
 */
export async function loadMemoryIndex(scopeKey: string): Promise<string | null> {
  const bridge = getBridge();
  if (!bridge?.readIndex) return null;
  try {
    return await bridge.readIndex(scopeKey);
  } catch {
    return null;
  }
}

/** 打开记忆目录（文件管理器） */
export async function openMemoryDir(scopeKey: string): Promise<void> {
  const bridge = getBridge();
  await bridge?.openDir?.(scopeKey);
}
