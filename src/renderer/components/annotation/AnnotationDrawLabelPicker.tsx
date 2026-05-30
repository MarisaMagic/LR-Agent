import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LabelDefinition } from '../../types/annotation';
import { getLabelChipStyle } from '../../utils/labelColor';
import {
  splitLabelsForToolbar,
  type LabelUsageMap,
} from '../../utils/annotationLabelUsage';
import './AnnotationDrawLabelPicker.css';

type PickerVariant = 'toolbar' | 'panel';

const VARIANT_CLASSES: Record<
  PickerVariant,
  {
    chip: string;
    chipActive: string;
    chipMenu: string;
    moreWrap: string;
    moreBtn: string;
    moreBtnOpen: string;
    moreMenu: string;
  }
> = {
  toolbar: {
    chip: 'image-annotation-toolbar-chip',
    chipActive: 'image-annotation-toolbar-chip--active',
    chipMenu: 'image-annotation-toolbar-chip--menu',
    moreWrap: 'image-annotation-toolbar-more-wrap',
    moreBtn: 'image-annotation-toolbar-more-btn',
    moreBtnOpen: 'image-annotation-toolbar-more-btn--open',
    moreMenu: 'image-annotation-toolbar-more-menu',
  },
  panel: {
    chip: 'annotation-right-label-btn',
    chipActive: 'annotation-right-label-btn--picked',
    chipMenu: 'annotation-right-label-btn--menu',
    moreWrap: 'annotation-right-label-more-wrap',
    moreBtn: 'annotation-right-label-more-btn',
    moreBtnOpen: 'annotation-right-label-more-btn--open',
    moreMenu: 'annotation-right-label-more-menu',
  },
};

export interface AnnotationDrawLabelPickerProps {
  labels: LabelDefinition[];
  labelUsage: LabelUsageMap;
  activeLabelId: string | null;
  onSelect: (labelId: string) => void;
  variant: PickerVariant;
  className?: string;
}

export default function AnnotationDrawLabelPicker({
  labels,
  labelUsage,
  activeLabelId,
  onSelect,
  variant,
  className = '',
}: AnnotationDrawLabelPickerProps) {
  const classes = VARIANT_CLASSES[variant];
  const [moreOpen, setMoreOpen] = useState(false);
  const moreWrapRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  const { pinned, overflow } = useMemo(
    () => splitLabelsForToolbar(labels, labelUsage, activeLabelId),
    [labels, labelUsage, activeLabelId],
  );

  const selectLabel = useCallback(
    (id: string) => {
      onSelect(id);
      setMoreOpen(false);
    },
    [onSelect],
  );

  useEffect(() => {
    if (!moreOpen) return undefined;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        moreWrapRef.current?.contains(target) ||
        moreButtonRef.current?.contains(target)
      ) {
        return;
      }
      setMoreOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [moreOpen]);

  return (
    <div className={className || undefined}>
      {pinned.map((lab) => {
        const active = lab.id === activeLabelId;
        return (
          <button
            key={lab.id}
            type="button"
            className={`${classes.chip}${active ? ` ${classes.chipActive}` : ''}`}
            style={getLabelChipStyle(lab.color)}
            onClick={() => selectLabel(lab.id)}
          >
            {lab.name}
          </button>
        );
      })}
      {overflow.length > 0 && (
        <div ref={moreWrapRef} className={classes.moreWrap}>
          <button
            ref={moreButtonRef}
            type="button"
            className={`${classes.moreBtn}${moreOpen ? ` ${classes.moreBtnOpen}` : ''}`}
            title="更多标签"
            aria-label="更多标签"
            aria-expanded={moreOpen}
            aria-haspopup="listbox"
            onClick={() => setMoreOpen((open) => !open)}
          >
            <span className="codicon codicon-tag" aria-hidden />
          </button>
          {moreOpen && (
            <div
              className={classes.moreMenu}
              role="listbox"
              aria-label="更多标签"
            >
              {overflow.map((lab) => {
                const active = lab.id === activeLabelId;
                return (
                  <button
                    key={lab.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={`${classes.chip} ${classes.chipMenu}${active ? ` ${classes.chipActive}` : ''}`}
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
      )}
    </div>
  );
}
