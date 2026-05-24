import { API_BASE_URL } from '../config';
import { ApiError, ApiErrorBody, TokenResponse } from '../types/auth';
import tokenHolder from './tokenHolder';

interface ApiFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: FormData | string | null;
  _retried?: boolean;
  auth?: boolean;
}

async function tryRefreshSession(): Promise<boolean> {
  const refreshToken = await window.electron.auth.getRefreshToken();
  if (!refreshToken) {
    return false;
  }

  const response = await fetch(`${API_BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!response.ok) {
    tokenHolder.setAccessToken(null);
    await window.electron.auth.clearRefreshToken();
    return false;
  }

  const result = (await response.json()) as TokenResponse;
  tokenHolder.setAccessToken(result.access_token);
  await window.electron.auth.setRefreshToken(result.refresh_token);
  return true;
}

async function parseError(response: Response): Promise<ApiError> {
  let detail = 'request_failed';
  try {
    const body = (await response.json()) as ApiErrorBody;
    if (typeof body.detail === 'string') {
      detail = body.detail;
    }
  } catch {
    detail = response.statusText || detail;
  }
  return new ApiError(response.status, detail);
}

// eslint-disable-next-line import/prefer-default-export
export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const { auth = true, _retried = false, headers, ...rest } = options;
  const requestHeaders = new Headers(headers);

  if (auth) {
    const accessToken = tokenHolder.getAccessToken();
    if (accessToken) {
      requestHeaders.set('Authorization', `Bearer ${accessToken}`);
    }
  }

  if (
    rest.body &&
    !(rest.body instanceof FormData) &&
    !requestHeaders.has('Content-Type')
  ) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    headers: requestHeaders,
  });

  if (response.status === 401 && auth && !_retried) {
    const refreshed = await tryRefreshSession();
    if (refreshed) {
      return apiFetch<T>(path, { ...options, _retried: true });
    }
    tokenHolder.notifySessionExpired();
    throw new ApiError(401, 'session_expired');
  }

  if (!response.ok) {
    throw await parseError(response);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}
