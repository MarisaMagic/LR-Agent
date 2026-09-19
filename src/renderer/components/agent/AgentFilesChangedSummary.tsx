import { useCallback, useEffect, useMemo, useState } from 'react';
import { VscodeIcon } from '@vscode-elements/react-elements';
import type { ChatMessage } from '../../../shared/agentTypes';
import { isFileProposalBlock } from '../../../shared/agentTypes';
import FileTypeIcon from '../FileTypeIcon';
import { basename } from '../../types/file';
import { useAgentChat } from '../../context/AgentChatContext';
import { useAnnotation } from '../../context/AnnotationContext';
import { useApp } from '../../context/AppContext';
import {
  collectMessageChangeItems,
  type MessageChangeItem,
} from '../../services/agentProposalApply';
import { messageCanUndo } from '../../services/turnCheckpoint';
import { computeFileProposalDiffStats } from '../../utils/workspaceFileRead';
import { useOpenAgentChange } from './useOpenAgentChange';
import './AgentFilesChangedSummary.css';

const INITIAL_VISIBLE = 5;

interface AgentFilesChangedSummaryProps {
  message: ChatMessage;
}

function resolveItemStats(
  item: MessageChangeItem,
  computed: Record<string, { additions: number; deletions: number }>,
): { additions?: number; deletions?: number } {
  if (item.additions != null || item.deletions != null) {
    return { additions: item.additions, deletions: item.deletions };
  }
  return computed[item.id] ?? {};
}

export default function AgentFilesChangedSummary({
  message,
}: AgentFilesChangedSummaryProps) {
  const { updateMessageBlocks, undoAssistantChanges } = useAgentChat();
  const { activeProject } = useAnnotation();
  const { rootPath } = useApp();
  const { openFileProposal, openAnnotationProposal } = useOpenAgentChange();
  const [expanded, setExpanded] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [computedStats, setComputedStats] = useState<
    Record<string, { additions: number; deletions: number }>
  >({});

  const items = useMemo(() => collectMessageChangeItems(message), [message]);
  // 仅当本消息的已应用改动**全部**留有改前快照时可撤销（部分缺失会让回滚不完整）
  const canUndo = useMemo(() => messageCanUndo(message), [message]);

  const handleUndo = useCallback(() => {
    setUndoing(true);
    undoAssistantChanges(message.id)
      .catch(() => undefined)
      .finally(() => setUndoing(false));
  }, [message.id, undoAssistantChanges]);

  useEffect(() => {
    const missing = items.filter(
      (item) =>
        item.kind === 'file' &&
        item.additions == null &&
        item.deletions == null,
    );
    if (missing.length === 0) {
      return undefined;
    }

    let cancelled = false;
    void (async () => {
      const next: Record<string, { additions: number; deletions: number }> = {};
      await Promise.all(
        missing.map(async (item) => {
          const stats = await computeFileProposalDiffStats({
            project: activeProject ?? null,
            workspaceRoot: rootPath,
            relativePath: item.path,
            newContent: item.newContent ?? '',
            operation:
              item.operation === 'delete'
                ? 'delete'
                : item.operation === 'rename'
                  ? 'rename'
                  : 'write',
          });
          next[item.id] = stats;
        }),
      );
      if (cancelled) return;
      setComputedStats((prev) => ({ ...prev, ...next }));

      const persistable = missing.filter((item) => {
        const stats = next[item.id];
        return stats && (stats.additions > 0 || stats.deletions > 0);
      });
      if (persistable.length === 0) return;

      updateMessageBlocks(message.sessionId, message.id, (blocks) => {
        let changed = false;
        const nextBlocks = blocks.map((block, index) => {
          if (!isFileProposalBlock(block)) return block;
          if (block.additions != null || block.deletions != null) return block;
          const item = persistable.find(
            (entry) => entry.ref.blockIndex === index,
          );
          if (!item) return block;
          const stats = next[item.id];
          if (!stats) return block;
          changed = true;
          return {
            ...block,
            additions: stats.additions,
            deletions: stats.deletions,
          };
        });
        return changed ? nextBlocks : blocks;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeProject,
    items,
    message.id,
    message.sessionId,
    rootPath,
    updateMessageBlocks,
  ]);

  const handleOpen = (item: MessageChangeItem) => {
    const block = message.blocks[item.ref.blockIndex];
    if (!block) return;
    if (item.kind === 'file' && isFileProposalBlock(block)) {
      void openFileProposal({
        relativePath: block.suggestedRelativePath,
        content: block.content,
        operation: block.operation,
        status: block.status,
      });
      return;
    }
    if (item.kind === 'annotation' && block.type === 'annotation_proposal') {
      openAnnotationProposal({
        relativePath: item.path,
        absolutePath: item.absolutePath ?? '',
        status: block.status,
        proposal: block.proposal,
        proposalAnchorId: `proposal-${item.ref.messageId}-${item.ref.blockIndex}`,
      });
    }
  };

  if (items.length === 0) return null;

  const visible = expanded ? items : items.slice(0, INITIAL_VISIBLE);
  const hiddenCount = items.length - visible.length;

  return (
    <div className="agent-files-changed">
      <div className="agent-files-changed__header">
        <span className="agent-files-changed__title">
          {items.length} Files Changed
        </span>
        <div className="agent-files-changed__actions">
          <button
            type="button"
            className="agent-files-changed__review"
            onClick={() => handleOpen(items[0])}
          >
            Review
          </button>
          {canUndo ? (
            <button
              type="button"
              className="agent-files-changed__undo"
              title="撤销本消息的全部已应用修改"
              disabled={undoing}
              onClick={handleUndo}
            >
              <VscodeIcon name="discard" size={13} />
              {undoing ? '撤销中…' : '撤销修改'}
            </button>
          ) : null}
        </div>
      </div>
      <div className="agent-files-changed__list">
        {visible.map((item) => {
          const stats = resolveItemStats(item, computedStats);
          const fileName = basename(item.path) || item.path;
          return (
            <button
              key={item.id}
              type="button"
              className="agent-files-changed__row"
              title={item.path}
              onClick={() => handleOpen(item)}
            >
              <FileTypeIcon path={item.path} size={16} />
              <span className="agent-files-changed__name">{fileName}</span>
              <span className="agent-files-changed__meta">
                {stats.additions ? (
                  <span className="agent-files-changed__add">
                    +{stats.additions}
                  </span>
                ) : null}
                {stats.deletions ? (
                  <span className="agent-files-changed__del">
                    -{stats.deletions}
                  </span>
                ) : null}
                {item.status === 'applied' ? (
                  <span className="agent-files-changed__badge">已应用</span>
                ) : null}
                {item.status === 'undone' ? (
                  <span className="agent-files-changed__badge agent-files-changed__badge--undone">
                    已撤销
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      {hiddenCount > 0 ? (
        <button
          type="button"
          className="agent-files-changed__more"
          onClick={() => setExpanded(true)}
        >
          ... Show {hiddenCount} more
        </button>
      ) : null}
    </div>
  );
}
