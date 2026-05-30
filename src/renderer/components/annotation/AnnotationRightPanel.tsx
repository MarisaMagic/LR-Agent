import {
  VscodeButton,
  VscodeIcon,
  VscodeLabel,
} from '@vscode-elements/react-elements';
import type { CSSProperties, KeyboardEventHandler, ReactElement } from 'react';
import {
  type AnnotationProject,
  getAnnotationTypeLabel,
  TASK_TYPE_CONFIG,
} from '../../types/annotation';
import type {
  BboxAnnotation,
  PolygonAnnotation,
  RotatedBboxAnnotation,
} from '../../types/annotationDocument';
import { useAnnotation } from '../../context/AnnotationContext';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import {
  AnnotationMotionList,
  AnnotationMotionListItem,
} from '../../motion/AnnotationListMotion';
import { getLabelChipStyle, hexToRgba } from '../../utils/labelColor';
import VscodeScrollHost from '../VscodeScrollHost';
import AnnotationDrawLabelPicker from './AnnotationDrawLabelPicker';
import AnnotationItemLabelMenu from './AnnotationItemLabelMenu';
import './AnnotationRightPanel.css';

function getAnnotationItemStyle(accentColor?: string): CSSProperties {
  if (!accentColor) {
    return {
      '--annotation-accent': 'var(--vscode-descriptionForeground, #858585)',
      '--annotation-accent-bg': 'rgba(255, 255, 255, 0.03)',
      '--annotation-accent-bg-hover': 'rgba(255, 255, 255, 0.06)',
      '--annotation-accent-bg-active':
        'var(--vscode-list-activeSelectionBackground, rgba(0, 127, 212, 0.12))',
      '--annotation-accent-bar': 'rgba(255, 255, 255, 0.18)',
    } as CSSProperties;
  }

  return {
    '--annotation-accent': accentColor,
    '--annotation-accent-bg': hexToRgba(accentColor, 0.08),
    '--annotation-accent-bg-hover': hexToRgba(accentColor, 0.12),
    '--annotation-accent-bg-active': hexToRgba(accentColor, 0.2),
    '--annotation-accent-bar': hexToRgba(accentColor, 0.55),
  } as CSSProperties;
}

function handleAnnotationItemKeyDown(
  onSelect: () => void,
): KeyboardEventHandler<HTMLDivElement> {
  return (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
    }
  };
}

function AnnotationListRow({
  index,
  labelId,
  labels,
  onChangeLabel,
  onDelete,
  suffix,
}: {
  index: number;
  labelId: string;
  labels: { id: string; name: string; color: string }[];
  onChangeLabel: (labelId: string) => void;
  onDelete: () => void;
  suffix?: string;
}) {
  const activeLabel = labels.find((l) => l.id === labelId);

  return (
    <div className="annotation-right-item-row">
      <div className="annotation-right-item-label-group">
        <span className="annotation-right-item-main">
          <span className="annotation-right-index">#{index + 1}</span>
          {suffix ? (
            <span className="annotation-right-suffix">{suffix}</span>
          ) : null}
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
        </span>

        <AnnotationItemLabelMenu
          labels={labels}
          value={labelId}
          onChange={onChangeLabel}
          ariaLabel={`标注 #${index + 1} 切换类别`}
        />
      </div>

      <VscodeButton
        iconOnly
        className="annotation-right-delete"
        aria-label={`删除标注 #${index + 1}`}
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
      >
        <VscodeIcon name="trash" />
      </VscodeButton>
    </div>
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

  const emptyHint =
    project.labels.length === 0
      ? '添加标签后即可在画布上拖拽绘制矩形。'
      : '在画布空白处拖拽以新建矩形标注。';

  return (
    <VscodeScrollHost
      className="annotation-right-list-host"
      scrollableClassName="annotation-right-list-scroll"
    >
      {bboxAnnotations.length === 0 ? (
        <p className="annotation-right-muted">{emptyHint}</p>
      ) : (
        <AnnotationMotionList className="annotation-right-items">
          {bboxAnnotations.map((ann, idx) => {
            const selected = ann.id === selectedAnnotationId;
            const activeLabel = project.labels.find((l) => l.id === ann.labelId);
            const selectItem = () => selectAnnotation(ann.id);
            return (
              <AnnotationMotionListItem
                key={ann.id}
                layoutKey={ann.id}
                className={`annotation-right-item${selected ? ' annotation-right-item--active' : ''}`}
                style={getAnnotationItemStyle(activeLabel?.color)}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`选择标注 ${idx + 1}`}
                onClick={selectItem}
                onKeyDown={handleAnnotationItemKeyDown(selectItem)}
              >
                <AnnotationListRow
                  index={idx}
                  labelId={ann.labelId}
                  labels={project.labels}
                  onChangeLabel={(lid) => updateAnnotationLabel(ann.id, lid)}
                  onDelete={() => deleteAnnotation(ann.id)}
                />
              </AnnotationMotionListItem>
            );
          })}
        </AnnotationMotionList>
      )}
    </VscodeScrollHost>
  );
}

