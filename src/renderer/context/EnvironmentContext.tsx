import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type {
  EnvironmentStatus,
  InstallStartResult,
  InstallTarget,
  LocalAgentServiceStatus,
} from '../../shared/envTypes';
import {
  completeFirstRun as completeFirstRunIpc,
  dismissFirstRun as dismissFirstRunIpc,
  loadEnvironmentStatus,
  saveEnvSettings,
  startEnvironmentInstall,
} from '../services/environmentService';
import { invalidateLocalAgentAuth, setApiBaseUrlOverride } from '../config';

interface EnvironmentContextValue {
  status: EnvironmentStatus | null;
  loading: boolean;
  refresh: () => Promise<void>;
  wizardOpen: boolean;
  openWizard: () => void;
  closeWizard: () => void;
  completeFirstRun: () => Promise<void>;
  dismissFirstRun: () => Promise<void>;
  saveBackendUrl: (url: string) => Promise<void>;
  savePythonOverride: (
    target: InstallTarget,
    pythonPath: string,
  ) => Promise<void>;
  startInstall: (target: InstallTarget) => Promise<InstallStartResult>;
  localAgentService: LocalAgentServiceStatus | null;
}

const EnvironmentContext = createContext<EnvironmentContextValue | null>(null);

export function EnvironmentProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<EnvironmentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [localAgentService, setLocalAgentService] =
    useState<LocalAgentServiceStatus | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await loadEnvironmentStatus();
      setStatus(next);
      // 同步后端地址覆盖到 config.ts（更换地址后需重新登录才生效于会话）
      if (next) {
        setApiBaseUrlOverride(next.settings.backendBaseUrl.trim() || null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  // 订阅本地 Agent 服务状态（启动/退出/重启推送）
  useEffect(() => {
    if (!window.electron?.localAgent?.onStatus) return undefined;
    const unsubscribe = window.electron.localAgent.onStatus((next) => {
      setLocalAgentService(next);
      // 运行时每次启动都会换随机端口与新 token，因此任何状态变更都要
      // 丢弃渲染层缓存的地址与凭据 —— 否则重启后会一直打向已死端口。
      invalidateLocalAgentAuth();
    });
    return unsubscribe;
  }, []);

  const openWizard = useCallback(() => setWizardOpen(true), []);
  const closeWizard = useCallback(() => setWizardOpen(false), []);

  const completeFirstRun = useCallback(async () => {
    await completeFirstRunIpc();
    await refresh();
  }, [refresh]);

  const dismissFirstRun = useCallback(async () => {
    await dismissFirstRunIpc();
    await refresh();
  }, [refresh]);

  const saveBackendUrl = useCallback(
    async (url: string) => {
      await saveEnvSettings({ backendBaseUrl: url });
      await refresh();
    },
    [refresh],
  );

  /** 保存手动 Python 解释器覆盖（清空即恢复自动检测），随后重新检测 */
  const savePythonOverride = useCallback(
    async (target: InstallTarget, pythonPath: string) => {
      // 目前仅剩 inference 一个安装/覆盖目标（Agent 编排已迁到 Node，无需 Python）
      void target;
      await saveEnvSettings({ inferencePythonOverride: pythonPath.trim() });
      await refresh();
    },
    [refresh],
  );

  const startInstall = useCallback(async (target: InstallTarget) => {
    const result = await startEnvironmentInstall(target);
    return result;
  }, []);

  const value = useMemo(
    () => ({
      status,
      loading,
      refresh,
      wizardOpen,
      openWizard,
      closeWizard,
      completeFirstRun,
      dismissFirstRun,
      saveBackendUrl,
      savePythonOverride,
      startInstall,
      localAgentService,
    }),
    [
      status,
      loading,
      refresh,
      wizardOpen,
      openWizard,
      closeWizard,
      completeFirstRun,
      dismissFirstRun,
      saveBackendUrl,
      savePythonOverride,
      startInstall,
      localAgentService,
    ],
  );

  return (
    <EnvironmentContext.Provider value={value}>
      {children}
    </EnvironmentContext.Provider>
  );
}

export function useEnvironment(): EnvironmentContextValue {
  const ctx = useContext(EnvironmentContext);
  if (!ctx) {
    throw new Error('useEnvironment must be used within EnvironmentProvider');
  }
  return ctx;
}
