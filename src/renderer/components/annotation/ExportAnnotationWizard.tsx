import { FormEvent, useEffect, useMemo, useState } from 'react';
import { VscodeButton, VscodeIcon } from '@vscode-elements/react-elements';
import ModalMotion from '../../motion/ModalMotion';
import {
  AnnotationProject,
  getAnnotationTypeLabel,
  TASK_TYPE_CONFIG,
} from '../../types/annotation';
import {
  defaultExportFormat,
  getExportFormatsForType,
  type ExportCoordinateMode,
  type ExportFormatId,
  isImageAnnotationType,
} from '../../../shared/annotationExportTypes';
import { exportAnnotationProject } from '../../services/annotationExportService';
import './ExportAnnotationWizard.css';

interface ExportAnnotationWizardProps {
  project: AnnotationProject | null;
  onClose: () => void;
  onExported?: (outputDir: string) => void;
}

function defaultOutputDir(project: AnnotationProject): string {
  const base = project.directoryPath.replace(/[/\\]+$/, '');
  const stamp = new Date().toISOString().slice(0, 10);
  return `${base}/exports/${stamp}`;
}

export default function ExportAnnotationWizard({
  project,
  onClose,
  onExported,
}: ExportAnnotationWizardProps) {
  const open = Boolean(project);

  const formatOptions = useMemo(
    () => (project ? getExportFormatsForType(project.annotationType) : []),
    [project],
  );

  const [format, setFormat] = useState<ExportFormatId>('yolo');
  const [outputDir, setOutputDir] = useState('');
  const [coordinateMode, setCoordinateMode] =
    useState<ExportCoordinateMode>('pixel');
  const [includeEmptyImages, setIncludeEmptyImages] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!project) return;
    setFormat(defaultExportFormat(project.annotationType));
    setOutputDir(defaultOutputDir(project));
    setCoordinateMode('pixel');
    setIncludeEmptyImages(false);
    setSubmitting(false);
    setError(null);
    setSuccessMessage(null);
  }, [project]);

  const showCoordinateMode = format === 'csv';
  const canExport =
    project &&
    isImageAnnotationType(project.annotationType) &&
    outputDir.trim().length > 0;

  const handlePickDirectory = async () => {
    const picked = await window.electron.fileSystem.openDirectory();
    if (picked) setOutputDir(picked);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!project || !canExport) return;

    if (!isImageAnnotationType(project.annotationType)) {
      setError('当前任务类型暂不支持格式化导出');
      return;
    }

    setSubmitting(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const result = await exportAnnotationProject(project, {
        format,
        outputDir: outputDir.trim(),
        coordinateMode,
        includeEmptyImages,
      });

      if (!result.success) {
        setError(result.error ?? result.message);
        return;
      }

      setSuccessMessage(result.message);
      onExported?.(result.outputDir);
    } catch (err) {
      setError(err instanceof Error ? err.message : '导出失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleOpenOutputFolder = () => {
    if (!outputDir.trim()) return;
    window.electron.fileSystem.openPath(outputDir.trim());
  };

  if (!project) return null;

  const modalityLabel = TASK_TYPE_CONFIG[project.modality].label;
  const typeLabel = getAnnotationTypeLabel(
    project.modality,
    project.annotationType,
  );

  return (
    <ModalMotion
      open={open}
      onClose={onClose}
      closeOnBackdropClick={!submitting}
      dialogClassName="export-annotation-wizard"
      dialogRole="form"
      labelledBy="export-annotation-title"
      onSubmit={handleSubmit}
    >
      <div className="export-annotation-header">
        <h3 id="export-annotation-title">导出标注</h3>
        <button
          type="button"
          className="export-annotation-close"
          aria-label="关闭"
          onClick={onClose}
        >
          <VscodeIcon name="close" size={16} />
        </button>
      </div>

      <div className="export-annotation-meta">
        任务：<strong>{project.name}</strong>
        <br />
        类型：{modalityLabel} · {typeLabel}
        <br />
        标签数：{project.labels.length}
      </div>

      {error && <div className="export-annotation-error">{error}</div>}
      {successMessage && (
        <div className="export-annotation-success">{successMessage}</div>
      )}

      <div className="export-annotation-body">
        <div className="export-annotation-field">
          <span className="export-annotation-label">导出格式</span>
          <div className="export-annotation-format-list" role="radiogroup">
            {formatOptions.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={format === option.id}
                className={`export-annotation-format-option${
                  format === option.id ? ' selected' : ''
                }`}
                onClick={() => setFormat(option.id)}
              >
                <span className="export-annotation-format-name">
                  {option.label}
                </span>
                <span className="export-annotation-format-desc">
                  {option.description}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="export-annotation-field">
          <label className="export-annotation-label" htmlFor="export-output-dir">
            输出目录
          </label>
          <div className="export-annotation-directory-row">
            <input
              id="export-output-dir"
              type="text"
              value={outputDir}
              onChange={(event) => setOutputDir(event.target.value)}
              placeholder="选择导出目标文件夹"
              required
            />
            <VscodeButton secondary type="button" onClick={handlePickDirectory}>
              浏览…
            </VscodeButton>
          </div>
        </div>

        {showCoordinateMode && (
          <div className="export-annotation-field">
            <label className="export-annotation-label" htmlFor="export-coord-mode">
              CSV 坐标单位
            </label>
            <select
              id="export-coord-mode"
              className="export-annotation-select"
              value={coordinateMode}
              onChange={(event) =>
                setCoordinateMode(event.target.value as ExportCoordinateMode)
              }
            >
              <option value="pixel">像素</option>
              <option value="normalized">归一化 (0–1)</option>
            </select>
          </div>
        )}

        <label className="export-annotation-checkbox-row">
          <input
            type="checkbox"
            checked={includeEmptyImages}
            onChange={(event) => setIncludeEmptyImages(event.target.checked)}
          />
          包含已索引但无标注的图片
        </label>
      </div>

      <div className="export-annotation-actions">
        {successMessage && (
          <VscodeButton secondary type="button" onClick={handleOpenOutputFolder}>
            打开输出文件夹
          </VscodeButton>
        )}
        <VscodeButton secondary type="button" onClick={onClose}>
          {successMessage ? '关闭' : '取消'}
        </VscodeButton>
        {!successMessage && (
          <VscodeButton
            secondary
            type="submit"
            disabled={!canExport || submitting}
          >
            {submitting ? '导出中…' : '开始导出'}
          </VscodeButton>
        )}
      </div>
    </ModalMotion>
  );
}
