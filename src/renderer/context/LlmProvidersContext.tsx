import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { createAgentId, type LlmProviderConfig } from '../../shared/agentTypes';
import {
  buildEmptyProvider,
  loadDefaultProviderId,
  loadLlmProviders,
  markDefaultLlmProvider,
  persistDefaultProviderId,
  removeLlmProvider,
  resolveDefaultProvider,
  upsertLlmProvider,
} from '../services/llmProviderService';
import { probeLlmProviderVisionOnApi } from '../services/llmProviderApi';

interface LlmProvidersContextValue {
  providers: LlmProviderConfig[];
  loading: boolean;
  defaultProvider: LlmProviderConfig | null;
  refreshProviders: () => Promise<void>;
  upsertProvider: (
    provider: LlmProviderConfig,
    isNew?: boolean,
  ) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;
  setDefaultProvider: (id: string) => Promise<void>;
  probeProviderVision: (id: string) => Promise<void>;
}

const LlmProvidersContext = createContext<LlmProvidersContextValue | null>(
  null,
);

export function LlmProvidersProvider({ children }: { children: ReactNode }) {
  const [providers, setProviders] = useState<LlmProviderConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [defaultProviderId, setDefaultProviderId] = useState<string | null>(
    loadDefaultProviderId(),
  );

  const refreshProviders = useCallback(async () => {
    setLoading(true);
    try {
      const list = await loadLlmProviders();
      setProviders(list);
      const resolved = resolveDefaultProvider(list);
      setDefaultProviderId(resolved?.id ?? null);
      if (resolved?.id) {
        persistDefaultProviderId(resolved.id);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshProviders().catch(() => undefined);
  }, [refreshProviders]);

  const upsertProvider = useCallback(
    async (provider: LlmProviderConfig, isNew = false) => {
      const saved = await upsertLlmProvider(providers, provider, isNew);
      let next = isNew
        ? [...providers, saved]
        : providers.map((item) => (item.id === saved.id ? saved : item));

      if (saved.isDefault) {
        next = next.map((item) => ({
          ...item,
          isDefault: item.id === saved.id,
        }));
        persistDefaultProviderId(saved.id);
        setDefaultProviderId(saved.id);
      }

      setProviders(next);
    },
    [providers],
  );

  const deleteProvider = useCallback(
    async (id: string) => {
      await removeLlmProvider(id);
      const next = providers.filter((item) => item.id !== id);
      setProviders(next);
      if (defaultProviderId === id) {
        const resolved = resolveDefaultProvider(next);
        persistDefaultProviderId(resolved?.id ?? null);
        setDefaultProviderId(resolved?.id ?? null);
      }
    },
    [providers, defaultProviderId],
  );

  const setDefaultProvider = useCallback(
    async (id: string) => {
      const updated = await markDefaultLlmProvider(id);
      const next = providers.map((item) => ({
        ...item,
        isDefault: item.id === updated.id,
      }));
      setProviders(next);
      persistDefaultProviderId(updated.id);
      setDefaultProviderId(updated.id);
    },
    [providers],
  );

  const probeProviderVision = useCallback(async (id: string) => {
    const updated = await probeLlmProviderVisionOnApi(id);
    setProviders((prev) =>
      prev.map((item) => (item.id === updated.id ? updated : item)),
    );
  }, []);

  const defaultProvider = useMemo(
    () =>
      providers.find((item) => item.id === defaultProviderId) ??
      resolveDefaultProvider(providers),
    [providers, defaultProviderId],
  );

  const value = useMemo(
    () => ({
      providers,
      loading,
      defaultProvider,
      refreshProviders,
      upsertProvider,
      deleteProvider,
      setDefaultProvider,
      probeProviderVision,
    }),
    [
      providers,
      loading,
      defaultProvider,
      refreshProviders,
      upsertProvider,
      deleteProvider,
      setDefaultProvider,
      probeProviderVision,
    ],
  );

  return (
    <LlmProvidersContext.Provider value={value}>
      {children}
    </LlmProvidersContext.Provider>
  );
}

export function useLlmProviders(): LlmProvidersContextValue {
  const ctx = useContext(LlmProvidersContext);
  if (!ctx) {
    throw new Error('useLlmProviders must be used within LlmProvidersProvider');
  }
  return ctx;
}

export { buildEmptyProvider, createAgentId };
