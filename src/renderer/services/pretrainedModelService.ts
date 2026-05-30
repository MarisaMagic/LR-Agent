import {
  PretrainedModelConfig,
  PretrainedModelValidationResult,
  Sam2ScanResult,
  normalizeModelsOnSave,
} from '../types/pretrainedModel';

export async function loadPretrainedModels(): Promise<PretrainedModelConfig[]> {
  if (!window.electron?.pretrainedModels) return [];
  return window.electron.pretrainedModels.getAll();
}

export async function persistPretrainedModels(
  models: PretrainedModelConfig[],
  changed?: PretrainedModelConfig,
): Promise<void> {
  if (!window.electron?.pretrainedModels) return;
  const normalized = normalizeModelsOnSave(models, changed);
  await window.electron.pretrainedModels.saveAll(normalized);
}

export async function validatePretrainedModelPaths(
  model: Pick<
    PretrainedModelConfig,
    'modelType' | 'checkpointPath' | 'configPath'
  >,
): Promise<PretrainedModelValidationResult> {
  if (!window.electron?.pretrainedModels) {
    return { ok: false, errors: ['当前环境不支持本地模型配置'], warnings: [] };
  }
  return window.electron.pretrainedModels.validate(model);
}

export async function scanSam2Directory(
  rootDir: string,
): Promise<Sam2ScanResult[]> {
  if (!window.electron?.pretrainedModels) return [];
  return window.electron.pretrainedModels.scanSam2Directory(rootDir);
}

export async function pickModelFile(
  extensions: string[],
  title: string,
): Promise<string | null> {
  if (!window.electron?.dialog) return null;
  return window.electron.dialog.openFile({
    title,
    filters: [{ name: '模型文件', extensions }],
  });
}

export async function pickSam2RootDirectory(): Promise<string | null> {
  return window.electron.fileSystem.openDirectory();
}
