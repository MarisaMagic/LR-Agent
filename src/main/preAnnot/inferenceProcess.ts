import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { app } from 'electron';
import type {
  PreAnnotRequest,
  PreAnnotResult,
  PreAnnotRuntimeInfo,
  PreAnnotRunResponse,
} from '../../shared/preAnnotTypes';

interface IpcMessage {
  ok: boolean;
  result?: PreAnnotResult;
  runtime?: Record<string, unknown>;
  error?: string;
  trace?: string;
}

type PendingEntry = {
  resolve: (value: IpcMessage) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

let processRef: ChildProcessWithoutNullStreams | null = null;
let startingProcess: Promise<ChildProcessWithoutNullStreams> | null = null;
let buffer = '';
let nextId = 0;
const pending = new Map<string, PendingEntry>();

const INFERENCE_TIMEOUT_MS = 5 * 60 * 1000;

export function getInferenceRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'inference');
  }
  return path.resolve(app.getAppPath(), '..', 'LR-Agent-inference');
}

function trimEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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

/** Resolve conda env root from .../envs/<name>/python.exe or .../envs/<name>/bin/python */
function inferCondaEnvRoot(pythonPath: string): string | null {
  const normalized = pythonPath.replace(/\\/g, '/');
  if (!normalized.toLowerCase().includes('/envs/')) return null;
  if (normalized.endsWith('/bin/python')) {
    return path.dirname(path.dirname(pythonPath));
  }
  return path.dirname(pythonPath);
}

/**
 * Prevent inherited Anaconda base vars (PYTHONHOME / PYTHONPATH / CONDA_PREFIX=base)
 * from hijacking imports to D:\\...\\anaconda3\\Lib\\site-packages.
 */
export function buildInferenceSpawnEnv(
  pythonPath: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };

  delete env.PYTHONHOME;
  delete env.PYTHONPATH;

  const envRoot = inferCondaEnvRoot(pythonPath);
  if (envRoot) {
    env.CONDA_PREFIX = envRoot;
    env.CONDA_DEFAULT_ENV = path.basename(envRoot);
    const pathParts = [
      path.join(envRoot, process.platform === 'win32' ? 'Scripts' : 'bin'),
      path.join(envRoot, process.platform === 'win32' ? 'Library\\bin' : 'lib'),
      env.PATH ?? '',
    ].filter(Boolean);
    env.PATH = pathParts.join(path.delimiter);
  }

  env.PYTHONUNBUFFERED = '1';
  env.PYTHONNOUSERSITE = '1';
  env.PYTHONIOENCODING = 'utf-8';
  if (process.platform === 'win32') {
    env.PYTHONUTF8 = '1';
  }
  return env;
}

export function resolvePythonExecutable(): string {
  const condaEnv = process.env.LR_AGENT_INFERENCE_CONDA_ENV ?? 'lr-agent-inference';
  const candidates: string[] = [];

  const fromEnv = trimEnv(process.env.LR_AGENT_INFERENCE_PYTHON);
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
    '[preAnnot] lr-agent-inference python not found; falling back to system python. ' +
      'Set LR_AGENT_INFERENCE_PYTHON to your env python.exe.',
  );
  return process.platform === 'win32' ? 'python' : 'python3';
}

function flushBuffer(): void {
  let newline = buffer.indexOf('\n');
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      handleLine(line);
    }
    newline = buffer.indexOf('\n');
  }
}

function handleLine(line: string): void {
  let payload: IpcMessage;
  try {
    payload = JSON.parse(line) as IpcMessage;
  } catch {
    console.error('[preAnnot] invalid json from inference process:', line);
    return;
  }

  // Single-flight responses without id — resolve oldest pending
  const first = pending.entries().next();
  if (first.done) return;
  const [id, entry] = first.value;
  pending.delete(id);
  clearTimeout(entry.timer);

  if (payload.ok) {
    entry.resolve({
      ok: true,
      result: payload.result,
      runtime: payload.runtime,
    });
  } else {
    entry.resolve({
      ok: false,
      error: payload.error ?? 'inference failed',
      trace: payload.trace,
    });
  }
}

function attachProcess(proc: ChildProcessWithoutNullStreams): void {
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    flushBuffer();
  });

  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk: string) => {
    console.error('[preAnnot stderr]', chunk);
  });

  proc.on('exit', (code) => {
    processRef = null;
    buffer = '';
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`inference process exited (${code ?? 'unknown'})`));
      pending.delete(id);
    }
  });
}

