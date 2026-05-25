import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  AnnotationProject,
  CreateAnnotationProjectInput,
  UpdateAnnotationProjectInput,
} from '../types/annotation';
import {
  createAnnotationProject,
  deleteAnnotationProjectRecord,
  loadAnnotationProjects,
  touchAnnotationProject,
  updateAnnotationProject,
  validateProjectDirectory,
} from '../services/annotationProjectStore';
import { useApp } from './AppContext';
import { useToast } from './ToastContext';

const STORAGE_KEYS = {
  lastAnnotationProjectId: 'lr-agent:lastAnnotationProjectId',
};

export type AppMode = 'browse' | 'annotation';

interface AnnotationContextValue {
  mode: AppMode;
  projects: AnnotationProject[];
  activeProject: AnnotationProject | null;
  loading: boolean;
  createWizardOpen: boolean;
  editingProject: AnnotationProject | null;
  openCreateWizard: () => void;
  closeCreateWizard: () => void;
  openEditProject: (project: AnnotationProject) => void;
  closeEditProject: () => void;
  refreshProjects: () => Promise<void>;
  createProject: (
    input: CreateAnnotationProjectInput,
  ) => Promise<AnnotationProject>;
  updateProject: (
    projectId: string,
    input: UpdateAnnotationProjectInput,
  ) => Promise<AnnotationProject>;
  openProject: (projectId: string) => Promise<void>;
  deleteProject: (projectId: string) => Promise<void>;
  clearActiveProject: () => void;
  showProjectInFolder: (project: AnnotationProject) => void;
}

const AnnotationContext = createContext<AnnotationContextValue | null>(null);

export function AnnotationProvider({ children }: { children: ReactNode }) {
  const { openFolder } = useApp();
  const { showToast } = useToast();

  const [mode, setMode] = useState<AppMode>('browse');
  const [projects, setProjects] = useState<AnnotationProject[]>([]);
  const [activeProject, setActiveProject] = useState<AnnotationProject | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [createWizardOpen, setCreateWizardOpen] = useState(false);
  const [editingProject, setEditingProject] =
    useState<AnnotationProject | null>(null);

  const refreshProjects = useCallback(async () => {
    const list = await loadAnnotationProjects();
    setProjects(list);
    setActiveProject((current) => {
      if (!current) return null;
      return list.find((item) => item.id === current.id) ?? null;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      setLoading(true);
      try {
        const list = await loadAnnotationProjects();
        if (cancelled) return;
        setProjects(list);

        const lastId = localStorage.getItem(
          STORAGE_KEYS.lastAnnotationProjectId,
        );
        if (!lastId) return;

        const lastProject = list.find((item) => item.id === lastId);
        if (!lastProject) return;

        const valid = await validateProjectDirectory(lastProject.directoryPath);
        if (!valid || cancelled) return;

        setActiveProject(lastProject);
        setMode('annotation');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    init().catch(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const openCreateWizard = useCallback(() => {
    setCreateWizardOpen(true);
  }, []);

  const closeCreateWizard = useCallback(() => {
    setCreateWizardOpen(false);
  }, []);

  const openEditProject = useCallback((project: AnnotationProject) => {
    setEditingProject(project);
  }, []);

  const closeEditProject = useCallback(() => {
    setEditingProject(null);
  }, []);

  const createProject = useCallback(
    async (input: CreateAnnotationProjectInput) => {
      const valid = await validateProjectDirectory(input.directoryPath);
      if (!valid) {
        throw new Error('所选目录不存在或无法访问');
      }

      const project = await createAnnotationProject(input);
      await refreshProjects();
      return project;
    },
    [refreshProjects],
  );

  const updateProject = useCallback(
    async (projectId: string, input: UpdateAnnotationProjectInput) => {
      if (!input.name.trim()) {
        throw new Error('任务名称不能为空');
      }

      const updated = await updateAnnotationProject(projectId, input);
      if (!updated) {
        throw new Error('标注任务不存在或已被删除');
      }

      await refreshProjects();
      setActiveProject((current) =>
        current?.id === projectId ? updated : current,
      );
      setEditingProject((current) =>
        current?.id === projectId ? updated : current,
      );
      showToast(`已更新标注任务「${updated.name}」`, { type: 'success' });
      return updated;
    },
    [refreshProjects, showToast],
  );

  const openProject = useCallback(
    async (projectId: string) => {
      const project = projects.find((item) => item.id === projectId);
      if (!project) {
        showToast('标注任务不存在或已被删除', { type: 'error' });
        await refreshProjects();
        return;
      }

      const valid = await validateProjectDirectory(project.directoryPath);
      if (!valid) {
        showToast('项目目录不存在，请检查路径或重新绑定', { type: 'error' });
        return;
      }

      const updated = await touchAnnotationProject(projectId);
      const nextProject = updated ?? project;

      await openFolder(project.directoryPath);
      setActiveProject(nextProject);
      setMode('annotation');
      localStorage.setItem(STORAGE_KEYS.lastAnnotationProjectId, projectId);
      await refreshProjects();
      showToast(`已打开标注任务「${nextProject.name}」`, { type: 'success' });
    },
    [projects, openFolder, refreshProjects, showToast],
  );

  const deleteProject = useCallback(
    async (projectId: string) => {
      const removed = await deleteAnnotationProjectRecord(projectId);
      if (!removed) {
        showToast('删除失败，任务可能已不存在', { type: 'error' });
        await refreshProjects();
        return;
      }

      if (activeProject?.id === projectId) {
        setActiveProject(null);
        setMode('browse');
        localStorage.removeItem(STORAGE_KEYS.lastAnnotationProjectId);
      }

      await refreshProjects();
      showToast(`已删除标注任务「${removed.name}」`, { type: 'success' });
    },
    [activeProject, refreshProjects, showToast],
  );

  const clearActiveProject = useCallback(() => {
    setActiveProject(null);
    setMode('browse');
    localStorage.removeItem(STORAGE_KEYS.lastAnnotationProjectId);
  }, []);

  const showProjectInFolder = useCallback((project: AnnotationProject) => {
    window.electron.annotation.showItemInFolder(project.directoryPath);
  }, []);

  useEffect(() => {
    const unsub = window.electron.ipcRenderer.on(
      'menu:createAnnotationProject',
      () => {
        openCreateWizard();
      },
    );
    return unsub;
  }, [openCreateWizard]);

  const value = useMemo<AnnotationContextValue>(
    () => ({
      mode,
      projects,
      activeProject,
      loading,
      createWizardOpen,
      editingProject,
      openCreateWizard,
      closeCreateWizard,
      openEditProject,
      closeEditProject,
      refreshProjects,
      createProject,
      updateProject,
      openProject,
      deleteProject,
      clearActiveProject,
      showProjectInFolder,
    }),
    [
      mode,
      projects,
      activeProject,
      loading,
      createWizardOpen,
      editingProject,
      openCreateWizard,
      closeCreateWizard,
      openEditProject,
      closeEditProject,
      refreshProjects,
      createProject,
      updateProject,
      openProject,
      deleteProject,
      clearActiveProject,
      showProjectInFolder,
    ],
  );

  return (
    <AnnotationContext.Provider value={value}>
      {children}
    </AnnotationContext.Provider>
  );
}

export function useAnnotation(): AnnotationContextValue {
  const ctx = useContext(AnnotationContext);
  if (!ctx) {
    throw new Error('useAnnotation must be used within AnnotationProvider');
  }
  return ctx;
}
