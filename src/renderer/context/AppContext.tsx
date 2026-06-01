import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import { DirectoryItem } from '../../main/preload';
import { FileNode } from '../types/file';

const STORAGE_KEYS = {
  leftWidth: 'lr-agent:leftWidth',
  rightWidth: 'lr-agent:rightWidth',
  leftCollapsed: 'lr-agent:leftCollapsed',
  rightCollapsed: 'lr-agent:rightCollapsed',
  lastWorkspace: 'lr-agent:lastWorkspace',
};

const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 500;
const MIN_MAIN_CONTENT_WIDTH = 480;
const DEFAULT_LEFT_WIDTH = 250;
const DEFAULT_RIGHT_WIDTH = 350;
const ACTIVITY_BAR_WIDTH = 48;

function readNumber(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function readBool(key: string, fallback: boolean): boolean {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  return raw === 'true';
}

function itemsToNodes(items: DirectoryItem[]): FileNode[] {
  const nodes: FileNode[] = items.map((item) => ({
    name: item.name,
    path: item.path,
    type: item.isDirectory ? 'folder' : 'file',
  }));
  return nodes.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'folder' ? -1 : 1;
  });
}

function patchNodeChildren(
  nodes: FileNode[],
  targetPath: string,
  children: FileNode[],
): FileNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) {
      return { ...node, children, isLoading: false };
    }
    if (node.children) {
      return {
        ...node,
        children: patchNodeChildren(node.children, targetPath, children),
      };
    }
    return node;
  });
}

function setNodeLoading(
  nodes: FileNode[],
  targetPath: string,
  isLoading: boolean,
): FileNode[] {
  return nodes.map((node) => {
    if (node.path === targetPath) {
      return { ...node, isLoading };
    }
    if (node.children) {
      return {
        ...node,
        children: setNodeLoading(node.children, targetPath, isLoading),
      };
    }
    return node;
  });
}

function collectFolderPaths(nodes: FileNode[]): Set<string> {
  const paths = new Set<string>();
  const walk = (list: FileNode[]) => {
    for (const node of list) {
      if (node.type === 'folder') {
        paths.add(node.path);
        if (node.children) walk(node.children);
      }
    }
  };
  walk(nodes);
  return paths;
}

function pruneExpandedPaths(
  expandedPaths: Set<string>,
  tree: FileNode[],
  rootPath: string,
): Set<string> {
  const validFolders = collectFolderPaths(tree);
  validFolders.add(rootPath);
  const next = new Set<string>();
  for (const path of expandedPaths) {
    if (validFolders.has(path)) next.add(path);
  }
  return next;
}

function nodeMetaEqual(a: FileNode, b: FileNode): boolean {
  return a.path === b.path && a.name === b.name && a.type === b.type;
}

function childrenSameReferences(
  next: FileNode[] | undefined,
  prev: FileNode[] | undefined,
): boolean {
  if (!next && !prev) return true;
  if (!next || !prev || next.length !== prev.length) return false;
  return next.every((node, index) => node === prev[index]);
}

async function refreshNodesAtLevel(
  oldNodes: FileNode[] | undefined,
  freshNodes: FileNode[],
  expandedPaths: Set<string>,
  loadDirectory: (dirPath: string) => Promise<FileNode[]>,
): Promise<FileNode[]> {
  return Promise.all(
    freshNodes.map(async (fresh) => {
      const oldNode = oldNodes?.find((node) => node.path === fresh.path);

      if (fresh.type !== 'folder' || !expandedPaths.has(fresh.path)) {
        // Drop cached children for collapsed folders so the next expand re-reads disk.
        if (fresh.type === 'folder') {
          return { ...fresh, isLoading: false };
        }
        if (oldNode && nodeMetaEqual(oldNode, fresh)) {
          return oldNode;
        }
        return fresh;
      }

      const childFresh = await loadDirectory(fresh.path);
      const children = await refreshNodesAtLevel(
        oldNode?.children,
        childFresh,
        expandedPaths,
        loadDirectory,
      );

      if (
        oldNode &&
        nodeMetaEqual(oldNode, fresh) &&
        childrenSameReferences(children, oldNode.children)
      ) {
        return oldNode;
      }

      const base = oldNode && nodeMetaEqual(oldNode, fresh) ? oldNode : fresh;
      return { ...base, children, isLoading: false };
    }),
  );
}

