import { useEffect, useMemo, useState } from 'react';
import { VscodeIcon } from '@vscode-elements/react-elements';
import { useAgentChat } from '../../context/AgentChatContext';
import { useAnnotation } from '../../context/AnnotationContext';
import { useApp } from '../../context/AppContext';
import FileTypeIcon from '../FileTypeIcon';
import { basename } from '../../types/file';
import {
  collectPendingChangeItems,
  collectPendingProposals,
} from '../../services/agentProposalApply';
import { scrollToProposalAnchor } from '../../utils/fileDiffStats';
import { computeFileProposalDiffStats } from '../../utils/workspaceFileRead';
import './AgentKeepAllBar.css';

type ItemStats = Record<string, { additions?: number; deletions?: number }>;

export default function AgentKeepAllBar() {
  const {
    pendingProposalCount,
    applyAllPendingChanges,
    applyingAllPending,
    isSessionStreaming,
    activeSessionId,
    preparingContext,
    getSessionMessages,
  } = useAgentChat();
  const { activeProject } = useAnnotation();
  const { rootPath } = useApp();

  const [expanded, setExpanded] = useState(true);
  const [itemStats, setItemStats] = useState<ItemStats>({});

  const changeItems = useMemo(() => {
    if (!activeSessionId || pendingProposalCount <= 0) return [];
    return collectPendingChangeItems(getSessionMessages(activeSessionId));
  }, [activeSessionId, pendingProposalCount, getSessionMessages]);

  const changeItemsKey = useMemo(
    () => changeItems.map((item) => item.id).join(','),
    [changeItems],
  );

  useEffect(() => {
    if (changeItems.length === 0) {
      setItemStats({});
      return undefined;
    }

    let cancelled = false;

    void (async () => {
      const next: ItemStats = {};
      await Promise.all(
        changeItems.map(async (item) => {
          if (item.kind === 'file' && item.newContent != null) {
            const stats = await computeFileProposalDiffStats({
              project: activeProject ?? null,
              workspaceRoot: rootPath,
              relativePath: item.path,
              newContent: item.newContent,
            });
            next[item.id] = stats;
          }
        }),
      );
      if (!cancelled) {
        setItemStats(next);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeProject, changeItems, changeItemsKey, rootPath]);

  if (pendingProposalCount <= 0) return null;

  const busy =
    applyingAllPending ||
    (activeSessionId != null && isSessionStreaming(activeSessionId)) ||
    preparingContext;

  const fileCount = changeItems.length;
  const headerLabel = fileCount === 1 ? '1 个文件' : `${fileCount} 个文件`;

  const handleReview = () => {
    setExpanded(true);
    if (!activeSessionId) return;
    const refs = collectPendingProposals(getSessionMessages(activeSessionId));
    const first = refs[0];
    if (first) {
      scrollToProposalAnchor(first.messageId, first.blockIndex);
    }
  };

  const handleItemClick = (messageId: string, blockIndex: number) => {
    scrollToProposalAnchor(messageId, blockIndex);
  };

  return (
    <div className="agent-keep-all-bar">
      <div className="agent-keep-all-bar__header">
        <button
          type="button"
          className="agent-keep-all-bar__toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          <VscodeIcon
            name={expanded ? 'chevron-down' : 'chevron-right'}
            size={14}
          />
          <span className="agent-keep-all-bar__title">{headerLabel}</span>
        </button>
        <div className="agent-keep-all-bar__actions">
          <button
            type="button"
            className="agent-keep-all-bar__review"
            disabled={busy}
            onClick={handleReview}
          >
            Review
          </button>
          <button
            type="button"
            className="agent-keep-all-bar__button"
            disabled={busy}
            onClick={() => {
              applyAllPendingChanges().catch(() => undefined);
            }}
          >
            {applyingAllPending ? '应用中…' : 'Keep All'}
          </button>
        </div>
      </div>
      {expanded && changeItems.length > 0 ? (
        <ul className="agent-keep-all-bar__list">
          {changeItems.map((item) => {
            const stats = itemStats[item.id];
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className="agent-keep-all-bar__item"
                  onClick={() => {
                    handleItemClick(item.ref.messageId, item.ref.blockIndex);
                  }}
                >
                  {item.kind === 'file' || item.kind === 'annotation' ? (
                    <FileTypeIcon path={item.path} size={14} />
                  ) : (
                    <VscodeIcon name="code" size={14} />
                  )}
                  <span className="agent-keep-all-bar__path" title={item.path}>
                    {item.kind === 'file' || item.kind === 'annotation'
                      ? basename(item.path)
                      : item.path}
                  </span>
                  <span className="agent-keep-all-bar__meta">
                    {stats?.additions != null && stats.additions > 0 ? (
                      <span className="agent-keep-all-bar__stat-add">
                        +{stats.additions}
                      </span>
                    ) : null}
                    {stats?.deletions != null && stats.deletions > 0 ? (
                      <span className="agent-keep-all-bar__stat-del">
                        -{stats.deletions}
                      </span>
                    ) : null}
                    {item.kind !== 'file' || stats == null ? (
                      <span className="agent-keep-all-bar__summary">
                        {item.summary}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
