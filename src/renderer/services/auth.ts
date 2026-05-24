import { MessageResponse, TokenResponse, UserPublic } from '../types/auth';
import { resolveApiBaseUrl } from '../config';
import tokenHolder from './tokenHolder';
import { apiFetch } from './api';

async function persistSession(result: TokenResponse): Promise<void> {
  tokenHolder.setAccessToken(result.access_token);
  await window.electron.auth.setRefreshToken(result.refresh_token);
}

async function clearSession(): Promise<void> {
  tokenHolder.setAccessToken(null);
  await window.electron.auth.clearRefreshToken();
}

export async function register(email: string, password: string): Promise<void> {
  await apiFetch<MessageResponse>('/auth/register', {
    method: 'POST',
    auth: false,
    body: JSON.stringify({ email, password }),
  });
}

export async function resendVerificationEmail(): Promise<void> {
  await apiFetch<MessageResponse>('/auth/resend-verification-email', {
    method: 'POST',
  });
}

export async function verifyEmail(token: string): Promise<void> {
  const response = await fetch(`${resolveApiBaseUrl()}/auth/verify-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  if (!response.ok) {
    let detail = 'request_failed';
    try {
      const body = (await response.json()) as { detail?: string };
      if (typeof body.detail === 'string') {
        detail = body.detail;
      }
    } catch {
      detail = response.statusText || detail;
    }
    throw new Error(detail);
  }
}

export async function login(
  email: string,
  password: string,
): Promise<TokenResponse> {
  const result = await apiFetch<TokenResponse>('/auth/login', {
    method: 'POST',
    auth: false,
    body: JSON.stringify({ email, password }),
  });
  await persistSession(result);
  return result;
}

export async function refresh(refreshToken: string): Promise<TokenResponse> {
  const result = await apiFetch<TokenResponse>('/auth/refresh', {
    method: 'POST',
    auth: false,
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  await persistSession(result);
  return result;
}

export async function logout(): Promise<void> {
  const refreshToken = await window.electron.auth.getRefreshToken();
  if (refreshToken) {
    try {
      await apiFetch<MessageResponse>('/auth/logout', {
        method: 'POST',
        auth: false,
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
    } catch {
      // Ignore network errors during logout.
    }
  }
  await clearSession();
}

export async function tryRefreshSession(): Promise<boolean> {
  const refreshToken = await window.electron.auth.getRefreshToken();
  if (!refreshToken) {
    return false;
  }

  try {
    await refresh(refreshToken);
    return true;
  } catch {
    await clearSession();
    return false;
  }
}

export async function restoreSession(): Promise<UserPublic | null> {
  const refreshToken = await window.electron.auth.getRefreshToken();
  if (!refreshToken) {
    return null;
  }

  try {
    const result = await refresh(refreshToken);
    return result.user;
  } catch {
    await clearSession();
    return null;
  }
}

export async function revokeAllSessions(): Promise<void> {
  await apiFetch<MessageResponse>('/auth/revoke-all-sessions', {
    method: 'POST',
  });
  await clearSession();
}

export { clearSession };