async function spawnProcess(): Promise<ChildProcessWithoutNullStreams> {
  if (processRef && !processRef.killed) {
    return processRef;
  }
  if (startingProcess) {
    return startingProcess;
  }

  startingProcess = (async () => {
    const inferenceRoot = getInferenceRoot();
    const serverPath = path.join(inferenceRoot, 'server.py');
    if (!(await fs.pathExists(serverPath))) {
      throw new Error(`推理服务未找到: ${serverPath}`);
    }

    const pythonPath = resolvePythonExecutable();
    const spawnEnv = buildInferenceSpawnEnv(pythonPath);
    console.info('[preAnnot] spawning inference server:', pythonPath);

    const proc = spawn(pythonPath, [serverPath], {
      cwd: inferenceRoot,
      stdio: 'pipe',
      env: spawnEnv,
    });

    processRef = proc;
    attachProcess(proc);

    const ping = await sendToProcess({ cmd: 'ping' });
    if (!ping.ok) {
      proc.kill();
      processRef = null;
      throw new Error(ping.error ?? '推理服务启动失败');
    }

    return proc;
  })();

  try {
    return await startingProcess;
  } finally {
    startingProcess = null;
  }
}

function sendToProcess(payload: Record<string, unknown>): Promise<IpcMessage> {
  return new Promise((resolve, reject) => {
    const proc = processRef;
    if (!proc || proc.killed) {
      reject(new Error('推理进程未就绪'));
      return;
    }

    const id = `req-${++nextId}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('推理超时'));
    }, INFERENCE_TIMEOUT_MS);

    pending.set(id, {
      resolve,
      reject,
      timer,
    });

    proc.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
      if (err) {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      }
    });
  });
}

function invokeRaw(payload: Record<string, unknown>): Promise<IpcMessage> {
  return spawnProcess().then(() => sendToProcess(payload));
}

async function ensureProcess(): Promise<ChildProcessWithoutNullStreams> {
  return spawnProcess();
}

export async function checkInferenceRuntime(): Promise<PreAnnotRuntimeInfo> {
  const inferenceRoot = getInferenceRoot();
  const pythonPath = resolvePythonExecutable();
  const serverPath = path.join(inferenceRoot, 'server.py');

  if (!(await fs.pathExists(serverPath))) {
    return {
      pythonOk: false,
      pythonPath,
      inferenceRoot,
      error: `推理脚本不存在: ${serverPath}`,
    };
  }

  try {
    const resp = await invokeRaw({ cmd: 'ping' });
    const runtime = resp.runtime ?? {};
    return {
      pythonOk: Boolean(resp.ok),
      pythonPath,
      inferenceRoot,
      pythonVersion:
        typeof runtime.pythonVersion === 'string'
          ? runtime.pythonVersion
          : undefined,
      torchVersion:
        typeof runtime.torchVersion === 'string' ? runtime.torchVersion : null,
      cudaAvailable: Boolean(runtime.cudaAvailable),
      ultralytics: Boolean(runtime.ultralytics),
      sam2: Boolean(runtime.sam2),
      mediapipe: Boolean(runtime.mediapipe),
      faceAlignment: Boolean(runtime.faceAlignment),
      opencv: Boolean(runtime.opencv),
      error: resp.ok ? undefined : resp.error,
    };
  } catch (error) {
    return {
      pythonOk: false,
      pythonPath,
      inferenceRoot,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runPreAnnotInference(
  request: PreAnnotRequest,
): Promise<PreAnnotRunResponse> {
  const model = {
    ...request.model,
    params: { ...request.model.params, ...request.overrides },
  };

  const payload = {
    cmd: 'run',
    request: {
      kind: request.kind,
      imagePath: request.imagePath,
      model,
      box: request.box,
      templateId: request.templateId,
    },
  };

  try {
    await ensureProcess();
    const resp = await invokeRaw(payload);
    if (!resp.ok) {
      return { ok: false, error: resp.error, trace: resp.trace };
    }
    return { ok: true, result: resp.result };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function shutdownInferenceProcess(): void {
  if (!processRef || processRef.killed) return;
  try {
    processRef.stdin.write(`${JSON.stringify({ cmd: 'shutdown' })}\n`);
  } catch {
    // ignore
  }
  processRef.kill();
  processRef = null;
}

app.on('before-quit', () => {
  shutdownInferenceProcess();
});
