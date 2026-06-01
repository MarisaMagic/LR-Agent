import FloatingActionMenuPortal from '../../motion/FloatingActionMenuPortal';
import './AnnotationProjectMenuPortal.css';

interface AnnotationProjectMenuPortalProps {
  open: boolean;
  anchorEl: HTMLElement;
  onClose: () => void;
  onExitComplete?: () => void;
  onOpen: () => void;
  onEdit: () => void;
  onExport: () => void;
  onShowInFolder: () => void;
  onDelete: () => void;
}

export default function AnnotationProjectMenuPortal({
  open,
  anchorEl,
  onClose,
  onExitComplete,
  onOpen,
  onEdit,
  onExport,
  onShowInFolder,
  onDelete,
}: AnnotationProjectMenuPortalProps) {
  return (
    <FloatingActionMenuPortal
      open={open}
      anchorEl={anchorEl}
      onClose={onClose}
      onExitComplete={onExitComplete}
      className="annotation-project-menu annotation-project-menu-portal"
      openUpClassName="annotation-project-menu-open-up"
    >
      <button type="button" role="menuitem" onClick={onOpen}>
        打开
      </button>
      <button type="button" role="menuitem" onClick={onEdit}>
        编辑设置
      </button>
      <button type="button" role="menuitem" onClick={onExport}>
        导出标注…
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
    </FloatingActionMenuPortal>
  );
}
