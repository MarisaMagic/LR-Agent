/**
 * 阶段 1 验收：真实 Electron `utilityProcess.fork` + RPC 冒烟。
 *
 * 单元测试用内存端点验证了桥的逻辑，但没验证 Electron 的真实 fork 语义：
 *   - `utilityProcess.fork` 能否加载 webpack 产出的 UMD bundle
 *   - `stdio: 'pipe'` 是否可用、stdout 能否被主进程读到
 *   - `child.on('message')` 收到的是裸对象还是包裹结构
 *   - 子进程 `process.parentPort` 双向 postMessage 是否对称
 *   - 端口绑定 0 后实际端口能否回报
 *   - `shutdown` 消息能否让子进程优雅退出且退出码为 0
 *
 * 这些是 jest（Electron 全 mock）覆盖不到的部分。
 *
 * 用法：
 *   npx electron scripts/agent-baseline/electronForkSmoke.js
 *
 * 退出码 0 表示全部通过。
 */

const path = require('node:path');
const http = require('node:http');
const { app, utilityProcess } = require('electron');

const ENTRY = path.resolve(
  __dirname,
  '..',
  '..',
  '.erb',
  'dll',
  'agentRuntime.bundle.dev.js',
);
const TOKEN = 'smoke-token-abcdef';

let failures = 0;
function check(ok, label, detail = '') {
  if (ok) {
    console.log(`  OK   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function get(port, urlPath, headers, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, headers, method, timeout: 5000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

/** 主进程侧的最小 RPC 客户端（与 bridge.ts 的线格式一致）。 */
function makeRpc(child) {
  const pending = new Map();
  let nextId = 1;

  child.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'rpc:response') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error));
    }
  });

  return {
    call(channel, payload) {
      const id = `h${nextId}`;
      nextId += 1;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`rpc timeout on ${channel}`)),
          5000,
        );
        pending.set(id, { resolve, reject, timer });
        child.postMessage({ type: 'rpc:request', id, channel, payload });
      });
    },
  };
}

function waitForReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ready timeout')), timeoutMs);
    child.on('message', (m) => {
      if (m && m.type === 'ready') {
        clearTimeout(timer);
        resolve(m.port);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`exited during startup: ${code}`));
    });
  });
}

const stdoutChunks = [];

app.whenReady().then(async () => {
  console.log(`[smoke] 入口: ${ENTRY}`);
  console.log('— fork 与就绪 —');

  const child = utilityProcess.fork(ENTRY, [], {
    serviceName: 'lr-agent-runtime-smoke',
    stdio: 'pipe',
    env: {
      ...process.env,
      LR_AGENT_LOCAL_TOKEN: TOKEN,
      LR_AGENT_LOCAL_PORT: '0',
    },
  });

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (c) => stdoutChunks.push(c));
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (c) => stdoutChunks.push(c));

  let port = 0;
  try {
    port = await waitForReady(child, 15000);
    check(port > 0, `收到 ready 消息并拿到端口 (${port})`);
  } catch (err) {
    check(false, '收到 ready 消息', err.message);
    console.log(stdoutChunks.join(''));
    child.kill();
    app.exit(1);
    return;
  }

  check(
    child.pid !== undefined && child.pid > 0,
    '子进程有独立 pid（独立进程而非线程）',
    `pid=${child.pid}`,
  );

  // ── HTTP 层 ──────────────────────────────────────────────
  console.log('\n— HTTP 层 —');
  try {
    const health = await get(port, '/health');
    check(health.status === 200, '/health 免鉴权返回 200', `got ${health.status}`);
    check(
      JSON.parse(health.body).status === 'ok',
      '/health 响应体正确',
      health.body,
    );
  } catch (err) {
    check(false, '/health 可达', err.message);
  }

  try {
    const noAuth = await get(port, '/api/v1/agent/chat/stream');
    check(noAuth.status === 401, '无 token 访问业务路由返回 401', `got ${noAuth.status}`);
  } catch (err) {
    check(false, '无 token 访问业务路由', err.message);
  }

  try {
    // /chat/cancel 现已实现：应返回 200 {ok:true}
    const withAuth = await get(
      port,
      '/api/v1/agent/chat/cancel',
      { Authorization: `Bearer ${TOKEN}` },
      'POST',
    );
    check(
      withAuth.status === 200,
      '带 token 通过鉴权并到达已实现路由 (200)',
      `got ${withAuth.status}`,
    );
    check(
      JSON.parse(withAuth.body || '{}').ok === true,
      '/chat/cancel 返回 {ok:true}',
      withAuth.body,
    );
  } catch (err) {
    check(false, '带 token 访问业务路由', err.message);
  }

  // ── RPC 层 ───────────────────────────────────────────────
  console.log('\n— RPC 层 —');
  const rpc = makeRpc(child);

  try {
    const pong = await rpc.call('ping', {});
    check(pong && pong.ok === true, '运行时响应 ping（消息通道双向可用）');
  } catch (err) {
    check(false, '运行时响应 ping', err.message);
  }

  try {
    await rpc.call('nonexistent:channel', {});
    check(false, '未注册通道应返回结构化错误');
  } catch (err) {
    check(
      /unknown channel/.test(err.message),
      '未注册通道返回结构化错误（异常未穿越进程边界）',
      err.message,
    );
  }

  // ── 优雅退出 ─────────────────────────────────────────────
  console.log('\n— 优雅退出 —');
  const exitCode = await new Promise((resolve) => {
    child.once('exit', (code) => resolve(code));
    child.postMessage({ type: 'shutdown' });
    setTimeout(() => {
      child.kill();
      resolve('killed');
    }, 5000);
  });
  check(exitCode === 0, 'shutdown 消息触发退出且退出码为 0', `exit=${exitCode}`);

  console.log(failures ? `\n[smoke] 失败 ${failures} 项` : '\n[smoke] 全部通过');
  app.exit(failures ? 1 : 0);
});

app.on('window-all-closed', () => {
  /* 不创建窗口，避免 Electron 在无窗口时提前退出 */
});
