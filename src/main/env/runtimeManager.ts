/**
 * 嵌入式 Python 运行时与 venv 管理。
 *
 * **注意**：Agent 编排已迁到 Node 运行时，不再需要 Python；嵌入式运行时亦已移除。
 * 本模块现在只服务于**可选的**预标注推理（`vendor/inference`），且
 * `ensureRuntimeExtracted` 在无资产时返回 `null`，由调用方给出「请自行准备
 * conda 环境」的指引（见 `envInstaller.ts`）。
 *
 * venv 与安装标记路径保留，用于识别用户此前已创建的 `inference` venv
 * （`<userData>/runtimes/inference-venv`）。
 */
import crypto from 'crypto';
import path from 'path';
import fs from 'fs-extra';
import { app } from 'electron';
import type { InstallTarget } from '../../shared/envTypes';

export const TARGET_PYTHON_VERSION: Record<InstallTarget, 'py312'> = {
  inference: 'py312',
};

export interface InstallMarker {
  requirementsHash: string;
  variant?: 'gpu' | 'cpu';
  installedAt: string;
}

export function getRuntimesDir(): string {
  return path.join(app.getPath('userData'), 'runtimes');
}

function runtimeAssetDir(version: 'py312'): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'python-runtime', version);
  }
  return path.resolve(app.getAppPath(), 'assets', 'python-runtime', version);
}

function runtimeUserDir(version: 'py312'): string {
  return path.join(getRuntimesDir(), version);
}

/** 嵌入式运行时解释器在 userData 下的路径（python-build-standalone 布局） */
export function getEmbeddedRuntimePythonPath(version: 'py312'): string {
  return process.platform === 'win32'
    ? path.join(runtimeUserDir(version), 'python.exe')
    : path.join(runtimeUserDir(version), 'bin', 'python3');
}

/** 首次使用时把运行时从 resources 复制到 userData；无资产（开发机未 fetch）返回 null */
export async function ensureRuntimeExtracted(
  version: 'py312',
): Promise<string | null> {
  const userDir = runtimeUserDir(version);
  const pythonPath = getEmbeddedRuntimePythonPath(version);
  if (fs.existsSync(pythonPath)) return pythonPath;

  const assetDir = runtimeAssetDir(version);
  if (
    !(await fs.pathExists(path.join(assetDir, 'python.exe'))) &&
    !(await fs.pathExists(path.join(assetDir, 'bin', 'python3')))
  ) {
    return null;
  }

  await fs.ensureDir(path.dirname(userDir));
  await fs.copy(assetDir, userDir, { overwrite: false });
  return fs.existsSync(pythonPath) ? pythonPath : null;
}

export function getVenvDir(target: InstallTarget): string {
  return path.join(getRuntimesDir(), `${target}-venv`);
}

export function getVenvPythonPath(target: InstallTarget): string {
  const venvDir = getVenvDir(target);
  return process.platform === 'win32'
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

export async function removeVenv(target: InstallTarget): Promise<void> {
  await fs.remove(getVenvDir(target));
}

function getMarkerPath(target: InstallTarget): string {
  return path.join(getRuntimesDir(), `${target}-installed.json`);
}

export function requirementsHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export async function readInstallMarker(
  target: InstallTarget,
): Promise<InstallMarker | null> {
  try {
    const data = await fs.readJson(getMarkerPath(target));
    if (!data || typeof data.requirementsHash !== 'string') return null;
    return data as InstallMarker;
  } catch {
    return null;
  }
}

export async function writeInstallMarker(
  target: InstallTarget,
  marker: InstallMarker,
): Promise<void> {
  await fs.ensureDir(getRuntimesDir());
  await fs.writeJson(getMarkerPath(target), marker, { spaces: 2 });
}
