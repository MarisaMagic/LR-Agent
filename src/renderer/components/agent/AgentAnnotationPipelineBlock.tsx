import { useMemo } from 'react';
import { VscodeIcon } from '@vscode-elements/react-elements';
import type { AnnotationPipelineStep } from '../../types/agent';
import {
  isImageDetailPipelineStage,
  resolvePipelineImagePath,
  workerStepDisplayLabel,
  workerStepDisplayMessage,
} from '../../services/annotationAgent/pipelineImageSteps';
import {
  PIPELINE_TITLES,
} from '../../services/annotationAgent/pipelineKinds';
import type { PipelineKind } from '../../types/agent';
import OverlayVerticalScrollArea from '../OverlayVerticalScrollArea';
import './AgentAnnotationPipelineBlock.css';

interface AgentAnnotationPipelineBlockProps {
  steps: AnnotationPipelineStep[];
  collapsed: boolean;
  streaming?: boolean;
  pipelineCompleted?: boolean;
  batchCompleted?: boolean;
  pipelineKind?: PipelineKind;
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

function sortWorkerSteps(steps: AnnotationPipelineStep[]): AnnotationPipelineStep[] {
  const statusRank = (status: AnnotationPipelineStep['status']): number => {
    if (status === 'running') return 0;
    if (status === 'error' || status === 'skipped') return 1;
    return 2;
  };
  return [...steps].sort((a, b) => {
    const rank = statusRank(a.status) - statusRank(b.status);
    if (rank !== 0) return rank;
    const pathA = resolvePipelineImagePath(a) ?? a.message;
    const pathB = resolvePipelineImagePath(b) ?? b.message;
    return pathA.localeCompare(pathB, undefined, { numeric: true });
  });
}

export default function AgentAnnotationPipelineBlock({
  steps,
  collapsed,
  streaming = false,
  pipelineCompleted = false,
  batchCompleted = false,
  pipelineKind = 'batch',
  onToggle,
}: AgentAnnotationPipelineBlockProps) {
  const completed = pipelineCompleted || batchCompleted;
  const running = steps.some((s) => s.status === 'running');
  const failed = steps.some((s) => s.status === 'error');
  const inProgress = !completed && (streaming || running);
  const titles = PIPELINE_TITLES[pipelineKind] ?? PIPELINE_TITLES.batch;
  const title = inProgress
    ? titles.active
    : failed
      ? titles.failed
      : titles.idle;

  const mainStages = steps.filter((s) => !isImageDetailPipelineStage(s.stage));
  const workerSteps = useMemo(
    () => sortWorkerSteps(steps.filter((s) => isImageDetailPipelineStage(s.stage))),
    [steps],
  );
  const workerDoneCount = workerSteps.filter((s) => s.status === 'done').length;
  const workerErrorCount = workerSteps.filter(
    (s) => s.status === 'error' || s.status === 'skipped',
  ).length;

  return (
    <div className="agent-pipeline-block">
      <button type="button" className="agent-pipeline-toggle" onClick={onToggle}>
        <VscodeIcon
          name={collapsed ? 'chevron-right' : 'chevron-down'}
          size={12}
        />
        <span>{title}</span>
        {inProgress && (
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
                    inProgress && step.status === 'running'
                      ? 'agent-pipeline-spin'
                      : undefined
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

          {workerSteps.length > 0 && pipelineKind === 'batch' ? (
            <details className="agent-pipeline-workers" open={inProgress}>
              <summary>
                图片处理明细（{workerSteps.length}
                {!inProgress && workerSteps.length > 0
                  ? ` · 成功 ${workerDoneCount}${workerErrorCount ? ` · 失败 ${workerErrorCount}` : ''}`
                  : ''}
                ）
              </summary>
              <OverlayVerticalScrollArea maxHeight="160px">
                <ul className="agent-pipeline-list agent-pipeline-list--nested">
                {workerSteps.map((step) => {
                  const rowKey =
                    resolvePipelineImagePath(step) ?? `${step.stage}-${step.message}`;
                  const displayMessage = workerStepDisplayMessage(step);
                  return (
                    <li
                      key={rowKey}
                      className={`agent-pipeline-step ${statusClass(step.status)}`}
                    >
                      <VscodeIcon
                        name={statusIcon(step.status)}
                        size={12}
                        className={
                          inProgress && step.status === 'running'
                            ? 'agent-pipeline-spin'
                            : undefined
                        }
                      />
                      <div className="agent-pipeline-step-text">
                        <span className="agent-pipeline-step-label">
                          {workerStepDisplayLabel(step)}
                        </span>
                        <span className="agent-pipeline-step-message">{displayMessage}</span>
                      </div>
                    </li>
                  );
                })}
                </ul>
              </OverlayVerticalScrollArea>
            </details>
          ) : null}
        </div>
      )}
    </div>
  );
}
