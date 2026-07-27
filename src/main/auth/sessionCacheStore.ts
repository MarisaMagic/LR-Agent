import fs from 'fs-extra';
import { app, safeStorage } from 'electron';
import path from 'path';

const CACHE_FILE = 'session_cache.dat';

export interface LocalSessionCache {
  user: {
    id: string;
    email: string;
    email_verified: boolean;
    username: string | null;
    display_name: string | null;
    avatar_url: string | null;
    created_at: string;
  };
  lastOnlineAt: string;
  refreshTokenExp: number;
}

function cacheFilePath(): string {
  return path.join(app.getPath('userData'), CACHE_FILE);
}

async function readEncryptedJson(): Promise<LocalSessionCache | null> {
  const filePath = cacheFilePath();
  if (!(await fs.pathExists(filePath))) {
    return null;
  }

  const buffer = await fs.readFile(filePath);
  let json: string;
  if (safeStorage.isEncryptionAvailable()) {
    try {
      json = safeStorage.decryptString(buffer);
    } catch {
      return null;
    }
  } else {
    json = buffer.toString('utf-8');
  }

  try {
    return JSON.parse(json) as LocalSessionCache;
  } catch {
    return null;
  }
}

export async function getSessionCache(): Promise<LocalSessionCache | null> {
  return readEncryptedJson();
}

export async function setSessionCache(cache: LocalSessionCache): Promise<void> {
  const filePath = cacheFilePath();
  const json = JSON.stringify(cache);
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf-8');
  await fs.writeFile(filePath, data);
}

export async function clearSessionCache(): Promise<void> {
  const filePath = cacheFilePath();
  if (await fs.pathExists(filePath)) {
    await fs.remove(filePath);
  }
}
