import { ApiError } from '../types/auth';
import { isOfflineMode } from './authMode';
import tokenHolder from './tokenHolder';

/** Ensures cloud-backed APIs are only called when online with a valid access token. */
export function requireCloudAuth(): void {
  if (isOfflineMode()) {
    throw new ApiError(0, 'network_unavailable');
  }
  if (!tokenHolder.getAccessToken()) {
    throw new ApiError(401, 'not_authenticated');
  }
}
