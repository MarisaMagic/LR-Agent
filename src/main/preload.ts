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
  | 'theme:notifyEffectiveTheme'
  | 'file-system:changed'
  | 'workspace:createFile'
  | 'workspace:createFolder'
  | 'workspace:deleteEntry'
  | 'workspace:renameEntry'
  | 'workspace:moveEntry'
  | 'edit:undo'
  | 'edit:redo'
  | 'edit:cut'
  | 'edit:copy'
  | 'edit:paste'
  | 'edit:selectAll'
  | 'dialog:confirm';

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
    onChanged: (callback: (changedDir: string) => void): (() => void) =>
      electronHandler.ipcRenderer.on('file-system:changed', (value) => {
        callback(String(value));
      }),
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
        | 'modelType'
        | 'checkpointPath'
        | 'configPath'
        | 'keypointBackend'
        | 'keypointTemplateIds'
        | 'auxiliaryPaths'
      >,
    ): Promise<
      import('./pretrainedModels/pretrainedModelStore').PretrainedModelValidationResult
    > => ipcRenderer.invoke('pretrainedModels:validate', model),
    scanSam2Directory: (
      rootDir: string,
    ): Promise<
      import('./pretrainedModels/pretrainedModelStore').Sam2ScanResult[]
    > => ipcRenderer.invoke('pretrainedModels:scanSam2Directory', rootDir),
    scanFaceAlignmentDirectory: (
      rootDir: string,
    ): Promise<
      | import('./pretrainedModels/pretrainedModelStore').KeypointAssetScanResult
      | null
    > => ipcRenderer.invoke('pretrainedModels:scanFaceAlignmentDirectory', rootDir),
    scanKeypointBundleDirectory: (
      rootDir: string,
    ): Promise<
      import('./pretrainedModels/pretrainedModelStore').KeypointBundleScanResult
    > => ipcRenderer.invoke('pretrainedModels:scanKeypointBundleDirectory', rootDir),
  },
  preAnnot: {
    checkRuntime: (): Promise<
      import('../shared/preAnnotTypes').PreAnnotRuntimeInfo
    > => ipcRenderer.invoke('preAnnot:checkRuntime'),
    run: (
      request: import('../shared/preAnnotTypes').PreAnnotRequest,
    ): Promise<import('../shared/preAnnotTypes').PreAnnotRunResponse> =>
      ipcRenderer.invoke('preAnnot:run', request),
    cancel: (): Promise<void> => ipcRenderer.invoke('preAnnot:cancel'),
  },
  dialog: {
    openFile: (options?: {
      title?: string;
      filters?: { name: string; extensions: string[] }[];
    }): Promise<string | null> =>
      ipcRenderer.invoke('dialog:openFile', options),
    confirm: (
      message: string,
      title?: string,
    ): Promise<{ confirmed: boolean }> =>
      ipcRenderer.invoke('dialog:confirm', { title, message }),
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
    exportAnnotations: (
      request: import('../shared/annotationExportTypes').AnnotationExportRequest,
    ): Promise<
      import('../shared/annotationExportTypes').AnnotationExportResult
    > => ipcRenderer.invoke('annotation:exportAnnotations', request),
  },
  annotationAgent: {
    listImages: (
      projectDir: string,
      maxFiles?: number,
    ): Promise<
      Array<{
        relativePath: string;
        name: string;
        parent: string;
        absolutePath: string;
        index: number;
      }>
    > => ipcRenderer.invoke('annotationAgent:listImages', projectDir, maxFiles),
    globImages: (
      projectDir: string,
      options?: {
        parentFolder?: string;
        namePattern?: string;
        limit?: number;
      },
    ): Promise<{
      count: number;
      images: Array<{
        relativePath: string;
        name: string;
        parent: string;
        absolutePath: string;
        index: number;
      }>;
    }> => ipcRenderer.invoke('annotationAgent:globImages', projectDir, options),
    listDirectory: (
      projectDir: string,
      relativeDir?: string,
      maxEntries?: number,
    ): Promise<{
      relativeDir: string;
      entries: Array<{
        name: string;
        relativePath: string;
        kind: 'file' | 'directory';
        isImage: boolean;
      }>;
    }> =>
      ipcRenderer.invoke(
        'annotationAgent:listDirectory',
        projectDir,
        relativeDir,
        maxEntries,
      ),
  },
  analysis: {
    runScript: (payload: {
      script: string;
      dataFiles?: Record<string, unknown>;
      timeoutMs?: number;
    }): Promise<{ stdout: string; truncated: boolean }> =>
      ipcRenderer.invoke('analysis:runScript', payload),
  },
  workspace: {
    writeTextFile: (payload: {
      rootDir: string;
      relativePath: string;
      content: string;
    }): Promise<{ success: boolean; filePath?: string; error?: string }> =>
      ipcRenderer.invoke('workspace:writeTextFile', payload),
    readTextFile: (payload: {
      rootDir: string;
      relativePath: string;
    }): Promise<{
      success: boolean;
      content?: string;
      exists?: boolean;
      filePath?: string;
      error?: string;
    }> => ipcRenderer.invoke('workspace:readTextFile', payload),
    createFile: (
      dirPath: string,
      fileName: string,
    ): Promise<{ success: boolean; filePath?: string; error?: string }> =>
      ipcRenderer.invoke('workspace:createFile', dirPath, fileName),
    createFolder: (
      dirPath: string,
      folderName: string,
    ): Promise<{ success: boolean; folderPath?: string; error?: string }> =>
      ipcRenderer.invoke('workspace:createFolder', dirPath, folderName),
    deleteEntry: (
      entryPath: string,
    ): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('workspace:deleteEntry', entryPath),
    renameEntry: (
      oldPath: string,
      newName: string,
    ): Promise<{
      success: boolean;
      oldPath?: string;
      newPath?: string;
      error?: string;
    }> => ipcRenderer.invoke('workspace:renameEntry', oldPath, newName),
    moveEntry: (
      srcPath: string,
      destDir: string,
    ): Promise<{
      success: boolean;
      oldPath?: string;
      newPath?: string;
      error?: string;
    }> => ipcRenderer.invoke('workspace:moveEntry', srcPath, destDir),
  },
  mcp: {
    /** 获取本地 MCP Server URL（如 "http://127.0.0.1:PORT"），未启动时返回 null */
    getServerUrl: (): Promise<string | null> =>
      ipcRenderer.invoke('mcp:getServerUrl'),
  },
};

contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
