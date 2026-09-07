jest.mock('remark-math', () => ({
  __esModule: true,
  default: () => undefined,
}));

jest.mock('rehype-katex', () => ({
  __esModule: true,
  default: () => undefined,
}));

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: jest.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  })),
});

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
      isFullScreen: jest.fn().mockResolvedValue(false),
      openExternal: jest.fn().mockResolvedValue(undefined),
      onMaximizeChange: jest.fn(() => jest.fn()),
      onFullScreenChange: jest.fn(() => jest.fn()),
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
      getSessionCache: jest.fn().mockResolvedValue(null),
      setSessionCache: jest.fn().mockResolvedValue(undefined),
      clearSessionCache: jest.fn().mockResolvedValue(undefined),
    },
    annotation: {
      getProjects: jest.fn().mockResolvedValue([]),
      saveProjects: jest.fn().mockResolvedValue(undefined),
      writeProjectConfig: jest.fn().mockResolvedValue(undefined),
      removeProjectConfig: jest.fn().mockResolvedValue(undefined),
      showItemInFolder: jest.fn().mockResolvedValue(undefined),
      readFileAnnotationDoc: jest.fn().mockResolvedValue(null),
      writeFileAnnotationDoc: jest.fn().mockResolvedValue(undefined),
      exportAnnotations: jest.fn().mockResolvedValue({
        success: true,
        outputDir: '',
        filesWritten: 0,
        imageCount: 0,
        annotationCount: 0,
        message: 'ok',
      }),
    },
    theme: {
      getSystemDark: jest.fn().mockResolvedValue(false),
      onSystemChanged: jest.fn(() => jest.fn()),
      notifyEffectiveTheme: jest.fn(),
    },
    preAnnot: {
      checkRuntime: jest.fn().mockResolvedValue({ pythonOk: false }),
      run: jest.fn().mockResolvedValue({ ok: false, error: 'mock' }),
      cancel: jest.fn().mockResolvedValue(undefined),
    },
    workspace: {
      writeTextFile: jest.fn().mockResolvedValue({ success: true }),
    },
  },
});

export {};
