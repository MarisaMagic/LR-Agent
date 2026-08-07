import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { LlmProviderConfig } from '../../types/agent';
import {
  computeFloatingMenuPosition,
  type FloatingMenuPosition,
} from '../../utils/annotationMenuPosition';
import PopoverMotion from '../../motion/PopoverMotion';
import './AgentModelPicker.css';

interface AgentModelPickerProps {
  providers: LlmProviderConfig[];
  selectedId: string;
  disabled?: boolean;
  /** 与模式选择器并排时，使用 Cursor 式纯文本触发样式 */
  inline?: boolean;
  /** 下拉菜单相对触发按钮的展开方向；Agent Composer 在底部用 above */
  menuPlacement?: 'above' | 'below';
  onSelect: (providerId: string) => void;
}

const MENU_GAP = 6;

export default function AgentModelPicker({
  providers,
  selectedId,
  disabled = false,
  inline = false,
  menuPlacement = 'above',
  onSelect,
}: AgentModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<FloatingMenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selected =
    providers.find((item) => item.id === selectedId) ?? providers[0] ?? null;

  const updatePosition = useCallback(() => {
    const anchorEl = triggerRef.current;
    const menuEl = menuRef.current;
    if (!anchorEl || !menuEl) return;
    setPosition(
      computeFloatingMenuPosition(
        anchorEl,
        menuEl.offsetWidth,
        menuEl.offsetHeight,
        {
          gap: MENU_GAP,
          alignEnd: false,
          preferOpenUp: menuPlacement === 'above',
        },
      ),
    );
  }, [menuPlacement]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    updatePosition();
  }, [open, providers, updatePosition]);

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };

    const onDismiss = () => setOpen(false);

    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('scroll', onDismiss, true);
    window.addEventListener('resize', onDismiss);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('scroll', onDismiss, true);
      window.removeEventListener('resize', onDismiss);
    };
  }, [open]);

  const label = selected
    ? selected.model
    : providers.length === 0
      ? '请先配置大模型'
      : '选择模型';

  const menuOpen = open && providers.length > 0;

  const menu = menuOpen
    ? createPortal(
        <PopoverMotion
          open
          innerRef={menuRef}
          className={`agent-model-picker-menu agent-model-picker-menu--portal${
            position?.openUp ? ' agent-model-picker-menu--open-up' : ''
          }`}
          style={
            position
              ? {
                  top: `${position.top}px`,
                  left: `${position.left}px`,
                }
              : { visibility: 'hidden' }
          }
          origin={position?.openUp ? 'bottom' : 'top'}
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
        </PopoverMotion>,
        document.body,
      )
    : null;

  return (
    <div
      className={`agent-model-picker${inline ? ' agent-model-picker--inline' : ''}`}
      ref={rootRef}
    >
      <button
        ref={triggerRef}
        type="button"
        className="agent-model-picker-trigger"
        disabled={disabled || providers.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected ? `${selected.name || selected.model} · ${selected.model}` : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="agent-model-picker-label">{label}</span>
        <span className="codicon codicon-chevron-down agent-model-picker-chevron" />
      </button>
      {menu}
    </div>
  );
}
