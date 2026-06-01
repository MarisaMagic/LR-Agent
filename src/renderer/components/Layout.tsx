import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { m } from 'framer-motion';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import ActivityBar, { type LeftPanel, type RightPanel } from './ActivityBar';
import AnnotationRightPanel from './annotation/AnnotationRightPanel';
import AgentPanel from './agent/AgentPanel';
import EmailVerifyBanner from './EmailVerifyBanner';
import FileTree from './FileTree';
import FileViewer from './FileViewer';
import LlmProvidersPanel from './llmProviders/LlmProvidersPanel';
import PretrainedModelsPanel from './pretrainedModels/PretrainedModelsPanel';
import SettingsPanel from './SettingsPanel';
import Sidebar from './Sidebar';
import PanelTransition from '../motion/PanelTransition';
import AnnotationProjectPanel from './annotation/AnnotationProjectPanel';
import CreateAnnotationProjectWizard from './annotation/CreateAnnotationProjectWizard';
import EditAnnotationProjectModal from './annotation/EditAnnotationProjectModal';
import ExportAnnotationWizard from './annotation/ExportAnnotationWizard';
import { useAnnotation } from '../context/AnnotationContext';
import './Layout.css';

const ACTIVITY_BAR_WIDTH = 48;
const RIGHT_ACTIVITY_BAR_WIDTH = 48;
const RESIZER_WIDTH = 4;

const LEFT_PANEL_TITLES: Record<LeftPanel, string> = {
  explorer: '资源管理器',
  annotations: '标注任务',
  models: '预训练模型',
  llmProviders: '大模型配置',
  settings: '账户设置',
};

function renderLeftPanel(panel: LeftPanel, onProjectOpened: () => void) {
  if (panel === 'settings') return <SettingsPanel />;
  if (panel === 'llmProviders') return <LlmProvidersPanel />;
  if (panel === 'models') return <PretrainedModelsPanel />;
  if (panel === 'annotations') {
    return <AnnotationProjectPanel onProjectOpened={onProjectOpened} />;
  }
  return <FileTree />;
}

