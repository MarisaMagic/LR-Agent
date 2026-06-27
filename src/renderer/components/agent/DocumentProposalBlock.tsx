import { useCallback, useState } from 'react';
import { VscodeButton } from '@vscode-elements/react-elements';
import { useAgentChat } from '../../context/AgentChatContext';
import { useAnnotation } from '../../context/AnnotationContext';
import { useToast } from '../../context/ToastContext';
import { isAgentDocumentWriteEnabled } from '../../services/agentFeatureFlags';
import AgentMarkdown from './AgentMarkdown';
import './AnnotationProposalBlock.css';

interface DocumentProposalBlockProps {
  title: string;
  content: string;
  suggestedRelativePath: string;
  status: 'pending' | 'applied' | 'dismissed';
  onStatusChange: (status: 'pending' | 'applied' | 'dismissed') => void;
}

/** @deprecated 使用 AgentFileChangeBlock + Keep All 栏 */
export default function DocumentProposalBlock({
  title,
  content,
  suggestedRelativePath,
  status,
  onStatusChange,
}: DocumentProposalBlockProps) {
  const { activeProject } = useAnnotation();
  const { showToast } = useToast();
  const { pendingProposalCount } = useAgentChat();
  const [saving, setSaving] = useState(false);
  const hideInlineActions = pendingProposalCount > 0;

  const handleSave = useCallback(async () => {
    if (!isAgentDocumentWriteEnabled()) {
      showToast('文档写入功能未启用', { type: 'info' });
      return;
    }
    const root = activeProject?.directoryPath;
    if (!root) {
      showToast('请先打开项目目录', { type: 'info' });
      return;
    }
    setSaving(true);
    try {
      const result = await window.electron?.workspace?.writeTextFile({
        rootDir: root,
        relativePath: suggestedRelativePath,
        content,
      });
      if (!result?.success) {
        throw new Error(result?.error ?? '保存失败');
      }
      onStatusChange('applied');
      showToast(`已保存：${suggestedRelativePath}`, { type: 'success' });
      if (result.filePath) {
        await window.electron?.annotation?.showItemInFolder(result.filePath);
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : '保存失败', { type: 'error' });
    } finally {
      setSaving(false);
    }
  }, [
    activeProject?.directoryPath,
    content,
    onStatusChange,
    showToast,
    suggestedRelativePath,
  ]);

  const disabled = status !== 'pending' || saving;

  return (
    <div className="annotation-proposal-block">
      <div className="annotation-proposal-title">{title}</div>
      <AgentMarkdown content={content} />
      <div className="annotation-proposal-stats">建议路径：{suggestedRelativePath}</div>
      {!hideInlineActions ? (
      <div className="annotation-proposal-actions">
        <VscodeButton disabled={disabled} onClick={() => void handleSave()}>
          {status === 'applied' ? '已保存' : saving ? '保存中…' : '保存到项目'}
        </VscodeButton>
        <VscodeButton
          secondary
          disabled={disabled}
          onClick={() => onStatusChange('dismissed')}
        >
          忽略
        </VscodeButton>
      </div>
      ) : null}
    </div>
  );
}
