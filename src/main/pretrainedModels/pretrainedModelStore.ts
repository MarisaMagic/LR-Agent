import path from 'path';
import fs from 'fs-extra';
import { app } from 'electron';

export type PretrainedModelType = 'object_detection' | 'image_segmentation';

export interface PretrainedModelParams {
  device?: 'auto' | 'cuda' | 'cpu';
  confThreshold?: number;
  iouThreshold?: number;
  minArea?: number;
  epsilonRatio?: number;
}

export interface PretrainedModelConfig {
  id: string;
  name: string;
  modelType: PretrainedModelType;
  enabled: boolean;
  isDefault: boolean;
  checkpointPath: string;
  configPath?: string;
  params?: PretrainedModelParams;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PretrainedModelValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface Sam2ScanResult {
  variant: string;
  name: string;
  checkpointPath: string;
  configPath: string;
}

interface RegistryFile {
  version: number;
  models: PretrainedModelConfig[];
}

const REGISTRY_VERSION = 1;

const SAM2_VARIANTS: Array<{
  key: string;
  label: string;
  configFile: string;
  checkpointHints: string[];
}> = [
  {
    key: 'tiny',
    label: 'Tiny',
    configFile: 'sam2.1_hiera_t.yaml',
    checkpointHints: ['tiny', '_t.pt', '_t_'],
  },
  {
    key: 'small',
    label: 'Small',
    configFile: 'sam2.1_hiera_s.yaml',
    checkpointHints: ['small', '_s.pt', '_s_'],
  },
  {
    key: 'base_plus',
    label: 'Base+',
    configFile: 'sam2.1_hiera_b+.yaml',
    checkpointHints: ['base_plus', 'b+', 'base-plus'],
  },
  {
    key: 'large',
    label: 'Large',
    configFile: 'sam2.1_hiera_l.yaml',
    checkpointHints: ['large', '_l.pt', '_l_'],
  },
];

function getRegistryPath(): string {
  return path.join(app.getPath('userData'), 'pretrained-models.json');
}

async function readRegistry(): Promise<RegistryFile> {
  const registryPath = getRegistryPath();
  try {
    if (!(await fs.pathExists(registryPath))) {
      return { version: REGISTRY_VERSION, models: [] };
    }
    const data = await fs.readJson(registryPath);
    if (!data || typeof data !== 'object' || !Array.isArray(data.models)) {
      return { version: REGISTRY_VERSION, models: [] };
    }
    return {
      version: REGISTRY_VERSION,
      models: data.models as PretrainedModelConfig[],
    };
  } catch {
    return { version: REGISTRY_VERSION, models: [] };
  }
}

function normalizeDefaultFlags(models: PretrainedModelConfig[]): PretrainedModelConfig[] {
  const byType = new Map<PretrainedModelType, PretrainedModelConfig[]>();
  for (const model of models) {
    const list = byType.get(model.modelType) ?? [];
    list.push(model);
    byType.set(model.modelType, list);
  }

  for (const list of byType.values()) {
    const enabledDefaults = list.filter((m) => m.enabled && m.isDefault);
    if (enabledDefaults.length === 1) continue;
    if (enabledDefaults.length === 0 && list.length > 0) {
      const firstEnabled = list.find((m) => m.enabled) ?? list[0];
      for (const model of list) {
        model.isDefault = model.id === firstEnabled.id;
      }
      continue;
    }
    const keepId = enabledDefaults[0]?.id;
    for (const model of list) {
      model.isDefault = model.id === keepId;
    }
  }

  return models;
}

export async function getPretrainedModels(): Promise<PretrainedModelConfig[]> {
  const registry = await readRegistry();
  return registry.models;
}

export async function savePretrainedModels(
  models: PretrainedModelConfig[],
): Promise<void> {
  const normalized = normalizeDefaultFlags(models.map((m) => ({ ...m })));
  const registryPath = getRegistryPath();
  await fs.ensureDir(path.dirname(registryPath));
  await fs.writeJson(
    registryPath,
    { version: REGISTRY_VERSION, models: normalized },
    { spaces: 2 },
  );
}

function matchSam2Variant(checkpointName: string): (typeof SAM2_VARIANTS)[number] | null {
  const lower = checkpointName.toLowerCase();
  for (const variant of SAM2_VARIANTS) {
    if (variant.checkpointHints.some((hint) => lower.includes(hint))) {
      return variant;
    }
  }
  return null;
}

export async function scanSam2Directory(rootDir: string): Promise<Sam2ScanResult[]> {
  const resolvedRoot = path.resolve(rootDir);
  if (!(await fs.pathExists(resolvedRoot))) {
    return [];
  }

  const configDir = path.join(resolvedRoot, 'configs', 'sam2.1');
  const checkpointDir = path.join(resolvedRoot, 'checkpoints');

  const configExists = await fs.pathExists(configDir);
  const checkpointExists = await fs.pathExists(checkpointDir);
  if (!configExists || !checkpointExists) {
    return [];
  }

  const configFiles = (await fs.readdir(configDir)).filter((name) =>
    name.endsWith('.yaml'),
  );
  const checkpointFiles = (await fs.readdir(checkpointDir)).filter((name) =>
    name.endsWith('.pt'),
  );

  const results: Sam2ScanResult[] = [];

  for (const checkpointFile of checkpointFiles) {
    const variant = matchSam2Variant(checkpointFile);
    if (!variant) continue;

    const configFile = variant.configFile;
    if (!configFiles.includes(configFile)) continue;

    results.push({
      variant: variant.key,
      name: `SAM2.1 ${variant.label}`,
      checkpointPath: path.join(checkpointDir, checkpointFile),
      configPath: path.join(configDir, configFile),
    });
  }

  return results;
}

export async function validatePretrainedModel(
  model: Pick<
    PretrainedModelConfig,
    'modelType' | 'checkpointPath' | 'configPath'
  >,
): Promise<PretrainedModelValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const checkpointPath = model.checkpointPath?.trim();
  if (!checkpointPath) {
    errors.push('请指定权重文件路径');
  } else if (!(await fs.pathExists(checkpointPath))) {
    errors.push(`权重文件不存在：${checkpointPath}`);
  } else if (!checkpointPath.toLowerCase().endsWith('.pt')) {
    warnings.push('权重文件扩展名不是 .pt');
  }

  if (model.modelType === 'image_segmentation') {
    const configPath = model.configPath?.trim();
    if (!configPath) {
      errors.push('SAM2 需要指定配置文件路径（.yaml）');
    } else if (!(await fs.pathExists(configPath))) {
      errors.push(`配置文件不存在：${configPath}`);
    } else if (!configPath.toLowerCase().endsWith('.yaml')) {
      warnings.push('配置文件扩展名不是 .yaml');
    }

    if (
      checkpointPath &&
      configPath &&
      (await fs.pathExists(checkpointPath)) &&
      (await fs.pathExists(configPath))
    ) {
      const ckptVariant = matchSam2Variant(path.basename(checkpointPath));
      const cfgVariant = SAM2_VARIANTS.find((v) =>
        path.basename(configPath).includes(v.configFile.replace('.yaml', '')),
      );
      if (ckptVariant && cfgVariant && ckptVariant.key !== cfgVariant.key) {
        warnings.push(
          `权重变体（${ckptVariant.label}）与配置变体（${cfgVariant.label}）可能不匹配`,
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}
