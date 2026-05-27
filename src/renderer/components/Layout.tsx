import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import ActivityBar, { type LeftPanel, type RightPanel } from './ActivityBar';
import AnnotationRightPanel from './annotation/AnnotationRightPanel';
import AgentPanel from './AgentPanel';
import EmailVerifyBanner from './EmailVerifyBanner';
import FileTree from './FileTree';
import FileViewer from './FileViewer';
import SettingsPanel from './SettingsPanel';
import Sidebar from './Sidebar';
import { m } from 'framer-motion';
import PanelTransition from '../motion/PanelTransition';
import AnnotationProjectPanel from './annotation/AnnotationProjectPanel';
import CreateAnnotationProjectWizard from './annotation/CreateAnnotationProjectWizard';
import EditAnnotationProjectModal from './annotation/EditAnnotationProjectModal';
import { useAnnotation } from '../context/AnnotationContext';
import './Layout.css';

const ACTIVITY_BAR_WIDTH = 48;
const RIGHT_ACTIVITY_BAR_WIDTH = 48;
const RESIZER_WIDTH = 4;

const LEFT_PANEL_TITLES: Record<LeftPanel, string> = {
  explorer: '资源管理器',
  annotations: '标注任务',
  settings: '账户设置',
};

function renderLeftPanel(panel: LeftPanel, onProjectOpened: () => void) {
  if (panel === 'settings') return <SettingsPanel />;
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
    toggleRightSidebar,
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
    activeProject,
    mode,
  } = useAnnotation();

  const leftSidebarRef = useRef<HTMLElement>(null);
  const rightSidebarRef = useRef<HTMLElement>(null);
  const resizeSideRef = useRef<'left' | 'right' | null>(null);
  const [resizingSide, setResizingSide] = useState<'left' | 'right' | null>(
    null,
  );
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

  const getMaxLeftWidth = useCallback(() => {
    const rightOccupied = rightCollapsed
      ? RIGHT_ACTIVITY_BAR_WIDTH
      : rightWidth + RESIZER_WIDTH;
    return Math.min(
      maxSidebarWidth,
      window.innerWidth -
        ACTIVITY_BAR_WIDTH -
        RESIZER_WIDTH -
        minMainContentWidth -
        rightOccupied,
    );
  }, [rightCollapsed, rightWidth, maxSidebarWidth, minMainContentWidth]);

  const getMaxRightWidth = useCallback(() => {
    const leftOccupied = leftCollapsed
      ? ACTIVITY_BAR_WIDTH
      : ACTIVITY_BAR_WIDTH + leftWidth + RESIZER_WIDTH;
    return Math.min(
      maxSidebarWidth,
      window.innerWidth - leftOccupied - RESIZER_WIDTH - minMainContentWidth,
    );
  }, [leftCollapsed, leftWidth, maxSidebarWidth, minMainContentWidth]);

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
    const onResize = () => {
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
    leftCollapsed,
    rightCollapsed,
    leftWidth,
    rightWidth,
    clampLeftWidth,
    clampRightWidth,
    setLeftWidth,
    setRightWidth,
  ]);

  const applySidebarWidth = useCallback(
    (side: 'left' | 'right', width: number) => {
      const el =
        side === 'left' ? leftSidebarRef.current : rightSidebarRef.current;
      if (!el || el.classList.contains('collapsed')) return;
      const w = `${width}px`;
      el.style.width = w;
    },
    [],
  );

  const startResize = useCallback(
    (side: 'left' | 'right') => (e: MouseEvent) => {
      if (side === 'left' && leftCollapsed) return;
      if (side === 'right' && rightCollapsed) return;

      const el =
        side === 'left' ? leftSidebarRef.current : rightSidebarRef.current;
      if (!el) return;

      e.preventDefault();
      resizeSideRef.current = side;
      setResizingSide(side);

      const onMove = (ev: MouseEvent) => {
        if (resizeSideRef.current === 'left') {
          applySidebarWidth(
            'left',
            clampLeftWidth(ev.clientX - ACTIVITY_BAR_WIDTH),
          );
        }
        if (resizeSideRef.current === 'right') {
          const rightOffset = rightCollapsed ? RIGHT_ACTIVITY_BAR_WIDTH : 0;
          applySidebarWidth(
            'right',
            clampRightWidth(window.innerWidth - ev.clientX - rightOffset),
          );
        }
      };

      const onUp = () => {
        const activeSide = resizeSideRef.current;
        resizeSideRef.current = null;
        setResizingSide(null);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        document.body.classList.remove(
          'is-resizing',
          'is-resizing-left',
          'is-resizing-right',
        );

        if (activeSide === 'left' && leftSidebarRef.current) {
          const finalWidth = Math.round(
            leftSidebarRef.current.getBoundingClientRect().width,
          );
          leftSidebarRef.current.style.width = '';
          setLeftWidth(finalWidth);
        }
        if (activeSide === 'right' && rightSidebarRef.current) {
          const finalWidth = Math.round(
            rightSidebarRef.current.getBoundingClientRect().width,
          );
          rightSidebarRef.current.style.width = '';
          setRightWidth(finalWidth);
        }
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.body.classList.add('is-resizing', `is-resizing-${side}`);
    },
    [
      leftCollapsed,
      rightCollapsed,
      clampLeftWidth,
      clampRightWidth,
      applySidebarWidth,
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
        onSettingsClick={() => openLeftPanel('settings')}
      />

      <Sidebar
        ref={leftSidebarRef}
        side="left"
        width={leftWidth}
        collapsed={leftCollapsed}
        title={leftSidebarTitle}
        onToggleCollapse={toggleLeftSidebar}
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
        ref={rightSidebarRef}
        side="right"
        width={rightWidth}
        collapsed={rightCollapsed}
        title={rightSidebarTitle}
        onToggleCollapse={toggleRightSidebar}
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
          <AgentPanel />
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
    </div>
  );
}
