import { useCallback, useEffect, useState } from 'react';
import type { QualityReportIndexEntry } from '../../../shared/qualityReportTypes';
import ReportPreviewPanel from './ReportPreviewPanel';

interface ReportHistoryListProps {
  projectDir: string;
  refreshKey: number;
  onSelectRun?: (runId: string) => void;
}

export default function ReportHistoryList({
  projectDir,
  refreshKey,
  onSelectRun,
}: ReportHistoryListProps) {
  const [entries, setEntries] = useState<QualityReportIndexEntry[]>([]);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [previewMarkdown, setPreviewMarkdown] = useState('');
  const [reportRootPath, setReportRootPath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list =
        (await window.electron?.quality?.listReports(projectDir)) ?? [];
      if (!cancelled) setEntries(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [projectDir, refreshKey]);

  const handleExpand = useCallback(
    async (runId: string) => {
      if (expandedRunId === runId) {
        setExpandedRunId(null);
        setPreviewMarkdown('');
        setReportRootPath(null);
        return;
      }
      const report = await window.electron?.quality?.readReport(
        projectDir,
        runId,
      );
      if (!report) return;
      setExpandedRunId(runId);
      setPreviewMarkdown(report.markdown);
      setReportRootPath(report.runAbsolutePath);
      onSelectRun?.(runId);
    },
    [expandedRunId, onSelectRun, projectDir],
  );

  const handleShowInFolder = useCallback(
    async (runId: string) => {
      const path = await window.electron?.quality?.getRunPath(
        projectDir,
        runId,
      );
      if (path) {
        await window.electron?.annotation?.showItemInFolder(path);
      }
    },
    [projectDir],
  );

  if (entries.length === 0) {
    return <p className="quality-history-empty">暂无历史报告</p>;
  }

  return (
    <div className="quality-history">
      <h3 className="quality-section-title">历史报告</h3>
      <ul className="quality-history-list">
        {entries.map((entry) => (
          <li key={entry.runId} className="quality-history-item">
            <div className="quality-history-item__header">
              <button
                type="button"
                className="quality-history-item__title"
                onClick={() => handleExpand(entry.runId)}
              >
                {entry.createdAt.slice(0, 19).replace('T', ' ')}
                {entry.summary ? ` · ${entry.summary}` : ''}
              </button>
              <button
                type="button"
                className="quality-history-item__folder"
                onClick={() => handleShowInFolder(entry.runId)}
                title="在文件夹中显示"
              >
                打开目录
              </button>
            </div>
            {expandedRunId === entry.runId ? (
              <ReportPreviewPanel
                markdown={previewMarkdown}
                reportRootPath={reportRootPath}
              />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
