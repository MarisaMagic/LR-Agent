import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnnotationProjectSnapshot } from '../../../shared/annotationAgentTypes';
import { useLlmProviders } from '../../context/LlmProvidersContext';
import { useTheme } from '../../context/ThemeContext';
import {
  runQualityReportGeneration,
} from '../../services/annotationQuality/reportGenerationRunner';
import type { QualityReportStage, QualityScope } from '../../services/annotationQuality/types';
import ReportPreviewPanel from './ReportPreviewPanel';

const STAGE_LABELS: Record<QualityReportStage, string> = {
  collect: '采集数据',
  analyze: '质量检查',
  export_charts: '导出图表',
  compose_llm: 'AI 撰写',
  write_report: '写入报告',
  done: '完成',
};

interface ReportGenerationSectionProps {
  project: AnnotationProjectSnapshot;
  scope: QualityScope;
  scopePath?: string;
  relativeFilePath: string | null;
  onComplete?: () => void;
}

type StepStatus = 'pending' | 'running' | 'done' | 'error';

interface StepState {
  stage: QualityReportStage;
  status: StepStatus;
  message: string;
  detail?: string;
}

export default function ReportGenerationSection({
  project,
  scope,
  scopePath,
  relativeFilePath,
  onComplete,
}: ReportGenerationSectionProps) {
  const { providers } = useLlmProviders();
  const { effectiveTheme } = useTheme();
  const enabledProviders = useMemo(
    () => providers.filter((p) => p.enabled),
    [providers],
  );
  const [providerId, setProviderId] = useState('');
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<StepState[]>([]);
  const [markdown, setMarkdown] = useState('');
  const [reportRootPath, setReportRootPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!providerId && enabledProviders.length > 0) {
      setProviderId(enabledProviders[0].id);
    }
  }, [enabledProviders, providerId]);

  const updateStep = useCallback(
    (stage: QualityReportStage, patch: Partial<StepState>) => {
      setSteps((prev) => {
        const existing = prev.find((s) => s.stage === stage);
        if (existing) {
          return prev.map((s) =>
            s.stage === stage ? { ...s, ...patch } : s,
          );
        }
        return [
          ...prev,
          {
            stage,
            status: 'pending' as StepStatus,
            message: STAGE_LABELS[stage],
            ...patch,
          },
        ];
      });
    },
    [],
  );

  const selectedProvider = useMemo(
    () => enabledProviders.find((p) => p.id === providerId) ?? null,
    [enabledProviders, providerId],
  );

  const handleGenerate = useCallback(async () => {
    if (!providerId || !selectedProvider || running) return;
    if (
      !selectedProvider.apiKey.trim() ||
      !selectedProvider.baseUrl.trim() ||
      !selectedProvider.model.trim()
    ) {
      setError('所选大模型缺少 API Key、Base URL 或 Model，请在「大模型配置」中补全');
      return;
    }
    setRunning(true);
    setError(null);
    setMarkdown('');
    setReportRootPath(null);
    setSteps([]);
    abortRef.current = new AbortController();

    try {
      for await (const event of runQualityReportGeneration({
        project,
        providerId,
        providerApiKey: selectedProvider.apiKey,
        providerBaseUrl: selectedProvider.baseUrl,
        providerModel: selectedProvider.model,
        scope,
        scopePath,
        relativeFilePath,
        isDark: effectiveTheme === 'dark',
        signal: abortRef.current.signal,
      })) {
        if (event.type === 'progress') {
          updateStep(event.stage, {
            status: event.status ?? 'running',
            message: event.message,
            detail: event.detail,
          });
        } else if (event.type === 'text_delta') {
          setMarkdown((prev) => prev + event.content);
        } else if (event.type === 'report_run_ready') {
          setReportRootPath(event.reportRootPath);
        } else if (event.type === 'report_complete') {
          setMarkdown(event.markdown);
          const report = await window.electron?.quality?.readReport(
            project.directoryPath,
            event.runId,
          );
          if (report) {
            setReportRootPath(report.runAbsolutePath);
          }
          onComplete?.();
        } else if (event.type === 'error') {
          setError(event.message);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '报告生成失败');
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [
    effectiveTheme,
    onComplete,
    project,
    providerId,
    relativeFilePath,
    running,
    scope,
    scopePath,
    selectedProvider,
    updateStep,
  ]);

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    setRunning(false);
  }, []);

  return (
    <section className="quality-report-section">
      <h3 className="quality-section-title">标注质量报告</h3>
      <div className="quality-report-controls">
        <label className="quality-report-provider">
          <span>大模型</span>
          <select
            value={providerId}
            disabled={running || enabledProviders.length === 0}
            onChange={(e) => setProviderId(e.target.value)}
          >
            {enabledProviders.length === 0 ? (
              <option value="">请先配置大模型</option>
            ) : (
              enabledProviders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || p.model}
                </option>
              ))
            )}
          </select>
        </label>
        <div className="quality-report-actions">
          <button
            type="button"
            className="quality-btn quality-btn--primary"
            disabled={running || !providerId}
            onClick={handleGenerate}
          >
            {running ? '生成中…' : '生成报告'}
          </button>
          {running ? (
            <button
              type="button"
              className="quality-btn"
              onClick={handleCancel}
            >
              取消
            </button>
          ) : null}
        </div>
      </div>

      {steps.length > 0 ? (
        <ol className="quality-report-steps">
          {(['collect', 'analyze', 'export_charts', 'compose_llm', 'write_report', 'done'] as QualityReportStage[])
            .filter((stage) => steps.some((s) => s.stage === stage))
            .map((stage) => {
              const step = steps.find((s) => s.stage === stage)!;
              return (
                <li
                  key={stage}
                  className={`quality-report-step quality-report-step--${step.status}`}
                >
                  <span className="quality-report-step__label">
                    {STAGE_LABELS[stage]}
                  </span>
                  <span className="quality-report-step__message">
                    {step.message}
                  </span>
                  {step.detail ? (
                    <span className="quality-report-step__detail">
                      {step.detail}
                    </span>
                  ) : null}
                </li>
              );
            })}
        </ol>
      ) : null}

      {error ? <p className="quality-error">{error}</p> : null}

      <ReportPreviewPanel markdown={markdown} reportRootPath={reportRootPath} />
    </section>
  );
}
