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
  type ImagePointAnnotation,
  type PolygonAnnotation,
  type PoseAnnotation,
  type RotatedBboxAnnotation,
} from '../types/annotationDocument';
import {
  DEFAULT_KEYPOINT_TEMPLATE_ID,
  getKeypointTemplate,
  resolveLabelIdForTemplate,
  type KeypointTemplate,
} from '../types/keypointTemplate';
import {
  buildInitialPoseSceneGeometry,
  sceneGeometryToPoseAnn,
  type ScenePoint,
} from '../components/annotation/fabric/fabricKeypointCoords';
import {
  readFileAnnotationDoc,
  writeFileAnnotationDoc,
} from '../services/annotationDataService';
import { updateAnnotationWorkspaceAgentSnapshot } from '../services/annotationAgentBridge';
import {
  bumpLabelUsage,
  loadLabelUsage,
  pruneLabelUsage,
  saveLabelUsage,
  type LabelUsageMap,
} from '../utils/annotationLabelUsage';
import { getRelativeProjectPath, normalizeFsPath } from '../utils/projectPaths';
import {
  AnnotationHistory,
  type AnnotationHistorySnapshot,
} from '../utils/annotationHistory';

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

function isPoseInstance(a: AnnotationInstance): a is PoseAnnotation {
  return a.kind === 'pose';
}

function isImagePointInstance(a: AnnotationInstance): a is ImagePointAnnotation {
  return a.kind === 'point';
}

type DocMeta = Omit<FileAnnotationDocument, 'annotations'>;

export type ImageCanvasTool =
  | 'draw'
  | 'select'
  | 'polygon'
  | 'place_pose'
  | 'place_point'
  | 'preannot_sam_box'
  | 'preannot_roi_box';

