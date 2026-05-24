import fs from 'fs-extra';
import { app, safeStorage } from 'electron';
import path from 'path';

const TOKEN_FILE = 'refresh_token.dat';

function tokenFilePath(): string {
  return path.join(app.getPath('userData'), TOKEN_FILE);
}

export async function getRefreshToken(): Promise<string | null> {
  const filePath = tokenFilePath();
  if (!(await fs.pathExists(filePath))) {
    return null;
  }

  const buffer = await fs.readFile(filePath);
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(buffer);
    } catch {
      return null;
    }
  }

  return buffer.toString('utf-8');
}

export async function setRefreshToken(token: string): Promise<void> {
  const filePath = tokenFilePath();
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(token)
    : Buffer.from(token, 'utf-8');
  await fs.writeFile(filePath, data);
}

export async function clearRefreshToken(): Promise<void> {
  const filePath = tokenFilePath();
  if (await fs.pathExists(filePath)) {
    await fs.remove(filePath);
  }
}
