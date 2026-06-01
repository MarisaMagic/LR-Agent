import { KEYPOINT_TEMPLATES } from '../../types/keypointTemplate';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import './KeypointTemplateSelector.css';

export default function KeypointTemplateSelector() {
  const { activeTemplateId, setActiveTemplateId, activeTemplate } =
    useAnnotationWorkspace();

  return (
    <div className="keypoint-template-selector">
      <span className="keypoint-template-label">骨架模板</span>
      <select
        className="keypoint-template-select"
        value={activeTemplateId}
        aria-label="选择骨架模板"
        onChange={(e) => setActiveTemplateId(e.target.value)}
      >
        {KEYPOINT_TEMPLATES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} ({t.keypoints.length}点)
          </option>
        ))}
      </select>
      <span className="keypoint-template-hint" title={activeTemplate.description}>
        标签: {activeTemplate.defaultLabel}
      </span>
    </div>
  );
}

export function KeypointTemplateToolbarSlot() {
  return <KeypointTemplateSelector />;
}
