import { FormEvent, useEffect, useState } from 'react';
import { VscodeButton } from '@vscode-elements/react-elements';
import ModalMotion from '../../motion/ModalMotion';
import {
  PretrainedModelConfig,
  PRETRAINED_MODEL_TYPE_LABELS,
  PretrainedModelType,
  defaultParamsForType,
} from '../../types/pretrainedModel';
import {
  pickModelFile,
  pickSam2RootDirectory,
  scanSam2Directory,
  validatePretrainedModelPaths,
} from '../../services/pretrainedModelService';
import './PretrainedModelFormModal.css';

interface PretrainedModelFormModalProps {
  open: boolean;
  initial: PretrainedModelConfig;
  isNew: boolean;
  onClose: () => void;
  onSave: (model: PretrainedModelConfig) => Promise<void>;
}

export default function PretrainedModelFormModal({
  open,
  initial,
  isNew,
  onClose,
  onSave,
}: PretrainedModelFormModalProps) {
  const [form, setForm] = useState<PretrainedModelConfig>(initial);
  const [error, setError] = useState<string | null>(null);
  const [validationMessages, setValidationMessages] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(initial);
    setError(null);
    setValidationMessages([]);
    setSubmitting(false);
    setScanning(false);
  }, [open, initial]);

  const updateForm = (patch: Partial<PretrainedModelConfig>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  };

  const updateParams = (patch: NonNullable<PretrainedModelConfig['params']>) => {
    setForm((prev) => ({
      ...prev,
      params: { ...prev.params, ...patch },
    }));
  };

  const handleTypeChange = (modelType: PretrainedModelType) => {
    setForm((prev) => ({
      ...prev,
      modelType,
      configPath: modelType === 'image_segmentation' ? prev.configPath ?? '' : undefined,
      params: defaultParamsForType(modelType),
    }));
  };

  const handlePickCheckpoint = async () => {
    const path = await pickModelFile(['pt'], '选择模型权重 (.pt)');
    if (!path) return;
    updateForm({ checkpointPath: path });
  };

  const handlePickConfig = async () => {
    const path = await pickModelFile(['yaml', 'yml'], '选择 SAM2 配置文件 (.yaml)');
    if (!path) return;
    updateForm({ configPath: path });
  };

  const handleImportSam2Directory = async () => {
    setScanning(true);
    setError(null);
    try {
      const rootDir = await pickSam2RootDirectory();
      if (!rootDir) return;

      const scanned = await scanSam2Directory(rootDir);
      if (scanned.length === 0) {
        setError(
          '未在该目录找到可用的 SAM2 配对（需包含 checkpoints/*.pt 与 configs/sam2.1/*.yaml）',
        );
        return;
      }

      const first = scanned[0];
      updateForm({
        modelType: 'image_segmentation',
        checkpointPath: first.checkpointPath,
        configPath: first.configPath,
      });

      if (scanned.length > 1) {
        setValidationMessages([
          `已从目录导入 ${first.name}；该目录另有 ${scanned.length - 1} 个变体，保存后可继续添加。`,
        ]);
      }
    } finally {
      setScanning(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (!form.checkpointPath.trim()) {
      setError('请选择权重文件');
      return;
    }
    if (form.modelType === 'image_segmentation' && !form.configPath?.trim()) {
      setError('SAM2 需要配置文件路径');
      return;
    }

    const validation = await validatePretrainedModelPaths({
      modelType: form.modelType,
      checkpointPath: form.checkpointPath,
      configPath: form.configPath,
    });
    if (!validation.ok) {
      setError(validation.errors[0] ?? '路径校验未通过');
      setValidationMessages([...validation.errors, ...validation.warnings]);
      return;
    }

    setSubmitting(true);
    try {
      await onSave({
        ...form,
        name: form.name.trim(),
        checkpointPath: form.checkpointPath.trim(),
        configPath: form.configPath?.trim() || undefined,
        description: form.description?.trim() || '',
        updatedAt: new Date().toISOString(),
      });
      onClose();
    } catch {
      setError('保存失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ModalMotion
      open={open}
      onClose={onClose}
      dialogClassName="pretrained-model-form-dialog"
      labelledBy="pretrained-model-form-title"
      dialogRole="form"
      onSubmit={handleSubmit}
    >
      <h3 id="pretrained-model-form-title" className="pretrained-model-form-title">
        {isNew ? '添加预训练模型' : '编辑预训练模型'}
      </h3>

      <div className="pretrained-model-form-field">
        <label htmlFor="pm-name">显示名称（可选）</label>
        <input
          id="pm-name"
          value={form.name}
          onChange={(e) => updateForm({ name: e.target.value })}
          placeholder="留空则使用权重文件名"
        />
      </div>

      <div className="pretrained-model-form-field">
        <span className="pretrained-model-form-label">模型类型</span>
        <div className="pretrained-model-type-options">
          {(
            Object.entries(PRETRAINED_MODEL_TYPE_LABELS) as [
              PretrainedModelType,
              string,
            ][]
          ).map(([value, label]) => (
            <label key={value} className="pretrained-model-type-option">
              <input
                type="radio"
                name="modelType"
                value={value}
                checked={form.modelType === value}
                onChange={() => handleTypeChange(value)}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div className="pretrained-model-form-field">
        <label htmlFor="pm-checkpoint">权重路径 (.pt)</label>
        <div className="pretrained-model-path-row">
          <input
            id="pm-checkpoint"
            value={form.checkpointPath}
            readOnly
            placeholder="点击浏览选择 .pt 文件"
            title={form.checkpointPath}
          />
          <VscodeButton secondary type="button" onClick={handlePickCheckpoint}>
            浏览
          </VscodeButton>
        </div>
      </div>

      {form.modelType === 'image_segmentation' && (
        <>
          <div className="pretrained-model-form-field">
            <label htmlFor="pm-config">配置文件 (.yaml)</label>
            <div className="pretrained-model-path-row">
              <input
                id="pm-config"
                value={form.configPath ?? ''}
                readOnly
                placeholder="与权重变体匹配的 sam2.1_hiera_*.yaml"
                title={form.configPath ?? ''}
              />
              <VscodeButton secondary type="button" onClick={handlePickConfig}>
                浏览
              </VscodeButton>
            </div>
            <span className="pretrained-model-form-hint">
              SAM2 需要权重与 yaml 架构配置成对使用，变体必须一致（如 base_plus 配
              sam2.1_hiera_b+.yaml）。
            </span>
          </div>

          <div className="pretrained-model-form-field">
            <VscodeButton
              secondary
              type="button"
              disabled={scanning}
              onClick={handleImportSam2Directory}
            >
              {scanning ? '扫描中…' : '从 SAM2 目录导入'}
            </VscodeButton>
            <span className="pretrained-model-form-hint">
              选择含 checkpoints/ 与 configs/sam2.1/ 的根目录，自动配对第一个可用变体。
            </span>
          </div>
        </>
      )}

      {form.modelType === 'object_detection' && (
        <div className="pretrained-model-form-advanced">
          <span className="pretrained-model-form-label">推理参数</span>
          <div className="pretrained-model-form-grid">
            <label>
              置信度
              <input
                type="number"
                min={0.05}
                max={0.95}
                step={0.05}
                value={form.params?.confThreshold ?? 0.25}
                onChange={(e) =>
                  updateParams({ confThreshold: Number(e.target.value) })
                }
              />
            </label>
            <label>
              IoU
              <input
                type="number"
                min={0.1}
                max={0.9}
                step={0.05}
                value={form.params?.iouThreshold ?? 0.45}
                onChange={(e) =>
                  updateParams({ iouThreshold: Number(e.target.value) })
                }
              />
            </label>
          </div>
        </div>
      )}

      {form.modelType === 'image_segmentation' && (
        <div className="pretrained-model-form-advanced">
          <span className="pretrained-model-form-label">多边形参数</span>
          <div className="pretrained-model-form-grid">
            <label>
              最小面积
              <input
                type="number"
                min={1}
                step={10}
                value={form.params?.minArea ?? 100}
                onChange={(e) =>
                  updateParams({ minArea: Number(e.target.value) })
                }
              />
            </label>
            <label>
              简化系数
              <input
                type="number"
                min={0.001}
                max={0.05}
                step={0.001}
                value={form.params?.epsilonRatio ?? 0.006}
                onChange={(e) =>
                  updateParams({ epsilonRatio: Number(e.target.value) })
                }
              />
            </label>
          </div>
        </div>
      )}

      <div className="pretrained-model-form-field pretrained-model-form-switches">
        <label className="pretrained-model-switch">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => updateForm({ enabled: e.target.checked })}
          />
          启用
        </label>
        <label className="pretrained-model-switch">
          <input
            type="checkbox"
            checked={form.isDefault}
            onChange={(e) => updateForm({ isDefault: e.target.checked })}
          />
          设为该类型默认
        </label>
      </div>

      <div className="pretrained-model-form-field">
        <label htmlFor="pm-desc">描述（可选）</label>
        <textarea
          id="pm-desc"
          rows={2}
          value={form.description ?? ''}
          onChange={(e) => updateForm({ description: e.target.value })}
          placeholder="用途说明"
        />
      </div>

      {!isNew && (
        <div className="pretrained-model-form-field">
          <span className="pretrained-model-form-label">模型标识</span>
          <code className="pretrained-model-id">{form.id}</code>
        </div>
      )}

      {validationMessages.length > 0 && (
        <ul className="pretrained-model-validation-list">
          {validationMessages.map((msg) => (
            <li key={msg}>{msg}</li>
          ))}
        </ul>
      )}

      {error && <p className="pretrained-model-form-error">{error}</p>}

      <div className="pretrained-model-form-actions">
        <VscodeButton secondary type="button" onClick={onClose}>
          取消
        </VscodeButton>
        <VscodeButton type="submit" disabled={submitting}>
          {submitting ? '保存中…' : '保存'}
        </VscodeButton>
      </div>
    </ModalMotion>
  );
}
