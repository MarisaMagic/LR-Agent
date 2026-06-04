import { useEffect, useRef, useState } from 'react';
import type { AgentInteractionMode } from '../../../shared/agentTypes';
import PopoverMotion from '../../motion/PopoverMotion';
import './AgentModePicker.css';

interface ModeOption {
  id: AgentInteractionMode;
  label: string;
  description: string;
  icon: 'ask' | 'agent';
}

const MODE_OPTIONS: ModeOption[] = [
  {
    id: 'chat',
    label: 'Ask',
    description: '问答与分析，不写入标注',
    icon: 'ask',
  },
  {
    id: 'annotation',
    label: 'Agent',
    description: '批量检测与标注提案',
    icon: 'agent',
  },
];

function ModeIcon({ kind }: { kind: ModeOption['icon'] }) {
  if (kind === 'agent') {
    return (
      <span className="agent-mode-picker-symbol" aria-hidden>
        ∞
      </span>
    );
  }
  return (
    <span
      className="codicon codicon-comment-discussion agent-mode-picker-codicon"
      aria-hidden
    />
  );
}

interface AgentModePickerProps {
  mode: AgentInteractionMode;
  disabled?: boolean;
  onSelect: (mode: AgentInteractionMode) => void;
}

export default function AgentModePicker({
  mode,
  disabled = false,
  onSelect,
}: AgentModePickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const active =
    MODE_OPTIONS.find((item) => item.id === mode) ?? MODE_OPTIONS[0];

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  return (
    <div className="agent-mode-picker" ref={rootRef}>
      <button
        type="button"
        className="agent-mode-picker-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`交互模式：${active.label}`}
        onClick={() => setOpen((value) => !value)}
      >
        <ModeIcon kind={active.icon} />
        <span className="agent-mode-picker-label">{active.label}</span>
        <span className="codicon codicon-chevron-down agent-mode-picker-chevron" />
      </button>

      <PopoverMotion
        open={open}
        className="agent-mode-picker-menu"
        origin="bottom"
        role="listbox"
      >
        {MODE_OPTIONS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="option"
            aria-selected={option.id === mode}
            className={`agent-mode-picker-option${
              option.id === mode ? ' agent-mode-picker-option--active' : ''
            }`}
            onClick={() => {
              onSelect(option.id);
              setOpen(false);
            }}
          >
            <span className="agent-mode-picker-option-leading">
              <ModeIcon kind={option.icon} />
              <span className="agent-mode-picker-option-name">{option.label}</span>
            </span>
            <span className="agent-mode-picker-option-desc">{option.description}</span>
          </button>
        ))}
      </PopoverMotion>
    </div>
  );
}
