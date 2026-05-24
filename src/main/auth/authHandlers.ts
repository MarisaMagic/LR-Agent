import { ipcMain } from 'electron';
import {
  clearRefreshToken,
  getRefreshToken,
  setRefreshToken,
} from './tokenStore';

export default function registerAuthHandlers(): void {
  ipcMain.handle('auth:getRefreshToken', async () => getRefreshToken());
  ipcMain.handle('auth:setRefreshToken', async (_event, token: string) => {
    await setRefreshToken(token);
  });
  ipcMain.handle('auth:clearRefreshToken', async () => {
    await clearRefreshToken();
  });
}
