import { useCallback, useState } from 'react';
import { VscodeButton } from '@vscode-elements/react-elements';
import type { AnnotationBatchProposal } from '../../../shared/annotationAgentTypes';
import { useAnnotation } from '../../context/AnnotationContext';
import { useToast } from '../../context/ToastContext';
import { applyAnnotationBatchProposal } from '../../services/annotationProposalApply';
import './AnnotationProposalBlock.css';

interface AnnotationProposalBlockProps {
  proposal: AnnotationBatchProposal;
  status: 'pending' | 'applied' | 'dismissed';
  onStatusChange: (status: 'pending' | 'applied' | 'dismissed') => void;
}

export default function AnnotationProposalBlock({
  proposal,
  status,
  onStatusChange,
}: AnnotationProposalBlockProps) {
  const { activeProject } = useAnnotation();
  const { showToast } = useToast();
  const [applying, setApplying] = useState(false);

  const handleApply = useCallback(async () => {
    if (!activeProject || activeProject.id !== proposal.projectId) {
      showToast('请先打开对应的标注项目后再应用', { type: 'info' });
      return;
    }
    setApplying(true);
    try {
      const result = await applyAnnotationBatchProposal(activeProject, proposal);
      onStatusChange('applied');
      showToast(
        `已应用批量标注：${result.appliedFiles} 个文件，${result.appliedBoxes} 个框`,
        { type: 'success' },
      );
      window.dispatchEvent(
        new CustomEvent('lr-agent:annotation-batch-applied', {
          detail: { projectId: proposal.projectId },
        }),
      );
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : '应用标注失败',
        { type: 'error' },
      );
    } finally {
      setApplying(false);
    }
  }, [activeProject, onStatusChange, proposal, showToast]);

  const handleDismiss = useCallback(() => {
    onStatusChange('dismissed');
    showToast('已忽略本次批量标注建议', { type: 'info' });
  }, [onStatusChange, showToast]);

  const disabled = status !== 'pending' || applying;

  return (
    <div
      className={`annotation-proposal-block${status === 'applied' ? ' annotation-proposal-block--applied' : ''}`}
    >
      <div className="annotation-proposal-title">批量标注候选</div>
      <div className="annotation-proposal-summary">{proposal.summary}</div>
      <div className="annotation-proposal-stats">
        处理 {proposal.stats.processed} 张 · 成功 {proposal.stats.succeeded} · 跳过{' '}
        {proposal.stats.skipped} · 共 {proposal.stats.totalBoxes} 个框
      </div>
      <div className="annotation-proposal-actions">
        <VscodeButton disabled={disabled} onClick={() => void handleApply()}>
          {status === 'applied' ? '已应用' : applying ? '应用中…' : '应用标注'}
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
