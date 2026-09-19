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

/**
 * 本地 Agent 服务默认地址。
 *
 * 仅在 IPC 不可用（如纯 Web 调试）时作为回退；**注意此时没有 token**。
 * 该回退值**不会被缓存**，因此下一次请求仍会重新尝试 IPC。
 */
export const LOCAL_AGENT_DEFAULT_BASE_URL = 'http://127.0.0.1:8765/api/v1';

export const REMEMBERED_EMAIL_KEY = 'lr-agent:remembered-email';

// 运行时覆盖：由 environment.json（环境向导持久化的 backendBaseUrl）引导期注入，
// 优先于编译期 API_BASE_URL；更换后端地址后需重新登录才会作用于账户会话。
let apiBaseUrlOverride: string | null = null;

/** 设置后端地址运行时覆盖（空值清除覆盖，恢复默认） */
export function setApiBaseUrlOverride(url: string | null): void {
  apiBaseUrlOverride = url?.trim() || null;
}

/** Resolve API base URL; uses page hostname for LAN/mobile verify flows. */
export function resolveApiBaseUrl(): string {
  if (apiBaseUrlOverride) {
    return apiBaseUrlOverride;
  }
  if (process.env.API_BASE_URL) {
    return process.env.API_BASE_URL;
  }
  if (typeof window !== 'undefined' && window.location.hostname) {
    return `http://${window.location.hostname}:8000/api/v1`;
  }
  return API_BASE_URL;
}

let cachedLocalAgentBaseUrl: string | null = null;
let cachedLocalAgentToken: string | null = null;

/**
 * 失效本地 Agent 的地址与 token 缓存。
 *
 * 什么时候必须调用：**运行时重启会换随机端口与新 token**（见
 * `src/main/agent/host.ts` 的自动重启），此时旧缓存会让后续请求全部打向
 * 已死端口——表现为「突然 network error 且不再恢复」。
 *
 * 调用方：`EnvironmentContext` 订阅 `localAgent:status` 时（主进程推
 * `running` 即代表换过端口），以及本模块在连接失败/401 时的自愈重试。
 */
export function invalidateLocalAgentAuth(): void {
  cachedLocalAgentBaseUrl = null;
  cachedLocalAgentToken = null;
}

/** 是否已持有可用的本地 Agent 地址（不含未缓存的默认回退）。 */
export function hasLocalAgentAuth(): boolean {
  return cachedLocalAgentBaseUrl !== null;
}

async function queryLocalAgentEndpoint(): Promise<{
  url: string;
  token: string;
} | null> {
  if (typeof window === 'undefined') return null;
  return (
    (await window.electron?.localAgent?.getBaseUrl?.().catch(() => null)) ??
    null
  );
}

/**
 * 解析本地 Agent 服务 base URL 与访问 token。
 *
 * 优先使用 Electron main 进程持有的实际监听地址（随机端口）；
 * 服务尚未就绪时短暂重试；IPC 不可用（如纯 Web 调试）时回退默认端口（此时无 token）。
 */
export async function resolveLocalAgentAuth(options?: {
  retries?: number;
  intervalMs?: number;
}): Promise<{ baseUrl: string; token: string | null }> {
  if (cachedLocalAgentBaseUrl) {
    return { baseUrl: cachedLocalAgentBaseUrl, token: cachedLocalAgentToken };
  }

  const retries = options?.retries ?? 10;
  const intervalMs = options?.intervalMs ?? 500;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const result = await queryLocalAgentEndpoint();
    if (result) {
      cachedLocalAgentBaseUrl = result.url;
      cachedLocalAgentToken = result.token;
      return { baseUrl: result.url, token: result.token };
    }
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  return { baseUrl: LOCAL_AGENT_DEFAULT_BASE_URL, token: null };
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
  const { baseUrl } = await resolveLocalAgentAuth(options);
  return baseUrl;
}

/**
 * 清缓存并重新向主进程查询地址。
 *
 * @returns 真正从 IPC 拿到的 baseUrl；仍不可用时返回 null（不回退默认端口，
 *          因为那个地址此时已知不可用，重试只会白费一次请求）
 */
async function refreshLocalAgentAuth(): Promise<string | null> {
  invalidateLocalAgentAuth();
  await resolveLocalAgentAuth();
  return cachedLocalAgentBaseUrl;
}

/**
 * 把请求 URL 的 origin 换成新的 base（路径与查询保持不变）。
 *
 * 这样调用方无需感知重试：它们仍然用「解析出的 baseUrl + 路径」拼 URL，
 * 重试时由本模块统一改写主机与端口。
 */
function rewriteBase(input: string, newBaseUrl: string): string {
  try {
    const target = new URL(input, 'http://127.0.0.1');
    const base = new URL(newBaseUrl);
    target.protocol = base.protocol;
    target.host = base.host;
    return target.toString();
  } catch {
    return input;
  }
}

/** 本地服务不可达时的统一文案（替代裸的 `Failed to fetch`）。 */
const UNAVAILABLE_MESSAGE = '本机 Agent 服务未就绪，请稍后重试或重启应用';

/**
 * 携带本地服务 Bearer token 的 fetch 封装。
 * 所有发往 LR-Agent-local 的请求都应经此发出（否则服务返回 401）。
 *
 * **带一次自愈重试**：运行时可能刚崩溃重启过（换了端口与 token），
 * 而渲染层仍持有旧缓存。命中以下两种情形时清缓存、重新解析、重试一次：
 *
 *   1. **网络异常**（连接被拒 / 端口关闭）——旧端口已死，或此前回退到了
 *      默认端口；此时即便没有缓存也值得重试，因为运行时可能已经重启完毕。
 *   2. **401 且此前发过 token**——端口没变但 token 已随重启更换。
 *
 * 用户主动取消（`signal.aborted`）不重试，避免掩盖取消语义。
 */
export async function localAgentFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  if (!cachedLocalAgentBaseUrl) {
    await resolveLocalAgentAuth();
  }
  const hadToken = cachedLocalAgentToken !== null;

  const send = (url: string): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (cachedLocalAgentToken && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${cachedLocalAgentToken}`);
    }
    return fetch(url, { ...init, headers });
  };

  let response: Response;
  try {
    response = await send(input);
  } catch (err) {
    if (init?.signal?.aborted) throw err;
    const recovered = await refreshLocalAgentAuth();
    if (!recovered) throw new Error(UNAVAILABLE_MESSAGE);
    try {
      return await send(rewriteBase(input, recovered));
    } catch (retryErr) {
      // 重试也失败：统一成明确文案，避免裸的 `Failed to fetch` 漏到 UI
      if (init?.signal?.aborted) throw retryErr;
      throw new Error(UNAVAILABLE_MESSAGE);
    }
  }

  // 端口复用但 token 已更换：重试一次拿新 token
  if (response.status === 401 && hadToken) {
    const recovered = await refreshLocalAgentAuth();
    if (recovered) return send(rewriteBase(input, recovered));
  }

  return response;
}