interface LayoutState {
  leftWidth: number;
  rightWidth: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  leftLastWidth: number;
  rightLastWidth: number;
}

type LayoutAction =
  | { type: 'SET_LEFT_WIDTH'; width: number }
  | { type: 'SET_RIGHT_WIDTH'; width: number }
  | { type: 'TOGGLE_LEFT' }
  | { type: 'TOGGLE_RIGHT' };

function layoutReducer(state: LayoutState, action: LayoutAction): LayoutState {
  switch (action.type) {
    case 'SET_LEFT_WIDTH':
      return { ...state, leftWidth: action.width, leftLastWidth: action.width };
    case 'SET_RIGHT_WIDTH':
      return {
        ...state,
        rightWidth: action.width,
        rightLastWidth: action.width,
      };
    case 'TOGGLE_LEFT':
      if (!state.leftCollapsed) {
        return {
          ...state,
          leftCollapsed: true,
          leftLastWidth: state.leftWidth,
        };
      }
      return {
        ...state,
        leftCollapsed: false,
        leftWidth: state.leftLastWidth || DEFAULT_LEFT_WIDTH,
      };
    case 'TOGGLE_RIGHT':
      if (!state.rightCollapsed) {
        return {
          ...state,
          rightCollapsed: true,
          rightLastWidth: state.rightWidth,
        };
      }
      return {
        ...state,
        rightCollapsed: false,
        rightWidth: state.rightLastWidth || DEFAULT_RIGHT_WIDTH,
      };
    default:
      return state;
  }
}

interface WorkspaceState {
  rootPath: string | null;
  tree: FileNode[];
  expandedPaths: Set<string>;
  activeFilePath: string | null;
}

interface AppContextValue {
  layout: LayoutState;
  activityBarWidth: number;
  minMainContentWidth: number;
  minSidebarWidth: number;
  maxSidebarWidth: number;
  setLeftWidth: (width: number) => void;
  setRightWidth: (width: number) => void;
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
  expandLeftSidebar: () => void;
  expandRightSidebar: () => void;
  rootPath: string | null;
  tree: FileNode[];
  expandedPaths: Set<string>;
  activeFilePath: string | null;
  openFolder: (dirPath?: string) => Promise<void>;
  toggleFolder: (folderPath: string) => Promise<void>;
  selectFile: (filePath: string) => void;
  refreshTree: () => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [layout, dispatchLayout] = useReducer(layoutReducer, {
    leftWidth: readNumber(STORAGE_KEYS.leftWidth, DEFAULT_LEFT_WIDTH),
    rightWidth: readNumber(STORAGE_KEYS.rightWidth, DEFAULT_RIGHT_WIDTH),
    leftCollapsed: readBool(STORAGE_KEYS.leftCollapsed, false),
    rightCollapsed: readBool(STORAGE_KEYS.rightCollapsed, false),
    leftLastWidth: readNumber(STORAGE_KEYS.leftWidth, DEFAULT_LEFT_WIDTH),
    rightLastWidth: readNumber(STORAGE_KEYS.rightWidth, DEFAULT_RIGHT_WIDTH),
  });

  type WorkspaceAction =
    | { type: 'SET'; payload: Partial<WorkspaceState> }
    | {
        type: 'PATCH_CHILDREN';
        folderPath: string;
        children: FileNode[];
        expandedPaths: Set<string>;
      }
    | { type: 'SET_LOADING'; folderPath: string; isLoading: boolean };

