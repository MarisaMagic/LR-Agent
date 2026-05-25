import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import './AnnotationProjectMenuPortal.css';

const MENU_GAP = 4;
const MENU_MIN_WIDTH = 140;
const VIEWPORT_PADDING = 8;

interface AnnotationProjectMenuPortalProps {
  anchorEl: HTMLElement;
  onClose: () => void;
  onOpen: () => void;
  onEdit: () => void;
  onShowInFolder: () => void;
  onDelete: () => void;
}

interface MenuPosition {
  top: number;
  left: number;
  openUp: boolean;
}

function computeMenuPosition(
  anchorEl: HTMLElement,
  menuHeight: number,
): MenuPosition {
  const rect = anchorEl.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PADDING;
  const spaceAbove = rect.top - VIEWPORT_PADDING;
  const openUp = spaceBelow < menuHeight && spaceAbove > spaceBelow;

  const top = openUp
    ? Math.max(VIEWPORT_PADDING, rect.top - menuHeight - MENU_GAP)
    : Math.min(
        window.innerHeight - menuHeight - VIEWPORT_PADDING,
        rect.bottom + MENU_GAP,
      );

  const left = Math.min(
    Math.max(VIEWPORT_PADDING, rect.right - MENU_MIN_WIDTH),
    window.innerWidth - MENU_MIN_WIDTH - VIEWPORT_PADDING,
  );

  return { top, left, openUp };
}

export default function AnnotationProjectMenuPortal({
  anchorEl,
  onClose,
  onOpen,
  onEdit,
  onShowInFolder,
  onDelete,
}: AnnotationProjectMenuPortalProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<MenuPosition | null>(null);

  const updatePosition = useCallback(() => {
    const menuEl = menuRef.current;
    if (!menuEl) return;
    const menuHeight = menuEl.offsetHeight;
    setPosition(computeMenuPosition(anchorEl, menuHeight));
  }, [anchorEl]);

  useLayoutEffect(() => {
    updatePosition();
  }, [updatePosition]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (anchorEl.contains(target)) return;
      onClose();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    const onDismiss = () => onClose();

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onDismiss, true);
    window.addEventListener('resize', onDismiss);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onDismiss, true);
      window.removeEventListener('resize', onDismiss);
    };
  }, [anchorEl, onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className={`annotation-project-menu annotation-project-menu-portal${
        position?.openUp ? ' annotation-project-menu-open-up' : ''
      }`}
      role="menu"
      style={
        position
          ? {
              top: `${position.top}px`,
              left: `${position.left}px`,
            }
          : { visibility: 'hidden' }
      }
    >
      <button type="button" role="menuitem" onClick={onOpen}>
        打开
      </button>
      <button type="button" role="menuitem" onClick={onEdit}>
        编辑设置
      </button>
      <button type="button" role="menuitem" onClick={onShowInFolder}>
        在文件夹中显示
      </button>
      <button
        type="button"
        role="menuitem"
        className="danger"
        onClick={onDelete}
      >
        删除任务记录
      </button>
    </div>,
    document.body,
  );
}
