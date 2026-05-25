import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import ActivityBar, { type LeftPanel } from './ActivityBar';
import AgentPanel from './AgentPanel';
import EmailVerifyBanner from './EmailVerifyBanner';
import FileTree from './FileTree';
import FileViewer from './FileViewer';
import SettingsPanel from './SettingsPanel';
import Sidebar from './Sidebar';
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
  } = useAnnotation();

  const leftSidebarRef = useRef<HTMLElement>(null);
  const rightSidebarRef = useRef<HTMLElement>(null);
  const resizeSideRef = useRef<'left' | 'right' | null>(null);
  const [resizingSide, setResizingSide] = useState<'left' | 'right' | null>(
    null,
  );
  const [leftPanel, setLeftPanel] = useState<LeftPanel>('explorer');

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

  const handleAgentClick = () => {
    if (rightCollapsed) {
      expandRightSidebar();
    } else {
      toggleRightSidebar();
    }
  };

  const handleProjectOpened = useCallback(() => {
    setLeftPanel('explorer');
    if (leftCollapsed) {
      expandLeftSidebar();
    }
  }, [leftCollapsed, expandLeftSidebar]);

  const leftPanelActive = !leftCollapsed ? leftPanel : null;
  const rightPanelActive = !rightCollapsed ? 'agent' : null;
  const leftSidebarTitle = LEFT_PANEL_TITLES[leftPanel];

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
        title="AI Agent"
        onToggleCollapse={toggleRightSidebar}
      >
        <AgentPanel />
      </Sidebar>

      {rightCollapsed && (
        <ActivityBar
          side="right"
          activePanel={rightPanelActive}
          onAgentClick={handleAgentClick}
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
