import { VscodeIcon } from '@vscode-elements/react-elements';
import { useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import UserAvatar from './UserAvatar';
import { MoonIcon, SunIcon } from './ThemeToggleIcons';
import './ActivityBar.css';

export type LeftPanel = 'explorer' | 'annotations' | 'settings';
export type RightPanel = 'agent' | 'annotation';

interface ActivityBarProps {
  side: 'left' | 'right';
  activePanel: LeftPanel | RightPanel | null;
  onExplorerClick?: () => void;
  onAnnotationsClick?: () => void;
  onSettingsClick?: () => void;
  onAgentClick?: () => void;
  /** When open, render an extra 「标注列表」icon on the right bar */
  showAnnotationToolbar?: boolean;
  onAnnotationPanelClick?: () => void;
}

function ActivityIcon({
  name,
  label,
  active,
  onClick,
}: {
  name: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    const handler = () => onClick();
    el.addEventListener('vsc-click', handler);
    return () => el.removeEventListener('vsc-click', handler);
  }, [onClick]);

  return (
    <div
      className={`activity-icon-wrap ${active ? 'activity-icon-active' : ''}`}
    >
      <VscodeIcon ref={ref} name={name} size={24} actionIcon label={label} />
    </div>
  );
}

function ThemeToggleButton({ onClick }: { onClick: () => void }) {
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark';
  const label = isDark ? '切换到浅色主题' : '切换到深色主题';

  return (
    <button
      type="button"
      className="activity-theme-toggle"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {isDark ? (
        <SunIcon className="activity-theme-toggle-icon" />
      ) : (
        <MoonIcon className="activity-theme-toggle-icon" />
      )}
    </button>
  );
}

function AccountAvatarButton({
  active,
  onClick,
}: {
  active: boolean;
  onClick: () => void;
}) {
  const { user } = useAuth();

  return (
    <button
      type="button"
      className={`activity-avatar-btn ${active ? 'activity-icon-active' : ''}`}
      aria-label="账户设置"
      title="账户设置"
      onClick={onClick}
    >
      {user ? (
        <UserAvatar user={user} size="sm" alt="" />
      ) : (
        <span className="activity-avatar-fallback codicon codicon-account" />
      )}
    </button>
  );
}

export default function ActivityBar({
  side,
  activePanel,
  onExplorerClick,
  onAnnotationsClick,
  onSettingsClick,
  onAgentClick,
  showAnnotationToolbar,
  onAnnotationPanelClick,
}: ActivityBarProps) {
  const { toggleDarkLight } = useTheme();

  if (side === 'left') {
    return (
      <nav className="activity-bar activity-bar-left" aria-label="主活动栏">
        <div className="activity-bar-top">
          <ActivityIcon
            name="files"
            label="资源管理器"
            active={activePanel === 'explorer'}
            onClick={onExplorerClick ?? (() => undefined)}
          />
          <ActivityIcon
            name="list-unordered"
            label="标注任务"
            active={activePanel === 'annotations'}
            onClick={onAnnotationsClick ?? (() => undefined)}
          />
        </div>
        <div className="activity-bar-bottom">
          <ThemeToggleButton onClick={toggleDarkLight} />
          <AccountAvatarButton
            active={activePanel === 'settings'}
            onClick={onSettingsClick ?? (() => undefined)}
          />
        </div>
      </nav>
    );
  }

  return (
    <nav className="activity-bar activity-bar-right" aria-label="辅助活动栏">
      {showAnnotationToolbar && (
        <ActivityIcon
          name="tag"
          label="标注列表"
          active={activePanel === 'annotation'}
          onClick={onAnnotationPanelClick ?? (() => undefined)}
        />
      )}
      <ActivityIcon
        name="comment-discussion"
        label="AI Agent"
        active={activePanel === 'agent'}
        onClick={onAgentClick ?? (() => undefined)}
      />
    </nav>
  );
}
