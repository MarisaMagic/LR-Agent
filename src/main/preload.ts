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
  | 'menu:toggleRightSidebar'
  | 'auth:getRefreshToken'
  | 'auth:setRefreshToken'
  | 'auth:clearRefreshToken'
  | 'window:minimize'
  | 'window:maximize'
  | 'window:close'
  | 'window:reload'
  | 'window:toggleDevTools'
  | 'window:toggleFullScreen'
  | 'window:maximize-change'
  | 'menu:createAnnotationProject'
  | 'theme:systemChanged'
  | 'theme:notifyEffectiveTheme';

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
  platform: process.platform as NodeJS.Platform,
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
    invoke: <T = unknown>(channel: string, ...args: unknown[]) => {
      return ipcRenderer.invoke(channel, ...args) as Promise<T>;
    },
  },
  window: {
    minimize: (): void => {
      ipcRenderer.send('window:minimize');
    },
    maximize: (): void => {
      ipcRenderer.send('window:maximize');
    },
    close: (): void => {
      ipcRenderer.send('window:close');
    },
    reload: (): void => {
      ipcRenderer.send('window:reload');
    },
    toggleDevTools: (): void => {
      ipcRenderer.send('window:toggleDevTools');
    },
    toggleFullScreen: (): void => {
      ipcRenderer.send('window:toggleFullScreen');
    },
    isMaximized: (): Promise<boolean> =>
      ipcRenderer.invoke('window:isMaximized'),
    openExternal: (url: string): Promise<void> =>
      ipcRenderer.invoke('window:openExternal', url),
    onMaximizeChange: (
      callback: (isMaximized: boolean) => void,
    ): (() => void) =>
      electronHandler.ipcRenderer.on('window:maximize-change', (value) => {
        callback(Boolean(value));
      }),
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
  auth: {
    getRefreshToken: (): Promise<string | null> =>
      ipcRenderer.invoke('auth:getRefreshToken'),
    setRefreshToken: (token: string): Promise<void> =>
      ipcRenderer.invoke('auth:setRefreshToken', token),
    clearRefreshToken: (): Promise<void> =>
      ipcRenderer.invoke('auth:clearRefreshToken'),
  },
  theme: {
    getSystemDark: (): Promise<boolean> =>
      ipcRenderer.invoke('theme:getSystemDark'),
    notifyEffectiveTheme: (theme: 'dark' | 'light'): void => {
      ipcRenderer.send('theme:notifyEffectiveTheme', theme);
    },
    onSystemChanged: (callback: (isDark: boolean) => void): (() => void) =>
      electronHandler.ipcRenderer.on('theme:systemChanged', (value) => {
        callback(Boolean(value));
      }),
  },
  pretrainedModels: {
    getAll: (): Promise<
      import('./pretrainedModels/pretrainedModelStore').PretrainedModelConfig[]
    > => ipcRenderer.invoke('pretrainedModels:getAll'),
    saveAll: (
      models: import('./pretrainedModels/pretrainedModelStore').PretrainedModelConfig[],
    ): Promise<void> => ipcRenderer.invoke('pretrainedModels:saveAll', models),
    validate: (
      model: Pick<
        import('./pretrainedModels/pretrainedModelStore').PretrainedModelConfig,
        'modelType' | 'checkpointPath' | 'configPath'
      >,
    ): Promise<
      import('./pretrainedModels/pretrainedModelStore').PretrainedModelValidationResult
    > => ipcRenderer.invoke('pretrainedModels:validate', model),
    scanSam2Directory: (
      rootDir: string,
    ): Promise<
      import('./pretrainedModels/pretrainedModelStore').Sam2ScanResult[]
    > => ipcRenderer.invoke('pretrainedModels:scanSam2Directory', rootDir),
  },
  dialog: {
    openFile: (options?: {
      title?: string;
      filters?: { name: string; extensions: string[] }[];
    }): Promise<string | null> =>
      ipcRenderer.invoke('dialog:openFile', options),
  },
  annotation: {
    getProjects: (): Promise<unknown[]> =>
      ipcRenderer.invoke('annotation:getProjects'),
    saveProjects: (projects: unknown[]): Promise<void> =>
      ipcRenderer.invoke('annotation:saveProjects', projects),
    writeProjectConfig: (
      directoryPath: string,
      project: unknown,
    ): Promise<void> =>
      ipcRenderer.invoke(
        'annotation:writeProjectConfig',
        directoryPath,
        project,
      ),
    removeProjectConfig: (directoryPath: string): Promise<void> =>
      ipcRenderer.invoke('annotation:removeProjectConfig', directoryPath),
    showItemInFolder: (itemPath: string): Promise<void> =>
      ipcRenderer.invoke('annotation:showItemInFolder', itemPath),
    readFileAnnotationDoc: (
      projectDir: string,
      relativePath: string,
    ): Promise<unknown | null> =>
      ipcRenderer.invoke(
        'annotation:readFileAnnotationDoc',
        projectDir,
        relativePath,
      ),
    writeFileAnnotationDoc: (
      projectDir: string,
      relativePath: string,
      doc: unknown,
      sourceHint?: { mtimeMs?: number; size?: number },
    ): Promise<void> =>
      ipcRenderer.invoke(
        'annotation:writeFileAnnotationDoc',
        projectDir,
        relativePath,
        doc,
        sourceHint,
      ),
  },
};

contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
