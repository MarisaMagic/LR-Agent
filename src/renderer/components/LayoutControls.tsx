import { useApp } from '../context/AppContext';
import './LayoutControls.css';

export default function LayoutControls() {
  const {
    layout: { leftCollapsed, rightCollapsed },
    toggleLeftSidebar,
    toggleRightSidebar,
  } = useApp();

  return (
    <div className="layout-controls">
      <button
        type="button"
        className="layout-control-btn"
        aria-label={leftCollapsed ? '显示主侧栏' : '隐藏主侧栏'}
        aria-pressed={!leftCollapsed}
        onClick={toggleLeftSidebar}
      >
        <span
          className={`codicon ${
            leftCollapsed
              ? 'codicon-layout-sidebar-left-off'
              : 'codicon-layout-sidebar-left'
          }`}
          aria-hidden="true"
        />
      </button>
      <button
        type="button"
        className="layout-control-btn"
        aria-label={rightCollapsed ? '显示 Agent 侧栏' : '隐藏 Agent 侧栏'}
        aria-pressed={!rightCollapsed}
        onClick={toggleRightSidebar}
      >
        <span
          className={`codicon ${
            rightCollapsed
              ? 'codicon-layout-sidebar-right-off'
              : 'codicon-layout-sidebar-right'
          }`}
          aria-hidden="true"
        />
      </button>
    </div>
  );
}
