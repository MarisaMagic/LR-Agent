import { Channels, DirectoryItem, FileStats } from '../main/preload';

declare global {
  interface Window {
    electron: {
      ipcRenderer: {
        sendMessage(channel: Channels, ...args: unknown[]): void;
        on(channel: Channels, func: (...args: unknown[]) => void): () => void;
        once(channel: Channels, func: (...args: unknown[]) => void): void;
        invoke<T = unknown>(channel: Channels, ...args: unknown[]): Promise<T>;
      };
      fileSystem: {
        openDirectory(): Promise<string | null>;
        readDirectory(dirPath: string): Promise<DirectoryItem[]>;
        readFile(filePath: string): Promise<string | null>;
        readFileBuffer(filePath: string): Promise<ArrayBuffer | null>;
        getFileStats(filePath: string): Promise<FileStats | null>;
        openPath(filePath: string): Promise<string>;
      };
    };
  }
}

export {};
