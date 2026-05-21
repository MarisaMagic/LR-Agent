import { useCallback, useRef, useState, type MouseEvent } from 'react';
import { useApp } from '../context/AppContext';
import ActivityBar from './ActivityBar';
import AgentPanel from './AgentPanel';
import FileTree from './FileTree';
import FileViewer from './FileViewer';
import Sidebar from './Sidebar';
import './Layout.css';

const ACTIVITY_BAR_WIDTH = 48;
const RIGHT_ACTIVITY_BAR_WIDTH = 48;

export default function Layout() {
  const {
    layout,
    minSidebarWidth,
    maxSidebarWidth,
    setLeftWidth,
    setRightWidth,
    toggleLeftSidebar,
    toggleRightSidebar,
    expandLeftSidebar,
    expandRightSidebar,
    activeFilePath,
  } = useApp();

  const leftSidebarRef = useRef<HTMLElement>(null);
  const rightSidebarRef = useRef<HTMLElement>(null);
  const resizeSideRef = useRef<'left' | 'right' | null>(null);
  const [resizingSide, setResizingSide] = useState<'left' | 'right' | null>(
    null,
  );

  const { leftWidth, rightWidth, leftCollapsed, rightCollapsed } = layout;

  const clampWidth = useCallback(
    (width: number) =>
      Math.min(Math.max(width, minSidebarWidth), maxSidebarWidth),
    [minSidebarWidth, maxSidebarWidth],
  );

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
            clampWidth(ev.clientX - ACTIVITY_BAR_WIDTH),
          );
        }
        if (resizeSideRef.current === 'right') {
          const rightOffset = rightCollapsed ? RIGHT_ACTIVITY_BAR_WIDTH : 0;
          applySidebarWidth(
            'right',
            clampWidth(window.innerWidth - ev.clientX - rightOffset),
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
      clampWidth,
      applySidebarWidth,
      setLeftWidth,
      setRightWidth,
    ],
  );

  const handleExplorerClick = () => {
    if (leftCollapsed) {
      expandLeftSidebar();
    } else {
      toggleLeftSidebar();
    }
  };

  const handleAgentClick = () => {
    if (rightCollapsed) {
      expandRightSidebar();
    } else {
      toggleRightSidebar();
    }
  };

  const leftPanelActive = !leftCollapsed ? 'explorer' : null;
  const rightPanelActive = !rightCollapsed ? 'agent' : null;

  return (
    <div
      className={`layout${resizingSide ? ` is-resizing is-resizing-${resizingSide}` : ''}`}
    >
      <ActivityBar
        side="left"
        activePanel={leftPanelActive}
        onExplorerClick={handleExplorerClick}
        onAgentClick={() => undefined}
      />

      <Sidebar
        ref={leftSidebarRef}
        side="left"
        width={leftWidth}
        collapsed={leftCollapsed}
        title="资源管理器"
        onToggleCollapse={toggleLeftSidebar}
      >
        <FileTree />
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
        <FileViewer filePath={activeFilePath} />
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
          onExplorerClick={() => undefined}
          onAgentClick={handleAgentClick}
        />
      )}
    </div>
  );
}
