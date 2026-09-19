/**
 * @jest-environment node
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import {
  hasLocalAgentAuth,
  invalidateLocalAgentAuth,
  localAgentFetch,
  resolveLocalAgentAuth,
} from './config';

/**
 * `localAgentFetch` 内部的地址解析用的是默认重试参数（10 × 500ms ≈ 5s），
 * 因此「IPC 不可用」这类用例天然需要更长时间。
 */
jest.setTimeout(30_000);

/** 安装一个可控的 `window.electron.localAgent.getBaseUrl`。 */
function installIpc(
  handler: () => Promise<{ url: string; token: string } | null>,
): void {
  (globalThis as unknown as { window: unknown }).window = {
    electron: { localAgent: { getBaseUrl: handler } },
  };
}

/** 让 IPC 始终返回同一地址。 */
function ipcReturning(url: string, token: string): void {
  installIpc(async () => ({ url, token }));
}

beforeEach(() => {
  invalidateLocalAgentAuth();
  delete (globalThis as { fetch?: unknown }).fetch;
});

afterEach(() => {
  invalidateLocalAgentAuth();
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { fetch?: unknown }).fetch;
  jest.restoreAllMocks();
});

const FAST = { retries: 0, intervalMs: 0 };

describe('invalidateLocalAgentAuth / hasLocalAgentAuth', () => {
  it('初始无缓存', () => {
    expect(hasLocalAgentAuth()).toBe(false);
  });

  it('解析成功后进入有缓存状态', async () => {
    ipcReturning('http://127.0.0.1:1111/api/v1', 't1');
    await resolveLocalAgentAuth(FAST);
    expect(hasLocalAgentAuth()).toBe(true);
  });

  it('失效后回到无缓存状态', async () => {
    ipcReturning('http://127.0.0.1:1111/api/v1', 't1');
    await resolveLocalAgentAuth(FAST);
    invalidateLocalAgentAuth();
    expect(hasLocalAgentAuth()).toBe(false);
  });

  it('IPC 不可用时不写入缓存（回退默认端口不算缓存）', async () => {
    installIpc(async () => null);
    const auth = await resolveLocalAgentAuth(FAST);
    expect(auth.token).toBeNull();
    expect(hasLocalAgentAuth()).toBe(false);
  });
});

describe('localAgentFetch：网络异常自愈', () => {
  it('首次失败后清缓存、换新地址重试一次', async () => {
    let calls = 0;
    let asked = 0;
    installIpc(async () => {
      asked += 1;
      // 第一次给旧地址，第二次给新地址（模拟运行时重启换了端口）
      return asked === 1
        ? { url: 'http://127.0.0.1:1111/api/v1', token: 'old' }
        : { url: 'http://127.0.0.1:2222/api/v1', token: 'new' };
    });

    const seen: string[] = [];
    (globalThis as unknown as { fetch: unknown }).fetch = async (
      url: string,
    ) => {
      calls += 1;
      seen.push(url);
      if (calls === 1) throw new TypeError('Failed to fetch');
      return { status: 200 } as Response;
    };

    const response = await localAgentFetch(
      'http://127.0.0.1:1111/api/v1/agent/chat/stream',
    );

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    // 重试应改写为新 host，路径保持不变
    expect(seen[0]).toBe('http://127.0.0.1:1111/api/v1/agent/chat/stream');
    expect(seen[1]).toBe('http://127.0.0.1:2222/api/v1/agent/chat/stream');
  });

  it('重试仍失败时抛明确文案（替代裸 Failed to fetch）', async () => {
    ipcReturning('http://127.0.0.1:1111/api/v1', 't1');
    (globalThis as unknown as { fetch: unknown }).fetch = async () => {
      throw new TypeError('Failed to fetch');
    };

    await expect(
      localAgentFetch('http://127.0.0.1:1111/api/v1/agent/chat/cancel'),
    ).rejects.toThrow('本机 Agent 服务未就绪');
  });

  it('无法重新解析地址时不重试，直接抛文案', async () => {
    installIpc(async () => null);
    let calls = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = async () => {
      calls += 1;
      throw new TypeError('Failed to fetch');
    };

    await expect(
      localAgentFetch('http://127.0.0.1:1111/api/v1/agent/chat/cancel'),
    ).rejects.toThrow('本机 Agent 服务未就绪');
    // 只尝试了一次：没有可用地址就不该白白重试
    expect(calls).toBe(1);
  });

  it('用户取消（signal.aborted）不重试', async () => {
    ipcReturning('http://127.0.0.1:1111/api/v1', 't1');
    const controller = new AbortController();
    controller.abort();

    let calls = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = async () => {
      calls += 1;
      throw new DOMException('Aborted', 'AbortError');
    };

    await expect(
      localAgentFetch('http://127.0.0.1:1111/api/v1/agent/chat/stream', {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('localAgentFetch：401 自愈', () => {
  it('401 且此前发过 token 时换新 token 重试', async () => {
    let asked = 0;
    installIpc(async () => {
      asked += 1;
      return asked === 1
        ? { url: 'http://127.0.0.1:1111/api/v1', token: 'old' }
        : { url: 'http://127.0.0.1:1111/api/v1', token: 'new' };
    });

    const tokens: Array<string | undefined> = [];
    let calls = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = async (
      _url: string,
      init?: { headers?: Headers },
    ) => {
      calls += 1;
      tokens.push(init?.headers?.get('Authorization') ?? undefined);
      return { status: calls === 1 ? 401 : 200 } as Response;
    };

    const response = await localAgentFetch(
      'http://127.0.0.1:1111/api/v1/agent/chat/cancel',
    );

    expect(response.status).toBe(200);
    expect(tokens[0]).toBe('Bearer old');
    expect(tokens[1]).toBe('Bearer new');
  });

  it('401 但从未持有 token 时不重试（重试也无济于事）', async () => {
    installIpc(async () => null);
    let calls = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = async () => {
      calls += 1;
      return { status: 401 } as Response;
    };

    const response = await localAgentFetch(
      'http://127.0.0.1:1111/api/v1/agent/chat/cancel',
    );
    expect(response.status).toBe(401);
    expect(calls).toBe(1);
  });

  it('非 401 的失败响应原样返回（不做无谓重试）', async () => {
    ipcReturning('http://127.0.0.1:1111/api/v1', 't1');
    let calls = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = async () => {
      calls += 1;
      return { status: 502 } as Response;
    };

    const response = await localAgentFetch(
      'http://127.0.0.1:1111/api/v1/agent/chat/stream',
    );
    expect(response.status).toBe(502);
    expect(calls).toBe(1);
  });
});
