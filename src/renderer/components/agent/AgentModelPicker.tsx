import { useEffect, useRef, useState } from 'react';
import type { LlmProviderConfig } from '../../types/agent';
import PopoverMotion from '../../motion/PopoverMotion';
import './AgentModelPicker.css';

interface AgentModelPickerProps {
  providers: LlmProviderConfig[];
  selectedId: string;
  disabled?: boolean;
  /** 与模式选择器并排时，使用 Cursor 式纯文本触发样式 */
  inline?: boolean;
  onSelect: (providerId: string) => void;
}

export default function AgentModelPicker({
  providers,
  selectedId,
  disabled = false,
  inline = false,
  onSelect,
}: AgentModelPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected =
    providers.find((item) => item.id === selectedId) ?? providers[0] ?? null;

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

  const label = selected
    ? selected.model
    : providers.length === 0
      ? '请先配置大模型'
      : '选择模型';

  return (
    <div
      className={`agent-model-picker${inline ? ' agent-model-picker--inline' : ''}`}
      ref={rootRef}
    >
      <button
        type="button"
        className="agent-model-picker-trigger"
        disabled={disabled || providers.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="agent-model-picker-label">{label}</span>
        <span className="codicon codicon-chevron-down agent-model-picker-chevron" />
      </button>

      <PopoverMotion
        open={open && providers.length > 0}
        className="agent-model-picker-menu"
        origin="bottom"
        role="listbox"
      >
        {providers.map((provider) => (
          <button
            key={provider.id}
            type="button"
            role="option"
            aria-selected={provider.id === selectedId}
            className={`agent-model-picker-option${
              provider.id === selectedId
                ? ' agent-model-picker-option--active'
                : ''
            }`}
            onClick={() => {
              onSelect(provider.id);
              setOpen(false);
            }}
          >
            <span className="agent-model-picker-option-name">
              {provider.name || provider.model}
            </span>
            <span className="agent-model-picker-option-model">
              {provider.model}
            </span>
          </button>
        ))}
      </PopoverMotion>
    </div>
  );
}
