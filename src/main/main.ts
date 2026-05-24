import path from 'path';
import fs from 'fs-extra';
import { app, BrowserWindow, shell, ipcMain, dialog, Menu } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import MenuBuilder from './menu';
import { resolveHtmlPath } from './util';
import { DirectoryItem, FileStats } from './preload';
import registerAuthHandlers from './auth/authHandlers';

class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify();
  }
}

let mainWindow: BrowserWindow | null = null;

const DEFAULT_IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  '.erb',
  'dist',
  'release',
  '.cache',
]);

function normalizePath(filePath: string): string {
  return path.normalize(filePath);
}

function isIgnoredEntry(name: string, isDirectory: boolean): boolean {
  if (!isDirectory) return false;
  return DEFAULT_IGNORE_DIRS.has(name);
}

ipcMain.handle('fs:readFileBuffer', async (_event, filePath: string) => {
  try {
    const buffer = await fs.readFile(filePath);
    return buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );
  } catch (error) {
    console.error('Error reading file buffer:', error);
    return null;
  }
});

ipcMain.handle('shell:openPath', async (_event, filePath: string) => {
  return shell.openPath(filePath);
});

ipcMain.on('ipc-example', async (event, arg) => {
  const msgTemplate = (pingPong: string) => `IPC test: ${pingPong}`;
  console.log(msgTemplate(arg));
  event.reply('ipc-example', msgTemplate('pong'));
});

ipcMain.handle('dialog:openDirectory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });
  return result.filePaths[0] || null;
});

ipcMain.handle(
  'fs:readDir',
  async (_event, dirPath: string): Promise<DirectoryItem[]> => {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries
        .filter((entry) => !isIgnoredEntry(entry.name, entry.isDirectory()))
        .map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          path: normalizePath(path.join(dirPath, entry.name)),
        }));
    } catch (error) {
      console.error('Error reading directory:', error);
      return [];
    }
  },
);

ipcMain.handle(
  'fs:readFile',
  async (_event, filePath: string): Promise<string | null> => {
    try {
      const stats = await fs.stat(filePath);
      const maxPreviewBytes = 512 * 1024;
      if (stats.size > 5 * 1024 * 1024) {
        const handle = await fs.open(filePath, 'r');
        const buffer = Buffer.alloc(Math.min(maxPreviewBytes, stats.size));
        await handle.read(buffer, 0, buffer.length, 0);
        await handle.close();
        const content = buffer.toString('utf-8');
        const lines = content.split('\n').slice(0, 2000);
        return `${lines.join('\n')}\n\n... [文件过大，仅显示部分内容]`;
      }
      return await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      console.error('Error reading file:', error);
      return null;
    }
  },
);

ipcMain.handle(
  'fs:getFileStats',
  async (event, filePath: string): Promise<FileStats | null> => {
    try {
      const stats = await fs.stat(filePath);
      return {
        size: stats.size,
        mtime: stats.mtime,
        isDirectory: stats.isDirectory(),
      };
    } catch (error) {
      console.error('Error getting file stats:', error);
      return null;
    }
  },
);

let windowIpcRegistered = false;

function registerWindowIpcHandlers(): void {
  if (windowIpcRegistered) {
    return;
  }
  windowIpcRegistered = true;

  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.on('window:maximize', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
  });

  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.on('window:reload', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.webContents.reload();
  });

  ipcMain.on('window:toggleDevTools', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.webContents.toggleDevTools();
  });

  ipcMain.on('window:toggleFullScreen', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return;
    window.setFullScreen(!window.isFullScreen());
  });

  ipcMain.handle('window:isMaximized', (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    return window?.isMaximized() ?? false;
  });

  ipcMain.handle('window:openExternal', async (_event, url: string) => {
    await shell.openExternal(url);
  });
}

function attachWindowStateEvents(window: BrowserWindow): void {
  const notifyMaximizeChange = (isMaximized: boolean) => {
    window.webContents.send('window:maximize-change', isMaximized);
  };

  window.on('maximize', () => notifyMaximizeChange(true));
  window.on('unmaximize', () => notifyMaximizeChange(false));
}

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

if (isDebug) {
  require('electron-debug').default();
}

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS'];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload,
    )
    .catch(console.log);
};

const createWindow = async () => {
  if (isDebug && !process.env.SKIP_DEVTOOLS) {
    await installExtensions();
  }

  const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');

  const getAssetPath = (...paths: string[]): string => {
    return path.join(RESOURCES_PATH, ...paths);
  };

  const isMac = process.platform === 'darwin';

  registerWindowIpcHandlers();

  mainWindow = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    icon: getAssetPath('icon.png'),
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 12, y: 8 },
        }
      : { frame: false }),
    webPreferences: {
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  attachWindowStateEvents(mainWindow);

  mainWindow.loadURL(resolveHtmlPath('index.html'));

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) {
      throw new Error('"mainWindow" is not defined');
    }
    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
    } else {
      mainWindow.show();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  Menu.setApplicationMenu(null);

  if (isDebug) {
    const menuBuilder = new MenuBuilder(mainWindow);
    menuBuilder.setupDevelopmentEnvironment();
  }

  mainWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });

  new AppUpdater();
};

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app
  .whenReady()
  .then(() => {
    registerAuthHandlers();
    createWindow();
    app.on('activate', () => {
      if (mainWindow === null) createWindow();
    });
  })
  .catch(console.log);
