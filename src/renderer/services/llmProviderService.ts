import {
  createAgentId,
  type LlmProviderConfig,
} from '../../shared/agentTypes';
import {
  createLlmProviderOnApi,
  deleteLlmProviderOnApi,
  fetchLlmProvidersFromApi,
  setDefaultLlmProviderOnApi,
  updateLlmProviderOnApi,
} from './llmProviderApi';

const DEFAULT_PROVIDER_KEY = 'lr-agent:defaultLlmProviderId';

export function buildEmptyProvider(): LlmProviderConfig {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: '',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
    model: 'qwen-plus',
    enabled: true,
    isDefault: false,
    supportsVision: false,
    visionProbedAt: null,
    visionProbeDetail: '',
    createdAt: now,
    updatedAt: now,
  };
}

export async function loadLlmProviders(): Promise<LlmProviderConfig[]> {
  return fetchLlmProvidersFromApi();
}

export function loadDefaultProviderId(): string | null {
  return localStorage.getItem(DEFAULT_PROVIDER_KEY);
}

export function persistDefaultProviderId(id: string | null): void {
  if (id) {
    localStorage.setItem(DEFAULT_PROVIDER_KEY, id);
  } else {
    localStorage.removeItem(DEFAULT_PROVIDER_KEY);
  }
}

export function getEnabledProviders(
  providers: LlmProviderConfig[],
): LlmProviderConfig[] {
  return providers.filter((item) => item.enabled);
}

export function resolveDefaultProvider(
  providers: LlmProviderConfig[],
): LlmProviderConfig | null {
  const enabled = getEnabledProviders(providers);
  if (enabled.length === 0) return null;
  const storedId = loadDefaultProviderId();
  const stored = storedId
    ? enabled.find((item) => item.id === storedId)
    : null;
  if (stored) return stored;
  return enabled.find((item) => item.isDefault) ?? enabled[0] ?? null;
}

export async function upsertLlmProvider(
  providers: LlmProviderConfig[],
  provider: LlmProviderConfig,
  isNew: boolean,
): Promise<LlmProviderConfig> {
  const saved = isNew
    ? await createLlmProviderOnApi(provider)
    : await updateLlmProviderOnApi(provider);

  if (saved.isDefault) {
    const updated = await setDefaultLlmProviderOnApi(saved.id);
    persistDefaultProviderId(updated.id);
    return updated;
  }
  return saved;
}

export async function removeLlmProvider(id: string): Promise<void> {
  await deleteLlmProviderOnApi(id);
}

export async function markDefaultLlmProvider(id: string): Promise<LlmProviderConfig> {
  const updated = await setDefaultLlmProviderOnApi(id);
  persistDefaultProviderId(updated.id);
  return updated;
}

/** @deprecated local-only persistence removed */
export async function persistLlmProviders(
  _providers: LlmProviderConfig[],
): Promise<void> {
  // no-op: providers are stored on the backend
}
