import { API_BASE_URL } from '../config';
import { ApiError, ApiErrorBody, TokenResponse } from '../types/auth';
import tokenHolder from './tokenHolder';

let refreshInFlight: Promise<boolean> | null = null;

async function performRefresh(): Promise<boolean> {
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

/** Deduplicated refresh — concurrent 401s share one in-flight request. */
export async function refreshSessionOnce(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = performRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export async function handleUnauthorized(): Promise<boolean> {
  const refreshed = await refreshSessionOnce();
  if (!refreshed) {
    tokenHolder.notifySessionExpired();
  }
  return refreshed;
}

export function buildAuthHeaders(headers?: HeadersInit): Headers {
  const requestHeaders = new Headers(headers);
  const accessToken = tokenHolder.getAccessToken();
  if (accessToken) {
    requestHeaders.set('Authorization', `Bearer ${accessToken}`);
  }
  return requestHeaders;
}

export interface AuthFetchOptions extends RequestInit {
  auth?: boolean;
  _retried?: boolean;
}

export async function authFetch(
  url: string,
  options: AuthFetchOptions = {},
): Promise<Response> {
  const { auth = true, _retried = false, headers, ...rest } = options;
  const requestHeaders = buildAuthHeaders(headers);

  if (
    rest.body &&
    !(rest.body instanceof FormData) &&
    !requestHeaders.has('Content-Type')
  ) {
    requestHeaders.set('Content-Type', 'application/json');
  }

  const response = await fetch(url, {
    ...rest,
    headers: requestHeaders,
  });

  if (response.status === 401 && auth && !_retried) {
    const refreshed = await handleUnauthorized();
    if (refreshed) {
      return authFetch(url, { ...options, _retried: true });
    }
    throw new ApiError(401, 'session_expired');
  }

  return response;
}

export async function authFetchPath(
  path: string,
  options: AuthFetchOptions = {},
): Promise<Response> {
  return authFetch(`${API_BASE_URL}${path}`, options);
}

export async function parseApiError(response: Response): Promise<ApiError> {
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
