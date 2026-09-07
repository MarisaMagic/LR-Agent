/**
 * API 地址配置。
 *
 * - `API_BASE_URL`：云端 LR-Agent-backend（仅 auth / users 账号体系）
 * - `LOCAL_AGENT_BASE_URL`：本机 LR-Agent-local（Agent 编排：Assist / 标注 / 质量报告）
 *
 * 本地 Agent 服务由 Electron 主进程 spawn，端口随机分配；
 * renderer 通过 IPC（window.electron.localAgent.getBaseUrl）获取实际地址。
 */

export const API_BASE_URL =
  process.env.API_BASE_URL ?? 'http://localhost:8000/api/v1';

/** 本地 Agent 服务默认地址（IPC 不可用时的回退，对应 local_main.py 默认端口） */
export const LOCAL_AGENT_DEFAULT_BASE_URL = 'http://127.0.0.1:8765/api/v1';

export const REMEMBERED_EMAIL_KEY = 'lr-agent:remembered-email';

/** Resolve API base URL; uses page hostname for LAN/mobile verify flows. */
export function resolveApiBaseUrl(): string {
  if (process.env.API_BASE_URL) {
    return process.env.API_BASE_URL;
  }
  if (typeof window !== 'undefined' && window.location.hostname) {
    return `http://${window.location.hostname}:8000/api/v1`;
  }
  return API_BASE_URL;
}

let cachedLocalAgentBaseUrl: string | null = null;

/** 供测试或强制刷新时清除缓存 */
export function resetLocalAgentBaseUrlCache(): void {
  cachedLocalAgentBaseUrl = null;
}

/**
 * 解析本地 Agent 服务 base URL。
 *
 * 优先使用 Electron main 进程持有的实际监听地址（随机端口）；
 * 服务尚未就绪时短暂重试；IPC 不可用（如纯 Web 调试）时回退默认端口。
 */
export async function resolveLocalAgentBaseUrl(options?: {
  retries?: number;
  intervalMs?: number;
}): Promise<string> {
  if (cachedLocalAgentBaseUrl) {
    return cachedLocalAgentBaseUrl;
  }

  const retries = options?.retries ?? 10;
  const intervalMs = options?.intervalMs ?? 500;

  const query = async (): Promise<string | null> => {
    if (typeof window === 'undefined') return null;
    return (
      (await window.electron?.localAgent?.getBaseUrl?.().catch(() => null)) ??
      null
    );
  };

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const url = await query();
    if (url) {
      cachedLocalAgentBaseUrl = url;
      return url;
    }
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return LOCAL_AGENT_DEFAULT_BASE_URL;
}
