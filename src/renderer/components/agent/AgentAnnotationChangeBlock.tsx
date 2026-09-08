import { useCallback, useMemo, useState, type KeyboardEvent } from 'react';
import { VscodeIcon } from '@vscode-elements/react-elements';
import type { AnnotationBatchProposal } from '../../../shared/annotationAgentTypes';
import type { Modality } from '../../types/annotation';
import type { AnnotationInstance } from '../../types/annotationDocument';
import FileTypeIcon from '../FileTypeIcon';
import OverlayVerticalScrollArea from '../OverlayVerticalScrollArea';
import { basename } from '../../types/file';
import { useAnnotation } from '../../context/AnnotationContext';
import { useApp } from '../../context/AppContext';
import { useWorkMode } from '../../context/WorkModeContext';
import { useAnnotationWorkspace } from '../../context/AnnotationWorkspaceContext';
import {
  summarizeAnnotationChange,
  formatAnnotationPreviewText,
  buildLabelMap,
} from '../../services/agentProposalApply';
import { proposalAnchorId } from '../../utils/fileDiffStats';
import {
  getOpenActionLabels,
  resolveAnnotationOpenTarget,
} from './agentAnnotationNavigation';
import { requestOpenAnnotationPreview } from './agentAnnotationPreview';
import './AgentAnnotationChangeBlock.css';

/** 折叠预览时可见的变更行数（与 file block ~9 行 diff 视觉高度对齐） */
const INITIAL_VISIBLE_ITEMS = 4;
const LIST_ITEM_HEIGHT_PX = 28;
const LIST_SCROLL_MAX_ITEMS = 12;
const PREVIEW_CARD_MAX_HEIGHT_PX = 24 * 6;

interface AgentAnnotationChangeBlockProps {
  messageId: string;
  blockIndex: number;
  proposal: AnnotationBatchProposal;
  status: 'pending' | 'applied' | 'dismissed';
}

interface ChangeListItem {
  key: string;
  path: string;
  absolutePath: string;
  summary: string;
  annotations?: AnnotationInstance[];
}

const KIND_LABELS: Record<string, string> = {
  bbox: 'bbox',
  rotated_bbox: 'rotated_bbox',
  polygon: 'polygon',
  pose: 'pose',
  point: 'point',
  caption: 'caption',
  classification: '分类',
  span_ner: 'NER',
  text_classification: '文本分类',
  instruction: '指令',
  cot: 'CoT',
  conversation: '对话',
  preference: '偏好',
};

function handleCardKeyDown(
  event: KeyboardEvent<HTMLElement>,
  onOpen: () => void,
): void {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    onOpen();
  }
}

function AnnotationPreviewCard({
  ann,
  labelMap,
  index,
  openLabel,
  onOpen,
}: {
  ann: AnnotationInstance;
  labelMap: Map<string, string>;
  index: number;
  openLabel: string;
  onOpen: (ann: AnnotationInstance) => void;
}) {
  const previewText = formatAnnotationPreviewText(ann, labelMap);
  const kindLabel = KIND_LABELS[ann.kind] ?? ann.kind;

  return (
    <div
      className="agent-annotation-change-block__preview-card"
      role="button"
      tabIndex={0}
      aria-label={`${openLabel}：${kindLabel} #${index + 1}`}
      onClick={() => onOpen(ann)}
      onKeyDown={(event) => handleCardKeyDown(event, () => onOpen(ann))}
    >
      <span className="agent-annotation-change-block__preview-index">
        #{index + 1}
      </span>
      <span className="agent-annotation-change-block__preview-kind">
        {kindLabel}
      </span>
      <span
        className="agent-annotation-change-block__preview-text"
        title={previewText}
      >
        {previewText || '(空)'}
      </span>
      <span className="agent-annotation-change-block__preview-open">
        {openLabel}
      </span>
    </div>
  );
}

