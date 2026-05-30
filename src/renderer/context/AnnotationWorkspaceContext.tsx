import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useApp } from './AppContext';
import { useAnnotation } from './AnnotationContext';
import {
  parseFileAnnotationDocument,
  FILE_ANNOTATION_SCHEMA_VERSION,
  type AnnotationInstance,
  type BboxAnnotation,
  type FileAnnotationDocument,
  type PolygonAnnotation,
  type RotatedBboxAnnotation,
} from '../types/annotationDocument';
import {
  readFileAnnotationDoc,
  writeFileAnnotationDoc,
} from '../services/annotationDataService';
import {
  bumpLabelUsage,
  loadLabelUsage,
  pruneLabelUsage,
  saveLabelUsage,
  type LabelUsageMap,
} from '../utils/annotationLabelUsage';
import { getRelativeProjectPath, normalizeFsPath } from '../utils/projectPaths';

const DEBOUNCE_MS = 450;

const IMAGE_EXT = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'bmp',
  'ico',
]);

function getExtensionLower(filePath: string): string {
  const base = filePath.split(/[/\\]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot + 1).toLowerCase();
}

function workspacesMatch(rootPath: string | null, projectDir: string): boolean {
  if (!rootPath) return false;
  return (
    normalizeFsPath(rootPath).toLowerCase() ===
    normalizeFsPath(projectDir).toLowerCase()
  );
}

function isBBoxInstance(a: AnnotationInstance): a is BboxAnnotation {
  return a.kind === 'bbox';
}

function isRotatedBBoxInstance(
  a: AnnotationInstance,
): a is RotatedBboxAnnotation {
  return a.kind === 'rotated_bbox';
}

function isPolygonInstance(a: AnnotationInstance): a is PolygonAnnotation {
  return a.kind === 'polygon';
}

type DocMeta = Omit<FileAnnotationDocument, 'annotations'>;

export type ImageCanvasTool = 'draw' | 'select' | 'polygon';

export interface AnnotationWorkspaceContextValue {
  workspaceEnabled: boolean;
  annotationPanelVisible: boolean;
  projectRootMatched: boolean;
  relativeFilePath: string | null;
  annotations: AnnotationInstance[];
  bboxAnnotations: BboxAnnotation[];
  rotatedBboxAnnotations: RotatedBboxAnnotation[];
  polygonAnnotations: PolygonAnnotation[];
  imageAnnotationType: 'bbox' | 'rotated_bbox' | 'polygon' | null;
  selectedAnnotationId: string | null;
  tool: ImageCanvasTool;
  setTool: (tool: ImageCanvasTool) => void;
  activeLabelId: string | null;
  setActiveLabelId: (id: string | null) => void;
  labelUsage: LabelUsageMap;
  selectAnnotation: (id: string | null) => void;
  addBboxAnnotation: (rect: {
    x: number;
    y: number;
    width: number;
    height: number;
  }) => boolean;
  addRotatedBboxAnnotation: (rect: {
    cx: number;
    cy: number;
    width: number;
    height: number;
    angle: number;
  }) => boolean;
  addPolygonAnnotation: (points: { x: number; y: number }[]) => boolean;
  updateBboxGeometry: (
    id: string,
    patch: Pick<BboxAnnotation, 'x' | 'y' | 'width' | 'height'>,
  ) => void;
  updateRotatedBboxGeometry: (
    id: string,
    patch: Pick<
      RotatedBboxAnnotation,
      'cx' | 'cy' | 'width' | 'height' | 'angle'
    >,
  ) => void;
  updatePolygonGeometry: (
    id: string,
    points: { x: number; y: number }[],
  ) => void;
  deleteAnnotation: (id: string) => void;
  updateAnnotationLabel: (id: string, labelId: string) => void;
  reportImageNaturalSize: (width: number, height: number) => void;
  dirty: boolean;
  saving: boolean;
  loadError: string | null;
  sourceStale: boolean;
  saveNow: () => Promise<void>;
}

const AnnotationWorkspaceContext =
  createContext<AnnotationWorkspaceContextValue | null>(null);

function emptyDocMeta(
  proj: {
    id: string;
    modality: FileAnnotationDocument['modality'];
    annotationType: FileAnnotationDocument['annotationType'];
  },
  relPath: string,
  stats: { mtimeMs: number; size: number } | null | undefined,
): DocMeta {
  const now = new Date().toISOString();
  return {
    schemaVersion: FILE_ANNOTATION_SCHEMA_VERSION,
    projectId: proj.id,
    filePath: relPath,
    modality: proj.modality,
    annotationType: proj.annotationType,
    source:
      stats && stats.size !== undefined
        ? {
            width: 1,
            height: 1,
            mtimeMs: stats.mtimeMs,
            size: stats.size,
          }
        : { width: 1, height: 1 },
    updatedAt: now,
  };
}

