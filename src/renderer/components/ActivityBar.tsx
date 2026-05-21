import { VscodeIcon } from '@vscode-elements/react-elements';
import { useEffect, useRef } from 'react';
import './ActivityBar.css';

interface ActivityBarProps {
  side: 'left' | 'right';
  activePanel: 'explorer' | 'agent' | null;
  onExplorerClick: () => void;
  onAgentClick: () => void;
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

export default function ActivityBar({
  side,
  activePanel,
  onExplorerClick,
  onAgentClick,
}: ActivityBarProps) {
  return (
    <nav
      className={`activity-bar activity-bar-${side}`}
      aria-label={side === 'left' ? '主活动栏' : '辅助活动栏'}
    >
      {side === 'left' && (
        <ActivityIcon
          name="files"
          label="资源管理器"
          active={activePanel === 'explorer'}
          onClick={onExplorerClick}
        />
      )}
      {side === 'right' && (
        <ActivityIcon
          name="comment-discussion"
          label="AI Agent"
          active={activePanel === 'agent'}
          onClick={onAgentClick}
        />
      )}
    </nav>
  );
}
