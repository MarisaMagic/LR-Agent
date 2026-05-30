import {
  VscodeCollapsible,
  VscodeToolbarContainer,
} from '@vscode-elements/react-elements';
import { ReactNode } from 'react';
import VscodeClickableToolbarButton from './VscodeClickableButton';
import './Sidebar.css';

interface SidebarProps {
  side: 'left' | 'right';
  width: number;
  collapsed: boolean;
  isResizing?: boolean;
  title: string;
  onToggleCollapse: () => void;
  children: ReactNode;
}

export default function Sidebar({
  side,
  width,
  collapsed,
  isResizing = false,
  title,
  onToggleCollapse,
  children,
}: SidebarProps) {
  const collapseIcon = side === 'left' ? 'chevron-left' : 'chevron-right';

  return (
    <aside
      className={`sidebar sidebar-${side}${collapsed ? ' collapsed' : ''}${isResizing ? ' is-resizing' : ''}`}
      style={{ width: collapsed ? 0 : width }}
    >
      <div className="sidebar-inner">
        <VscodeCollapsible
          className="sidebar-panel-header"
          heading={title}
          open
          alwaysShowHeaderActions
        >
          <VscodeToolbarContainer slot="actions">
            <VscodeClickableToolbarButton
              icon={collapseIcon}
              label="收起侧栏"
              onClick={onToggleCollapse}
            />
          </VscodeToolbarContainer>
        </VscodeCollapsible>
        <div className="sidebar-body">{children}</div>
      </div>
    </aside>
  );
}