  const [workspace, dispatchWorkspace] = useReducer(
    (state: WorkspaceState, action: WorkspaceAction): WorkspaceState => {
      switch (action.type) {
        case 'SET':
          return { ...state, ...action.payload };
        case 'SET_LOADING':
          return {
            ...state,
            tree: setNodeLoading(
              state.tree,
              action.folderPath,
              action.isLoading,
            ),
          };
        case 'PATCH_CHILDREN':
          return {
            ...state,
            expandedPaths: action.expandedPaths,
            tree: patchNodeChildren(
              state.tree,
              action.folderPath,
              action.children,
            ),
          };
        default:
          return state;
      }
    },
    {
      rootPath: null,
      tree: [],
      expandedPaths: new Set<string>(),
      activeFilePath: null,
    },
  );

  const setWorkspace = (partial: Partial<WorkspaceState>) => {
    dispatchWorkspace({ type: 'SET', payload: partial });
  };

  const loadDirectory = useCallback(async (dirPath: string) => {
    const items = await window.electron.fileSystem?.readDirectory(dirPath);
    if (!items) return [];
    return itemsToNodes(items);
  }, []);

  const loadWorkspace = useCallback(
    async (dirPath: string) => {
      const tree = await loadDirectory(dirPath);
      const expanded = new Set<string>([dirPath]);
      setWorkspace({
        rootPath: dirPath,
        tree,
        expandedPaths: expanded,
        activeFilePath: null,
      });
      localStorage.setItem(STORAGE_KEYS.lastWorkspace, dirPath);
    },
    [loadDirectory],
  );

  const openFolder = useCallback(
    async (dirPath?: string) => {
      let path = dirPath;
      if (!path) {
        path = (await window.electron.fileSystem?.openDirectory()) ?? undefined;
      }
      if (!path) return;
      await loadWorkspace(path);
    },
    [loadWorkspace],
  );

  const toggleFolder = useCallback(
    async (folderPath: string) => {
      const expanded = new Set(workspace.expandedPaths);
      if (expanded.has(folderPath)) {
        expanded.delete(folderPath);
        setWorkspace({ expandedPaths: expanded });
        return;
      }

      expanded.add(folderPath);

      const findInTree = (nodes: FileNode[]): FileNode | undefined =>
        nodes.reduce<FileNode | undefined>((found, node) => {
          if (found) return found;
          if (node.path === folderPath) return node;
          if (node.children) return findInTree(node.children);
          return undefined;
        }, undefined);

      const node = findInTree(workspace.tree);
      const isRoot = folderPath === workspace.rootPath;

      if (!isRoot && node?.type === 'folder') {
        dispatchWorkspace({
          type: 'SET',
          payload: { expandedPaths: expanded },
        });
        dispatchWorkspace({
          type: 'SET_LOADING',
          folderPath,
          isLoading: true,
        });
        const childNodes = await loadDirectory(folderPath);
        dispatchWorkspace({
          type: 'PATCH_CHILDREN',
          folderPath,
          children: childNodes,
          expandedPaths: expanded,
        });
        return;
      }

      setWorkspace({ expandedPaths: expanded });
    },
    [
      workspace.expandedPaths,
      workspace.tree,
      workspace.rootPath,
      loadDirectory,
    ],
  );

  const selectFile = useCallback((filePath: string) => {
    setWorkspace({ activeFilePath: filePath });
  }, []);

  const refreshTree = useCallback(async () => {
    const { rootPath, expandedPaths, activeFilePath, tree } = workspace;
    if (!rootPath) return;

    const freshRoot = await loadDirectory(rootPath);
    const newTree = await refreshNodesAtLevel(
      tree,
      freshRoot,
      expandedPaths,
      loadDirectory,
    );
    const nextExpanded = pruneExpandedPaths(expandedPaths, newTree, rootPath);

    let nextActive = activeFilePath;
    if (nextActive) {
      const stats = await window.electron.fileSystem?.getFileStats(nextActive);
      if (!stats) nextActive = null;
    }

    const treeUnchanged = childrenSameReferences(newTree, tree);
    setWorkspace({
      tree: treeUnchanged ? tree : newTree,
      expandedPaths: nextExpanded,
      activeFilePath: nextActive,
    });
  }, [workspace, loadDirectory]);

