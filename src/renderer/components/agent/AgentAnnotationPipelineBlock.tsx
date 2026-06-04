import { VscodeIcon } from '@vscode-elements/react-elements';
import type { AnnotationPipelineStep } from '../../types/agent';
import './AgentAnnotationPipelineBlock.css';

interface AgentAnnotationPipelineBlockProps {
  steps: AnnotationPipelineStep[];
  collapsed: boolean;
  streaming?: boolean;
  onToggle: () => void;
}

function statusIcon(status: AnnotationPipelineStep['status']): string {
  switch (status) {
    case 'done':
      return 'check';
    case 'error':
    case 'skipped':
      return 'error';
    case 'running':
      return 'sync';
    default:
      return 'circle-large';
  }
}

function statusClass(status: AnnotationPipelineStep['status']): string {
  return `agent-pipeline-step--${status}`;
}

export default function AgentAnnotationPipelineBlock({
  steps,
  collapsed,
  streaming = false,
  onToggle,
}: AgentAnnotationPipelineBlockProps) {
  const running = steps.some((s) => s.status === 'running');
  const failed = steps.some((s) => s.status === 'error');
  const title = streaming || running ? '批量标注进行中…' : failed ? '批量标注未完成' : '批量标注步骤';

  const mainStages = steps.filter((s) => s.stage !== 'worker');
  const workerSteps = steps.filter((s) => s.stage === 'worker');

  return (
    <div className="agent-pipeline-block">
      <button type="button" className="agent-pipeline-toggle" onClick={onToggle}>
        <VscodeIcon
          name={collapsed ? 'chevron-right' : 'chevron-down'}
          size={12}
        />
        <span>{title}</span>
        {(streaming || running) && (
          <VscodeIcon name="sync" size={12} className="agent-pipeline-spin" />
        )}
      </button>

      {!collapsed && (
        <div className="agent-pipeline-body">
          <ul className="agent-pipeline-list">
            {mainStages.map((step) => (
              <li
                key={`${step.stage}-${step.message}`}
                className={`agent-pipeline-step ${statusClass(step.status)}`}
              >
                <VscodeIcon
                  name={statusIcon(step.status)}
                  size={14}
                  className={
                    step.status === 'running' ? 'agent-pipeline-spin' : undefined
                  }
                />
                <div className="agent-pipeline-step-text">
                  <span className="agent-pipeline-step-label">{step.label}</span>
                  <span className="agent-pipeline-step-message">{step.message}</span>
                  {step.detail ? (
                    <span className="agent-pipeline-step-detail">{step.detail}</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>

          {workerSteps.length > 0 ? (
            <details className="agent-pipeline-workers" open={running}>
              <summary>图片处理明细（{workerSteps.length}）</summary>
              <ul className="agent-pipeline-list agent-pipeline-list--nested">
                {workerSteps.map((step) => (
                  <li
                    key={step.message}
                    className={`agent-pipeline-step ${statusClass(step.status)}`}
                  >
                    <VscodeIcon name={statusIcon(step.status)} size={12} />
                    <div className="agent-pipeline-step-text">
                      <span className="agent-pipeline-step-message">{step.message}</span>
                      {step.detail ? (
                        <span className="agent-pipeline-step-detail">{step.detail}</span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      )}
    </div>
  );
}
