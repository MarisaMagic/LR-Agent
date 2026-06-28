import { useCallback, useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import { useTheme } from '../../context/ThemeContext';
import { getHighlightLanguage } from '../../utils/syntaxHighlight';
import {
  scheduleEditorLayout,
  waitForEditorContainer,
} from './monacoEditorHelpers';
import './MonacoTextEditor.css';

/** Align with --vscode-font-size (15px) in annotation preview. */
const EDITOR_FONT_SIZE = 15;
const EDITOR_LINE_HEIGHT = 22;

interface MonacoTextEditorProps {
  filePath: string;
  tabId: string;
  initialContent?: string;
  dirty?: boolean;
  readOnly?: boolean;
  visible?: boolean;
  onDirtyChange: (tabId: string, dirty: boolean, content: string) => void;
}

export default function MonacoTextEditor({
  filePath,
  tabId,
  initialContent,
  dirty = false,
  readOnly = false,
  visible = true,
  onDirtyChange,
}: MonacoTextEditorProps) {
  const { effectiveTheme } = useTheme();
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const modelsRef = useRef(new Map<string, monaco.editor.ITextModel>());
  const savedContentByPathRef = useRef(new Map<string, string>());
  const viewStateByPathRef = useRef(
    new Map<string, monaco.editor.ICodeEditorViewState | null>(),
  );
  const currentPathRef = useRef('');
  const currentTabIdRef = useRef(tabId);
  const onDirtyChangeRef = useRef(onDirtyChange);
  const applyingModelChangeRef = useRef(false);
  const disposablesRef = useRef<monaco.IDisposable[]>([]);
  const loadGenerationRef = useRef(0);
  const readOnlyRef = useRef(readOnly);
  const themeRef = useRef(effectiveTheme);

  currentTabIdRef.current = tabId;
  onDirtyChangeRef.current = onDirtyChange;
  readOnlyRef.current = readOnly;
  themeRef.current = effectiveTheme;

  const getLanguage = useCallback((path: string) => {
    return getHighlightLanguage(path) ?? 'plaintext';
  }, []);

  const ensureEditor = useCallback(async (): Promise<monaco.editor.IStandaloneCodeEditor | null> => {
    if (editorRef.current) return editorRef.current;
    const container = containerRef.current;
    if (!container) return null;

    const ready = await waitForEditorContainer(container, () => !containerRef.current);
    if (!ready || !containerRef.current) return null;
    if (editorRef.current) return editorRef.current;

    const editorInstance = monaco.editor.create(containerRef.current, {
      readOnly: readOnlyRef.current,
      minimap: { enabled: true },
      fontSize: EDITOR_FONT_SIZE,
      lineHeight: EDITOR_LINE_HEIGHT,
      wordWrap: 'on',
      automaticLayout: true,
      scrollBeyondLastLine: false,
      tabSize: 2,
      theme:
        themeRef.current === 'dark' ? 'lr-agent-dark' : 'lr-agent-light',
    });
    editorRef.current = editorInstance;

    const changeDisposable = editorInstance.onDidChangeModelContent(() => {
      if (applyingModelChangeRef.current) return;
      const path = currentPathRef.current;
      const currentTabId = currentTabIdRef.current;
      const model = editorInstance.getModel();
      if (!path || !currentTabId || !model) return;

      const next = model.getValue();
      const saved = savedContentByPathRef.current.get(path) ?? '';
      onDirtyChangeRef.current(currentTabId, next !== saved, next);
    });
    disposablesRef.current.push(changeDisposable);

    scheduleEditorLayout(editorInstance);
    return editorInstance;
  }, []);

  useEffect(() => {
    return () => {
      disposablesRef.current.forEach((disposable) => disposable.dispose());
      disposablesRef.current = [];
      editorRef.current?.dispose();
      editorRef.current = null;
      modelsRef.current.forEach((model) => model.dispose());
      modelsRef.current.clear();
      savedContentByPathRef.current.clear();
      viewStateByPathRef.current.clear();
      currentPathRef.current = '';
    };
  }, []);

  useEffect(() => {
    const editorInstance = editorRef.current;
    if (!editorInstance) return;
    editorInstance.updateOptions({ readOnly });
  }, [readOnly]);

  useEffect(() => {
    const editorInstance = editorRef.current;
    if (!editorInstance) return;
    monaco.editor.setTheme(
      effectiveTheme === 'dark' ? 'lr-agent-dark' : 'lr-agent-light',
    );
  }, [effectiveTheme]);

  useEffect(() => {
    if (!visible || !filePath) {
      setLoading(false);
      return undefined;
    }

    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    let cancelled = false;
    setLoading(true);

    const isStale = () =>
      cancelled || generation !== loadGenerationRef.current;

    const run = async () => {
      const editorInstance = await ensureEditor();
      if (isStale() || !editorInstance) return;

      const previousPath = currentPathRef.current;
      if (previousPath && previousPath !== filePath) {
        viewStateByPathRef.current.set(
          previousPath,
          editorInstance.saveViewState(),
        );
      }

      const existingModel = modelsRef.current.get(filePath);
      const existingContent = existingModel?.getValue();
      if (
        existingModel &&
        (initialContent === undefined || existingContent === initialContent)
      ) {
        if (isStale()) return;
        currentPathRef.current = filePath;
        editorInstance.setModel(existingModel);
        const viewState = viewStateByPathRef.current.get(filePath);
        if (viewState) editorInstance.restoreViewState(viewState);
        scheduleEditorLayout(editorInstance);
        setLoading(false);
        return;
      }

      let next = initialContent;
      if (next === undefined) {
        next = (await window.electron.fileSystem?.readFile(filePath)) ?? '';
      }
      if (isStale()) return;

      const uri = monaco.Uri.file(filePath);
      let model =
        modelsRef.current.get(filePath) ?? monaco.editor.getModel(uri);
      if (!model) {
        model = monaco.editor.createModel(next, getLanguage(filePath), uri);
        savedContentByPathRef.current.set(filePath, next);
      }
      modelsRef.current.set(filePath, model);

      if (initialContent !== undefined && model.getValue() !== next) {
        applyingModelChangeRef.current = true;
        try {
          model.setValue(next);
        } finally {
          applyingModelChangeRef.current = false;
        }
      }

      if (!savedContentByPathRef.current.has(filePath)) {
        savedContentByPathRef.current.set(filePath, next);
      }

      if (isStale()) return;

      monaco.editor.setModelLanguage(model, getLanguage(filePath));
      currentPathRef.current = filePath;
      editorInstance.setModel(model);
      const viewState = viewStateByPathRef.current.get(filePath);
      if (viewState) editorInstance.restoreViewState(viewState);
      scheduleEditorLayout(editorInstance);
      setLoading(false);
    };

    run().catch((error: unknown) => {
      if (isStale()) return;
      // eslint-disable-next-line no-console
      console.warn('[MonacoTextEditor] load failed:', filePath, error);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [ensureEditor, filePath, getLanguage, initialContent, visible]);

  useEffect(() => {
    if (!visible || !editorRef.current) return;
    scheduleEditorLayout(editorRef.current);
  }, [visible]);

  useEffect(() => {
    const editorInstance = editorRef.current;
    if (!editorInstance || !filePath || dirty) return;
    const model = modelsRef.current.get(filePath);
    if (!model) return;
    savedContentByPathRef.current.set(filePath, model.getValue());
  }, [dirty, filePath]);

  return (
    <div className="monaco-text-editor">
      <div ref={containerRef} className="monaco-text-editor-container" />
      {loading ? (
        <div className="monaco-text-editor-loading">加载中…</div>
      ) : null}
    </div>
  );
}