function renderRotatedBboxWorkspaceBody(
  project: AnnotationProject,
  workspaceEnabled: boolean,
  loadError: string | null,
  rotatedBboxAnnotations: RotatedBboxAnnotation[],
  selectedAnnotationId: string | null,
  selectAnnotation: (id: string | null) => void,
  setTool: (tool: 'select') => void,
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

  const emptyHint =
    project.labels.length === 0
      ? '添加标签后即可在画布上拖拽绘制旋转矩形。'
      : '在画布空白处拖拽以新建旋转矩形；选择模式下可拖动旋转控制点调整角度。';

  return (
    <VscodeScrollHost
      className="annotation-right-list-host"
      scrollableClassName="annotation-right-list-scroll"
    >
      {rotatedBboxAnnotations.length === 0 ? (
        <p className="annotation-right-muted">{emptyHint}</p>
      ) : (
        <AnnotationMotionList className="annotation-right-items">
          {rotatedBboxAnnotations.map((ann, idx) => {
            const selected = ann.id === selectedAnnotationId;
            const activeLabel = project.labels.find((l) => l.id === ann.labelId);
            const selectItem = () => {
              setTool('select');
              selectAnnotation(ann.id);
            };
            return (
              <AnnotationMotionListItem
                key={ann.id}
                layoutKey={ann.id}
                className={`annotation-right-item${selected ? ' annotation-right-item--active' : ''}`}
                style={getAnnotationItemStyle(activeLabel?.color)}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`选择标注 ${idx + 1}`}
                onClick={selectItem}
                onKeyDown={handleAnnotationItemKeyDown(selectItem)}
              >
                <AnnotationListRow
                  index={idx}
                  labelId={ann.labelId}
                  labels={project.labels}
                  onChangeLabel={(lid) => updateAnnotationLabel(ann.id, lid)}
                  onDelete={() => deleteAnnotation(ann.id)}
                  suffix={`${Math.round(ann.angle)}°`}
                />
              </AnnotationMotionListItem>
            );
          })}
        </AnnotationMotionList>
      )}
    </VscodeScrollHost>
  );
}

function renderPolygonWorkspaceBody(
  project: AnnotationProject,
  workspaceEnabled: boolean,
  loadError: string | null,
  polygonAnnotations: PolygonAnnotation[],
  selectedAnnotationId: string | null,
  selectAnnotation: (id: string | null) => void,
  setTool: (tool: 'select') => void,
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

  const emptyHint =
    project.labels.length === 0
      ? '添加标签后即可在画布上绘制多边形。'
      : '使用「多边形」工具在画布上点击描点，靠近起点或按 Enter 闭合。';

  return (
    <VscodeScrollHost
      className="annotation-right-list-host"
      scrollableClassName="annotation-right-list-scroll"
    >
      {polygonAnnotations.length === 0 ? (
        <p className="annotation-right-muted">{emptyHint}</p>
      ) : (
        <AnnotationMotionList className="annotation-right-items">
          {polygonAnnotations.map((ann, idx) => {
            const selected = ann.id === selectedAnnotationId;
            const activeLabel = project.labels.find((l) => l.id === ann.labelId);
            const selectItem = () => {
              setTool('select');
              selectAnnotation(ann.id);
            };
            return (
              <AnnotationMotionListItem
                key={ann.id}
                layoutKey={ann.id}
                className={`annotation-right-item${selected ? ' annotation-right-item--active' : ''}`}
                style={getAnnotationItemStyle(activeLabel?.color)}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`选择标注 ${idx + 1}`}
                onClick={selectItem}
                onKeyDown={handleAnnotationItemKeyDown(selectItem)}
              >
                <AnnotationListRow
                  index={idx}
                  labelId={ann.labelId}
                  labels={project.labels}
                  onChangeLabel={(lid) => updateAnnotationLabel(ann.id, lid)}
                  onDelete={() => deleteAnnotation(ann.id)}
                />
              </AnnotationMotionListItem>
            );
          })}
        </AnnotationMotionList>
      )}
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
    rotatedBboxAnnotations,
    polygonAnnotations,
    dirty,
    saving,
    loadError,
    sourceStale,
    selectedAnnotationId,
    selectAnnotation,
    setTool,
    activeLabelId,
    setActiveLabelId,
    labelUsage,
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
  const isImagePolygon =
    activeProject.modality === 'image' &&
    activeProject.annotationType === 'polygon';
  const isImageRotatedBbox =
    activeProject.modality === 'image' &&
    activeProject.annotationType === 'rotated_bbox';
  const isImageAnnotatable =
    isImageBbox || isImagePolygon || isImageRotatedBbox;

  if (!isImageAnnotatable) {
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
          <AnnotationDrawLabelPicker
            className="annotation-right-chip-row"
            variant="panel"
            labels={activeProject.labels}
            labelUsage={labelUsage}
            activeLabelId={activeLabelId}
            onSelect={setActiveLabelId}
          />
        )}
      </section>

      <section className="annotation-right-section annotation-right-section--grow">
        <h4 className="annotation-right-heading">
          {isImagePolygon
            ? '当前图片多边形'
            : isImageRotatedBbox
              ? '当前图片旋转矩形框'
              : '当前图片矩形框'}
        </h4>
        {isImagePolygon
          ? renderPolygonWorkspaceBody(
              activeProject,
              workspaceEnabled,
              loadError,
              polygonAnnotations,
              selectedAnnotationId,
              selectAnnotation,
              setTool,
              updateAnnotationLabel,
              deleteAnnotation,
            )
          : isImageRotatedBbox
            ? renderRotatedBboxWorkspaceBody(
                activeProject,
                workspaceEnabled,
                loadError,
                rotatedBboxAnnotations,
                selectedAnnotationId,
                selectAnnotation,
                setTool,
                updateAnnotationLabel,
                deleteAnnotation,
              )
            : renderBboxWorkspaceBody(
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
