import { useCallback, useEffect, useRef, useState } from 'react';
import { getLabelChipStyle } from '../../utils/labelColor';
import './AnnotationDrawLabelPicker.css';

interface LabelOption {
  id: string;
  name: string;
  color: string;
}

export interface AnnotationItemLabelMenuProps {
  labels: LabelOption[];
  value: string;
  onChange: (labelId: string) => void;
  ariaLabel?: string;
}

export default function AnnotationItemLabelMenu({
  labels,
  value,
  onChange,
  ariaLabel = '切换标签',
}: AnnotationItemLabelMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const selectLabel = useCallback(
    (id: string) => {
      onChange(id);
      setOpen(false);
    },
    [onChange],
  );

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event: MouseEvent) => {
      if (wrapRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  if (labels.length === 0) return null;

  return (
    <div ref={wrapRef} className="annotation-right-label-more-wrap">
      <button
        type="button"
        className={`annotation-right-label-more-btn annotation-right-item-label-more-btn${
          open ? ' annotation-right-label-more-btn--open' : ''
        }`}
        title="更多标签"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <span className="codicon codicon-tag" aria-hidden />
      </button>
      {open && (
        <div
          className="annotation-right-label-more-menu"
          role="listbox"
          tabIndex={0}
          aria-label={ariaLabel}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {labels.map((lab) => {
            const active = lab.id === value;
            return (
              <button
                key={lab.id}
                type="button"
                role="option"
                aria-selected={active}
                className={`annotation-right-label-btn annotation-right-label-btn--menu${
                  active ? ' annotation-right-label-btn--picked' : ''
                }`}
                style={getLabelChipStyle(lab.color)}
                onClick={() => selectLabel(lab.id)}
              >
                {lab.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
