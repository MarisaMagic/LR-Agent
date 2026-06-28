import { VscodeIcon } from '@vscode-elements/react-elements';
import { useEffect, useRef, type ComponentRef } from 'react';
import './ActivityBar.css';

interface ActivityIconProps {
  name: string;
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export default function ActivityIcon({
  name,
  label,
  active,
  disabled = false,
  onClick,
}: ActivityIconProps) {
  const ref = useRef<ComponentRef<typeof VscodeIcon>>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || disabled) return undefined;

    const handler = () => onClick();
    el.addEventListener('vsc-click', handler);
    return () => el.removeEventListener('vsc-click', handler);
  }, [onClick, disabled]);

  return (
    <div
      className={`activity-icon-wrap${active ? ' activity-icon-active' : ''}${disabled ? ' activity-icon-disabled' : ''}`}
      aria-disabled={disabled || undefined}
      title={label}
    >
      <VscodeIcon
        ref={ref}
        name={name}
        size={24}
        actionIcon
        label={label}
      />
    </div>
  );
}
