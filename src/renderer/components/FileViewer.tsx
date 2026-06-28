import {
  VscodeButton,
  VscodeIcon,
  VscodeLabel,
  VscodeProgressRing,
  VscodeScrollable,
} from '@vscode-elements/react-elements';
import mammoth from 'mammoth';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Document, Page, pdfjs } from 'react-pdf';
import { useApp } from '../context/AppContext';
import { useAnnotationWorkspace } from '../context/AnnotationWorkspaceContext';
import { basename, getExtension } from '../types/file';
import { getHighlightLanguage } from '../utils/syntaxHighlight';
import { createMarkdownCodeComponents } from './markdown/markdownCodeComponents';
import {
  getAdjacentSiblingFile,
  listSiblingFiles,
} from '../utils/siblingFiles';
import HighlightedCodeBlock from './preview/HighlightedCodeBlock';
import ImageFabricAnnotationEditor from './annotation/ImageFabricAnnotationEditor';
import ImageFabricRotatedBboxAnnotationEditor from './annotation/ImageFabricRotatedBboxAnnotationEditor';
import ImageFabricPolygonAnnotationEditor from './annotation/ImageFabricPolygonAnnotationEditor';
import ImageFabricKeypointAnnotationEditor from './annotation/ImageFabricKeypointAnnotationEditor';
import FileTypeIcon from './FileTypeIcon';
import 'react-pdf/dist/Page/TextLayer.css';
import VscodeClickableToolbarButton from './VscodeClickableButton';
import ContextMenu, { type ContextMenuItem } from './ContextMenu';
import './FileViewer.css';

pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'bmp',
  'ico',
]);

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);
const DOCX_EXTENSIONS = new Set(['docx']);

const PREVIEW_BINARY_EXTENSIONS = new Set(['pdf', ...IMAGE_EXTENSIONS]);

type ViewerType =
  | 'empty'
  | 'markdown'
  | 'pdf'
  | 'image'
  | 'docx'
  | 'text'
  | 'unsupported';

function getViewerType(filePath: string | null): ViewerType {
  if (!filePath) return 'empty';
  const ext = getExtension(filePath);
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (DOCX_EXTENSIONS.has(ext)) return 'docx';
  if (ext) return 'text';
  return 'unsupported';
}

/** 检查选区是否在 viewer-body 容器内 */
function isSelectionInsideViewer(containerEl: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return false;
  const { anchorNode, focusNode } = sel;
  return (
    (anchorNode && containerEl.contains(anchorNode)) ||
    (focusNode && containerEl.contains(focusNode))
  );
}

/** 选中 viewer-body 内所有文本 */
function selectAllInViewer(containerEl: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(containerEl);
  const sel = window.getSelection();
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
  // 聚焦主区域确保接收后续键盘事件
  containerEl.closest<HTMLElement>('.file-viewer')?.focus();
}

