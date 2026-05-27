import { VscodeButton } from '@vscode-elements/react-elements';
import { useAnnotation } from '../../context/AnnotationContext';
import {
  useAnnotationWorkspace,
  type ImageCanvasTool,
} from '../../context/AnnotationWorkspaceContext';
import { getLabelChipStyle } from '../../utils/labelColor';
import './ImageAnnotationToolbar.css';

export interface ImageAnnotationToolbarProps {
  canvasReady?: boolean;
  imageNatural?: { w: number; h: number };
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomFit?: () => void;
}

export default function ImageAnnotationToolbar({
  canvasReady = false,
  imageNatural = { w: 0, h: 0 },
  onZoomIn,
  onZoomOut,
  onZoomFit,
}: ImageAnnotationToolbarProps) {
  const { activeProject } = useAnnotation();
  const { tool, setTool, activeLabelId, setActiveLabelId } =
    useAnnotationWorkspace();

  if (!activeProject) return null;

  const zoomDisabled =
    !canvasReady || imageNatural.w <= 0 || imageNatural.h <= 0;

  const setToolAndFocus = (next: ImageCanvasTool) => {
    setTool(next);
  };

  return (
    <div className="image-annotation-toolbar">
      <div
        className="image-annotation-tool-group"
        role="group"
        aria-label="画布缩放"
      >
        <VscodeButton
          secondary
          icon="zoom-out"
          disabled={zoomDisabled}
          title="缩小"
          aria-label="缩小"
          onClick={onZoomOut}
        />
        <VscodeButton
          secondary
          icon="zoom-in"
          disabled={zoomDisabled}
          title="放大"
          aria-label="放大"
          onClick={onZoomIn}
        />
        <VscodeButton
          secondary
          icon="screen-full"
          disabled={zoomDisabled}
          title="适应窗口"
          aria-label="适应窗口"
          onClick={onZoomFit}
        />
      </div>

      <div className="image-annotation-toolbar-divider" aria-hidden />

      <div
        className="image-annotation-tool-group"
        role="group"
        aria-label="画布工具"
      >
        <VscodeButton
          secondary
          className={`image-annotation-tool-btn${tool === 'draw' ? ' image-annotation-tool-btn--active' : ''}`}
          aria-pressed={tool === 'draw'}
          onClick={() => setToolAndFocus('draw')}
        >
          画框 (B)
        </VscodeButton>
        <VscodeButton
          secondary
          className={`image-annotation-tool-btn${tool === 'select' ? ' image-annotation-tool-btn--active' : ''}`}
          aria-pressed={tool === 'select'}
          onClick={() => setToolAndFocus('select')}
        >
          选择 (V)
        </VscodeButton>
      </div>
      <div className="image-annotation-toolbar-labels">
        <span className="image-annotation-toolbar-hint">绘制标签</span>
        {activeProject.labels.length === 0 ? (
          <span className="image-annotation-toolbar-empty">
            请先在任务中定义标签
          </span>
        ) : (
          <div className="image-annotation-toolbar-chips">
            {activeProject.labels.map((lab) => (
              <button
                key={lab.id}
                type="button"
                className={`image-annotation-toolbar-chip${lab.id === activeLabelId ? ' image-annotation-toolbar-chip--active' : ''}`}
                style={getLabelChipStyle(lab.color)}
                onClick={() => setActiveLabelId(lab.id)}
              >
                {lab.name}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
