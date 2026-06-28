import { basename } from '../../types/file';
import FileTypeIcon from '../FileTypeIcon';
import './EditorTabBar.css';

interface EditorTabBarProps {
  tabs: Array<{
    id: string;
    filePath: string;
    dirty: boolean;
    preview: boolean;
  }>;
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onPinTab?: (tabId: string) => void;
}

export default function EditorTabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onPinTab,
}: EditorTabBarProps) {
  if (tabs.length === 0) return null;

  return (
    <div className="editor-tab-bar" role="tablist">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const name = basename(tab.filePath);
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            className={`editor-tab${active ? ' editor-tab--active' : ''}${
              tab.preview ? ' editor-tab--preview' : ''
            }`}
            onDoubleClick={() => onPinTab?.(tab.id)}
          >
            <button
              type="button"
              className="editor-tab-main"
              onClick={() => onSelectTab(tab.id)}
              title={tab.filePath}
            >
              <FileTypeIcon path={tab.filePath} size={14} />
              <span className="editor-tab-name">{name}</span>
              {tab.dirty ? (
                <span className="editor-tab-dirty" aria-label="未保存">
                  ●
                </span>
              ) : null}
            </button>
            <button
              type="button"
              className="editor-tab-close"
              aria-label={`关闭 ${name}`}
              onClick={(event) => {
                event.stopPropagation();
                onCloseTab(tab.id);
              }}
            >
              <span className="codicon codicon-close" aria-hidden />
            </button>
          </div>
        );
      })}
    </div>
  );
}
