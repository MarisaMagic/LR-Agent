Object.defineProperty(window, 'electron', {
  writable: true,
  value: {
    platform: 'win32',
    ipcRenderer: {
      sendMessage: jest.fn(),
      on: jest.fn(() => jest.fn()),
      once: jest.fn(),
      invoke: jest.fn(),
    },
    window: {
      minimize: jest.fn(),
      maximize: jest.fn(),
      close: jest.fn(),
      reload: jest.fn(),
      toggleDevTools: jest.fn(),
      toggleFullScreen: jest.fn(),
      isMaximized: jest.fn().mockResolvedValue(false),
      openExternal: jest.fn().mockResolvedValue(undefined),
      onMaximizeChange: jest.fn(() => jest.fn()),
    },
    fileSystem: {
      openDirectory: jest.fn(),
      readDirectory: jest.fn(),
      readFile: jest.fn(),
      readFileBuffer: jest.fn(),
      getFileStats: jest.fn(),
      openPath: jest.fn(),
    },
    auth: {
      getRefreshToken: jest.fn().mockResolvedValue(null),
      setRefreshToken: jest.fn().mockResolvedValue(undefined),
      clearRefreshToken: jest.fn().mockResolvedValue(undefined),
    },
  },
});

export {};
