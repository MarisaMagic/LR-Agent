import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import UserAvatar from './UserAvatar';
import { MoonIcon, SunIcon } from './ThemeToggleIcons';
import ActivityIcon from './ActivityIcon';
import './ActivityBar.css';

export type LeftPanel =
  | 'explorer'
  | 'annotations'
  | 'models'
  | 'llmProviders'
  | 'settings';
export type RightPanel = 'agent' | 'annotation';

interface ActivityBarProps {
  activePanel: LeftPanel | null;
  onExplorerClick?: () => void;
  onAnnotationsClick?: () => void;
  onModelsClick?: () => void;
  onLlmProvidersClick?: () => void;
  onSettingsClick?: () => void;
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
  activePanel,
  onExplorerClick,
  onAnnotationsClick,
  onModelsClick,
  onLlmProvidersClick,
  onSettingsClick,
}: ActivityBarProps) {
  const { toggleDarkLight } = useTheme();

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
        <ActivityIcon
          name="layers"
          label="预训练模型"
          active={activePanel === 'models'}
          onClick={onModelsClick ?? (() => undefined)}
        />
        <ActivityIcon
          name="copilot"
          label="大模型配置"
          active={activePanel === 'llmProviders'}
          onClick={onLlmProvidersClick ?? (() => undefined)}
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