  const setLeftWidth = useCallback((width: number) => {
    const clamped = Math.max(width, MIN_SIDEBAR_WIDTH);
    dispatchLayout({ type: 'SET_LEFT_WIDTH', width: clamped });
  }, []);

  const setRightWidth = useCallback((width: number) => {
    const clamped = Math.max(width, MIN_SIDEBAR_WIDTH);
    dispatchLayout({ type: 'SET_RIGHT_WIDTH', width: clamped });
  }, []);

  const toggleLeftSidebar = useCallback(() => {
    dispatchLayout({ type: 'TOGGLE_LEFT' });
  }, []);

  const toggleRightSidebar = useCallback(() => {
    dispatchLayout({ type: 'TOGGLE_RIGHT' });
  }, []);

  const expandLeftSidebar = useCallback(() => {
    if (layout.leftCollapsed) {
      dispatchLayout({ type: 'TOGGLE_LEFT' });
    }
  }, [layout.leftCollapsed]);

  const expandRightSidebar = useCallback(() => {
    if (layout.rightCollapsed) {
      dispatchLayout({ type: 'TOGGLE_RIGHT' });
    }
  }, [layout.rightCollapsed]);

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEYS.leftCollapsed,
      String(layout.leftCollapsed),
    );
    localStorage.setItem(
      STORAGE_KEYS.rightCollapsed,
      String(layout.rightCollapsed),
    );
  }, [layout.leftCollapsed, layout.rightCollapsed]);

  const persistSidebarWidths = useCallback((left: number, right: number) => {
    localStorage.setItem(STORAGE_KEYS.leftWidth, String(left));
    localStorage.setItem(STORAGE_KEYS.rightWidth, String(right));
  }, []);

  useEffect(() => {
    persistSidebarWidths(layout.leftWidth, layout.rightWidth);
  }, [layout.leftWidth, layout.rightWidth, persistSidebarWidths]);

  useEffect(() => {
    const last = localStorage.getItem(STORAGE_KEYS.lastWorkspace);
    if (last) {
      window.electron.fileSystem
        ?.getFileStats(last)
        .then((stats) => {
          if (stats?.isDirectory) {
            return loadWorkspace(last);
          }
          return undefined;
        })
        .catch(() => undefined);
    }
  }, [loadWorkspace]);

  useEffect(() => {
    const unsubOpen = window.electron.ipcRenderer.on('menu:openFolder', () => {
      openFolder();
    });
    const unsubLeft = window.electron.ipcRenderer.on(
      'menu:toggleLeftSidebar',
      () => {
        toggleLeftSidebar();
      },
    );
    const unsubRight = window.electron.ipcRenderer.on(
      'menu:toggleRightSidebar',
      () => {
        toggleRightSidebar();
      },
    );
    return () => {
      unsubOpen();
      unsubLeft();
      unsubRight();
    };
  }, [openFolder, toggleLeftSidebar, toggleRightSidebar]);

  const value = useMemo<AppContextValue>(
    () => ({
      layout,
      activityBarWidth: ACTIVITY_BAR_WIDTH,
      minMainContentWidth: MIN_MAIN_CONTENT_WIDTH,
      minSidebarWidth: MIN_SIDEBAR_WIDTH,
      maxSidebarWidth: MAX_SIDEBAR_WIDTH,
      setLeftWidth,
      setRightWidth,
      toggleLeftSidebar,
      toggleRightSidebar,
      expandLeftSidebar,
      expandRightSidebar,
      rootPath: workspace.rootPath,
      tree: workspace.tree,
      expandedPaths: workspace.expandedPaths,
      activeFilePath: workspace.activeFilePath,
      openFolder,
      toggleFolder,
      selectFile,
      refreshTree,
    }),
    [
      layout,
      setLeftWidth,
      setRightWidth,
      toggleLeftSidebar,
      toggleRightSidebar,
      expandLeftSidebar,
      expandRightSidebar,
      workspace,
      openFolder,
      toggleFolder,
      selectFile,
      refreshTree,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) {
    throw new Error('useApp must be used within AppProvider');
  }
  return ctx;
}
