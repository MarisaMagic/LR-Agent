import { useWorkMode } from '../../context/WorkModeContext';
import { isMonacoEditableFile } from '../../utils/editorFileTypes';
import FileViewer from '../FileViewer';
import './EditorPane.css';

interface EditorPaneProps {
  filePath: string;
  isActive: boolean;
}

export default function EditorPane({
  filePath,
  isActive,
}: EditorPaneProps) {
  const { workMode } = useWorkMode();
  const monacoEligible = isMonacoEditableFile(filePath);
  const loadPaused = !isActive;

  const hideFileHeader = workMode === 'editor';

  if (!monacoEligible) {
    return (
      <FileViewer
        filePath={filePath}
        embedded
        hideFileHeader={hideFileHeader}
        loadPaused={loadPaused}
      />
    );
  }

  if (workMode === 'annotation') {
    return (
      <FileViewer
        filePath={filePath}
        embedded
        hideFileHeader={hideFileHeader}
        loadPaused={loadPaused}
      />
    );
  }

  return <div className="editor-pane editor-pane--monaco-host" aria-hidden />;
}
