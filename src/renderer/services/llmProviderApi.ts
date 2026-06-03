import { API_BASE_URL } from '../config';
import type { LlmProviderConfig } from '../../shared/agentTypes';
import { apiFetch } from './api';

const LEGACY_STORAGE_KEY = 'lr-agent:llmProviders';

interface LlmProviderApiRow {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  enabled: boolean;
  is_default: boolean;
  created_at: number;
  updated_at: number;
}

function mapRow(row: LlmProviderApiRow): LlmProviderConfig {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    model: row.model,
    enabled: row.enabled,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapToCreateBody(provider: LlmProviderConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: provider.name,
    base_url: provider.baseUrl,
    api_key: provider.apiKey,
    model: provider.model,
    enabled: provider.enabled,
    is_default: provider.isDefault,
  };
  if (provider.id) {
    body.id = provider.id;
  }
  return body;
}

function mapToUpdateBody(provider: LlmProviderConfig): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: provider.name,
    base_url: provider.baseUrl,
    model: provider.model,
    enabled: provider.enabled,
    is_default: provider.isDefault,
  };
  if (provider.apiKey.trim()) {
    body.api_key = provider.apiKey;
  }
  return body;
}

export async function fetchLlmProvidersFromApi(): Promise<LlmProviderConfig[]> {
  const rows = await apiFetch<LlmProviderApiRow[]>('/llm-providers');
  return rows.map(mapRow);
}

export async function createLlmProviderOnApi(
  provider: LlmProviderConfig,
): Promise<LlmProviderConfig> {
  const row = await apiFetch<LlmProviderApiRow>('/llm-providers', {
    method: 'POST',
    body: JSON.stringify(mapToCreateBody(provider)),
    headers: { 'Content-Type': 'application/json' },
  });
  return mapRow(row);
}

export async function updateLlmProviderOnApi(
  provider: LlmProviderConfig,
): Promise<LlmProviderConfig> {
  const row = await apiFetch<LlmProviderApiRow>(`/llm-providers/${provider.id}`, {
    method: 'PATCH',
    body: JSON.stringify(mapToUpdateBody(provider)),
    headers: { 'Content-Type': 'application/json' },
  });
  return mapRow(row);
}

export async function deleteLlmProviderOnApi(id: string): Promise<void> {
  await apiFetch<void>(`/llm-providers/${id}`, { method: 'DELETE' });
}

export async function setDefaultLlmProviderOnApi(
  id: string,
): Promise<LlmProviderConfig> {
  const row = await apiFetch<LlmProviderApiRow>(`/llm-providers/${id}/default`, {
    method: 'POST',
  });
  return mapRow(row);
}

export async function migrateLocalProvidersToApi(): Promise<void> {
  const flag = localStorage.getItem('lr-agent:llmProvidersMigrated');
  if (flag === '1') return;

  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {
      localStorage.setItem('lr-agent:llmProvidersMigrated', '1');
      return;
    }
    const parsed = JSON.parse(raw) as LlmProviderConfig[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      localStorage.setItem('lr-agent:llmProvidersMigrated', '1');
      return;
    }
    const existing = await fetchLlmProvidersFromApi();
    if (existing.length > 0) {
      localStorage.setItem('lr-agent:llmProvidersMigrated', '1');
      return;
    }
    for (const item of parsed) {
      if (!item.apiKey?.trim()) continue;
      await createLlmProviderOnApi(item);
    }
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    localStorage.setItem('lr-agent:llmProvidersMigrated', '1');
  } catch {
    // ignore migration errors
  }
}

export async function cancelChatJobOnApi(clientJobId: string): Promise<void> {
  await apiFetch<{ status: string }>('/agent/chat/cancel', {
    method: 'POST',
    body: JSON.stringify({ client_job_id: clientJobId }),
    headers: { 'Content-Type': 'application/json' },
  });
}

export { API_BASE_URL };
