import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { UserPublic } from '../types/auth';
import * as authService from '../services/auth';
import * as userService from '../services/user';
import tokenHolder from '../services/tokenHolder';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

interface AuthContextValue {
  status: AuthStatus;
  user: UserPublic | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  switchAccount: () => Promise<void>;
  refreshUser: () => Promise<void>;
  setUser: (user: UserPublic | null) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<UserPublic | null>(null);

  const handleSessionExpired = useCallback(() => {
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  useEffect(() => {
    tokenHolder.setOnSessionExpired(handleSessionExpired);
    return () => tokenHolder.setOnSessionExpired(null);
  }, [handleSessionExpired]);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const restoredUser = await authService.restoreSession();
        if (cancelled) return;
        if (restoredUser) {
          setUser(restoredUser);
          setStatus('authenticated');
        } else {
          setStatus('unauthenticated');
        }
      } catch {
        if (!cancelled) {
          setStatus('unauthenticated');
        }
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await authService.login(email, password);
    setUser(result.user);
    setStatus('authenticated');
  }, []);

  const register = useCallback(async (email: string, password: string) => {
    await authService.register(email, password);
  }, []);

  const logout = useCallback(async () => {
    await authService.logout();
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  const switchAccount = useCallback(async () => {
    await authService.logout();
    setUser(null);
    setStatus('unauthenticated');
  }, []);

  const refreshUser = useCallback(async () => {
    const me = await userService.getMe();
    setUser(me);
  }, []);

  const value = useMemo(
    () => ({
      status,
      user,
      login,
      register,
      logout,
      switchAccount,
      refreshUser,
      setUser,
    }),
    [status, user, login, register, logout, switchAccount, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