function FileHeader({
  filePath,
  fileName,
  onSelectFile,
}: {
  filePath: string;
  fileName: string;
  onSelectFile: (filePath: string) => void;
}) {
  const [canNavigate, setCanNavigate] = useState(false);

  useEffect(() => {
    let cancelled = false;

    listSiblingFiles(filePath).then((siblings) => {
      if (!cancelled) {
        setCanNavigate(siblings.length > 1);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  const navigateSibling = useCallback(
    async (direction: 'prev' | 'next') => {
      const nextPath = await getAdjacentSiblingFile(filePath, direction);
      if (nextPath) {
        onSelectFile(nextPath);
      }
    },
    [filePath, onSelectFile],
  );

  return (
    <div className="file-header">
      <div className="file-header-left">
        <FileTypeIcon path={filePath} size={16} className="file-header-icon" />
        <span className="file-header-name" title={filePath}>
          {fileName}
        </span>
      </div>
      <div
        className={`file-header-nav${canNavigate ? '' : ' file-header-nav--disabled'}`}
      >
        <VscodeClickableToolbarButton
          icon="chevron-left"
          label="上一个文件"
          onClick={() => {
            void navigateSibling('prev');
          }}
        />
        <VscodeClickableToolbarButton
          icon="chevron-right"
          label="下一个文件"
          onClick={() => {
            void navigateSibling('next');
          }}
        />
      </div>
      <div className="file-header-right" aria-hidden="true" />
    </div>
  );
}

interface FileViewerProps {
  filePath: string | null;
}

export default function FileViewer({ filePath }: FileViewerProps) {
  const { selectFile } = useApp();
  const annotationWorkspace = useAnnotationWorkspace();
  const showImageAnnotator = annotationWorkspace.workspaceEnabled;
  const isPolygonAnnotator =
    annotationWorkspace.imageAnnotationType === 'polygon';
  const isRotatedBboxAnnotator =
    annotationWorkspace.imageAnnotationType === 'rotated_bbox';
  const isKeypointAnnotator =
    annotationWorkspace.imageAnnotationType === 'keypoint';
  const viewerType = useMemo(() => getViewerType(filePath), [filePath]);
  const markdownComponents = useMemo(() => createMarkdownCodeComponents(), []);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [docxHtml, setDocxHtml] = useState<string | null>(null);
  const [binaryUrl, setBinaryUrl] = useState<string | null>(null);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── 选区与右键菜单 ──
  const viewerRef = useRef<HTMLDivElement>(null);
  const viewerBodyRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [hasSelection, setHasSelection] = useState(false);

  // 监听选区变化
  useEffect(() => {
    const onSelectionChange = () => {
      const body = viewerBodyRef.current;
      if (!body) {
        setHasSelection(false);
        return;
      }
      setHasSelection(isSelectionInsideViewer(body));
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () =>
      document.removeEventListener('selectionchange', onSelectionChange);
  }, [filePath]);

  // 点击时聚焦主区域
  const handleMainClick = useCallback(() => {
    viewerRef.current?.focus();
  }, []);

  // 键盘处理
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const body = viewerBodyRef.current;
      if (!body) return;

      switch (e.key.toLowerCase()) {
        case 'a':
          e.preventDefault();
          selectAllInViewer(body);
          break;
        case 'c':
          e.preventDefault();
          document.execCommand('copy');
          break;
        case 'x':
          e.preventDefault();
          document.execCommand('cut');
          break;
        case 'v':
          e.preventDefault();
          document.execCommand('paste');
          break;
        default:
          break;
      }
    },
    [],
  );

  // 右键菜单
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const sel = window.getSelection();
      const body = viewerBodyRef.current;
      if (!body || !sel || sel.isCollapsed || !isSelectionInsideViewer(body)) {
        return;
      }
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY });
    },
    [],
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    return [
      {
        id: 'cut',
        label: '剪切',
        shortcut: 'Ctrl+X',
        disabled: !hasSelection,
        onClick: () => {
          document.execCommand('cut');
        },
      },
      {
        id: 'copy',
        label: '复制',
        shortcut: 'Ctrl+C',
        disabled: !hasSelection,
        onClick: () => {
          document.execCommand('copy');
        },
      },
      {
        id: 'paste',
        label: '粘贴',
        shortcut: 'Ctrl+V',
        onClick: () => {
          document.execCommand('paste');
        },
      },
    ];
  }, [hasSelection]);

  // ── Edit 菜单 IPC ──
  useEffect(() => {
    const unsubs: (() => void)[] = [];
    const actions: Record<string, () => void> = {
      'edit:undo': () => document.execCommand('undo'),
      'edit:redo': () => document.execCommand('redo'),
      'edit:cut': () => document.execCommand('cut'),
      'edit:copy': () => document.execCommand('copy'),
      'edit:paste': () => document.execCommand('paste'),
      'edit:selectAll': () => {
        const body = viewerBodyRef.current;
        if (body) selectAllInViewer(body);
      },
    };

    for (const [channel, fn] of Object.entries(actions)) {
      const unsub = window.electron.ipcRenderer.on(channel, () => {
        // 聚焦主区域
        viewerRef.current?.focus();
        fn();
      });
      unsubs.push(unsub);
    }

    return () => unsubs.forEach((u) => u());
  }, [filePath]);

  const highlightLanguage = useMemo(
    () => (filePath ? getHighlightLanguage(filePath) : null),
    [filePath],
  );

  useEffect(() => {
    setTextContent(null);
    setDocxHtml(null);
    setBinaryUrl(null);
    setPdfData(null);
    setNumPages(null);
    setError(null);

    if (!filePath) return undefined;

    let revoked = false;
    let objectUrl: string | null = null;

    const load = async () => {
      setLoading(true);
      try {
        if (viewerType === 'markdown' || viewerType === 'text') {
          const text = await window.electron.fileSystem?.readFile(filePath);
          if (revoked) return;
          if (text === null) {
            setError('无法读取文件');
          } else {
            setTextContent(text);
          }
          return;
        }

        if (viewerType === 'docx') {
          const buffer =
            await window.electron.fileSystem?.readFileBuffer(filePath);
          if (revoked) return;
          if (!buffer) {
            setError('无法读取文件');
            return;
          }
          const result = await mammoth.convertToHtml({
            arrayBuffer: buffer,
          });
          if (revoked) return;
          setDocxHtml(result.value);
          return;
        }

        if (
          viewerType === 'pdf' ||
          viewerType === 'image' ||
          PREVIEW_BINARY_EXTENSIONS.has(getExtension(filePath))
        ) {
          const buffer =
            await window.electron.fileSystem?.readFileBuffer(filePath);
          if (revoked) return;
          if (!buffer) {
            setError('无法读取文件');
            return;
          }
          if (viewerType === 'pdf') {
            setPdfData(new Uint8Array(buffer));
            return;
          }
          const blob = new Blob([buffer]);
          objectUrl = URL.createObjectURL(blob);
          setBinaryUrl(objectUrl);
          return;
        }

        setError('暂不支持预览此文件类型');
      } catch {
        if (!revoked) setError('加载文件时出错');
      } finally {
        if (!revoked) setLoading(false);
      }
    };

    load();

    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [filePath, viewerType]);

  const handleOpenExternal = async () => {
    if (!filePath) return;
    const err = await window.electron.fileSystem?.openPath(filePath);
    if (err) setError(`无法用系统打开: ${err}`);
  };

  // ── 渲染内容区（body） ──

  const renderBody = () => {
    let body: React.ReactNode = null;
    if (loading) {
      body = (
        <div className="viewer-body loading">
          <VscodeProgressRing />
          <VscodeLabel>加载中...</VscodeLabel>
        </div>
      );
    } else if (error && viewerType !== 'unsupported') {
      body = (
        <div className="viewer-body error-state">
          <VscodeIcon name="warning" size={32} />
          <VscodeLabel>{error}</VscodeLabel>
          <VscodeButton icon="link-external" onClick={handleOpenExternal}>
            用系统应用打开
          </VscodeButton>
        </div>
      );
    } else if (viewerType === 'pdf' && pdfData) {
      body = (
        <VscodeScrollable className="viewer-body pdf-container">
          <Document
            file={{ data: pdfData }}
            onLoadSuccess={({ numPages: pages }) => setNumPages(pages)}
            onLoadError={() => setError('无法加载 PDF')}
            error="无法加载 PDF 文件"
          >
            {Array.from(new Array(numPages || 0), (_, index) => (
              <Page key={`page_${index + 1}`} pageNumber={index + 1} />
            ))}
          </Document>
        </VscodeScrollable>
      );
    } else if (viewerType === 'image' && binaryUrl) {
      body = (
        <div className="viewer-body image-container image-container--fabric">
          {showImageAnnotator ? (
            isKeypointAnnotator ? (
              <ImageFabricKeypointAnnotationEditor
                imageUrl={binaryUrl}
                imagePath={filePath!}
              />
            ) : isPolygonAnnotator ? (
              <ImageFabricPolygonAnnotationEditor
                imageUrl={binaryUrl}
                imagePath={filePath!}
              />
            ) : isRotatedBboxAnnotator ? (
              <ImageFabricRotatedBboxAnnotationEditor
                imageUrl={binaryUrl}
                imagePath={filePath!}
              />
            ) : (
              <ImageFabricAnnotationEditor
                imageUrl={binaryUrl}
                imagePath={filePath!}
              />
            )
          ) : (
            <img
              src={binaryUrl}
              alt={fileName}
              className="image-preview-only"
            />
          )}
        </div>
      );
    } else if (viewerType === 'markdown') {
      body = (
        <VscodeScrollable className="viewer-body markdown-content">
          {textContent ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {textContent}
            </ReactMarkdown>
          ) : (
            <div className="loading">
              <VscodeProgressRing />
            </div>
          )}
        </VscodeScrollable>
      );
    } else if (viewerType === 'docx' && docxHtml) {
      body = (
        <VscodeScrollable className="viewer-body docx-content">
          <div
            className="docx-html"
            dangerouslySetInnerHTML={{ __html: docxHtml }}
          />
        </VscodeScrollable>
      );
    } else if (viewerType === 'text' && textContent !== null) {
      body = (
        <VscodeScrollable className="viewer-body text-content">
          {highlightLanguage ? (
            <HighlightedCodeBlock content={textContent} filePath={filePath!} />
          ) : (
            <pre className="code-block">{textContent}</pre>
          )}
        </VscodeScrollable>
      );
    } else {
      body = (
        <div className="viewer-body error-state">
          <VscodeIcon name="file-binary" size={32} />
          <VscodeLabel>{error || '暂不支持预览此文件类型'}</VscodeLabel>
          <VscodeButton icon="link-external" onClick={handleOpenExternal}>
            用系统应用打开
          </VscodeButton>
        </div>
      );
    }
    return (
      <div ref={viewerBodyRef} className="file-viewer-body-inner">
        {body}
      </div>
    );
  };

  if (!filePath) {
    return (
      <div className="file-viewer-empty">
        <VscodeIcon name="files" size={48} />
        <VscodeLabel>在左侧选择文件以预览</VscodeLabel>
      </div>
    );
  }

  const fileName = basename(filePath);
  const fileHeaderProps = {
    filePath,
    fileName,
    onSelectFile: selectFile,
  };

  return (
    <div
      ref={viewerRef}
      className="file-viewer"
      tabIndex={0}
      onClick={handleMainClick}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
    >
      <FileHeader {...fileHeaderProps} />
      {renderBody()}
      {contextMenu && (
        <ContextMenu
          items={contextMenuItems}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
