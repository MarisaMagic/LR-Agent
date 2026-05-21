import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

export type Channels =
  | 'ipc-example'
  | 'dialog:openDirectory'
  | 'fs:readDir'
  | 'fs:readFile'
  | 'fs:readFileBuffer'
  | 'fs:getFileStats'
  | 'shell:openPath'
  | 'menu:openFolder'
  | 'menu:toggleLeftSidebar'
  | 'menu:toggleRightSidebar';

export interface DirectoryItem {
  name: string;
  isDirectory: boolean;
  path: string;
}

export interface FileStats {
  size: number;
  mtime: Date;
  isDirectory: boolean;
}

const electronHandler = {
  ipcRenderer: {
    sendMessage(channel: Channels, ...args: unknown[]) {
      ipcRenderer.send(channel, ...args);
    },
    on(channel: Channels, func: (...args: unknown[]) => void) {
      const subscription = (_event: IpcRendererEvent, ...args: unknown[]) =>
        func(...args);
      ipcRenderer.on(channel, subscription);

      return () => {
        ipcRenderer.removeListener(channel, subscription);
      };
    },
    once(channel: Channels, func: (...args: unknown[]) => void) {
      ipcRenderer.once(channel, (_event, ...args) => func(...args));
    },
    invoke: <T = unknown>(channel: Channels, ...args: unknown[]) => {
      return ipcRenderer.invoke(channel, ...args) as Promise<T>;
    },
  },
  fileSystem: {
    openDirectory: (): Promise<string | null> =>
      ipcRenderer.invoke('dialog:openDirectory'),
    readDirectory: (dirPath: string): Promise<DirectoryItem[]> =>
      ipcRenderer.invoke('fs:readDir', dirPath),
    readFile: (filePath: string): Promise<string | null> =>
      ipcRenderer.invoke('fs:readFile', filePath),
    readFileBuffer: (filePath: string): Promise<ArrayBuffer | null> =>
      ipcRenderer.invoke('fs:readFileBuffer', filePath),
    getFileStats: (filePath: string): Promise<FileStats | null> =>
      ipcRenderer.invoke('fs:getFileStats', filePath),
    openPath: (filePath: string): Promise<string> =>
      ipcRenderer.invoke('shell:openPath', filePath),
  },
};

contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
