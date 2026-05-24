export const API_BASE_URL =
  process.env.API_BASE_URL ?? 'http://localhost:8000/api/v1';

export const REMEMBERED_EMAIL_KEY = 'lr-agent:remembered-email';

/** Resolve API base URL; uses page hostname for LAN/mobile verify flows. */
export function resolveApiBaseUrl(): string {
  if (process.env.API_BASE_URL) {
    return process.env.API_BASE_URL;
  }
  if (typeof window !== 'undefined' && window.location.hostname) {
    return `http://${window.location.hostname}:8000/api/v1`;
  }
  return API_BASE_URL;
}
