import { useCallback, useState } from 'react';
import { VscodeButton } from '@vscode-elements/react-elements';
import { useToast } from '../../context/ToastContext';
import { executeAnalysisScript } from '../../services/agentDataAnalysis/dataAnalysisRunner';
import { buildAnnotationStatsSnapshot } from '../../services/agentDataAnalysis/buildAnnotationStatsSnapshot';
import { formatAnalysisStdout } from '../../services/agentDataAnalysis/analysisOutputFormat';
import { useAnnotation } from '../../context/AnnotationContext';
import './AnnotationProposalBlock.css';

interface AnalysisScriptProposalBlockProps {
  script: string;
  explanation: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'dismissed';
  result?: string;
  error?: string;
  onStatusChange: (
    patch: Partial<{
      status: AnalysisScriptProposalBlockProps['status'];
      result?: string;
      error?: string;
    }>,
  ) => void;
}

export default function AnalysisScriptProposalBlock({
  script,
  explanation,
  status,
  result,
  error,
  onStatusChange,
}: AnalysisScriptProposalBlockProps) {
  const { showToast } = useToast();
  const { activeProject } = useAnnotation();
  const [running, setRunning] = useState(false);
  const [scriptExpanded, setScriptExpanded] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);

  const autoPipeline = status === 'running' || status === 'done';

  const handleRerun = useCallback(async () => {
    if (!activeProject) {
      showToast('请先打开标注项目', { type: 'info' });
      return;
    }
    setRunning(true);
    onStatusChange({ status: 'running', error: undefined });
    try {
      const snapshot = await buildAnnotationStatsSnapshot({
        projectId: activeProject.id,
        name: activeProject.name,
        directoryPath: activeProject.directoryPath,
        modality: activeProject.modality,
        annotationType: activeProject.annotationType,
        labels: activeProject.labels,
      });
      const stdout = await executeAnalysisScript(script, {
        ...snapshot,
        annotations: snapshot,
      });
      onStatusChange({ status: 'done', result: stdout });
      showToast('分析脚本执行完成', { type: 'success' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : '执行失败';
      onStatusChange({ status: 'error', error: msg });
      showToast(msg, { type: 'error' });
    } finally {
      setRunning(false);
    }
  }, [activeProject, onStatusChange, script, showToast]);

  const handleDismiss = useCallback(() => {
    onStatusChange({ status: 'dismissed' });
    showToast('已忽略分析脚本', { type: 'info' });
  }, [onStatusChange, showToast]);

  const showRerun = status === 'done' || status === 'error';
  const isBusy = status === 'running' || running;

  return (
    <div className="annotation-proposal-block">
      <div className="annotation-proposal-title">数据分析</div>
      <div className="annotation-proposal-summary">{explanation}</div>
      {status === 'running' && !result ? (
        <div className="annotation-proposal-weak">正在生成并运行分析脚本…</div>
      ) : null}
      <div className="annotation-proposal-weak">
        <VscodeButton
          secondary
          onClick={() => setScriptExpanded((v) => !v)}
          aria-expanded={scriptExpanded}
        >
          {scriptExpanded ? '收起脚本' : '查看脚本'}
        </VscodeButton>
        {result ? (
          <VscodeButton
            secondary
            onClick={() => setOutputExpanded((v) => !v)}
            aria-expanded={outputExpanded}
          >
            {outputExpanded ? '收起原始输出' : '查看原始输出'}
          </VscodeButton>
        ) : null}
      </div>
      {scriptExpanded ? (
        <pre className="annotation-proposal-weak-list" style={{ whiteSpace: 'pre-wrap' }}>
          {script}
        </pre>
      ) : null}
      {outputExpanded && result ? (
        <pre className="annotation-proposal-summary" style={{ whiteSpace: 'pre-wrap' }}>
          {formatAnalysisStdout(result)}
        </pre>
      ) : null}
      {error ? (
        <div className="annotation-proposal-weak">
          <span className="annotation-proposal-badge">{error}</span>
        </div>
      ) : null}
      <div className="annotation-proposal-actions">
        {showRerun ? (
          <VscodeButton disabled={isBusy} onClick={() => void handleRerun()}>
            {isBusy ? '执行中…' : '重新运行脚本'}
          </VscodeButton>
        ) : null}
        {!autoPipeline && status === 'pending' ? (
          <VscodeButton disabled={isBusy} onClick={() => void handleRerun()}>
            {isBusy ? '执行中…' : '运行分析'}
          </VscodeButton>
        ) : null}
        {status === 'done' ? (
          <span className="annotation-proposal-badge">已完成</span>
        ) : null}
        <VscodeButton
          secondary
          disabled={isBusy || status === 'dismissed'}
          onClick={handleDismiss}
        >
          忽略
        </VscodeButton>
      </div>
    </div>
  );
}