export default function Layout() {
  const {
    layout,
    minSidebarWidth,
    maxSidebarWidth,
    minMainContentWidth,
    setLeftWidth,
    setRightWidth,
    toggleLeftSidebar,
    expandLeftSidebar,
    expandRightSidebar,
    activeFilePath,
  } = useApp();
  const { refreshUser } = useAuth();
  const {
    createWizardOpen,
    closeCreateWizard,
    editingProject,
    closeEditProject,
    exportingProject,
    closeExportProject,
    activeProject,
    mode,
  } = useAnnotation();

  const resizeSideRef = useRef<'left' | 'right' | null>(null);
  const resizeDraftRef = useRef<number | null>(null);
  const [resizingSide, setResizingSide] = useState<'left' | 'right' | null>(
    null,
  );
  const [resizeDraft, setResizeDraft] = useState<{
    side: 'left' | 'right';
    width: number;
  } | null>(null);
  const [leftPanel, setLeftPanel] = useState<LeftPanel>('explorer');

  const [rightPanel, setRightPanel] = useState<RightPanel>('agent');
  const annotationToolbarActive =
    Boolean(activeProject) && mode === 'annotation';

  useEffect(() => {
    if (annotationToolbarActive) {
      setRightPanel('annotation');
    } else {
      setRightPanel('agent');
    }
  }, [annotationToolbarActive]);

  useEffect(() => {
    refreshUser().catch(() => undefined);
  }, [refreshUser]);

  const { leftWidth, rightWidth, leftCollapsed, rightCollapsed } = layout;

  const displayLeftWidth =
    resizeDraft?.side === 'left' ? resizeDraft.width : leftWidth;
  const displayRightWidth =
    resizeDraft?.side === 'right' ? resizeDraft.width : rightWidth;

  const getMaxLeftWidth = useCallback(() => {
    const rightOccupied = rightCollapsed
      ? RIGHT_ACTIVITY_BAR_WIDTH
      : rightWidth + RESIZER_WIDTH;
    const spaceMax =
      window.innerWidth -
      ACTIVITY_BAR_WIDTH -
      RESIZER_WIDTH -
      minMainContentWidth -
      rightOccupied;
    return Math.max(
      minSidebarWidth,
      Math.min(maxSidebarWidth, spaceMax),
    );
  }, [
    rightCollapsed,
    rightWidth,
    maxSidebarWidth,
    minMainContentWidth,
    minSidebarWidth,
  ]);

  const getMaxRightWidth = useCallback(() => {
    const leftOccupied = leftCollapsed
      ? ACTIVITY_BAR_WIDTH
      : ACTIVITY_BAR_WIDTH + leftWidth + RESIZER_WIDTH;
    const spaceMax =
      window.innerWidth - leftOccupied - RESIZER_WIDTH - minMainContentWidth;
    const halfMax = Math.floor(window.innerWidth * 0.5);
    return Math.max(minSidebarWidth, Math.min(halfMax, spaceMax));
  }, [leftCollapsed, leftWidth, minMainContentWidth, minSidebarWidth]);

  const clampLeftWidth = useCallback(
    (width: number) =>
      Math.min(Math.max(width, minSidebarWidth), getMaxLeftWidth()),
    [minSidebarWidth, getMaxLeftWidth],
  );

  const clampRightWidth = useCallback(
    (width: number) =>
      Math.min(Math.max(width, minSidebarWidth), getMaxRightWidth()),
    [minSidebarWidth, getMaxRightWidth],
  );

  useEffect(() => {
    if (resizingSide) return;

    if (!rightCollapsed) {
      const nextRight = clampRightWidth(rightWidth);
      if (nextRight !== rightWidth) {
        setRightWidth(nextRight);
        return;
      }
    }

    if (!leftCollapsed) {
      const nextLeft = clampLeftWidth(leftWidth);
      if (nextLeft !== leftWidth) {
        setLeftWidth(nextLeft);
      }
    }
  }, [
    resizingSide,
    leftCollapsed,
    rightCollapsed,
    leftWidth,
    rightWidth,
    clampLeftWidth,
    clampRightWidth,
    setLeftWidth,
    setRightWidth,
  ]);

  useEffect(() => {
    const onResize = () => {
      if (resizingSide) return;
      if (!leftCollapsed) {
        setLeftWidth(clampLeftWidth(leftWidth));
      }
      if (!rightCollapsed) {
        setRightWidth(clampRightWidth(rightWidth));
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [
    resizingSide,
    leftCollapsed,
    rightCollapsed,
    leftWidth,
    rightWidth,
    clampLeftWidth,
    clampRightWidth,
    setLeftWidth,
    setRightWidth,
  ]);

  const startResize = useCallback(
    (side: 'left' | 'right') => (e: ReactMouseEvent) => {
      if (side === 'left' && leftCollapsed) return;
      if (side === 'right' && rightCollapsed) return;

      e.preventDefault();
      const initialWidth =
        side === 'left'
          ? clampLeftWidth(leftWidth)
          : clampRightWidth(rightWidth);

      resizeSideRef.current = side;
      resizeDraftRef.current = initialWidth;
      setResizingSide(side);
      setResizeDraft({ side, width: initialWidth });

      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.body.classList.add('is-resizing', `is-resizing-${side}`);

      const onMove = (ev: { clientX: number }) => {
        if (resizeSideRef.current === 'left') {
          const width = clampLeftWidth(ev.clientX - ACTIVITY_BAR_WIDTH);
          resizeDraftRef.current = width;
          setResizeDraft({ side: 'left', width });
        }
        if (resizeSideRef.current === 'right') {
          const rightOffset = rightCollapsed ? RIGHT_ACTIVITY_BAR_WIDTH : 0;
          const width = clampRightWidth(
            window.innerWidth - ev.clientX - rightOffset,
          );
          resizeDraftRef.current = width;
          setResizeDraft({ side: 'right', width });
        }
      };

      const onUp = () => {
        const activeSide = resizeSideRef.current;
        const finalWidth = resizeDraftRef.current;
        resizeSideRef.current = null;
        resizeDraftRef.current = null;
        setResizingSide(null);
        setResizeDraft(null);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.body.classList.remove(
          'is-resizing',
          'is-resizing-left',
          'is-resizing-right',
        );

        if (activeSide === 'left' && finalWidth != null) {
          setLeftWidth(finalWidth);
        }
        if (activeSide === 'right' && finalWidth != null) {
          setRightWidth(finalWidth);
        }
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [
      leftCollapsed,
      rightCollapsed,
      leftWidth,
      rightWidth,
      clampLeftWidth,
      clampRightWidth,
      setLeftWidth,
      setRightWidth,
    ],
  );

  const openLeftPanel = useCallback(
    (panel: LeftPanel) => {
      if (!leftCollapsed && leftPanel === panel) {
        toggleLeftSidebar();
        return;
      }
      setLeftPanel(panel);
      if (leftCollapsed) {
        expandLeftSidebar();
      }
    },
    [leftCollapsed, leftPanel, toggleLeftSidebar, expandLeftSidebar],
  );

  const handleCollapsedRightActivity = useCallback(
    (panel: RightPanel) => {
      setRightPanel(panel);
      if (rightCollapsed) {
        expandRightSidebar();
      }
    },
    [rightCollapsed, expandRightSidebar],
  );

  const handleProjectOpened = useCallback(() => {
    setLeftPanel('explorer');
    if (leftCollapsed) {
      expandLeftSidebar();
    }
  }, [leftCollapsed, expandLeftSidebar]);

  const leftPanelActive = !leftCollapsed ? leftPanel : null;
  /** Collapsed right activity bar highlighted tab */
  const collapsedRightHighlight: RightPanel = annotationToolbarActive
    ? rightPanel
    : 'agent';

  const rightActivityActive = rightCollapsed ? collapsedRightHighlight : null;

  const leftSidebarTitle = LEFT_PANEL_TITLES[leftPanel];
  const rightSidebarTitle =
    annotationToolbarActive && rightPanel === 'annotation'
      ? '标注列表'
      : 'AI Agent';

  return (
    <div
      className={`layout${resizingSide ? ` is-resizing is-resizing-${resizingSide}` : ''}`}
    >
      <ActivityBar
        side="left"
        activePanel={leftPanelActive}
        onExplorerClick={() => openLeftPanel('explorer')}
        onAnnotationsClick={() => openLeftPanel('annotations')}
        onModelsClick={() => openLeftPanel('models')}
        onLlmProvidersClick={() => openLeftPanel('llmProviders')}
        onSettingsClick={() => openLeftPanel('settings')}
      />

      <Sidebar
        side="left"
        width={displayLeftWidth}
        collapsed={leftCollapsed}
        isResizing={resizingSide === 'left'}
        title={leftSidebarTitle}
      >
        <PanelTransition panelKey={leftPanel} className="sidebar-panel-motion">
          {renderLeftPanel(leftPanel, handleProjectOpened)}
        </PanelTransition>
      </Sidebar>

      {!leftCollapsed && (
        <button
          type="button"
          className="resizer resizer-left"
          onMouseDown={startResize('left')}
          aria-label="调整左侧栏宽度"
        />
      )}

      <main className="main-content">
        <EmailVerifyBanner />
        <div className="main-content-body">
          <FileViewer filePath={activeFilePath} />
        </div>
      </main>

      {!rightCollapsed && (
        <button
          type="button"
          className="resizer resizer-right"
          onMouseDown={startResize('right')}
          aria-label="调整右侧栏宽度"
        />
      )}

      <Sidebar
        side="right"
        width={displayRightWidth}
        collapsed={rightCollapsed}
        isResizing={resizingSide === 'right'}
        title={rightSidebarTitle}
      >
        {annotationToolbarActive ? (
          <>
            <div className="right-panel-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={rightPanel === 'annotation'}
                className={`right-panel-tab${rightPanel === 'annotation' ? ' right-panel-tab--active' : ''}`}
                onClick={() => setRightPanel('annotation')}
              >
                标注列表
                {rightPanel === 'annotation' && (
                  <m.span
                    layoutId="right-panel-tab-indicator"
                    className="right-panel-tab-indicator"
                    transition={{
                      type: 'spring',
                      stiffness: 420,
                      damping: 32,
                    }}
                  />
                )}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={rightPanel === 'agent'}
                className={`right-panel-tab${rightPanel === 'agent' ? ' right-panel-tab--active' : ''}`}
                onClick={() => setRightPanel('agent')}
              >
                AI Agent
                {rightPanel === 'agent' && (
                  <m.span
                    layoutId="right-panel-tab-indicator"
                    className="right-panel-tab-indicator"
                    transition={{
                      type: 'spring',
                      stiffness: 420,
                      damping: 32,
                    }}
                  />
                )}
              </button>
            </div>
            <PanelTransition
              panelKey={rightPanel}
              className="sidebar-panel-motion"
              direction="up"
            >
              {rightPanel === 'annotation' ? (
                <AnnotationRightPanel />
              ) : (
                <AgentPanel />
              )}
            </PanelTransition>
          </>
        ) : (
          <div className="sidebar-panel-motion">
            <AgentPanel />
          </div>
        )}
      </Sidebar>

      {rightCollapsed && (
        <ActivityBar
          side="right"
          activePanel={rightActivityActive}
          showAnnotationToolbar={annotationToolbarActive}
          onAnnotationPanelClick={() =>
            handleCollapsedRightActivity('annotation')
          }
          onAgentClick={() => handleCollapsedRightActivity('agent')}
        />
      )}

      <CreateAnnotationProjectWizard
        open={createWizardOpen}
        onClose={closeCreateWizard}
        onCreated={handleProjectOpened}
      />

      {editingProject && (
        <EditAnnotationProjectModal
          project={editingProject}
          onClose={closeEditProject}
        />
      )}

      <ExportAnnotationWizard
        project={exportingProject}
        onClose={closeExportProject}
      />
    </div>
  );
}
