import { useCallback, useState } from 'react';
import { VscodeIcon } from '@vscode-elements/react-elements';
import { useAgentChat } from '../../context/AgentChatContext';
import { useToast } from '../../context/ToastContext';
import { executeAnalysisScript } from '../../services/agentDataAnalysis/dataAnalysisRunner';
import { buildAnnotationStatsSnapshot } from '../../services/agentDataAnalysis/buildAnnotationStatsSnapshot';
import { formatAnalysisStdout } from '../../services/agentDataAnalysis/analysisOutputFormat';
import { useAnnotation } from '../../context/AnnotationContext';
import AgentScrollablePre from './AgentScrollablePre';
import './AgentAnnotationPipelineBlock.css';

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
  const { pendingProposalCount } = useAgentChat();
  const { activeProject } = useAnnotation();
  const [running, setRunning] = useState(false);
  const [scriptExpanded, setScriptExpanded] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);

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
  const hideInlineActions = pendingProposalCount > 0;

  return (
    <div className="agent-pipeline-block">
      <div className="agent-pipeline-toggle" style={{ cursor: 'default' }}>
        <span>数据分析</span>
        {status === 'running' ? (
          <VscodeIcon name="sync" size={12} className="agent-pipeline-spin" />
        ) : null}
      </div>
      <div className="agent-pipeline-body">
        {explanation ? (
          <div className="agent-pipeline-step-message">{explanation}</div>
        ) : null}
        {status === 'running' && !result ? (
          <div className="agent-pipeline-step-message">正在生成并运行分析脚本…</div>
        ) : null}
        <div className="agent-pipeline-embedded">
          {script ? (
            <button
              type="button"
              className="agent-pipeline-embedded-toggle"
              onClick={() => setScriptExpanded((v) => !v)}
              aria-expanded={scriptExpanded}
            >
              <VscodeIcon
                name={scriptExpanded ? 'chevron-down' : 'chevron-right'}
                size={12}
              />
              <span>查看脚本</span>
            </button>
          ) : null}
          {scriptExpanded && script ? (
            <AgentScrollablePre className="agent-pipeline-embedded-pre">
              {script}
            </AgentScrollablePre>
          ) : null}
          {result ? (
            <button
              type="button"
              className="agent-pipeline-embedded-toggle"
              onClick={() => setOutputExpanded((v) => !v)}
              aria-expanded={outputExpanded}
            >
              <VscodeIcon
                name={outputExpanded ? 'chevron-down' : 'chevron-right'}
                size={12}
              />
              <span>查看原始输出</span>
            </button>
          ) : null}
          {outputExpanded && result ? (
            <AgentScrollablePre className="agent-pipeline-embedded-pre">
              {formatAnalysisStdout(result)}
            </AgentScrollablePre>
          ) : null}
          {error ? (
            <div className="agent-pipeline-embedded-error">{error}</div>
          ) : null}
        </div>
        {!hideInlineActions && status === 'pending' ? (
          <div className="agent-pipeline-embedded-actions">
            <button
              type="button"
              className="agent-pipeline-embedded-action"
              disabled={isBusy}
              onClick={() => void handleRerun()}
            >
              {isBusy ? '执行中…' : '运行分析'}
            </button>
            <button
              type="button"
              className="agent-pipeline-embedded-action agent-pipeline-embedded-action--muted"
              disabled={isBusy}
              onClick={handleDismiss}
            >
              忽略
            </button>
          </div>
        ) : null}
        {!hideInlineActions && showRerun ? (
          <div className="agent-pipeline-embedded-actions">
            <button
              type="button"
              className="agent-pipeline-embedded-action"
              disabled={isBusy}
              onClick={() => void handleRerun()}
            >
              {isBusy ? '执行中…' : '重新运行'}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
