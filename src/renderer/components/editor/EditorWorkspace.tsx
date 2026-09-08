import { useCallback, useEffect, useMemo, useState } from 'react';
import { VscodeIcon, VscodeLabel } from '@vscode-elements/react-elements';
import { useApp } from '../../context/AppContext';
import { useWorkMode } from '../../context/WorkModeContext';
import { checkBinaryFile } from '../../utils/binaryFileDetect';
import { isMonacoEditableFile } from '../../utils/editorFileTypes';
import EditorPane from './EditorPane';
import MonacoTextEditor from './MonacoTextEditor';
import './EditorWorkspace.css';

export default function EditorWorkspace() {
  const { workMode } = useWorkMode();
  const { openTabs, activeTabId, markTabDirty, saveActiveTab, refreshTree } =
    useApp();

  const activeTab = useMemo(
    () => openTabs.find((tab) => tab.id === activeTabId) ?? null,
    [openTabs, activeTabId],
  );

  const hasTabs = openTabs.length > 0;
  const [activeTabBinary, setActiveTabBinary] = useState(false);

  useEffect(() => {
    if (
      workMode !== 'editor' ||
      !activeTab ||
      !isMonacoEditableFile(activeTab.filePath)
    ) {
      setActiveTabBinary(false);
      return undefined;
    }

    let cancelled = false;
    checkBinaryFile(activeTab.filePath)
      .then((binary) => {
        if (!cancelled) setActiveTabBinary(binary);
      })
      .catch(() => {
        if (!cancelled) setActiveTabBinary(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeTab, workMode]);

  /** 仅编辑器模式下、当前激活 tab 是文本且非二进制时才显示 Monaco 浮层 */
  const showSharedMonaco = Boolean(
    workMode === 'editor' &&
    activeTab &&
    isMonacoEditableFile(activeTab.filePath) &&
    !activeTabBinary,
  );

  const handleDirtyChange = useCallback(
    (tabId: string, dirty: boolean) => {
      markTabDirty(tabId, dirty);
    },
    [markTabDirty],
  );

  const handleSave = useCallback(async () => {
    const saved = await saveActiveTab();
    if (saved) {
      await refreshTree();
    }
  }, [saveActiveTab, refreshTree]);

  useEffect(() => {
    const unsub = window.electron.ipcRenderer.on('edit:save', () => {
      handleSave().catch(() => undefined);
    });
    return unsub;
  }, [handleSave]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      if (event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      handleSave().catch(() => undefined);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleSave]);

  return (
    <div className="editor-workspace">
      <div className="editor-workspace-body">
        {hasTabs ? (
          <div className="editor-workspace-pane">
            {openTabs.map((tab) => (
              <div
                key={tab.id}
                className={`editor-workspace-tab-pane${
                  tab.id === activeTabId
                    ? ' editor-workspace-tab-pane--active'
                    : ''
                }`}
              >
                <EditorPane
                  filePath={tab.filePath}
                  isActive={tab.id === activeTabId}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="editor-workspace-empty">
            <VscodeIcon name="files" size={48} />
            <VscodeLabel>在左侧选择文件以打开</VscodeLabel>
          </div>
        )}
        {/* Monaco 单例始终存在于 DOM 中，避免首次打开文件时重新初始化 */}
        <div
          className={`shared-monaco-layer${showSharedMonaco ? '' : ' shared-monaco-layer--hidden'}`}
          aria-hidden={!showSharedMonaco}
        >
          <MonacoTextEditor
            filePath={showSharedMonaco ? (activeTab?.filePath ?? '') : ''}
            tabId={activeTab?.id ?? ''}
            dirty={activeTab?.dirty ?? false}
            readOnly={false}
            visible={showSharedMonaco}
            onDirtyChange={handleDirtyChange}
          />
        </div>
      </div>
    </div>
  );
}
