import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  createAgentId,
  type LlmProviderConfig,
} from '../../shared/agentTypes';
import {
  buildEmptyProvider,
  loadDefaultProviderId,
  loadLlmProviders,
  persistDefaultProviderId,
  persistLlmProviders,
  resolveDefaultProvider,
} from '../services/llmProviderService';

interface LlmProvidersContextValue {
  providers: LlmProviderConfig[];
  loading: boolean;
  defaultProvider: LlmProviderConfig | null;
  refreshProviders: () => Promise<void>;
  upsertProvider: (provider: LlmProviderConfig) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;
  setDefaultProvider: (id: string) => Promise<void>;
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
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshProviders().catch(() => undefined);
  }, [refreshProviders]);

  const upsertProvider = useCallback(
    async (provider: LlmProviderConfig) => {
      const exists = providers.some((item) => item.id === provider.id);
      let next = exists
        ? providers.map((item) => (item.id === provider.id ? provider : item))
        : [...providers, provider];

      if (provider.isDefault) {
        next = next.map((item) => ({
          ...item,
          isDefault: item.id === provider.id,
        }));
      }

      await persistLlmProviders(next);
      setProviders(next);
      if (provider.isDefault) {
        persistDefaultProviderId(provider.id);
        setDefaultProviderId(provider.id);
      }
    },
    [providers],
  );

  const deleteProvider = useCallback(
    async (id: string) => {
      const next = providers.filter((item) => item.id !== id);
      await persistLlmProviders(next);
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
      const next = providers.map((item) => ({
        ...item,
        isDefault: item.id === id,
      }));
      await persistLlmProviders(next);
      setProviders(next);
      persistDefaultProviderId(id);
      setDefaultProviderId(id);
    },
    [providers],
  );

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
    }),
    [
      providers,
      loading,
      defaultProvider,
      refreshProviders,
      upsertProvider,
      deleteProvider,
      setDefaultProvider,
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
    throw new Error(
      'useLlmProviders must be used within LlmProvidersProvider',
    );
  }
  return ctx;
}

export { buildEmptyProvider };
