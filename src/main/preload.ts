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
  | 'auth:getSessionCache'
  | 'auth:setSessionCache'
  | 'auth:clearSessionCache'
  | 'auth:resetPasswordDeepLink'
  | 'window:minimize'
  | 'window:maximize'
  | 'window:close'
  | 'window:reload'
  | 'window:toggleDevTools'
  | 'window:toggleFullScreen'
  | 'window:maximize-change'
  | 'window:fullscreen-change'
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
  | 'edit:save'
  | 'dialog:confirm'
  | 'env:install:progress'
  | 'localAgent:status';

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
    isFullScreen: (): Promise<boolean> =>
      ipcRenderer.invoke('window:isFullScreen'),
    openExternal: (url: string): Promise<void> =>
      ipcRenderer.invoke('window:openExternal', url),
    onMaximizeChange: (
      callback: (isMaximized: boolean) => void,
    ): (() => void) =>
      electronHandler.ipcRenderer.on('window:maximize-change', (value) => {
        callback(Boolean(value));
      }),
    onFullScreenChange: (
      callback: (isFullScreen: boolean) => void,
    ): (() => void) =>
      electronHandler.ipcRenderer.on('window:fullscreen-change', (value) => {
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
    getSessionCache: (): Promise<import('./auth/sessionCacheStore').LocalSessionCache | null> =>
      ipcRenderer.invoke('auth:getSessionCache'),
    setSessionCache: (
      cache: import('./auth/sessionCacheStore').LocalSessionCache,
    ): Promise<void> => ipcRenderer.invoke('auth:setSessionCache', cache),
    clearSessionCache: (): Promise<void> =>
      ipcRenderer.invoke('auth:clearSessionCache'),
    getPendingResetToken: (): Promise<string | null> =>
      ipcRenderer.invoke('auth:getPendingResetToken'),
    onResetPasswordDeepLink: (
      callback: (token: string) => void,
    ): (() => void) =>
      electronHandler.ipcRenderer.on('auth:resetPasswordDeepLink', (value) => {
        callback(String(value));
      }),
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
    listTextFiles: (
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
    > => ipcRenderer.invoke('annotationAgent:listTextFiles', projectDir, maxFiles),
    resolveRelativeFile: (
      projectDir: string,
      relativePath: string,
    ): Promise<{ relativePath: string; absolutePath: string } | null> =>
      ipcRenderer.invoke('annotationAgent:resolveRelativeFile', projectDir, relativePath),
  },
  quality: {
    createRun: (
      projectDir: string,
    ): Promise<{ runId: string; runAbsolutePath: string }> =>
      ipcRenderer.invoke('quality:createRun', projectDir),
    writeChart: (
      projectDir: string,
      runId: string,
      fileName: string,
      base64Png: string,
    ): Promise<string> =>
      ipcRenderer.invoke(
        'quality:writeChart',
        projectDir,
        runId,
        fileName,
        base64Png,
      ),
    writeSnapshot: (
      projectDir: string,
      runId: string,
      payload: unknown,
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('quality:writeSnapshot', projectDir, runId, payload),
    writeFindings: (
      projectDir: string,
      runId: string,
      payload: unknown,
    ): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('quality:writeFindings', projectDir, runId, payload),
    writeReport: (
      projectDir: string,
      runId: string,
      markdown: string,
      indexEntry: import('../shared/qualityReportTypes').QualityReportIndexEntry,
    ): Promise<{ reportRelativePath: string; reportAbsolutePath: string }> =>
      ipcRenderer.invoke(
        'quality:writeReport',
        projectDir,
        runId,
        markdown,
        indexEntry,
      ),
    listReports: (
      projectDir: string,
    ): Promise<
      import('../shared/qualityReportTypes').QualityReportIndexEntry[]
    > => ipcRenderer.invoke('quality:listReports', projectDir),
    readReport: (
      projectDir: string,
      runId: string,
    ): Promise<{
      markdown: string;
      runAbsolutePath: string;
      chartsDir: string;
    } | null> => ipcRenderer.invoke('quality:readReport', projectDir, runId),
    getRunPath: (projectDir: string, runId: string): Promise<string> =>
      ipcRenderer.invoke('quality:getRunPath', projectDir, runId),
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
  localAgent: {
    /** 获取本地 Agent 编排服务 base URL（如 "http://127.0.0.1:PORT/api/v1"），未启动时返回 null */
    getBaseUrl: (): Promise<string | null> =>
      ipcRenderer.invoke('localAgent:getBaseUrl'),
    /** 订阅本地 Agent 服务状态变化（starting/running/stopped/error） */
    onStatus: (
      callback: (
        status: import('../shared/envTypes').LocalAgentServiceStatus,
      ) => void,
    ): (() => void) =>
      electronHandler.ipcRenderer.on('localAgent:status', (value) => {
        callback(
          value as import('../shared/envTypes').LocalAgentServiceStatus,
        );
      }),
  },
  env: {
    getStatus: (): Promise<import('../shared/envTypes').EnvironmentStatus> =>
      ipcRenderer.invoke('env:getStatus'),
    getSettings: (): Promise<import('../shared/envTypes').EnvSettings> =>
      ipcRenderer.invoke('env:getSettings'),
    setSettings: (
      patch: Partial<import('../shared/envTypes').EnvSettings>,
    ): Promise<import('../shared/envTypes').EnvSettings> =>
      ipcRenderer.invoke('env:setSettings', patch),
    installStart: (
      target: import('../shared/envTypes').InstallTarget,
    ): Promise<import('../shared/envTypes').InstallStartResult> =>
      ipcRenderer.invoke('env:install:start', target),
    installCancel: (): Promise<boolean> =>
      ipcRenderer.invoke('env:install:cancel'),
    installGetProgress: (): Promise<
      import('../shared/envTypes').InstallProgress | null
    > => ipcRenderer.invoke('env:install:getProgress'),
    completeFirstRun: (): Promise<import('../shared/envTypes').EnvSettings> =>
      ipcRenderer.invoke('env:completeFirstRun'),
    dismissFirstRun: (): Promise<import('../shared/envTypes').EnvSettings> =>
      ipcRenderer.invoke('env:dismissFirstRun'),
    markFirstRunSeen: (): Promise<import('../shared/envTypes').EnvSettings> =>
      ipcRenderer.invoke('env:markFirstRunSeen'),
    showItemInFolder: (itemPath: string): Promise<boolean> =>
      ipcRenderer.invoke('env:showItemInFolder', itemPath),
    validatePython: (
      pythonPath: string,
    ): Promise<import('../shared/envTypes').PythonValidationResult> =>
      ipcRenderer.invoke('env:validatePython', pythonPath),
    /** 订阅一键安装进度流 */
    onInstallProgress: (
      callback: (progress: import('../shared/envTypes').InstallProgress) => void,
    ): (() => void) =>
      electronHandler.ipcRenderer.on('env:install:progress', (value) => {
        callback(value as import('../shared/envTypes').InstallProgress);
      }),
  },
  memory: {
    /** 读取目录下 .lragent/INSTRUCTIONS.md（项目级指令），不存在时返回 null */
    readInstructions: (directoryPath: string): Promise<string | null> =>
      ipcRenderer.invoke('agent:memory:readInstructions', directoryPath),
    /** 读取 MEMORY.md 索引（截断后），同时设置活动记忆作用域 */
    readIndex: (scopeKey: string): Promise<string | null> =>
      ipcRenderer.invoke('agent:memory:readIndex', scopeKey),
    readTopic: (scopeKey: string, topicFile: string): Promise<string | null> =>
      ipcRenderer.invoke('agent:memory:readTopic', scopeKey, topicFile),
    listTopics: (scopeKey: string): Promise<string[]> =>
      ipcRenderer.invoke('agent:memory:listTopics', scopeKey),
    writeTopic: (options: {
      scopeKey: string;
      topicFile: string;
      content: string;
      indexLine?: string;
    }): Promise<{ topicPath: string }> =>
      ipcRenderer.invoke('agent:memory:writeTopic', options),
    /** 打开记忆目录（文件管理器） */
    openDir: (scopeKey: string): Promise<string> =>
      ipcRenderer.invoke('agent:memory:openDir', scopeKey),
  },
  skills: {
    /** 扫描全局 skills 目录（~/.agents/skills），返回 catalog（name + description） */
    listCatalog: (): Promise<unknown> =>
      ipcRenderer.invoke('agent:skills:listCatalog'),
  },
  db: {
    // ── Session operations ──
    sessions: {
      list: (options: {
        userId: string;
        limit?: number;
        cursor?: string | null;
        annotationProjectId?: string | null;
        workspaceOnly?: boolean;
      }): Promise<unknown> => ipcRenderer.invoke('db:sessions:list', options),
      get: (sessionId: string, userId: string): Promise<unknown> =>
        ipcRenderer.invoke('db:sessions:get', sessionId, userId),
      create: (session: {
        id: string;
        userId: string;
        title?: string;
        annotationProjectId?: string | null;
        interactionMode?: string | null;
        providerId?: string | null;
        model?: string | null;
      }): Promise<unknown> => ipcRenderer.invoke('db:sessions:create', session),
      update: (sessionId: string, userId: string, patch: Record<string, unknown>): Promise<unknown> =>
        ipcRenderer.invoke('db:sessions:update', sessionId, userId, patch),
      softDelete: (sessionId: string, userId: string): Promise<void> =>
        ipcRenderer.invoke('db:sessions:softDelete', sessionId, userId),
      getMessageIds: (sessionId: string): Promise<string[]> =>
        ipcRenderer.invoke('db:sessions:getMessageIds', sessionId),
      getMessageCount: (sessionId: string): Promise<number> =>
        ipcRenderer.invoke('db:sessions:getMessageCount', sessionId),
      getLastMessagePreview: (sessionId: string): Promise<string | null> =>
        ipcRenderer.invoke('db:sessions:getLastMessagePreview', sessionId),
      listWithStats: (options: {
        userId: string;
        limit?: number;
        cursor?: string | null;
        annotationProjectId?: string | null;
        workspaceOnly?: boolean;
      }): Promise<unknown> =>
        ipcRenderer.invoke('db:sessions:listWithStats', options),
      backfillLegacyUserId: (userId: string): Promise<{
        sessionsUpdated: number;
        messagesUpdated: number;
      }> => ipcRenderer.invoke('db:sessions:backfillLegacyUserId', userId),
    },
    // ── Message operations ──
    messages: {
      list: (sessionId: string, options: {
        beforeMessageId?: string | null;
        limit?: number;
      }): Promise<unknown> => ipcRenderer.invoke('db:messages:list', sessionId, options),
      create: (message: {
        id: string;
        sessionId: string;
        userId: string;
        role: string;
        interactionMode?: string | null;
        sortIndex?: number;
        blocksJson?: string;
        status?: string;
        providerId?: string | null;
        model?: string | null;
        error?: string | null;
      }): Promise<unknown> => ipcRenderer.invoke('db:messages:create', message),
      update: (messageId: string, patch: Record<string, unknown>): Promise<unknown> =>
        ipcRenderer.invoke('db:messages:update', messageId, patch),
      deleteAfter: (sessionId: string, sortIndex: number): Promise<void> =>
        ipcRenderer.invoke('db:messages:deleteAfter', sessionId, sortIndex),
      get: (messageId: string): Promise<unknown> =>
        ipcRenderer.invoke('db:messages:get', messageId),
      deleteAfterId: (sessionId: string, messageId: string): Promise<void> =>
        ipcRenderer.invoke('db:messages:deleteAfterId', sessionId, messageId),
      cleanupStreaming: (sessionId?: string): Promise<number> =>
        ipcRenderer.invoke('db:messages:cleanupStreaming', sessionId),
      deleteBySession: (sessionId: string): Promise<void> =>
        ipcRenderer.invoke('db:messages:deleteBySession', sessionId),
      batchCreate: (messages: unknown[]): Promise<void> =>
        ipcRenderer.invoke('db:messages:batchCreate', messages),
      getForExport: (sessionId: string): Promise<unknown> =>
        ipcRenderer.invoke('db:messages:getForExport', sessionId),
    },
    // ── Provider operations ──
    providers: {
      list: (): Promise<unknown> => ipcRenderer.invoke('db:providers:list'),
      get: (id: string): Promise<unknown> => ipcRenderer.invoke('db:providers:get', id),
      create: (provider: {
        id: string;
        name: string;
        baseUrl: string;
        apiKeyEncrypted: string;
        encryptionKeyId?: string;
        model: string;
        enabled?: boolean;
        isDefault?: boolean;
        supportsVision?: boolean;
      }): Promise<unknown> => ipcRenderer.invoke('db:providers:create', provider),
      update: (id: string, patch: Record<string, unknown>): Promise<unknown> =>
        ipcRenderer.invoke('db:providers:update', id, patch),
      delete: (id: string): Promise<void> =>
        ipcRenderer.invoke('db:providers:delete', id),
      setDefault: (id: string): Promise<unknown> =>
        ipcRenderer.invoke('db:providers:setDefault', id),
      getDefault: (): Promise<unknown> => ipcRenderer.invoke('db:providers:getDefault'),
    },
  },
};

contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
