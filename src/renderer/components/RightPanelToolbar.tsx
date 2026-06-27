import ActivityIcon from './ActivityIcon';
import type { RightPanel } from './ActivityBar';
import './RightPanelToolbar.css';

interface RightPanelToolbarProps {
  activePanel: RightPanel;
  onAnnotationClick: () => void;
  onAgentClick: () => void;
}

export default function RightPanelToolbar({
  activePanel,
  onAnnotationClick,
  onAgentClick,
}: RightPanelToolbarProps) {
  return (
    <div className="right-panel-icon-toolbar" role="tablist">
      <div
        role="tab"
        aria-selected={activePanel === 'annotation'}
        className="right-panel-icon-tab"
      >
        <ActivityIcon
          name="tag"
          label="标注列表"
          active={activePanel === 'annotation'}
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
