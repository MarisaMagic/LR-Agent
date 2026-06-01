import {
  createAgentId,
  type LlmProviderConfig,
} from '../../shared/agentTypes';

const STORAGE_KEY = 'lr-agent:llmProviders';
const DEFAULT_PROVIDER_KEY = 'lr-agent:defaultLlmProviderId';

export function buildEmptyProvider(): LlmProviderConfig {
  const now = Date.now();
  return {
    id: createAgentId('llm'),
    name: '',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
    model: 'Qwen3.6-Plus',
    enabled: true,
    isDefault: false,
    createdAt: now,
    updatedAt: now,
  };
}

export async function loadLlmProviders(): Promise<LlmProviderConfig[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LlmProviderConfig[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function persistLlmProviders(
  providers: LlmProviderConfig[],
): Promise<void> {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(providers));
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
