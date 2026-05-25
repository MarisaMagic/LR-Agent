import { VscodeButton, VscodeIcon } from '@vscode-elements/react-elements';
import { LABEL_COLOR_PRESETS, LabelDefinition } from '../../types/annotation';
import './LabelEditor.css';

interface LabelEditorProps {
  labels: LabelDefinition[];
  onChange: (labels: LabelDefinition[]) => void;
}

function nextPresetColor(index: number): string {
  return LABEL_COLOR_PRESETS[index % LABEL_COLOR_PRESETS.length];
}

export default function LabelEditor({ labels, onChange }: LabelEditorProps) {
  const addLabel = () => {
    onChange([
      ...labels,
      {
        id: crypto.randomUUID(),
        name: '',
        color: nextPresetColor(labels.length),
      },
    ]);
  };

  const updateLabel = (id: string, patch: Partial<LabelDefinition>) => {
    onChange(
      labels.map((label) => (label.id === id ? { ...label, ...patch } : label)),
    );
  };

  const removeLabel = (id: string) => {
    onChange(labels.filter((label) => label.id !== id));
  };

  return (
    <div className="label-editor">
      <div className="label-editor-header">
        <span className="label-editor-title">标签定义</span>
        <VscodeButton secondary icon="add" onClick={addLabel}>
          添加标签
        </VscodeButton>
      </div>

      {labels.length === 0 ? (
        <p className="label-editor-empty">
          可选：添加标签名称与颜色，后续标注时使用。
        </p>
      ) : (
        <ul className="label-editor-list">
          {labels.map((label) => (
            <li key={label.id} className="label-editor-row">
              <input
                type="color"
                className="label-editor-color"
                value={label.color}
                onChange={(event) =>
                  updateLabel(label.id, { color: event.target.value })
                }
                aria-label="标签颜色"
              />
              <input
                type="text"
                className="label-editor-name"
                placeholder="标签名称，如 dog"
                value={label.name}
                onChange={(event) =>
                  updateLabel(label.id, { name: event.target.value })
                }
              />
              <button
                type="button"
                className="label-editor-remove"
                aria-label="删除标签"
                onClick={() => removeLabel(label.id)}
              >
                <VscodeIcon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function normalizeLabels(labels: LabelDefinition[]): LabelDefinition[] {
  const seen = new Set<string>();
  const result: LabelDefinition[] = [];

  labels.forEach((label) => {
    const name = label.name.trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push({
      id: label.id,
      name,
      color: label.color,
    });
  });

  return result;
}
