import { useCallback, useMemo, useState } from 'react';
import { VscodeIcon } from '@vscode-elements/react-elements';
import type { AnnotationBatchProposal } from '../../../shared/annotationAgentTypes';
import FileTypeIcon from '../FileTypeIcon';
import OverlayVerticalScrollArea from '../OverlayVerticalScrollArea';
import { basename } from '../../types/file';
import { useAnnotation } from '../../context/AnnotationContext';
import { useApp } from '../../context/AppContext';
import { useWorkMode } from '../../context/WorkModeContext';
import { summarizeAnnotationChange } from '../../services/agentProposalApply';
import { proposalAnchorId } from '../../utils/fileDiffStats';
import { resolveWorkspaceAbsolutePath } from '../../utils/workspacePaths';
import './AgentAnnotationChangeBlock.css';

/** 折叠预览时可见的变更行数（与 file block ~9 行 diff 视觉高度对齐） */
const INITIAL_VISIBLE_ITEMS = 4;
const LIST_ITEM_HEIGHT_PX = 28;
const LIST_SCROLL_MAX_ITEMS = 12;

interface AgentAnnotationChangeBlockProps {
  messageId: string;
  blockIndex: number;
  proposal: AnnotationBatchProposal;
  status: 'pending' | 'applied' | 'dismissed';
}

function AnnotationChangeListItems({
  items,
  onOpen,
}: {
  items: Array<{
    key: string;
    path: string;
    absolutePath: string;
    summary: string;
  }>;
  onOpen: (relativePath: string, absolutePath: string) => void;
}) {
  return (
    <ul className="agent-annotation-change-block__list">
      {items.map((item) => (
        <li key={item.key}>
          <button
            type="button"
            className="agent-annotation-change-block__item"
            aria-label={`在标注画布中打开 ${basename(item.path)}`}
            onClick={() => onOpen(item.path, item.absolutePath)}
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
        </li>
      ))}
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
  const [showFullList, setShowFullList] = useState(false);
  const anchorId = proposalAnchorId(messageId, blockIndex);

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
      })),
    [proposal.changes],
  );

  const canExpandList = items.length > INITIAL_VISIBLE_ITEMS;
  const listScrollable = showFullList || !canExpandList;

  const handleOpenInAnnotation = useCallback(
    (relativePath: string, absolutePath: string) => {
      const resolved =
        absolutePath ||
        resolveWorkspaceAbsolutePath(
          relativePath,
          activeProject ?? null,
          rootPath,
        ) ||
        '';
      if (!resolved) return;
      setWorkMode('annotation', { silent: true });
      openFileInEditor(resolved);
    },
    [activeProject, openFileInEditor, rootPath, setWorkMode],
  );

  const title =
    status === 'applied'
      ? `已应用标注变更（${fileCount} 个文件）`
      : `标注变更（${fileCount} 个文件）`;

  const listContent = (
    <AnnotationChangeListItems items={items} onOpen={handleOpenInAnnotation} />
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
