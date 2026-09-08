import type { LlmProviderConfig } from '../../shared/agentTypes';

function getDb() {
  return (
    window as unknown as {
      electron: {
        db: {
          providers: {
            list: () => Promise<ProviderRow[]>;
            get: (id: string) => Promise<ProviderRow | undefined>;
            create: (p: CreateProviderParams) => Promise<ProviderRow>;
            update: (
              id: string,
              patch: Record<string, unknown>,
            ) => Promise<ProviderRow | undefined>;
            delete: (id: string) => Promise<void>;
            setDefault: (id: string) => Promise<ProviderRow>;
            getDefault: () => Promise<ProviderRow | undefined>;
          };
        };
      };
    }
  ).electron.db;
}

interface ProviderRow {
  id: string;
  name: string;
  base_url: string;
  api_key_encrypted: string;
  encryption_key_id: string;
  model: string;
  enabled: number;
  is_default: number;
  supports_vision: number;
  vision_probed_at: number | null;
  vision_probe_detail: string;
  created_at: number;
  updated_at: number;
}

interface CreateProviderParams {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEncrypted: string;
  encryptionKeyId?: string;
  model: string;
  enabled?: boolean;
  isDefault?: boolean;
  supportsVision?: boolean;
}

// ── Mappers ───────────────────────────────────────────────────────

function rowToConfig(row: ProviderRow): LlmProviderConfig {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    apiKey: row.api_key_encrypted,
    model: row.model,
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    supportsVision: row.supports_vision === 1,
    visionProbedAt: row.vision_probed_at,
    visionProbeDetail: row.vision_probe_detail ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function configToCreateParams(config: LlmProviderConfig): CreateProviderParams {
  return {
    id: config.id,
    name: config.name,
    baseUrl: config.baseUrl,
    apiKeyEncrypted: config.apiKey,
    encryptionKeyId: 'v0',
    model: config.model,
    enabled: config.enabled,
    isDefault: config.isDefault,
    supportsVision: config.supportsVision,
  };
}

function configToUpdatePatch(
  config: LlmProviderConfig,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    name: config.name,
    baseUrl: config.baseUrl,
    apiKeyEncrypted: config.apiKey,
    model: config.model,
    enabled: config.enabled,
    isDefault: config.isDefault,
    supportsVision: config.supportsVision,
  };
  if (config.visionProbedAt !== undefined) {
    patch.visionProbedAt = config.visionProbedAt;
  }
  if (config.visionProbeDetail !== undefined) {
    patch.visionProbeDetail = config.visionProbeDetail;
  }
  return patch;
}

// ── Public API ────────────────────────────────────────────────────

export async function fetchLlmProvidersFromApi(): Promise<LlmProviderConfig[]> {
  const db = getDb();
  const rows = await db.providers.list();
  return rows.map(rowToConfig);
}

export async function createLlmProviderOnApi(
  provider: LlmProviderConfig,
): Promise<LlmProviderConfig> {
  const db = getDb();
  const row = await db.providers.create(configToCreateParams(provider));
  return rowToConfig(row);
}

export async function updateLlmProviderOnApi(
  provider: LlmProviderConfig,
): Promise<LlmProviderConfig> {
  const db = getDb();
  const row = await db.providers.update(
    provider.id,
    configToUpdatePatch(provider),
  );
  return rowToConfig(row!);
}

export async function deleteLlmProviderOnApi(id: string): Promise<void> {
  const db = getDb();
  await db.providers.delete(id);
}

export async function setDefaultLlmProviderOnApi(
  id: string,
): Promise<LlmProviderConfig> {
  const db = getDb();
  const row = await db.providers.setDefault(id);
  return rowToConfig(row);
}

export async function probeLlmProviderVisionOnApi(
  id: string,
): Promise<LlmProviderConfig> {
  const db = getDb();
  const row = await db.providers.get(id);
  if (!row) {
    throw new Error('provider_not_found');
  }

  const config = rowToConfig(row);
  if (!config.enabled) {
    return config;
  }

  // 生成 64x64 红色 JPEG 作为测试图
  const tinyJpegDataUrl = ((): string => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return '';
    }
    ctx.fillStyle = 'rgb(180, 60, 60)';
    ctx.fillRect(0, 0, 64, 64);
    return canvas.toDataURL('image/jpeg', 0.85);
  })();

  if (!tinyJpegDataUrl) {
    return config;
  }

  const probePrompt =
    '这是一张纯色测试图。请只回复一个大写字母 OK，不要其它内容。';

  try {
    const baseUrl = config.baseUrl.replace(/\/+$/, '');
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: probePrompt },
              { type: 'image_url', image_url: { url: tinyJpegDataUrl } },
            ],
          },
        ],
        max_tokens: 10,
        temperature: 0,
      }),
    });

    if (!resp.ok) {
      const detail = `http_${resp.status}`;
      await db.providers.update(id, {
        supportsVision: false,
        visionProbedAt: Date.now(),
        visionProbeDetail: `probe_error:${detail}`,
      });
      return rowToConfig((await db.providers.get(id))!);
    }

    const data = await resp.json();
    const choice = data?.choices?.[0]?.message;
    const content: unknown = choice?.content;
    let looksOk = false;
    if (typeof content === 'string') {
      looksOk = content.toLowerCase().includes('ok');
    } else if (Array.isArray(content)) {
      const text = content
        .map((part: unknown) =>
          typeof part === 'object' &&
          part !== null &&
          'text' in (part as Record<string, unknown>)
            ? String((part as Record<string, unknown>).text)
            : String(part),
        )
        .join('');
      looksOk = text.toLowerCase().includes('ok');
    }

    const detail = looksOk
      ? 'probe_ok'
      : `probe_no_ok_response:${JSON.stringify(content).slice(0, 120)}`;
    await db.providers.update(id, {
      supportsVision: looksOk,
      visionProbedAt: Date.now(),
      visionProbeDetail: detail,
    });
    return rowToConfig((await db.providers.get(id))!);
  } catch (err: unknown) {
    const errorMsg =
      err instanceof Error
        ? `${err.name}:${err.message}`.slice(0, 200)
        : 'unknown';
    await db.providers.update(id, {
      supportsVision: false,
      visionProbedAt: Date.now(),
      visionProbeDetail: `probe_error:${errorMsg}`,
    });
    return rowToConfig((await db.providers.get(id))!);
  }
}
