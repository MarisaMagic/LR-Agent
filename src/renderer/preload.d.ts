import { Channels, DirectoryItem, FileStats } from '../main/preload';

declare global {
  interface Window {
    electron: {
      platform: NodeJS.Platform;
      ipcRenderer: {
        sendMessage(channel: Channels, ...args: unknown[]): void;
        on(channel: Channels, func: (...args: unknown[]) => void): () => void;
        once(channel: Channels, func: (...args: unknown[]) => void): void;
        invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
      };
      window: {
        minimize(): void;
        maximize(): void;
        close(): void;
        reload(): void;
        toggleDevTools(): void;
        toggleFullScreen(): void;
        isMaximized(): Promise<boolean>;
        openExternal(url: string): Promise<void>;
        onMaximizeChange(callback: (isMaximized: boolean) => void): () => void;
      };
      fileSystem: {
        openDirectory(): Promise<string | null>;
        readDirectory(dirPath: string): Promise<DirectoryItem[]>;
        readFile(filePath: string): Promise<string | null>;
        readFileBuffer(filePath: string): Promise<ArrayBuffer | null>;
        getFileStats(filePath: string): Promise<FileStats | null>;
        openPath(filePath: string): Promise<string>;
      };
      auth: {
        getRefreshToken(): Promise<string | null>;
        setRefreshToken(token: string): Promise<void>;
        clearRefreshToken(): Promise<void>;
      };
      annotation: {
        getProjects(): Promise<unknown[]>;
        saveProjects(projects: unknown[]): Promise<void>;
        writeProjectConfig(
          directoryPath: string,
          project: unknown,
        ): Promise<void>;
        removeProjectConfig(directoryPath: string): Promise<void>;
        showItemInFolder(itemPath: string): Promise<void>;
      };
    };
  }
}

export {};
