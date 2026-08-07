import { ipcMain } from 'electron';
import { scanSkillsCatalog } from './skillScanner';

export function registerSkillHandlers(): void {
  ipcMain.handle('agent:skills:listCatalog', () => {
    return scanSkillsCatalog();
  });
}