export interface AnnotationWorkspaceContextValue {
  workspaceEnabled: boolean;
  annotationPanelVisible: boolean;
  projectRootMatched: boolean;
  relativeFilePath: string | null;
  annotations: AnnotationInstance[];
  bboxAnnotations: BboxAnnotation[];
  rotatedBboxAnnotations: RotatedBboxAnnotation[];
  polygonAnnotations: PolygonAnnotation[];
  poseAnnotations: PoseAnnotation[];
  pointAnnotations: ImagePointAnnotation[];
  imageAnnotationType:
    | 'bbox'
    | 'rotated_bbox'
    | 'polygon'
    | 'keypoint'
    | null;
  activeTemplateId: string;
  setActiveTemplateId: (id: string) => void;
  activeTemplate: KeypointTemplate;
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
  addPoseAnnotation: (
    templateId: string,
    centerScene: ScenePoint,
    naturalWidth: number,
    naturalHeight: number,
  ) => string | null;
  addPointAnnotation: (
    x: number,
    y: number,
    labelId: string,
  ) => string | null;
  addPreAnnotBboxes: (
    items: Array<{
      labelId?: string | null;
      x: number;
      y: number;
      width: number;
      height: number;
    }>,
  ) => number;
  addPreAnnotRotatedBboxes: (
    items: Array<{
      labelId?: string | null;
      cx: number;
      cy: number;
      width: number;
      height: number;
      angle: number;
    }>,
  ) => number;
  addPreAnnotPolygon: (
    points: { x: number; y: number }[],
    labelId?: string,
  ) => boolean;
  addPreAnnotPoses: (
    items: Array<{
      labelId: string;
      templateId: string;
      cx: number;
      cy: number;
      width: number;
      height: number;
      angle: number;
      keypoints: { x: number; y: number; visibility: 0 | 1 | 2 }[];
    }>,
  ) => number;
  clearPreAnnots: () => number;
  updatePoseGeometry: (id: string, ann: PoseAnnotation) => void;
  updatePointGeometry: (id: string, x: number, y: number) => void;
  updateKeypointVisibility: (
    poseId: string,
    index: number,
    visibility: 0 | 1 | 2,
  ) => void;
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
  undo: () => boolean;
  redo: () => boolean;
  canUndo: boolean;
  canRedo: boolean;
  beginHistoryBatch: () => void;
  endHistoryBatch: () => void;
  /** Polygon draft undo runs before workspace undo (Ctrl+Z). */
  setLocalUndoHandler: (handler: (() => boolean) | null) => void;
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
      activeProject.annotationType === 'polygon' ||
      activeProject.annotationType === 'keypoint')
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
  const [activeTemplateId, setActiveTemplateIdState] = useState(
    DEFAULT_KEYPOINT_TEMPLATE_ID,
  );
  const [activeLabelId, setActiveLabelId] = useState<string | null>(null);
  const [labelUsage, setLabelUsage] = useState<LabelUsageMap>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sourceStale, setSourceStale] = useState(false);
  const [historyTick, setHistoryTick] = useState(0);

  const annotationsRef = useRef(annotations);
  const dirtyRef = useRef(dirty);
  const loadedMetaRef = useRef<DocMeta | null>(null);
  const selectedIdRef = useRef(selectedAnnotationId);
  const historyRef = useRef(new AnnotationHistory());
  const isApplyingHistoryRef = useRef(false);
  const localUndoHandlerRef = useRef<(() => boolean) | null>(null);

  annotationsRef.current = annotations;
  dirtyRef.current = dirty;
  loadedMetaRef.current = loadedDocMeta;
  selectedIdRef.current = selectedAnnotationId;

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

  const poseAnnotations = useMemo(
    () => annotations.filter(isPoseInstance),
    [annotations],
  );

  const pointAnnotations = useMemo(
    () => annotations.filter(isImagePointInstance),
    [annotations],
  );

  const activeTemplate = useMemo(() => {
    return (
      getKeypointTemplate(activeTemplateId) ??
      getKeypointTemplate(DEFAULT_KEYPOINT_TEMPLATE_ID)!
    );
  }, [activeTemplateId]);

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
      setToolState((prev) =>
        prev === 'polygon' || prev === 'place_pose' || prev === 'place_point'
          ? 'draw'
          : prev,
      );
    } else if (activeProject?.annotationType === 'keypoint') {
      setToolState((prev) =>
        prev === 'draw' || prev === 'polygon' ? 'place_pose' : prev,
      );
    }
  }, [activeProject?.annotationType]);

  const setActiveTemplateId = useCallback((id: string) => {
    setActiveTemplateIdState(id);
  }, []);

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

  const bumpHistory = useCallback(() => {
    setHistoryTick((t) => t + 1);
  }, []);

  const captureHistorySnapshot = useCallback((): AnnotationHistorySnapshot => {
    return {
      annotations: structuredClone(annotationsRef.current),
      selectedAnnotationId: selectedIdRef.current,
    };
  }, []);

  const clearHistory = useCallback(() => {
    historyRef.current.clear();
    bumpHistory();
  }, [bumpHistory]);

  const recordHistory = useCallback(() => {
    if (isApplyingHistoryRef.current) return;
    historyRef.current.record(captureHistorySnapshot());
    bumpHistory();
  }, [captureHistorySnapshot, bumpHistory]);

  const applyHistorySnapshot = useCallback(
    (snapshot: AnnotationHistorySnapshot) => {
      isApplyingHistoryRef.current = true;
      setAnnotations(snapshot.annotations);
      setSelectedAnnotationId(snapshot.selectedAnnotationId);
      isApplyingHistoryRef.current = false;
      touchDirty();
    },
    [touchDirty],
  );

  const beginHistoryBatch = useCallback(() => {
    historyRef.current.beginBatch(captureHistorySnapshot());
  }, [captureHistorySnapshot]);

  const endHistoryBatch = useCallback(() => {
    historyRef.current.endBatch();
    bumpHistory();
  }, [bumpHistory]);

  const undo = useCallback((): boolean => {
    const restored = historyRef.current.undo(captureHistorySnapshot());
    if (!restored) return false;
    applyHistorySnapshot(restored);
    bumpHistory();
    return true;
  }, [captureHistorySnapshot, applyHistorySnapshot, bumpHistory]);

  const redo = useCallback((): boolean => {
    const restored = historyRef.current.redo(captureHistorySnapshot());
    if (!restored) return false;
    applyHistorySnapshot(restored);
    bumpHistory();
    return true;
  }, [captureHistorySnapshot, applyHistorySnapshot, bumpHistory]);

  const setLocalUndoHandler = useCallback(
    (handler: (() => boolean) | null) => {
      localUndoHandlerRef.current = handler;
    },
    [],
  );

  const canUndo = useMemo(
    () => historyRef.current.canUndo(),
    [historyTick],
  );
  const canRedo = useMemo(
    () => historyRef.current.canRedo(),
    [historyTick],
  );

  useEffect(() => {
    if (!annotationPanelVisible) return undefined;

    const onKeyDown = (ev: KeyboardEvent) => {
      const tag = (ev.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!(ev.ctrlKey || ev.metaKey)) return;

      const isUndo =
        !ev.shiftKey && (ev.key === 'z' || ev.key === 'Z');
      const isRedo =
        (ev.shiftKey && (ev.key === 'z' || ev.key === 'Z')) ||
        ev.key === 'y' ||
        ev.key === 'Y';

      if (isUndo) {
        if (localUndoHandlerRef.current?.()) {
          ev.preventDefault();
          return;
        }
        if (undo()) ev.preventDefault();
        return;
      }

      if (isRedo) {
        if (redo()) ev.preventDefault();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [annotationPanelVisible, undo, redo]);

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
      historyRef.current.clear();
      setHistoryTick(0);
      return undefined;
    }

    if (
      activeProject.modality !== 'image' ||
      (activeProject.annotationType !== 'bbox' &&
        activeProject.annotationType !== 'rotated_bbox' &&
        activeProject.annotationType !== 'polygon' &&
        activeProject.annotationType !== 'keypoint') ||
      !relativeFilePath
    ) {
      currentPairRef.current = { rel: null, abs: null };
      setAnnotations([]);
      setLoadedDocMeta(null);
      setSelectedAnnotationId(null);
      setLoadError(null);
      setDirty(false);
      setSourceStale(false);
      historyRef.current.clear();
      setHistoryTick(0);
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
        if (cancelled) return;
        const parsed = raw ? parseFileAnnotationDocument(raw) : null;
        const stats = await statsForPath(activeFilePath);
        if (cancelled) return;

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
          clearHistory();
          setDirty(false);
          setSourceStale(stale);
          setSelectedAnnotationId(null);
          currentPairRef.current = { rel, abs: activeFilePath };
        } else {
          const meta = emptyDocMeta(projForMeta, rel, stats);
          setLoadedDocMeta(meta);
          setAnnotations([]);
          clearHistory();
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
          clearHistory();
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
    clearHistory,
  ]);

  useEffect(() => {
    if (!annotationPanelVisible || !projectRootMatched) return undefined;

    const onBatchApplied = (event: Event) => {
      const detail = (
        event as CustomEvent<{ projectId?: string; relativePaths?: string[] }>
      ).detail;
      const proj = activeProjectRef.current;
      if (!proj || detail?.projectId !== proj.id) return;
      const rel = relativeFilePath;
      if (!rel) return;
      if (
        detail?.relativePaths?.length &&
        !detail.relativePaths.includes(rel)
      ) {
        return;
      }
      if (dirtyRef.current) {
        return;
      }
      void readFileAnnotationDoc(proj.directoryPath, rel)
        .then((raw) => {
          const parsed = raw ? parseFileAnnotationDocument(raw) : null;
          if (!parsed) return;
          const { annotations: ann, ...meta } = parsed;
          setLoadedDocMeta(meta);
          setAnnotations(ann);
          setDirty(false);
          clearHistory();
        })
        .catch(() => undefined);
    };

    const onMutationsApplied = onBatchApplied;

    window.addEventListener(
      'lr-agent:annotation-mutations-applied',
      onMutationsApplied,
    );
    window.addEventListener('lr-agent:annotation-batch-applied', onBatchApplied);
    return () => {
      window.removeEventListener(
        'lr-agent:annotation-mutations-applied',
        onMutationsApplied,
      );
      window.removeEventListener('lr-agent:annotation-batch-applied', onBatchApplied);
    };
  }, [
    annotationPanelVisible,
    projectRootMatched,
    relativeFilePath,
    clearHistory,
  ]);

  useEffect(() => {
    updateAnnotationWorkspaceAgentSnapshot({
      selectedAnnotationId,
      selectedAnnotationIds: selectedAnnotationId ? [selectedAnnotationId] : [],
      workspaceDirty: dirty,
      workspaceRelativePath: relativeFilePath,
      workspaceProjectId: activeProject?.id ?? null,
    });
  }, [
    selectedAnnotationId,
    dirty,
    relativeFilePath,
    activeProject?.id,
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

      recordHistory();
      setAnnotations((prev) => [...prev, next]);
      touchDirty();
      recordLabelUsage(activeLabelId);
      return true;
    },
    [activeLabelId, loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
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

      recordHistory();
      setAnnotations((prev) => [...prev, next]);
      touchDirty();
      recordLabelUsage(activeLabelId);
      return true;
    },
    [activeLabelId, loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
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

      recordHistory();
      setAnnotations((prev) => [...prev, next]);
      touchDirty();
      recordLabelUsage(activeLabelId);
      return true;
    },
    [activeLabelId, loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const updateRotatedBboxGeometry = useCallback(
    (
      id: string,
      patch: Pick<
        RotatedBboxAnnotation,
        'cx' | 'cy' | 'width' | 'height' | 'angle'
      >,
    ) => {
      recordHistory();
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
    [touchDirty, recordHistory],
  );

  const updateBboxGeometry = useCallback(
    (
      id: string,
      patch: Pick<BboxAnnotation, 'x' | 'y' | 'width' | 'height'>,
    ) => {
      recordHistory();
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
    [touchDirty, recordHistory],
  );

  const updatePolygonGeometry = useCallback(
    (id: string, points: { x: number; y: number }[]) => {
      if (points.length < 3) return;
      recordHistory();
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
    [touchDirty, recordHistory],
  );

  const addPoseAnnotation = useCallback(
    (
      templateId: string,
      centerScene: ScenePoint,
      naturalWidth: number,
      naturalHeight: number,
    ): string | null => {
      if (!loadedDocMeta) return null;
      const template = getKeypointTemplate(templateId);
      if (!template) return null;
      const labels = activeProjectRef.current?.labels ?? [];
      const labelId = resolveLabelIdForTemplate(template, labels);
      if (!labelId) return null;

      const scene = buildInitialPoseSceneGeometry(
        template,
        centerScene,
        naturalWidth,
        naturalHeight,
      );
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const next = sceneGeometryToPoseAnn(scene, naturalWidth, naturalHeight, {
        id,
        labelId,
        templateId,
        createdAt: now,
      });

      recordHistory();
      setAnnotations((prev) => [...prev, next]);
      touchDirty();
      recordLabelUsage(labelId);
      return id;
    },
    [loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const addPointAnnotation = useCallback(
    (x: number, y: number, labelId: string): string | null => {
      if (!loadedDocMeta || !labelId) return null;
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const next: ImagePointAnnotation = {
        id,
        kind: 'point',
        labelId,
        createdAt: now,
        updatedAt: now,
        x,
        y,
      };
      recordHistory();
      setAnnotations((prev) => [...prev, next]);
      touchDirty();
      recordLabelUsage(labelId);
      return id;
    },
    [loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const addPreAnnotBboxes = useCallback(
    (
      items: Array<{
        labelId?: string | null;
        x: number;
        y: number;
        width: number;
        height: number;
      }>,
    ): number => {
      if (!loadedDocMeta || items.length === 0) return 0;
      const now = new Date().toISOString();
      const nextItems: BboxAnnotation[] = items.map((item) => ({
        id: crypto.randomUUID(),
        kind: 'bbox',
        labelId: item.labelId ?? null,
        createdAt: now,
        updatedAt: now,
        source: 'preannot',
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
      }));

      recordHistory();
      setAnnotations((prev) => [...prev, ...nextItems]);
      touchDirty();
      nextItems.forEach((ann) => {
        if (ann.labelId) recordLabelUsage(ann.labelId);
      });
      return nextItems.length;
    },
    [loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const addPreAnnotRotatedBboxes = useCallback(
    (
      items: Array<{
        labelId?: string | null;
        cx: number;
        cy: number;
        width: number;
        height: number;
        angle: number;
      }>,
    ): number => {
      if (!loadedDocMeta || items.length === 0) return 0;
      const now = new Date().toISOString();
      const nextItems: RotatedBboxAnnotation[] = items.map((item) => ({
        id: crypto.randomUUID(),
        kind: 'rotated_bbox',
        labelId: item.labelId ?? null,
        createdAt: now,
        updatedAt: now,
        source: 'preannot',
        cx: item.cx,
        cy: item.cy,
        width: item.width,
        height: item.height,
        angle: item.angle,
      }));

      recordHistory();
      setAnnotations((prev) => [...prev, ...nextItems]);
      touchDirty();
      nextItems.forEach((ann) => {
        if (ann.labelId) recordLabelUsage(ann.labelId);
      });
      return nextItems.length;
    },
    [loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const addPreAnnotPolygon = useCallback(
    (points: { x: number; y: number }[], labelId?: string): boolean => {
      const resolvedLabelId = labelId ?? activeLabelId;
      if (!resolvedLabelId || points.length < 3) return false;
      if (!loadedDocMeta) return false;

      const now = new Date().toISOString();
      const next: PolygonAnnotation = {
        id: crypto.randomUUID(),
        kind: 'polygon',
        labelId: resolvedLabelId,
        createdAt: now,
        updatedAt: now,
        source: 'preannot',
        points,
      };

      recordHistory();
      setAnnotations((prev) => [...prev, next]);
      touchDirty();
      recordLabelUsage(resolvedLabelId);
      return true;
    },
    [activeLabelId, loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const addPreAnnotPoses = useCallback(
    (
      items: Array<{
        labelId: string;
        templateId: string;
        cx: number;
        cy: number;
        width: number;
        height: number;
        angle: number;
        keypoints: { x: number; y: number; visibility: 0 | 1 | 2 }[];
      }>,
    ): number => {
      if (!loadedDocMeta || items.length === 0) return 0;
      const now = new Date().toISOString();
      const nextItems: PoseAnnotation[] = items.map((item) => ({
        id: crypto.randomUUID(),
        kind: 'pose',
        labelId: item.labelId,
        templateId: item.templateId,
        createdAt: now,
        updatedAt: now,
        source: 'preannot',
        cx: item.cx,
        cy: item.cy,
        width: item.width,
        height: item.height,
        angle: item.angle,
        keypoints: item.keypoints,
      }));

      recordHistory();
      setAnnotations((prev) => [...prev, ...nextItems]);
      touchDirty();
      nextItems.forEach((ann) => {
        if (ann.labelId) recordLabelUsage(ann.labelId);
      });
      return nextItems.length;
    },
    [loadedDocMeta, touchDirty, recordLabelUsage, recordHistory],
  );

  const clearPreAnnots = useCallback((): number => {
    let removed = 0;
    setAnnotations((prev) => {
      const next = prev.filter((item) => item.source !== 'preannot');
      removed = prev.length - next.length;
      return next;
    });
    if (removed > 0) {
      recordHistory();
      touchDirty();
      setSelectedAnnotationId(null);
    }
    return removed;
  }, [touchDirty, recordHistory]);

  const updatePoseGeometry = useCallback(
    (id: string, ann: PoseAnnotation) => {
      recordHistory();
      setAnnotations((prev) =>
        prev.map((item) =>
          item.kind === 'pose' && item.id === id ? ann : item,
        ),
      );
      touchDirty();
    },
    [touchDirty, recordHistory],
  );

  const updatePointGeometry = useCallback(
    (id: string, x: number, y: number) => {
      recordHistory();
      setAnnotations((prev) =>
        prev.map((item) =>
          item.kind === 'point' && item.id === id
            ? { ...item, x, y, updatedAt: new Date().toISOString() }
            : item,
        ),
      );
      touchDirty();
    },
    [touchDirty, recordHistory],
  );

  const updateKeypointVisibility = useCallback(
    (poseId: string, index: number, visibility: 0 | 1 | 2) => {
      recordHistory();
      setAnnotations((prev) =>
        prev.map((item) => {
          if (item.kind !== 'pose' || item.id !== poseId) return item;
          const keypoints = item.keypoints.map((kp, i) =>
            i === index ? { ...kp, visibility } : kp,
          );
          return {
            ...item,
            keypoints,
            updatedAt: new Date().toISOString(),
          };
        }),
      );
      touchDirty();
    },
    [touchDirty, recordHistory],
  );

  const deleteAnnotation = useCallback(
    (id: string) => {
      recordHistory();
      setAnnotations((prev) => prev.filter((a) => a.id !== id));
      setSelectedAnnotationId((sid) => (sid === id ? null : sid));
      touchDirty();
    },
    [touchDirty, recordHistory],
  );

  const updateAnnotationLabel = useCallback(
    (id: string, labelId: string) => {
      recordHistory();
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
    [touchDirty, recordLabelUsage, recordHistory],
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
      poseAnnotations,
      pointAnnotations,
      imageAnnotationType,
      activeTemplateId,
      setActiveTemplateId,
      activeTemplate,
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
      addPoseAnnotation,
      addPointAnnotation,
      addPreAnnotBboxes,
      addPreAnnotRotatedBboxes,
      addPreAnnotPolygon,
      addPreAnnotPoses,
      clearPreAnnots,
      updateBboxGeometry,
      updateRotatedBboxGeometry,
      updatePolygonGeometry,
      updatePoseGeometry,
      updatePointGeometry,
      updateKeypointVisibility,
      deleteAnnotation,
      updateAnnotationLabel,
      reportImageNaturalSize,
      dirty,
      saving,
      loadError,
      sourceStale,
      saveNow,
      undo,
      redo,
      canUndo,
      canRedo,
      beginHistoryBatch,
      endHistoryBatch,
      setLocalUndoHandler,
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
    poseAnnotations,
    pointAnnotations,
    imageAnnotationType,
    activeTemplateId,
    activeTemplate,
    selectedAnnotationId,
    tool,
    setTool,
    activeLabelId,
    labelUsage,
    selectAnnotation,
    addBboxAnnotation,
    addRotatedBboxAnnotation,
    addPolygonAnnotation,
    addPoseAnnotation,
    addPointAnnotation,
    addPreAnnotBboxes,
    addPreAnnotRotatedBboxes,
    addPreAnnotPolygon,
    addPreAnnotPoses,
    clearPreAnnots,
    updateBboxGeometry,
    updateRotatedBboxGeometry,
    updatePolygonGeometry,
    updatePoseGeometry,
    updatePointGeometry,
    updateKeypointVisibility,
    deleteAnnotation,
    updateAnnotationLabel,
    reportImageNaturalSize,
    dirty,
    saving,
    loadError,
    sourceStale,
    saveNow,
    undo,
    redo,
    canUndo,
    canRedo,
    beginHistoryBatch,
    endHistoryBatch,
    setLocalUndoHandler,
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
