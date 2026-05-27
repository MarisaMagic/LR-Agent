import {
  VscodeButton,
  VscodeIcon,
  VscodeLabel,
} from '@vscode-elements/react-elements';
import type { CSSProperties, ReactElement } from 'react';
import {
  type AnnotationProject,
  getAnnotationTypeLabel,
  TASK_TYPE_CONFIG,
} from '../../types/annotation';
import type { BboxAnnotation } from '../../types/annotationDocument';
import { useAnnotation } from '../../context/AnnotationContext';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import { getLabelChipStyle } from '../../utils/labelColor';
import VscodeScrollHost from '../VscodeScrollHost';
import './AnnotationRightPanel.css';

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function BboxAnnotationRow({
  index,
  ann,
  labels,
  selected,
  onSelect,
  onChangeLabel,
  onDelete,
}: {
  index: number;
  ann: BboxAnnotation;
  labels: { id: string; name: string; color: string }[];
  selected: boolean;
  onSelect: () => void;
  onChangeLabel: (labelId: string) => void;
  onDelete: () => void;
}) {
  const activeLabel = labels.find((l) => l.id === ann.labelId);
  const unknown = !activeLabel;
  const accentColor = activeLabel?.color;

  return (
    <>
      <button
        type="button"
        className={`annotation-right-summary-btn${selected ? ' annotation-right-summary-btn--selected' : ''}`}
        aria-pressed={selected}
        aria-label={`选择标注 ${index + 1}`}
        onClick={onSelect}
      >
        <span className="annotation-right-item-main">
          <span className="annotation-right-index">#{index + 1}</span>
          {activeLabel ? (
            <span
              className="annotation-right-chip"
              style={getLabelChipStyle(activeLabel.color)}
            >
              {activeLabel.name}
            </span>
          ) : (
            <span className="annotation-right-unknown">未知标签</span>
          )}
          <span className="annotation-right-coords">
            {pct(ann.x)},{pct(ann.y)} · {pct(ann.width)}×{pct(ann.height)}
          </span>
        </span>
      </button>
      <div className="annotation-right-item-actions">
        <select
          className="annotation-right-select"
          aria-label={`标注 #${index + 1} 类别`}
          value={unknown ? '' : ann.labelId}
          onChange={(ev) => onChangeLabel(ev.target.value)}
        >
          {unknown && <option value="">选择标签…</option>}
          {labels.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <VscodeButton
          appearance="icon"
          className="annotation-right-delete"
          aria-label={`删除标注 #${index + 1}`}
          onClick={onDelete}
        >
          <VscodeIcon name="trash" />
        </VscodeButton>
      </div>
    </>
  );
}

function renderBboxWorkspaceBody(
  project: AnnotationProject,
  workspaceEnabled: boolean,
  loadError: string | null,
  bboxAnnotations: BboxAnnotation[],
  selectedAnnotationId: string | null,
  selectAnnotation: (id: string | null) => void,
  updateAnnotationLabel: (annotationId: string, labelId: string) => void,
  deleteAnnotation: (annotationId: string) => void,
): ReactElement {
  if (!workspaceEnabled) {
    return (
      <p className="annotation-right-muted">
        请在资源管理器中选择一张项目内的图片。
      </p>
    );
  }
  if (loadError) {
    return <p className="annotation-right-error">{loadError}</p>;
  }
  if (bboxAnnotations.length === 0) {
    const hint =
      project.labels.length === 0
        ? '添加标签后即可在画布上拖拽绘制矩形。'
        : '在画布空白处拖拽以新建矩形标注。';
    return <p className="annotation-right-muted">{hint}</p>;
  }
  return (
    <VscodeScrollHost
      className="annotation-right-list-host"
      scrollableClassName="annotation-right-list-scroll"
    >
      <div className="annotation-right-items">
        {bboxAnnotations.map((ann, idx) => {
          const selected = ann.id === selectedAnnotationId;
          const activeLabel = project.labels.find((l) => l.id === ann.labelId);
          const accentColor = activeLabel?.color;
          return (
            <div
              key={ann.id}
              className={`annotation-right-item${selected ? ' annotation-right-item--active' : ''}`}
              style={
                selected && accentColor
                  ? ({ '--annotation-accent': accentColor } as CSSProperties)
                  : undefined
              }
            >
              <BboxAnnotationRow
                index={idx}
                ann={ann}
                labels={project.labels}
                selected={selected}
                onSelect={() => selectAnnotation(ann.id)}
                onChangeLabel={(lid) => updateAnnotationLabel(ann.id, lid)}
                onDelete={() => deleteAnnotation(ann.id)}
              />
            </div>
          );
        })}
      </div>
    </VscodeScrollHost>
  );
}

export default function AnnotationRightPanel() {
  const { activeProject } = useAnnotation();
  const {
    annotationPanelVisible,
    workspaceEnabled,
    projectRootMatched,
    bboxAnnotations,
    dirty,
    saving,
    loadError,
    sourceStale,
    selectedAnnotationId,
    selectAnnotation,
    activeLabelId,
    setActiveLabelId,
    deleteAnnotation,
    updateAnnotationLabel,
    saveNow,
  } = useAnnotationWorkspace();

  if (!annotationPanelVisible || !activeProject) {
    return null;
  }

  if (!projectRootMatched) {
    return (
      <div className="annotation-right-root">
        <VscodeScrollHost
          className="annotation-right-scroll-host"
          scrollableClassName="annotation-right-scrollable"
        >
          <div className="annotation-right-placeholder">
            <VscodeIcon name="warning" size={36} />
            <VscodeLabel>工作区文件夹与标注任务目录不一致。</VscodeLabel>
            <p className="annotation-right-placeholder-hint">
              请先通过左侧「标注任务」打开该项目，以使资源管理器根目录指向任务文件夹。
            </p>
          </div>
        </VscodeScrollHost>
      </div>
    );
  }

  const isImageBbox =
    activeProject.modality === 'image' &&
    activeProject.annotationType === 'bbox';

  if (!isImageBbox) {
    const modalityLabel = TASK_TYPE_CONFIG[activeProject.modality].label;
    const kindLabel = getAnnotationTypeLabel(
      activeProject.modality,
      activeProject.annotationType,
    );
    return (
      <div className="annotation-right-root">
        <VscodeScrollHost
          className="annotation-right-scroll-host"
          scrollableClassName="annotation-right-scrollable"
        >
          <div className="annotation-right-placeholder">
            <VscodeIcon name="tag" size={36} />
            <VscodeLabel>
              {modalityLabel} · {kindLabel}
            </VscodeLabel>
            <p className="annotation-right-placeholder-hint">
              画布与列表标注即将支持当前类型。
            </p>
          </div>
        </VscodeScrollHost>
      </div>
    );
  }

  let statusMessage = '已保存';
  if (saving) statusMessage = '保存中…';
  else if (dirty) statusMessage = '未保存更改';

  return (
    <div className="annotation-right-root">
      <header className="annotation-right-header">
        <div className="annotation-right-header-main">
          <span className="annotation-right-status">{statusMessage}</span>
          {sourceStale && (
            <span
              className="annotation-right-warning"
              title="源文件可能与上次保存时不同"
            >
              文件已变更
            </span>
          )}
        </div>
        <VscodeButton
          secondary
          onClick={() => {
            saveNow().catch(() => undefined);
          }}
          disabled={!dirty && !saving}
        >
          立即保存
        </VscodeButton>
      </header>

      <section className="annotation-right-section">
        <h4 className="annotation-right-heading">绘制用标签</h4>
        {activeProject.labels.length === 0 ? (
          <p className="annotation-right-muted">
            未定义标签。请在「标注任务」中编辑项目并添加类别。
          </p>
        ) : (
          <div className="annotation-right-chip-row">
            {activeProject.labels.map((lab) => {
              const picked = lab.id === activeLabelId;
              return (
                <button
                  key={lab.id}
                  type="button"
                  className={`annotation-right-label-btn${picked ? ' annotation-right-label-btn--picked' : ''}`}
                  style={getLabelChipStyle(lab.color)}
                  onClick={() => setActiveLabelId(lab.id)}
                >
                  {lab.name}
                </button>
              );
            })}
          </div>
        )}
      </section>

      <section className="annotation-right-section annotation-right-section--grow">
        <h4 className="annotation-right-heading">当前图片矩形框</h4>
        {renderBboxWorkspaceBody(
          activeProject,
          workspaceEnabled,
          loadError,
          bboxAnnotations,
          selectedAnnotationId,
          selectAnnotation,
          updateAnnotationLabel,
          deleteAnnotation,
        )}
      </section>
    </div>
  );
}
