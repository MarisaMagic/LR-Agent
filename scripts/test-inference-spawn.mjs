/**
 * 模拟 Electron 主进程 spawn 推理服务，诊断 Python/conda 环境污染问题。
 * 用法: node scripts/test-inference-spawn.mjs
 */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const inferenceRoot = path.resolve(__dirname, '../vendor/inference');
const serverPath = path.join(inferenceRoot, 'server.py');

function trimEnv(value) {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function condaEnvCandidates(condaEnv) {
  const userHome = process.env.USERPROFILE || process.env.HOME || '';
  return [
    path.join(userHome, 'anaconda3', 'envs', condaEnv, 'python.exe'),
    path.join(userHome, 'miniconda3', 'envs', condaEnv, 'python.exe'),
    path.join(userHome, 'AppData', 'Local', 'miniconda3', 'envs', condaEnv, 'python.exe'),
    path.join(userHome, 'AppData', 'Local', 'anaconda3', 'envs', condaEnv, 'python.exe'),
  ];
}

function normalizePythonPath(rawPath) {
  const trimmed = rawPath.trim().replace(/^["']|["']$/g, '');
  if (!trimmed) return trimmed;
  if (fs.existsSync(trimmed) && fs.statSync(trimmed).isDirectory()) {
    return path.join(trimmed, 'python.exe');
  }
  return trimmed;
}

function inferCondaEnvRoot(pythonPath) {
  const normalized = pythonPath.replace(/\\/g, '/');
  if (!normalized.toLowerCase().includes('/envs/')) return null;
  if (normalized.endsWith('/bin/python')) {
    return path.dirname(path.dirname(pythonPath));
  }
  return path.dirname(pythonPath);
}

function buildInferenceSpawnEnv(pythonPath) {
  const env = { ...process.env };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  const envRoot = inferCondaEnvRoot(pythonPath);
  if (envRoot) {
    env.CONDA_PREFIX = envRoot;
    env.CONDA_DEFAULT_ENV = path.basename(envRoot);
    const pathParts = [
      path.join(envRoot, 'Scripts'),
      path.join(envRoot, 'Library\\bin'),
      env.PATH ?? '',
    ].filter(Boolean);
    env.PATH = pathParts.join(path.delimiter);
  }
  env.PYTHONUNBUFFERED = '1';
  env.PYTHONNOUSERSITE = '1';
  return env;
}

function resolvePythonExecutable() {
  const condaEnv = process.env.LR_AGENT_INFERENCE_CONDA_ENV ?? 'lr-agent-inference';
  const candidates = [];
  const fromEnv = trimEnv(process.env.LR_AGENT_INFERENCE_PYTHON);
  if (fromEnv) candidates.push(normalizePythonPath(fromEnv));
  const home = trimEnv(process.env.CONDA_PREFIX);
  if (home && path.basename(home) === condaEnv) {
    candidates.push(path.join(home, 'python.exe'));
  }
  candidates.push(...condaEnvCandidates(condaEnv));
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return 'python';
}

function pingWithEnv(label, spawnEnv, pythonPath) {
  return new Promise((resolve) => {
    console.log(`\n--- ${label} ---`);
    console.log('python:', pythonPath);
    console.log('PYTHONHOME:', spawnEnv.PYTHONHOME ?? '(unset)');
    console.log('PYTHONPATH:', spawnEnv.PYTHONPATH ?? '(unset)');
    console.log('CONDA_PREFIX:', spawnEnv.CONDA_PREFIX ?? '(unset)');

    const proc = spawn(pythonPath, [serverPath], {
      cwd: inferenceRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });

    proc.stdin.write('{"cmd":"ping"}\n');
    proc.stdin.end();

    const timer = setTimeout(() => {
      proc.kill();
      resolve({ ok: false, error: 'timeout', stderr });
    }, 120000);

    proc.on('close', (code) => {
      clearTimeout(timer);
      const line = stdout.trim().split('\n').pop() ?? '';
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = { ok: false, raw: line, stderr: stderr.slice(0, 2000) };
      }
      console.log('exit:', code);
      if (parsed.runtime) {
        console.log('runtime:', JSON.stringify(parsed.runtime, null, 2));
      } else if (parsed.error) {
        console.log('error:', parsed.error);
      }
      if (stderr) console.log('stderr (first 800):', stderr.slice(0, 800));
      resolve(parsed);
    });
  });
}

async function main() {
  console.log('=== Pre-Annot Inference Spawn Diagnostic ===');
  console.log('inferenceRoot:', inferenceRoot);
  console.log('server exists:', fs.existsSync(serverPath));
  console.log('LR_AGENT_INFERENCE_PYTHON:', process.env.LR_AGENT_INFERENCE_PYTHON ?? '(unset)');
  console.log('process CONDA_PREFIX:', process.env.CONDA_PREFIX ?? '(unset)');

  const pythonPath = resolvePythonExecutable();
  console.log('resolved python:', pythonPath);

  // 1. 模拟修复前：直接继承当前 process.env（含 base conda 污染）
  const polluted = { ...process.env, PYTHONUNBUFFERED: '1' };
  await pingWithEnv('BEFORE FIX (inherit process.env)', polluted, pythonPath);

  // 2. 修复后：buildInferenceSpawnEnv
  const fixed = buildInferenceSpawnEnv(pythonPath);
  const result = await pingWithEnv('AFTER FIX (buildInferenceSpawnEnv)', fixed, pythonPath);

  console.log('\n=== SUMMARY ===');
  if (result.ok) {
    console.log('PASS: 修复后的 spawn 环境 ping 成功');
    console.log(`torch: ${result.runtime?.torchVersion}, cuda: ${result.runtime?.cudaAvailable}`);
  } else {
    console.log('FAIL: 修复后仍失败，需进一步排查');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
