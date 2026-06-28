import ActivityIcon from './ActivityIcon';
import type { RightPanel } from './ActivityBar';
import './RightPanelToolbar.css';

interface RightPanelToolbarProps {
  activePanel: RightPanel;
  annotationTabDisabled?: boolean;
  onAnnotationClick: () => void;
  onAgentClick: () => void;
}

export default function RightPanelToolbar({
  activePanel,
  annotationTabDisabled = false,
  onAnnotationClick,
  onAgentClick,
}: RightPanelToolbarProps) {
  return (
    <div className="right-panel-icon-toolbar" role="tablist">
      <div
        role="tab"
        aria-selected={activePanel === 'annotation'}
        aria-disabled={annotationTabDisabled || undefined}
        className={`right-panel-icon-tab${annotationTabDisabled ? ' right-panel-icon-tab--disabled' : ''}`}
      >
        <ActivityIcon
          name="tag"
          label={
            annotationTabDisabled
              ? '标注列表（编辑器模式下不可用）'
              : '标注列表'
          }
          active={activePanel === 'annotation' && !annotationTabDisabled}
          disabled={annotationTabDisabled}
          onClick={onAnnotationClick}
        />
      </div>
      <div
        role="tab"
        aria-selected={activePanel === 'agent'}
        className="right-panel-icon-tab"
      >
        <ActivityIcon
          name="comment-discussion"
          label="AI Agent"
          active={activePanel === 'agent'}
          onClick={onAgentClick}
        />
      </div>
    </div>
  );
}
