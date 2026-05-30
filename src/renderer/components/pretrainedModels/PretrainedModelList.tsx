import {
  PretrainedModelConfig,
  PRETRAINED_MODEL_TYPE_LABELS,
  PretrainedModelType,
  getModelDisplayName,
} from '../../types/pretrainedModel';
import './PretrainedModelList.css';

interface PretrainedModelListProps {
  models: PretrainedModelConfig[];
  loading: boolean;
  filterType: PretrainedModelType | 'all';
  onEdit: (model: PretrainedModelConfig) => void;
  onDelete: (model: PretrainedModelConfig) => void;
}

function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || filePath;
}

export default function PretrainedModelList({
  models,
  loading,
  filterType,
  onEdit,
  onDelete,
}: PretrainedModelListProps) {
  const filtered =
    filterType === 'all'
      ? models
      : models.filter((m) => m.modelType === filterType);

  if (loading) {
    return (
      <div className="pretrained-model-list-empty">加载预训练模型配置…</div>
    );
  }

  if (filtered.length === 0) {
    return (
      <div className="pretrained-model-list-empty">
        {filterType === 'all'
          ? '尚未配置预训练模型。点击上方 + 添加。'
          : `暂无${PRETRAINED_MODEL_TYPE_LABELS[filterType as PretrainedModelType]}配置。`}
      </div>
    );
  }

  return (
    <ul className="pretrained-model-list">
      {filtered.map((model) => (
        <li key={model.id} className="pretrained-model-item">
          <div className="pretrained-model-item-head">
            <span
              className="pretrained-model-item-name"
              title={getModelDisplayName(model)}
            >
              {getModelDisplayName(model)}
            </span>
            <div className="pretrained-model-item-badges">
              {model.isDefault && (
                <span className="pretrained-model-badge pretrained-model-badge-default">
                  默认
                </span>
              )}
              {!model.enabled && (
                <span className="pretrained-model-badge pretrained-model-badge-disabled">
                  已停用
                </span>
              )}
            </div>
          </div>

          <div className="pretrained-model-item-type">
            {PRETRAINED_MODEL_TYPE_LABELS[model.modelType]}
          </div>

          <div
            className="pretrained-model-item-path"
            title={model.checkpointPath}
          >
            {basename(model.checkpointPath) || '未设置权重路径'}
          </div>

          {model.modelType === 'image_segmentation' && model.configPath && (
            <div
              className="pretrained-model-item-path pretrained-model-item-path-sub"
              title={model.configPath}
            >
              {basename(model.configPath)}
            </div>
          )}

          <div className="pretrained-model-item-actions">
            <button
              type="button"
              className="pretrained-model-action-btn"
              onClick={() => onEdit(model)}
            >
              编辑
            </button>
            <button
              type="button"
              className="pretrained-model-action-btn pretrained-model-action-btn-danger"
              onClick={() => onDelete(model)}
            >
              删除
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
