import { LocalSessionCache, TokenResponse, UserPublic } from '../types/auth';
import tokenHolder from './tokenHolder';
import { decodeJwtPayload, isRefreshTokenExpiredLocally } from './jwtUtils';

export async function writeSessionCache(
  user: UserPublic,
  refreshToken: string,
): Promise<void> {
  const payload = decodeJwtPayload(refreshToken);
  const refreshTokenExp = payload?.exp;
  if (!refreshTokenExp) {
    return;
  }

  const cache: LocalSessionCache = {
    user,
    lastOnlineAt: new Date().toISOString(),
    refreshTokenExp,
  };
  await window.electron.auth.setSessionCache(cache);
}

export async function readValidSessionCache(): Promise<LocalSessionCache | null> {
  const cache = await window.electron.auth.getSessionCache();
  if (!cache) {
    return null;
  }
  if (isRefreshTokenExpiredLocally(cache.refreshTokenExp)) {
    return null;
  }
  return cache;
}

export async function persistSession(result: TokenResponse): Promise<void> {
  tokenHolder.setAccessToken(result.access_token);
  await window.electron.auth.setRefreshToken(result.refresh_token);
  await writeSessionCache(result.user, result.refresh_token);
}

export async function clearSession(): Promise<void> {
  tokenHolder.setAccessToken(null);
  await window.electron.auth.clearRefreshToken();
  await window.electron.auth.clearSessionCache();
}
