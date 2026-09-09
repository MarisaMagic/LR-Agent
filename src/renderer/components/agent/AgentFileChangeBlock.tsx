import { useEffect, useMemo, useState } from 'react';
import { VscodeIcon } from '@vscode-elements/react-elements';
import OverlayVerticalScrollArea from '../OverlayVerticalScrollArea';
import { basename } from '../../types/file';
import { useAnnotation } from '../../context/AnnotationContext';
import { useApp } from '../../context/AppContext';
import {
  computeLineDiff,
  pickCollapsedDiffLines,
  proposalAnchorId,
} from '../../utils/fileDiffStats';
import { readWorkspaceTextFile } from '../../utils/workspaceFileRead';
import { AgentFileDiffLines } from './AgentFileDiffView';
import './AgentReasoningBlock.css';
import './AgentFileChangeBlock.css';

interface AgentFileChangeBlockProps {
  messageId: string;
  blockIndex: number;
  relativePath: string;
  newContent: string;
  operation?: 'write' | 'delete';
}

export default function AgentFileChangeBlock({
  messageId,
  blockIndex,
  relativePath,
  newContent,
  operation = 'write',
}: AgentFileChangeBlockProps) {
  const { activeProject } = useAnnotation();
  const { rootPath } = useApp();
  const [oldContent, setOldContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showFullDiff, setShowFullDiff] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const isDelete = operation === 'delete';

  const anchorId = proposalAnchorId(messageId, blockIndex);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void readWorkspaceTextFile({
      project: activeProject ?? null,
      workspaceRoot: rootPath,
      relativePath,
    }).then((result) => {
      if (cancelled) return;
      setOldContent(result.exists ? result.content : '');
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [activeProject, rootPath, relativePath]);

  const diffResult = useMemo(() => {
    if (oldContent === null) return null;
    return computeLineDiff(oldContent, isDelete ? '' : newContent);
  }, [isDelete, newContent, oldContent]);

  const collapsed = useMemo(() => {
    if (!diffResult) return null;
    return pickCollapsedDiffLines(diffResult.lines, 2);
  }, [diffResult]);

  const canExpandDiff = useMemo(() => {
    if (isDelete || !collapsed || !diffResult) return false;
    return (
      collapsed.hasMore || diffResult.lines.length > collapsed.lines.length
    );
  }, [collapsed, diffResult, isDelete]);

  const safeRelativePath = relativePath ?? '';
  const fileName = basename(safeRelativePath) || '未命名文件';
  const diffScrollable = showFullDiff || !canExpandDiff;

  return (
    <div className="agent-tool-block" data-proposal-id={anchorId}>
      <button
        type="button"
        className="agent-block-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        <VscodeIcon
          name={expanded ? 'chevron-down' : 'chevron-right'}
          size={12}
        />
        <span>
          {isDelete ? 'Deleted' : 'Edited'} {fileName}
        </span>
        {diffResult &&
        (diffResult.additions > 0 || diffResult.deletions > 0) ? (
          <span className="agent-edit-stats">
            {diffResult.additions > 0 ? (
              <span className="agent-edit-stats__add">
                +{diffResult.additions}
              </span>
            ) : null}
            {diffResult.deletions > 0 ? (
              <span className="agent-edit-stats__del">
                -{diffResult.deletions}
              </span>
            ) : null}
          </span>
        ) : null}
      </button>

      {expanded ? (
        <div className="agent-tool-body agent-file-change-block__body">
          {isDelete ? (
            <div className="agent-file-change-block__delete-note">
              将删除此文件
            </div>
          ) : loading || !diffResult || !collapsed ? (
            <div className="agent-file-change-block__loading">
              {loading ? '加载 diff…' : '正在生成内容…'}
            </div>
          ) : (
            <div
              className={`agent-change-block__body-wrap agent-file-change-block__diff-wrap${
                canExpandDiff && !showFullDiff
                  ? ' agent-file-change-block__diff-wrap--clamped'
                  : ''
              }${canExpandDiff ? ' agent-change-block__body-wrap--expandable' : ''}${
                showFullDiff
                  ? ' agent-change-block__body-wrap--full agent-file-change-block__diff-wrap--full'
                  : ''
              }`}
            >
              <OverlayVerticalScrollArea
                enabled={diffScrollable}
                maxHeight="calc(1.5em * 24 + 8px)"
                disabledContentClassName="agent-file-change-block__diff"
                contentClassName="agent-file-change-block__diff"
                observeKey={diffResult.lines.length}
              >
                <AgentFileDiffLines
                  lines={diffResult.lines}
                  relativePath={safeRelativePath}
                />
              </OverlayVerticalScrollArea>
              {canExpandDiff ? (
                <button
                  type="button"
                  className="agent-change-block__expand"
                  aria-expanded={showFullDiff}
                  aria-label={showFullDiff ? '收起变更' : '展开全部变更'}
                  title={showFullDiff ? '收起' : '展开全部变更'}
                  onClick={() => setShowFullDiff((full) => !full)}
                >
                  <VscodeIcon
                    name={showFullDiff ? 'chevron-up' : 'chevron-down'}
                    size={14}
                  />
                </button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
