import { useCallback, useMemo, useState } from 'react';
import { VscodeButton } from '@vscode-elements/react-elements';
import type { AnnotationBatchProposal } from '../../../shared/annotationAgentTypes';
import { useAnnotation } from '../../context/AnnotationContext';
import { useToast } from '../../context/ToastContext';
import {
  applyAnnotationBatchProposal,
  dispatchMutationsAppliedEvent,
} from '../../services/annotationProposalApply';
import { getAnnotationWorkspaceAgentSnapshot } from '../../services/annotationAgentBridge';
import './AnnotationProposalBlock.css';

interface AnnotationProposalBlockProps {
  proposal: AnnotationBatchProposal;
  status: 'pending' | 'applied' | 'dismissed';
  onStatusChange: (status: 'pending' | 'applied' | 'dismissed') => void;
}

function summarizeChange(change: AnnotationBatchProposal['changes'][number]): string {
  switch (change.operation) {
    case 'patch':
      return `修改 ${change.patches?.length ?? 0} 个框`;
    case 'delete':
      return `删除 ${change.deleteIds?.length ?? 0} 个框`;
    case 'replace':
    case 'replace_bboxes':
      return `替换 ${change.annotations?.length ?? 0} 个框`;
    case 'append':
    default:
      return `新增 ${change.annotations?.length ?? 0} 个框`;
  }
}

export default function AnnotationProposalBlock({
  proposal,
  status,
  onStatusChange,
}: AnnotationProposalBlockProps) {
  const { activeProject } = useAnnotation();
  const { showToast } = useToast();
  const [applying, setApplying] = useState(false);
  const weakAcceptedChanges = proposal.changes.filter(
    (change) => change.judge?.verdict === 'weak_accept',
  );

  const changeSummaries = useMemo(
    () =>
      proposal.changes.map((change) => ({
        path: change.relativePath,
        summary: summarizeChange(change),
        patchIds: change.patches?.map((p) => p.id) ?? [],
        deleteIds: change.deleteIds ?? [],
      })),
    [proposal.changes],
  );

  const hasUnresolved = proposal.changes.some((change) => {
    if (change.operation === 'patch') {
      return !(change.patches?.length);
    }
    if (change.operation === 'delete') {
      return !(change.deleteIds?.length);
    }
    if (
      change.operation === 'append' ||
      change.operation === 'replace' ||
      change.operation === 'replace_bboxes'
    ) {
      return !(change.annotations?.length);
    }
    return true;
  });

  const handleApply = useCallback(async () => {
    if (!activeProject || activeProject.id !== proposal.projectId) {
      showToast('请先打开对应的标注项目后再应用', { type: 'info' });
      return;
    }
    if (hasUnresolved) {
      showToast('提案包含未解析的变更，无法应用', { type: 'error' });
      return;
    }

    const wsSnap = getAnnotationWorkspaceAgentSnapshot();
    const overlapPaths = proposal.changes
      .map((c) => c.relativePath)
      .filter(
        (rel) =>
          wsSnap.workspaceDirty &&
          wsSnap.workspaceRelativePath === rel &&
          wsSnap.workspaceProjectId === proposal.projectId,
      );
    if (overlapPaths.length > 0) {
      const ok = window.confirm(
        '工作区有未保存的修改，应用提案将覆盖磁盘上的标注 JSON。是否继续？',
      );
      if (!ok) return;
    }

    setApplying(true);
    try {
      const result = await applyAnnotationBatchProposal(activeProject, proposal, {
        onFreshnessConflict: (_rel, reason) =>
          window.confirm(`${reason}。是否仍要应用？`),
      });
      onStatusChange('applied');
      const parts = [
        `${result.appliedFiles} 个文件`,
        result.appliedBoxes > 0 ? `${result.appliedBoxes} 个新增框` : '',
        result.appliedPatches > 0 ? `${result.appliedPatches} 处修改` : '',
        result.appliedDeletes > 0 ? `${result.appliedDeletes} 处删除` : '',
      ].filter(Boolean);
      showToast(`已应用标注变更：${parts.join('，')}`, { type: 'success' });
      dispatchMutationsAppliedEvent(proposal.projectId, result.relativePaths);
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : '应用标注失败',
        { type: 'error' },
      );
    } finally {
      setApplying(false);
    }
  }, [
    activeProject,
    hasUnresolved,
    onStatusChange,
    proposal,
    showToast,
  ]);

  const handleDismiss = useCallback(() => {
    onStatusChange('dismissed');
    showToast('已忽略本次标注建议', { type: 'info' });
  }, [onStatusChange, showToast]);

  const disabled = status !== 'pending' || applying || hasUnresolved;
  const isMutationProposal = proposal.changes.some(
    (c) => c.operation === 'patch' || c.operation === 'delete',
  );

  return (
    <div
      className={`annotation-proposal-block${status === 'applied' ? ' annotation-proposal-block--applied' : ''}`}
    >
      <div className="annotation-proposal-title">
        {isMutationProposal ? '标注变更候选' : '批量标注候选'}
      </div>
      <div className="annotation-proposal-summary">{proposal.summary}</div>
      <div className="annotation-proposal-stats">
        处理 {proposal.stats.processed} 张 · 成功 {proposal.stats.succeeded} · 跳过{' '}
        {proposal.stats.skipped} · 共 {proposal.stats.totalBoxes} 个框
      </div>
      {changeSummaries.length > 0 ? (
        <div className="annotation-proposal-weak-list">
          {changeSummaries.slice(0, 8).map((item) => (
            <span key={item.path}>
              {item.path}: {item.summary}
            </span>
          ))}
        </div>
      ) : null}
      {hasUnresolved ? (
        <div className="annotation-proposal-weak">
          <span className="annotation-proposal-badge">无法应用 · 目标未解析</span>
        </div>
      ) : null}
      {proposal.stats.judged ? (
        <div className="annotation-proposal-stats annotation-proposal-stats--judge">
          通过 {proposal.stats.accepted ?? 0} · 弱通过 {proposal.stats.weakAccepted ?? 0} ·
          拒绝 {proposal.stats.rejected ?? 0}
        </div>
      ) : null}
      {weakAcceptedChanges.length > 0 ? (
        <div className="annotation-proposal-weak">
          <span className="annotation-proposal-badge">弱通过 · 建议人工复查</span>
          <div className="annotation-proposal-weak-list">
            {weakAcceptedChanges.slice(0, 6).map((change) => (
              <span key={change.relativePath}>{change.relativePath}</span>
            ))}
            {weakAcceptedChanges.length > 6 ? (
              <span>等 {weakAcceptedChanges.length} 张</span>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="annotation-proposal-actions">
        <VscodeButton disabled={disabled} onClick={() => void handleApply()}>
          {status === 'applied' ? '已应用' : applying ? '应用中…' : '应用变更'}
        </VscodeButton>
        <VscodeButton
          secondary
          disabled={disabled}
          onClick={handleDismiss}
        >
          忽略
        </VscodeButton>
      </div>
    </div>
  );
}
