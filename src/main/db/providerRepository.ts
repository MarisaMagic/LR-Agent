import { getDatabase } from './database';

export interface ProviderRow {
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

export function listProviders(): ProviderRow[] {
  const db = getDatabase();
  return db.all(
    'SELECT * FROM llm_providers ORDER BY created_at ASC',
  ) as unknown as ProviderRow[];
}

export function createProvider(provider: {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEncrypted: string;
  encryptionKeyId?: string;
  model: string;
  enabled?: boolean;
  isDefault?: boolean;
  supportsVision?: boolean;
}): ProviderRow {
  const db = getDatabase();
  const now = Date.now();

  db.run(
    `
    INSERT INTO llm_providers (id, name, base_url, api_key_encrypted, encryption_key_id, model, enabled, is_default, supports_vision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    provider.id,
    provider.name,
    provider.baseUrl,
    provider.apiKeyEncrypted,
    provider.encryptionKeyId ?? 'v0',
    provider.model,
    provider.enabled !== false ? 1 : 0,
    provider.isDefault ? 1 : 0,
    provider.supportsVision ? 1 : 0,
    now,
    now,
  );

  return db.get(
    'SELECT * FROM llm_providers WHERE id = ?',
    provider.id,
  ) as unknown as ProviderRow;
}

export function getProvider(id: string): ProviderRow | undefined {
  const db = getDatabase();
  return db.get('SELECT * FROM llm_providers WHERE id = ?', id) as
    ProviderRow | undefined;
}

export function updateProvider(
  id: string,
  patch: Partial<{
    name: string;
    baseUrl: string;
    apiKeyEncrypted: string;
    encryptionKeyId: string;
    model: string;
    enabled: boolean;
    isDefault: boolean;
    supportsVision: boolean;
    visionProbedAt: number | null;
    visionProbeDetail: string;
  }>,
): ProviderRow | undefined {
  const db = getDatabase();
  const sets: string[] = [];
  const params: unknown[] = [];

  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.baseUrl !== undefined) {
    sets.push('base_url = ?');
    params.push(patch.baseUrl);
  }
  if (patch.apiKeyEncrypted !== undefined) {
    sets.push('api_key_encrypted = ?');
    params.push(patch.apiKeyEncrypted);
  }
  if (patch.encryptionKeyId !== undefined) {
    sets.push('encryption_key_id = ?');
    params.push(patch.encryptionKeyId);
  }
  if (patch.model !== undefined) {
    sets.push('model = ?');
    params.push(patch.model);
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(patch.enabled ? 1 : 0);
  }
  if (patch.isDefault !== undefined) {
    sets.push('is_default = ?');
    params.push(patch.isDefault ? 1 : 0);
  }
  if (patch.supportsVision !== undefined) {
    sets.push('supports_vision = ?');
    params.push(patch.supportsVision ? 1 : 0);
  }
  if (patch.visionProbedAt !== undefined) {
    sets.push('vision_probed_at = ?');
    params.push(patch.visionProbedAt);
  }
  if (patch.visionProbeDetail !== undefined) {
    sets.push('vision_probe_detail = ?');
    params.push(patch.visionProbeDetail);
  }

  if (sets.length === 0) return getProvider(id);

  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(id);

  db.run(`UPDATE llm_providers SET ${sets.join(', ')} WHERE id = ?`, ...params);

  return getProvider(id);
}

export function deleteProvider(id: string): void {
  const db = getDatabase();
  db.run('DELETE FROM llm_providers WHERE id = ?', id);
}

export function setDefaultProvider(id: string): ProviderRow | undefined {
  const db = getDatabase();
  const now = Date.now();

  // Clear all defaults first
  db.run('UPDATE llm_providers SET is_default = 0, updated_at = ?', now);
  // Set this one as default
  db.run(
    'UPDATE llm_providers SET is_default = 1, updated_at = ? WHERE id = ?',
    now,
    id,
  );

  return getProvider(id);
}

export function getDefaultProvider(): ProviderRow | undefined {
  const db = getDatabase();
  return db.get(
    'SELECT * FROM llm_providers WHERE is_default = 1 AND enabled = 1 LIMIT 1',
  ) as ProviderRow | undefined;
}
