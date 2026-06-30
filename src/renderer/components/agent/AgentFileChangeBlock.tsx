import { useCallback, useEffect, useMemo, useState } from 'react';
import { VscodeIcon } from '@vscode-elements/react-elements';
import FileTypeIcon from '../FileTypeIcon';
import OverlayVerticalScrollArea from '../OverlayVerticalScrollArea';
import { basename } from '../../types/file';
import { useAnnotation } from '../../context/AnnotationContext';
import { useApp } from '../../context/AppContext';
import { useWorkMode } from '../../context/WorkModeContext';
import {
  computeLineDiff,
  pickCollapsedDiffLines,
  proposalAnchorId,
  type DiffDisplayLine,
} from '../../utils/fileDiffStats';
import { readWorkspaceTextFile } from '../../utils/workspaceFileRead';
import { resolveWorkspaceAbsolutePath } from '../../utils/workspacePaths';
import { highlightCode } from '../../utils/syntaxHighlight';
import './AgentFileChangeBlock.css';

interface AgentFileChangeBlockProps {
  messageId: string;
  blockIndex: number;
  relativePath: string;
  newContent: string;
  status: 'pending' | 'applied' | 'dismissed';
}

function isEllipsisLine(text: string): boolean {
  return text === '…' || text.startsWith('… 省略');
}

function DiffLineContent({
  text,
  relativePath,
}: {
  text: string;
  relativePath: string;
}) {
  const html = useMemo(() => {
    if (!text || isEllipsisLine(text)) return null;
    return highlightCode(text, relativePath);
  }, [text, relativePath]);

  if (html === null) {
    return <span className="agent-file-change-block__diff-plain">{text || ' '}</span>;
  }

  return (
    <code
      className="agent-file-change-block__diff-code"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function DiffLines({
  lines,
  relativePath,
}: {
  lines: DiffDisplayLine[];
  relativePath: string;
}) {
  return (
    <>
      {lines.map((line, index) => (
        <div
          key={`${line.kind}-${index}`}
          className={`agent-file-change-block__diff-line${
            line.kind === 'added'
              ? ' agent-file-change-block__diff-line--added'
              : line.kind === 'removed'
                ? ' agent-file-change-block__diff-line--removed'
                : ''
          }`}
        >
          <span className="agent-file-change-block__diff-prefix">
            {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}
          </span>
          <DiffLineContent text={line.text} relativePath={relativePath} />
        </div>
      ))}
    </>
  );
}

export default function AgentFileChangeBlock({
  messageId,
  blockIndex,
  relativePath,
  newContent,
  status,
}: AgentFileChangeBlockProps) {
  const { activeProject } = useAnnotation();
  const { rootPath, openFileInEditor } = useApp();
  const { setWorkMode } = useWorkMode();
  const [oldContent, setOldContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showFullDiff, setShowFullDiff] = useState(false);

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
    return computeLineDiff(oldContent, newContent);
  }, [oldContent, newContent]);

  const collapsed = useMemo(() => {
    if (!diffResult) return null;
    return pickCollapsedDiffLines(diffResult.lines, 2);
  }, [diffResult]);

  const handleOpenInEditor = useCallback(() => {
    const absolutePath = resolveWorkspaceAbsolutePath(
      relativePath,
      activeProject ?? null,
      rootPath,
    );
    if (!absolutePath) return;
    setWorkMode('editor', { silent: true });
    openFileInEditor(absolutePath);
  }, [activeProject, openFileInEditor, relativePath, rootPath, setWorkMode]);

  const statsLabel = diffResult ? (
    <span className="agent-file-change-block__stats">
      {diffResult.additions > 0 ? (
        <span className="agent-file-change-block__stat-add">+{diffResult.additions}</span>
      ) : null}
      {diffResult.deletions > 0 ? (
        <span className="agent-file-change-block__stat-del">-{diffResult.deletions}</span>
      ) : null}
      {diffResult.additions === 0 && diffResult.deletions === 0 ? (
        <span className="agent-file-change-block__stat-add">+0</span>
      ) : null}
    </span>
  ) : null;

  const canExpandDiff = useMemo(() => {
    if (!collapsed || !diffResult) return false;
    return collapsed.hasMore || diffResult.lines.length > collapsed.lines.length;
  }, [collapsed, diffResult]);

  const fileName = basename(relativePath);
  const diffScrollable = showFullDiff || !canExpandDiff;

  return (
    <div
      className={`agent-file-change-block${status === 'applied' ? ' agent-file-change-block--applied' : ''}`}
      data-proposal-id={anchorId}
    >
      <button
        type="button"
        className="agent-file-change-block__header"
        aria-label={`在编辑器中打开 ${fileName}`}
        onClick={handleOpenInEditor}
      >
        <FileTypeIcon path={relativePath} size={14} />
        <span className="agent-file-change-block__name" title={relativePath}>
          {fileName}
        </span>
        {statsLabel}
        {status === 'applied' ? (
          <span className="agent-file-change-block__badge">已应用</span>
        ) : null}
      </button>

      <div className="agent-file-change-block__body">
        {loading || !diffResult || !collapsed ? (
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
              <DiffLines lines={diffResult.lines} relativePath={relativePath} />
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
    </div>
  );
}
