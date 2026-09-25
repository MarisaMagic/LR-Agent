import { VscodeButton } from '@vscode-elements/react-elements';
import ModalMotion from '../../motion/ModalMotion';
import { getLabelChipStyle } from '../../utils/labelColor';
import type { LabelImportPlan } from '../../utils/labelImport';
import OverlayVerticalScrollArea from '../OverlayVerticalScrollArea';
import './ImportLabelsDialog.css';

interface ImportLabelsDialogProps {
  open: boolean;
  plan: LabelImportPlan | null;
  fileName: string;
  onCancel: () => void;
  onConfirm: () => void;
}

const MAX_VISIBLE_INVALID = 6;

export default function ImportLabelsDialog({
  open,
  plan,
  fileName,
  onCancel,
  onConfirm,
}: ImportLabelsDialogProps) {
  const importedCount = plan?.imported.length ?? 0;
  const duplicateCount = plan?.duplicateNames.length ?? 0;
  const invalidCount = plan?.invalidMessages.length ?? 0;
  const visibleInvalid =
    plan?.invalidMessages.slice(0, MAX_VISIBLE_INVALID) ?? [];
  const hiddenInvalid = invalidCount - visibleInvalid.length;

  return (
    <ModalMotion
      open={open}
      onClose={onCancel}
      closeOnBackdropClick={false}
      dialogClassName="import-labels-dialog"
      labelledBy="import-labels-title"
    >
      <h3 id="import-labels-title" className="import-labels-title">
        导入标签
      </h3>
      {fileName ? (
        <p className="import-labels-file" title={fileName}>
          {fileName}
        </p>
      ) : null}

      <p className="import-labels-summary">
        将导入 <strong>{importedCount}</strong> 个
        {duplicateCount > 0 ? ` · 跳过重复 ${duplicateCount} 个` : ''}
        {invalidCount > 0 ? ` · 忽略无效 ${invalidCount} 项` : ''}
      </p>

      {visibleInvalid.length > 0 ? (
        <OverlayVerticalScrollArea
          maxHeight="120px"
          observeKey={invalidCount}
          contentClassName="import-labels-invalid"
        >
          <ul className="import-labels-invalid-list">
            {visibleInvalid.map((message) => (
              <li key={message}>{message}</li>
            ))}
            {hiddenInvalid > 0 ? <li>…另有 {hiddenInvalid} 项被忽略</li> : null}
          </ul>
        </OverlayVerticalScrollArea>
      ) : null}

      {importedCount > 0 ? (
        <OverlayVerticalScrollArea
          fillHost
          className="import-labels-list"
          contentClassName="import-labels-list-inner"
          observeKey={importedCount}
        >
          {plan?.imported.map((label) => (
            <span key={label.id} className="import-labels-item">
              <span
                className="import-labels-chip"
                style={getLabelChipStyle(label.color)}
              >
                {label.name}
              </span>
            </span>
          ))}
        </OverlayVerticalScrollArea>
      ) : (
        <p className="import-labels-empty">没有可导入的新标签。</p>
      )}

      <div className="import-labels-actions">
        <VscodeButton secondary icon="close" type="button" onClick={onCancel}>
          取消
        </VscodeButton>
        <VscodeButton
          icon="check"
          type="button"
          disabled={importedCount === 0}
          onClick={onConfirm}
        >
          确认导入
        </VscodeButton>
      </div>
    </ModalMotion>
  );
}