async function statsForPath(
  filePath: string | null | undefined,
): Promise<{ mtimeMs: number; size: number } | null> {
  if (!filePath) return null;
  const s = await window.electron.fileSystem?.getFileStats(filePath);
  if (!s || s.isDirectory) return null;
  return { mtimeMs: s.mtime.getTime(), size: s.size };
}

export function AnnotationWorkspaceProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { activeFilePath, rootPath } = useApp();
  const { activeProject, mode } = useAnnotation();
  const activeProjectRef = useRef(activeProject);
  activeProjectRef.current = activeProject;

  const annotationPanelVisible = Boolean(
    activeProject && mode === 'annotation',
  );

  const projectRootMatched = useMemo(() => {
    if (!activeProject || !annotationPanelVisible) return false;
    return workspacesMatch(rootPath, activeProject.directoryPath);
  }, [activeProject, annotationPanelVisible, rootPath]);

  const imageAnnotationType =
    activeProject?.modality === 'image' &&
    (activeProject.annotationType === 'bbox' ||
      activeProject.annotationType === 'rotated_bbox' ||
      activeProject.annotationType === 'polygon')
      ? activeProject.annotationType
      : null;

  const workspaceEnabled = Boolean(
    projectRootMatched &&
      activeProject &&
      imageAnnotationType &&
      activeFilePath &&
      IMAGE_EXT.has(getExtensionLower(activeFilePath)),
  );

  const relativeFilePath = useMemo(() => {
    if (
      !workspaceEnabled ||
      !activeProject ||
      !activeFilePath ||
      !projectRootMatched
    ) {
      return null;
    }
    return getRelativeProjectPath(activeProject.directoryPath, activeFilePath);
  }, [workspaceEnabled, activeProject, activeFilePath, projectRootMatched]);

  const [annotations, setAnnotations] = useState<AnnotationInstance[]>([]);
  const [loadedDocMeta, setLoadedDocMeta] = useState<DocMeta | null>(null);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<
    string | null
  >(null);
  const [tool, setToolState] = useState<ImageCanvasTool>('draw');
  const [activeLabelId, setActiveLabelId] = useState<string | null>(null);
  const [labelUsage, setLabelUsage] = useState<LabelUsageMap>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sourceStale, setSourceStale] = useState(false);

  const annotationsRef = useRef(annotations);
  const dirtyRef = useRef(dirty);
  const loadedMetaRef = useRef<DocMeta | null>(null);

  annotationsRef.current = annotations;
  dirtyRef.current = dirty;
  loadedMetaRef.current = loadedDocMeta;

  /** Tracks file identity for flush-before-navigation */
  const currentPairRef = useRef<{ rel: string | null; abs: string | null }>({
    rel: null,
    abs: null,
  });

  const saveTimerRef = useRef<number | undefined>(undefined);
  const labelUsageSaveTimerRef = useRef<number | undefined>(undefined);
  const labelUsageRef = useRef(labelUsage);
  labelUsageRef.current = labelUsage;

  const activeProjectDirectory = activeProject?.directoryPath;
  const activeProjectDirectoryRef = useRef(activeProjectDirectory);
  activeProjectDirectoryRef.current = activeProjectDirectory;

  const persistFromRefs = useCallback(
    async (opts?: { statsPathOverride?: string | null; force?: boolean }) => {
      if (!dirtyRef.current && !opts?.force) return;

      const dir = activeProjectDirectoryRef.current;
      if (!dir || !currentPairRef.current.rel || !loadedMetaRef.current) return;

      const relPath = currentPairRef.current.rel;

      const ann = annotationsRef.current;
      let meta = loadedMetaRef.current;

      setSaving(true);
      try {
        const hintPath = opts?.statsPathOverride ?? currentPairRef.current.abs;
        const hint = await statsForPath(hintPath);

        const now = new Date().toISOString();
        const mergedSource =
          hint && meta.source
            ? { ...meta.source, mtimeMs: hint.mtimeMs, size: hint.size }
            : meta.source;

        meta = { ...meta, source: mergedSource, updatedAt: now };
        const doc: FileAnnotationDocument = {
          ...meta,
          annotations: ann,
          updatedAt: now,
        };

        loadedMetaRef.current = meta;
        await writeFileAnnotationDoc(dir, relPath, doc, hint ?? undefined);
        setLoadedDocMeta(meta);
        setDirty(false);
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const bboxAnnotations = useMemo(
    () => annotations.filter(isBBoxInstance),
    [annotations],
  );

  const rotatedBboxAnnotations = useMemo(
    () => annotations.filter(isRotatedBBoxInstance),
    [annotations],
  );

  const polygonAnnotations = useMemo(
    () => annotations.filter(isPolygonInstance),
    [annotations],
  );

  useEffect(() => {
    if (!activeProject?.labels.length) {
      setActiveLabelId(null);
      return;
    }
    setActiveLabelId((prev) => {
      if (prev && activeProject.labels.some((l) => l.id === prev)) return prev;
      return activeProject.labels[0]?.id ?? null;
    });
  }, [activeProject?.id, activeProject?.labels]);

  useEffect(() => {
    if (!activeProject?.id) {
      setLabelUsage({});
      return;
    }
    const validIds = new Set(activeProject.labels.map((l) => l.id));
    const loaded = loadLabelUsage(activeProject.id);
    setLabelUsage(pruneLabelUsage(loaded, validIds));
  }, [activeProject?.id, activeProject?.labels]);

  const scheduleLabelUsageSave = useCallback((projectId: string) => {
    if (labelUsageSaveTimerRef.current) {
      window.clearTimeout(labelUsageSaveTimerRef.current);
    }
    labelUsageSaveTimerRef.current = window.setTimeout(() => {
      labelUsageSaveTimerRef.current = undefined;
      saveLabelUsage(projectId, labelUsageRef.current);
    }, 300);
  }, []);

  const recordLabelUsage = useCallback(
    (labelId: string) => {
      const projectId = activeProjectRef.current?.id;
      if (!projectId) return;
      const validIds = activeProjectRef.current?.labels.map((l) => l.id) ?? [];
      if (!validIds.includes(labelId)) return;

      setLabelUsage((prev) => {
        const next = bumpLabelUsage(prev, labelId);
        scheduleLabelUsageSave(projectId);
        return next;
      });
    },
    [scheduleLabelUsageSave],
  );

  useEffect(() => {
    if (activeProject?.annotationType === 'polygon') {
      setToolState((prev) => (prev === 'draw' ? 'polygon' : prev));
    } else if (
      activeProject?.annotationType === 'bbox' ||
      activeProject?.annotationType === 'rotated_bbox'
    ) {
      setToolState((prev) => (prev === 'polygon' ? 'draw' : prev));
    }
  }, [activeProject?.annotationType]);

  const saveNow = useCallback(async () => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = undefined;
    }
    await persistFromRefs({ force: true });
  }, [persistFromRefs]);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = undefined;
      persistFromRefs().catch(() => undefined);
    }, DEBOUNCE_MS);
  }, [persistFromRefs]);

  const touchDirty = useCallback(() => {
    setDirty(true);
    scheduleSave();
  }, [scheduleSave]);

  useEffect(() => {
    if (
      !annotationPanelVisible ||
      !projectRootMatched ||
      !activeProject?.directoryPath
    ) {
      currentPairRef.current = { rel: null, abs: null };
      setAnnotations([]);
      setLoadedDocMeta(null);
      setSelectedAnnotationId(null);
      setLoadError(null);
      setDirty(false);
      setSourceStale(false);
      return undefined;
    }

    if (
      activeProject.modality !== 'image' ||
      (activeProject.annotationType !== 'bbox' &&
        activeProject.annotationType !== 'rotated_bbox' &&
        activeProject.annotationType !== 'polygon') ||
      !relativeFilePath
    ) {
      currentPairRef.current = { rel: null, abs: null };
      setAnnotations([]);
      setLoadedDocMeta(null);
      setSelectedAnnotationId(null);
      setLoadError(null);
      setDirty(false);
      setSourceStale(false);
      return undefined;
    }

    const rel = relativeFilePath;
    const projDir = activeProject.directoryPath;
    let cancelled = false;

    const runLoadPipeline = async () => {
      setLoadError(null);

      const prev = currentPairRef.current;
      if (
        dirtyRef.current &&
        prev.rel &&
        prev.rel !== rel &&
        loadedMetaRef.current
      ) {
        await persistFromRefs({
          statsPathOverride: prev.abs,
          force: true,
        }).catch(() => undefined);
      }

      if (cancelled) return;

      const projForMeta = activeProjectRef.current;
      if (!projForMeta) return;

      try {
        const raw = await readFileAnnotationDoc(projDir, rel);
        const parsed = raw ? parseFileAnnotationDocument(raw) : null;
        const stats = await statsForPath(activeFilePath);

        if (parsed) {
          const { annotations: ann, ...meta } = parsed;

          let stale = false;
          if (
            meta.source?.mtimeMs !== undefined &&
            stats &&
            stats.mtimeMs !== meta.source.mtimeMs
          )
            stale = true;
          if (
            meta.source?.size !== undefined &&
            stats &&
            stats.size !== meta.source.size
          )
            stale = true;

          setLoadedDocMeta(meta);
          setAnnotations(ann);
          setDirty(false);
          setSourceStale(stale);
          setSelectedAnnotationId(null);
          currentPairRef.current = { rel, abs: activeFilePath };
        } else {
          const meta = emptyDocMeta(projForMeta, rel, stats);
          setLoadedDocMeta(meta);
          setAnnotations([]);
          setDirty(false);
          setSourceStale(false);
          setSelectedAnnotationId(null);
          currentPairRef.current = { rel, abs: activeFilePath };
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : '加载标注失败');
          setAnnotations([]);
          setLoadedDocMeta(null);
          currentPairRef.current = { rel, abs: activeFilePath };
          setDirty(false);
        }
      }
    };

    runLoadPipeline().catch(() => undefined);

    return () => {
      cancelled = true;
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = undefined;
      }
      if (dirtyRef.current) {
        persistFromRefs({ force: true }).catch(() => undefined);
      }
    };
  }, [
    annotationPanelVisible,
    projectRootMatched,
    activeProject?.id,
    activeProject?.directoryPath,
    activeProject?.modality,
    activeProject?.annotationType,
    activeFilePath,
    relativeFilePath,
    persistFromRefs,
  ]);

  const selectAnnotation = useCallback((id: string | null) => {
    setSelectedAnnotationId(id);
  }, []);

  const setTool = useCallback((next: ImageCanvasTool) => {
    setToolState(next);
  }, []);

  const addBboxAnnotation = useCallback(
    (rect: {
      x: number;
      y: number;
      width: number;
      height: number;
    }): boolean => {
      if (!activeLabelId) return false;
      if (!loadedDocMeta) return false;

      const now = new Date().toISOString();
      const next: BboxAnnotation = {
        id: crypto.randomUUID(),
        kind: 'bbox',
        labelId: activeLabelId,
        createdAt: now,
        updatedAt: now,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };

      setAnnotations((prev) => [...prev, next]);
      touchDirty();
      recordLabelUsage(activeLabelId);
      return true;
    },
    [activeLabelId, loadedDocMeta, touchDirty, recordLabelUsage],
  );

  const addPolygonAnnotation = useCallback(
    (points: { x: number; y: number }[]): boolean => {
      if (!activeLabelId || points.length < 3) return false;
      if (!loadedDocMeta) return false;

      const now = new Date().toISOString();
      const next: PolygonAnnotation = {
        id: crypto.randomUUID(),
        kind: 'polygon',
        labelId: activeLabelId,
        createdAt: now,
        updatedAt: now,
        points,
      };

      setAnnotations((prev) => [...prev, next]);
      touchDirty();
      recordLabelUsage(activeLabelId);
      return true;
    },
    [activeLabelId, loadedDocMeta, touchDirty, recordLabelUsage],
  );

  const addRotatedBboxAnnotation = useCallback(
    (rect: {
      cx: number;
      cy: number;
      width: number;
      height: number;
      angle: number;
    }): boolean => {
      if (!activeLabelId) return false;
      if (!loadedDocMeta) return false;

      const now = new Date().toISOString();
      const next: RotatedBboxAnnotation = {
        id: crypto.randomUUID(),
        kind: 'rotated_bbox',
        labelId: activeLabelId,
        createdAt: now,
        updatedAt: now,
        cx: rect.cx,
        cy: rect.cy,
        width: rect.width,
        height: rect.height,
        angle: rect.angle,
      };

      setAnnotations((prev) => [...prev, next]);
      touchDirty();
      recordLabelUsage(activeLabelId);
      return true;
    },
    [activeLabelId, loadedDocMeta, touchDirty, recordLabelUsage],
  );

  const updateRotatedBboxGeometry = useCallback(
    (
      id: string,
      patch: Pick<
        RotatedBboxAnnotation,
        'cx' | 'cy' | 'width' | 'height' | 'angle'
      >,
    ) => {
      setAnnotations((prev) =>
        prev.map((item) =>
          item.kind === 'rotated_bbox' && item.id === id
            ? {
                ...item,
                ...patch,
                updatedAt: new Date().toISOString(),
              }
            : item,
        ),
      );
      touchDirty();
    },
    [touchDirty],
  );

  const updateBboxGeometry = useCallback(
    (
      id: string,
      patch: Pick<BboxAnnotation, 'x' | 'y' | 'width' | 'height'>,
    ) => {
      setAnnotations((prev) =>
        prev.map((item) =>
          item.kind === 'bbox' && item.id === id
            ? {
                ...item,
                ...patch,
                updatedAt: new Date().toISOString(),
              }
            : item,
        ),
      );
      touchDirty();
    },
    [touchDirty],
  );

  const updatePolygonGeometry = useCallback(
    (id: string, points: { x: number; y: number }[]) => {
      if (points.length < 3) return;
      setAnnotations((prev) =>
        prev.map((item) =>
          item.kind === 'polygon' && item.id === id
            ? {
                ...item,
                points,
                updatedAt: new Date().toISOString(),
              }
            : item,
        ),
      );
      touchDirty();
    },
    [touchDirty],
  );

  const deleteAnnotation = useCallback(
    (id: string) => {
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
      setSelectedAnnotationId((sid) => (sid === id ? null : sid));
      touchDirty();
    },
    [touchDirty],
  );

  const updateAnnotationLabel = useCallback(
    (id: string, labelId: string) => {
      setAnnotations((prev) =>
        prev.map((item) =>
          item.id === id
            ? { ...item, labelId, updatedAt: new Date().toISOString() }
            : item,
        ),
      );
      touchDirty();
      recordLabelUsage(labelId);
    },
    [touchDirty, recordLabelUsage],
  );

  const reportImageNaturalSize = useCallback(
    (width: number, height: number) => {
      const meta = loadedMetaRef.current;
      if (
        width <= 0 ||
        height <= 0 ||
        !meta?.source ||
        (meta.source.width === width && meta.source.height === height)
      )
        return;

      const updated: DocMeta = {
        ...meta,
        source: { ...meta.source, width, height },
        updatedAt: new Date().toISOString(),
      };
      loadedMetaRef.current = updated;
      setLoadedDocMeta(updated);
      touchDirty();
    },
    [touchDirty],
  );

  const value = useMemo<AnnotationWorkspaceContextValue>(() => {
    return {
      workspaceEnabled,
      annotationPanelVisible,
      projectRootMatched,
      relativeFilePath,
      annotations,
      bboxAnnotations,
      rotatedBboxAnnotations,
      polygonAnnotations,
      imageAnnotationType,
      selectedAnnotationId,
      tool,
      setTool,
      activeLabelId,
      setActiveLabelId,
      labelUsage,
      selectAnnotation,
      addBboxAnnotation,
      addRotatedBboxAnnotation,
      addPolygonAnnotation,
      updateBboxGeometry,
      updateRotatedBboxGeometry,
      updatePolygonGeometry,
      deleteAnnotation,
      updateAnnotationLabel,
      reportImageNaturalSize,
      dirty,
      saving,
      loadError,
      sourceStale,
      saveNow,
    };
  }, [
    workspaceEnabled,
    annotationPanelVisible,
    projectRootMatched,
    relativeFilePath,
    annotations,
    bboxAnnotations,
    rotatedBboxAnnotations,
    polygonAnnotations,
    imageAnnotationType,
    selectedAnnotationId,
    tool,
    setTool,
    activeLabelId,
    labelUsage,
    selectAnnotation,
    addBboxAnnotation,
    addRotatedBboxAnnotation,
    addPolygonAnnotation,
    updateBboxGeometry,
    updateRotatedBboxGeometry,
    updatePolygonGeometry,
    deleteAnnotation,
    updateAnnotationLabel,
    reportImageNaturalSize,
    dirty,
    saving,
    loadError,
    sourceStale,
    saveNow,
  ]);

  return (
    <AnnotationWorkspaceContext.Provider value={value}>
      {children}
    </AnnotationWorkspaceContext.Provider>
  );
}

export function useAnnotationWorkspace(): AnnotationWorkspaceContextValue {
  const ctx = useContext(AnnotationWorkspaceContext);
  if (!ctx) {
    throw new Error(
      'useAnnotationWorkspace must be used within AnnotationWorkspaceProvider',
    );
  }
  return ctx;
}
