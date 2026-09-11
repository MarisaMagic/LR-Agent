import { ipcMain, shell } from 'electron';
import {
  clearSkillsCache,
  ensureUserSkillsRoot,
  resolveSkillDirPath,
  scanSkillsCatalog,
  scanSkillsInventory,
} from './skillScanner';

export function registerSkillHandlers(): void {
  ipcMain.handle('agent:skills:listCatalog', () => {
    return scanSkillsCatalog();
  });

  ipcMain.handle('agent:skills:listInventory', (_event, force?: unknown) => {
    if (force === true) clearSkillsCache();
    return scanSkillsInventory();
  });

  ipcMain.handle('agent:skills:openRoot', async () => {
    const root = await ensureUserSkillsRoot();
    return shell.openPath(root);
  });

  ipcMain.handle('agent:skills:reveal', async (_event, dirName: unknown) => {
    if (typeof dirName !== 'string' || !dirName.trim()) {
      return '';
    }
    const skillDir = await resolveSkillDirPath(dirName);
    if (!skillDir) return '';
    return shell.openPath(skillDir);
  });
}
