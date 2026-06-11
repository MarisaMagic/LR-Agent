import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import { app } from 'electron';
import { randomUUID } from 'crypto';
import {
  buildInferenceSpawnEnv,
  resolvePythonExecutable,
} from '../preAnnot/inferenceProcess';

const ANALYSIS_TIMEOUT_MS = 60_000;
const ANALYSIS_SCRIPT_FILENAME = 'analysis_script.py';

interface IpcMessage {
  ok: boolean;
  stdout?: string;
  truncated?: boolean;
  error?: string;
  trace?: string;
  kind?: string;
}

export function getAnalysisRoot(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'analysis');
  }
  return path.resolve(app.getAppPath(), '..', 'LR-Agent-analysis');
}

function sanitizeUnicodeText(text: string): string {
  return text.replace(/\uFFFD/g, '').replace(/[\uD800-\uDFFF]/g, '');
}

function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeUnicodeText(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeJsonValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        typeof k === 'string' ? sanitizeUnicodeText(k) : k,
        sanitizeJsonValue(v),
      ]),
    );
  }
  return value;
}

function writeStdinLine(
  proc: ChildProcessWithoutNullStreams,
  payload: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!proc.stdin) {
      reject(new Error('分析进程 stdin 不可用'));
      return;
    }
    const body = `${JSON.stringify(payload)}\n`;
    proc.stdin.write(body, 'utf8', (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function sendOnce(
  proc: ChildProcessWithoutNullStreams,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<IpcMessage> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error('分析脚本执行超时'));
    }, timeoutMs);

    const onData = (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) {
          newline = buffer.indexOf('\n');
          continue;
        }
        try {
          const parsed = JSON.parse(line) as IpcMessage;
          if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
            clearTimeout(timer);
            proc.stdout.off('data', onData);
            resolve(parsed);
            return;
          }
        } catch {
          // 忽略非 JSON 行，继续读
        }
        newline = buffer.indexOf('\n');
      }
    };

    proc.stdout.on('data', onData);
    writeStdinLine(proc, payload).catch((err) => {
      clearTimeout(timer);
      proc.stdout.off('data', onData);
      reject(err);
    });
  });
}

async function writeDataFiles(
  tempDir: string,
  dataFiles: Record<string, unknown>,
): Promise<void> {
  for (const [name, content] of Object.entries(dataFiles)) {
    const target = path.join(tempDir, name);
    await fs.ensureDir(path.dirname(target));
    const safe = sanitizeJsonValue(content);
    if (safe && typeof safe === 'object') {
      await fs.writeFile(
        target,
        `${JSON.stringify(safe, null, 2)}\n`,
        'utf8',
      );
    } else {
      await fs.writeFile(target, String(safe ?? ''), 'utf8');
    }
  }
}

export async function runAnalysisScript(options: {
  script: string;
  dataFiles: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<{ stdout: string; truncated: boolean }> {
  const analysisRoot = getAnalysisRoot();
  const serverPath = path.join(analysisRoot, 'server.py');
  if (!(await fs.pathExists(serverPath))) {
    throw new Error(`分析服务未找到: ${serverPath}`);
  }

  const tempDir = path.join(
    app.getPath('temp'),
    'lr-agent-analysis',
    randomUUID(),
  );
  await fs.ensureDir(tempDir);
  await writeDataFiles(tempDir, options.dataFiles);
  await fs.writeFile(
    path.join(tempDir, ANALYSIS_SCRIPT_FILENAME),
    sanitizeUnicodeText(options.script),
    'utf8',
  );

  const pythonPath = resolvePythonExecutable();
  const spawnEnv = buildInferenceSpawnEnv(pythonPath);

  const proc = spawn(pythonPath, [serverPath], {
    cwd: analysisRoot,
    stdio: 'pipe',
    env: spawnEnv,
  }) as ChildProcessWithoutNullStreams;
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');

  try {
    const ping = await sendOnce(proc, { cmd: 'ping' }, 10_000);
    if (!ping.ok) {
      throw new Error(ping.error ?? '分析服务 ping 失败');
    }

    const result = await sendOnce(
      proc,
      {
        cmd: 'run_script',
        data_dir: tempDir,
      },
      options.timeoutMs ?? ANALYSIS_TIMEOUT_MS,
    );

    if (!result.ok) {
      const detail = result.trace ? `\n${result.trace}` : '';
      throw new Error(`${result.error ?? '脚本执行失败'}${detail}`);
    }

    return {
      stdout: result.stdout ?? '',
      truncated: Boolean(result.truncated),
    };
  } finally {
    proc.kill();
    await fs.remove(tempDir).catch(() => undefined);
  }
}
