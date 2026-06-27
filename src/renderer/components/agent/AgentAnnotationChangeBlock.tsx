import { useCallback, useMemo, useState } from 'react';
import { VscodeIcon } from '@vscode-elements/react-elements';
import type { AnnotationBatchProposal } from '../../../shared/annotationAgentTypes';
import FileTypeIcon from '../FileTypeIcon';
import { basename } from '../../types/file';
import { summarizeAnnotationChange } from '../../services/agentProposalApply';
import { proposalAnchorId } from '../../utils/fileDiffStats';
import './AgentAnnotationChangeBlock.css';

interface AgentAnnotationChangeBlockProps {
  messageId: string;
  blockIndex: number;
  proposal: AnnotationBatchProposal;
  status: 'pending' | 'applied' | 'dismissed';
}

export default function AgentAnnotationChangeBlock({
  messageId,
  blockIndex,
  proposal,
  status,
}: AgentAnnotationChangeBlockProps) {
  const [expanded, setExpanded] = useState(status === 'pending');
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
        summary: summarizeAnnotationChange(change),
      })),
    [proposal.changes],
  );

  const toggleExpanded = useCallback(() => {
    setExpanded((open) => !open);
  }, []);

  const title =
    status === 'applied'
      ? `已应用标注变更（${fileCount} 个文件）`
      : `标注变更（${fileCount} 个文件）`;

  return (
    <div
      className={`agent-annotation-change-block${status === 'applied' ? ' agent-annotation-change-block--applied' : ''}`}
      data-proposal-id={anchorId}
    >
      <button
        type="button"
        className="agent-annotation-change-block__header"
        aria-expanded={expanded}
        onClick={toggleExpanded}
      >
        <VscodeIcon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
        <span className="agent-annotation-change-block__title">{title}</span>
        {status === 'applied' ? (
          <span className="agent-annotation-change-block__badge">已应用</span>
        ) : null}
      </button>
      {expanded ? (
        <ul className="agent-annotation-change-block__list">
          {items.map((item) => (
            <li key={item.key} className="agent-annotation-change-block__item">
              <FileTypeIcon path={item.path} size={14} />
              <span className="agent-annotation-change-block__path" title={item.path}>
                {basename(item.path)}
              </span>
              <span className="agent-annotation-change-block__summary">{item.summary}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
