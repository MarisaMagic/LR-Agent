/**
 * LR-Agent-local 本地 Agent 编排服务进程管理。
 *
 * 由 Electron 主进程 spawn 一个长驻 uvicorn 子进程（FastAPI，仅监听 127.0.0.1），
 * 承担 Assist 工具循环 SSE、标注 / 质量报告 LLM 编排。
 * 用户认证仍走云端 LR-Agent-backend；本服务无认证、无数据库。
 *
 * 生命周期对齐 mcp/server.ts：start → getBaseUrl → stop。
 * Python 环境解析对齐 preAnnot/inferenceProcess.ts：
 *   - LR_AGENT_LOCAL_PYTHON     Python 可执行文件完整路径
 *   - LR_AGENT_LOCAL_CONDA_ENV  conda 环境名（默认 lr-agent-local）
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import http from 'http';
import net from 'net';
import fs from 'fs-extra';
import path from 'path';
import { app } from 'electron';
import { buildInferenceSpawnEnv } from '../preAnnot/inferenceProcess';

let processRef: ChildProcessWithoutNullStreams | null = null;
let startingProcess: Promise<string> | null = null;
let listenPort: number | null = null;

const HEALTH_TIMEOUT_MS = 20_000;
const HEALTH_INTERVAL_MS = 300;

function getLocalAgentRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'local-agent');
  }
  return path.resolve(app.getAppPath(), 'vendor', 'local-agent');
}

function trimEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizePythonPath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return trimmed;
  if (fs.existsSync(trimmed) && fs.statSync(trimmed).isDirectory()) {
    return process.platform === 'win32'
      ? path.join(trimmed, 'python.exe')
      : path.join(trimmed, 'bin', 'python');
  }
  return trimmed;
}

function condaEnvCandidates(condaEnv: string): string[] {
  const userHome = app.getPath('home');
  if (process.platform === 'win32') {
    return [
      path.join(userHome, 'anaconda3', 'envs', condaEnv, 'python.exe'),
      path.join(userHome, 'miniconda3', 'envs', condaEnv, 'python.exe'),
      path.join(userHome, 'AppData', 'Local', 'miniconda3', 'envs', condaEnv, 'python.exe'),
      path.join(userHome, 'AppData', 'Local', 'anaconda3', 'envs', condaEnv, 'python.exe'),
    ];
  }
  return [
    path.join(userHome, 'miniconda3', 'envs', condaEnv, 'bin', 'python'),
    path.join(userHome, 'anaconda3', 'envs', condaEnv, 'bin', 'python'),
  ];
}

export function resolveLocalAgentPython(): string {
  const condaEnv = process.env.LR_AGENT_LOCAL_CONDA_ENV ?? 'lr-agent-local';
  const candidates: string[] = [];

  const fromEnv = trimEnv(process.env.LR_AGENT_LOCAL_PYTHON);
  if (fromEnv) {
    candidates.push(normalizePythonPath(fromEnv));
  }

  const home = trimEnv(process.env.CONDA_PREFIX);
  if (home && path.basename(home) === condaEnv) {
    candidates.push(
      process.platform === 'win32'
        ? path.join(home, 'python.exe')
        : path.join(home, 'bin', 'python'),
    );
  }

  candidates.push(...condaEnvCandidates(condaEnv));

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  console.warn(
    '[localAgent] lr-agent-local python not found; falling back to system python. ' +
      'Set LR_AGENT_LOCAL_PYTHON to your env python.exe.',
  );
  return process.platform === 'win32' ? 'python' : 'python3';
}

/** 获取本机随机空闲端口 */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(addr.port);
      });
    });
    srv.on('error', reject);
  });
}

function pingHealth(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/health', timeout: 2000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForHealthy(port: number): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    if (processRef === null || processRef.exitCode !== null) {
      throw new Error('本地 Agent 服务进程已退出');
    }
    if (await pingHealth(port)) return;
    if (Date.now() > deadline) {
      throw new Error(`本地 Agent 服务健康检查超时（${HEALTH_TIMEOUT_MS}ms）`);
    }
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
  }
}

/** 启动本地 Agent 服务，返回 API base URL（含 /api/v1 前缀） */
export async function startLocalAgentServer(): Promise<string> {
  if (processRef && listenPort) {
    return `http://127.0.0.1:${listenPort}/api/v1`;
  }
  if (startingProcess) {
    return startingProcess;
  }

  startingProcess = (async () => {
    const root = getLocalAgentRoot();
    const entry = path.join(root, 'local_main.py');
    if (!(await fs.pathExists(entry))) {
      throw new Error(`本地 Agent 服务未找到: ${entry}`);
    }

    const port = await getFreePort();
    const pythonPath = resolveLocalAgentPython();
    const spawnEnv = buildInferenceSpawnEnv(pythonPath);
    spawnEnv.LR_AGENT_LOCAL_PORT = String(port);

    const proc = spawn(pythonPath, [entry], {
      cwd: root,
      stdio: 'pipe',
      env: spawnEnv,
    }) as ChildProcessWithoutNullStreams;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      console.log('[localAgent]', chunk.trimEnd());
    });
    proc.stderr.on('data', (chunk: string) => {
      console.error('[localAgent]', chunk.trimEnd());
    });
    proc.on('exit', (code) => {
      console.log(`[localAgent] process exited with code ${code}`);
      if (processRef === proc) {
        processRef = null;
        listenPort = null;
      }
    });

    processRef = proc;
    try {
      await waitForHealthy(port);
    } catch (err) {
      proc.kill();
      processRef = null;
      throw err;
    }

    listenPort = port;
    const baseUrl = `http://127.0.0.1:${port}/api/v1`;
    console.log(`[localAgent] Local agent server started at ${baseUrl}`);
    return baseUrl;
  })();

  try {
    return await startingProcess;
  } finally {
    startingProcess = null;
  }
}

/** 停止本地 Agent 服务 */
export function stopLocalAgentServer(): void {
  if (processRef) {
    processRef.kill();
    processRef = null;
    listenPort = null;
  }
}

/** 获取当前服务 base URL（未启动时返回 null） */
export function getLocalAgentBaseUrl(): string | null {
  if (listenPort) return `http://127.0.0.1:${listenPort}/api/v1`;
  return null;
}
