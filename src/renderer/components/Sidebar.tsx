import {
  VscodeCollapsible,
  VscodeToolbarContainer,
} from '@vscode-elements/react-elements';
import { forwardRef, ReactNode } from 'react';
import VscodeClickableToolbarButton from './VscodeClickableButton';
import './Sidebar.css';

interface SidebarProps {
  side: 'left' | 'right';
  width: number;
  collapsed: boolean;
  title: string;
  onToggleCollapse: () => void;
  children: ReactNode;
}

const Sidebar = forwardRef<HTMLElement, SidebarProps>(function Sidebar(
  { side, width, collapsed, title, onToggleCollapse, children },
  ref,
) {
  const collapseIcon = side === 'left' ? 'chevron-left' : 'chevron-right';

  return (
    <aside
      ref={ref}
      className={`sidebar sidebar-${side} ${collapsed ? 'collapsed' : ''}`}
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
});

export default Sidebar;