function AnnotationPreviewCards({
  annotations,
  labelMap,
  openLabel,
  onOpenAnnotation,
}: {
  annotations: AnnotationInstance[];
  labelMap: Map<string, string>;
  openLabel: string;
  onOpenAnnotation: (ann: AnnotationInstance) => void;
}) {
  if (annotations.length === 0) {
    return (
      <div className="agent-annotation-change-block__preview-area">
        <div className="agent-annotation-change-block__preview-empty">
          无标注数据
        </div>
      </div>
    );
  }

  return (
    <div className="agent-annotation-change-block__preview-area">
      <OverlayVerticalScrollArea
        enabled
        maxHeight={`${PREVIEW_CARD_MAX_HEIGHT_PX}px`}
        disabledContentClassName="agent-annotation-change-block__preview-cards"
        contentClassName="agent-annotation-change-block__preview-cards"
        observeKey={annotations.length}
      >
        {annotations.map((ann, idx) => (
          <AnnotationPreviewCard
            key={ann.id ?? idx}
            ann={ann}
            labelMap={labelMap}
            index={idx}
            openLabel={openLabel}
            onOpen={(annotation) => onOpenAnnotation(annotation)}
          />
        ))}
      </OverlayVerticalScrollArea>
    </div>
  );
}

function AnnotationChangeListItems({
  items,
  expandedKeys,
  modality,
  onToggleExpand,
  onOpenFile,
  onOpenAnnotation,
  labelMap,
}: {
  items: ChangeListItem[];
  expandedKeys: Set<string>;
  modality: Modality | undefined;
  onToggleExpand: (key: string) => void;
  onOpenFile: (relativePath: string, absolutePath: string) => void;
  onOpenAnnotation: (
    relativePath: string,
    absolutePath: string,
    annotation: AnnotationInstance,
  ) => void;
  labelMap: Map<string, string>;
}) {
  return (
    <ul className="agent-annotation-change-block__list">
      {items.map((item) => {
        const isExpanded = expandedKeys.has(item.key);
        const hasAnnotations =
          item.annotations != null && item.annotations.length > 0;
        const openLabels = getOpenActionLabels(modality, item.path);

        return (
          <li key={item.key}>
            <div
              className={`agent-annotation-change-block__item-row${
                isExpanded
                  ? ' agent-annotation-change-block__item-row--expanded'
                  : ''
              } agent-annotation-change-block__item-row--clickable`}
            >
              <button
                type="button"
                className="agent-annotation-change-block__item-chevron"
                aria-label={isExpanded ? '折叠预览' : '展开预览'}
                title={isExpanded ? '折叠' : '展开'}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleExpand(item.key);
                }}
              >
                <VscodeIcon
                  name={isExpanded ? 'chevron-down' : 'chevron-right'}
                  size={14}
                />
              </button>
              <button
                type="button"
                className="agent-annotation-change-block__item"
                aria-label={openLabels.ariaLabel}
                title={openLabels.ariaLabel}
                onClick={() => onOpenFile(item.path, item.absolutePath)}
              >
                <FileTypeIcon path={item.path} size={14} />
                <span
                  className="agent-annotation-change-block__path"
                  title={item.path}
                >
                  {basename(item.path)}
                </span>
                <span className="agent-annotation-change-block__summary">
                  {item.summary}
                </span>
              </button>
            </div>
            {isExpanded && hasAnnotations ? (
              <AnnotationPreviewCards
                annotations={item.annotations!}
                labelMap={labelMap}
                openLabel={openLabels.button}
                onOpenAnnotation={(annotation) =>
                  onOpenAnnotation(item.path, item.absolutePath, annotation)
                }
              />
            ) : null}
            {isExpanded && !hasAnnotations ? (
              <div className="agent-annotation-change-block__preview-area">
                <div className="agent-annotation-change-block__preview-empty">
                  无标注数据
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export default function AgentAnnotationChangeBlock({
  messageId,
  blockIndex,
  proposal,
  status,
}: AgentAnnotationChangeBlockProps) {
  const { activeProject } = useAnnotation();
  const { rootPath, openFileInEditor } = useApp();
  const { setWorkMode } = useWorkMode();
  const {
    enterAgentPreview,
    clearAgentPreview,
    schedulePendingAgentNavigation,
    applyImmediateAnnotationPreview,
    relativeFilePath,
    loadSyntheticAnnotationForView,
    selectAnnotation,
    setTool,
  } = useAnnotationWorkspace();
  const [showFullList, setShowFullList] = useState(false);
  const [expandedItems, setExpandedItems] = useState<Set<string>>(new Set());
  const anchorId = proposalAnchorId(messageId, blockIndex);
  const modality = activeProject?.modality;

  const labelMap = useMemo(
    () => buildLabelMap(activeProject?.labels ?? []),
    [activeProject?.labels],
  );

  const fileCount = useMemo(
    () => new Set(proposal.changes.map((c) => c.relativePath)).size,
    [proposal.changes],
  );

  const items = useMemo(
    () =>
      proposal.changes.map((change) => ({
        key: `${change.relativePath}-${change.operation}`,
        path: change.relativePath,
        absolutePath: change.absolutePath,
        summary: summarizeAnnotationChange(change),
        annotations: change.annotations,
      })),
    [proposal.changes],
  );

  const canExpandList = items.length > INITIAL_VISIBLE_ITEMS;
  const listScrollable = showFullList || !canExpandList;

  const handleToggleExpand = useCallback((key: string) => {
    setExpandedItems((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleOpenInAnnotation = useCallback(
    (relativePath: string, absolutePath: string) => {
      const target = resolveAnnotationOpenTarget(
        relativePath,
        absolutePath,
        activeProject ?? null,
        rootPath,
      );
      if (!target) return;

      clearAgentPreview();
      setWorkMode('annotation', { silent: true });
      if (target.kind === 'file') {
        openFileInEditor(target.absolutePath);
      }
    },
    [activeProject, clearAgentPreview, openFileInEditor, rootPath, setWorkMode],
  );

  const handleOpenAnnotationPreview = useCallback(
    (
      relativePath: string,
      absolutePath: string,
      annotation: AnnotationInstance,
    ) => {
      if (!annotation.id) return;
      requestOpenAnnotationPreview(
        {
          relativePath,
          absolutePath,
          annotationId: annotation.id,
          status,
          proposal,
          proposalAnchorId: anchorId,
        },
        {
          activeProject: activeProject ?? null,
          rootPath,
          workspaceRelativePath: relativeFilePath,
          setWorkMode,
          openFileInEditor,
          schedulePendingAgentNavigation,
          applyImmediateAnnotationPreview,
          enterAgentPreview,
          selectAnnotation,
          setTool,
          loadSyntheticAnnotationForView,
        },
      );
    },
    [
      activeProject,
      anchorId,
      applyImmediateAnnotationPreview,
      enterAgentPreview,
      loadSyntheticAnnotationForView,
      openFileInEditor,
      proposal,
      relativeFilePath,
      rootPath,
      schedulePendingAgentNavigation,
      selectAnnotation,
      setTool,
      setWorkMode,
      status,
    ],
  );

  const title =
    status === 'applied'
      ? `已应用标注变更（${fileCount} 个文件）`
      : `标注变更（${fileCount} 个文件）`;

  const listContent = (
    <AnnotationChangeListItems
      items={items}
      expandedKeys={expandedItems}
      modality={modality}
      onToggleExpand={handleToggleExpand}
      onOpenFile={handleOpenInAnnotation}
      onOpenAnnotation={handleOpenAnnotationPreview}
      labelMap={labelMap}
    />
  );

  return (
    <div
      className={`agent-annotation-change-block${status === 'applied' ? ' agent-annotation-change-block--applied' : ''}`}
      data-proposal-id={anchorId}
    >
      <div className="agent-annotation-change-block__header">
        <span className="agent-annotation-change-block__title">{title}</span>
        {status === 'applied' ? (
          <span className="agent-annotation-change-block__badge">已应用</span>
        ) : null}
      </div>
      <div
        className={`agent-change-block__body-wrap agent-annotation-change-block__list-wrap${
          canExpandList && !showFullList
            ? ' agent-annotation-change-block__list-wrap--clamped'
            : ''
        }${canExpandList ? ' agent-change-block__body-wrap--expandable' : ''}${
          showFullList ? ' agent-change-block__body-wrap--full' : ''
        }`}
      >
        {listScrollable ? (
          <OverlayVerticalScrollArea
            enabled
            maxHeight={`${LIST_ITEM_HEIGHT_PX * LIST_SCROLL_MAX_ITEMS}px`}
            disabledContentClassName="agent-annotation-change-block__list-scroll-host"
            contentClassName="agent-annotation-change-block__list-scroll-host"
            observeKey={items.length}
          >
            {listContent}
          </OverlayVerticalScrollArea>
        ) : (
          listContent
        )}
        {canExpandList ? (
          <button
            type="button"
            className="agent-change-block__expand"
            aria-expanded={showFullList}
            aria-label={showFullList ? '收起列表' : '展开全部变更文件'}
            title={showFullList ? '收起' : '展开全部变更文件'}
            onClick={() => setShowFullList((full) => !full)}
          >
            <VscodeIcon
              name={showFullList ? 'chevron-up' : 'chevron-down'}
              size={14}
            />
          </button>
        ) : null}
      </div>
    </div>
  );
}
