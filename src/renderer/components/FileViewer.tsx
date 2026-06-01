import {
  VscodeButton,
  VscodeIcon,
  VscodeLabel,
  VscodeProgressRing,
  VscodeScrollable,
} from '@vscode-elements/react-elements';
import mammoth from 'mammoth';
import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Document, Page, pdfjs } from 'react-pdf';
import { useApp } from '../context/AppContext';
import { useAnnotationWorkspace } from '../context/AnnotationWorkspaceContext';
import { basename, getExtension } from '../types/file';
import { getHighlightLanguage } from '../utils/syntaxHighlight';
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileHeader({
  filePath,
  fileName,
  fileSize,
  onSelectFile,
}: {
  filePath: string;
  fileName: string;
  fileSize: number | null;
  onSelectFile: (filePath: string) => void;
}) {
  const sizeLabel = fileSize !== null ? ` (${formatBytes(fileSize)})` : '';
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

  const handleCopyPath = async () => {
    await navigator.clipboard.writeText(filePath);
  };

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
      <FileTypeIcon path={filePath} size={16} className="file-header-icon" />
      <span className="file-header-name" title={filePath}>
        {fileName}
        {sizeLabel}
      </span>
      <VscodeButton
        secondary
        icon="copy"
        onClick={handleCopyPath}
        className="file-header-copy-btn"
      >
        复制路径
      </VscodeButton>
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
  const [textContent, setTextContent] = useState<string | null>(null);
  const [docxHtml, setDocxHtml] = useState<string | null>(null);
  const [binaryUrl, setBinaryUrl] = useState<string | null>(null);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);

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
    setFileSize(null);

    if (!filePath) return undefined;

    let revoked = false;
    let objectUrl: string | null = null;

    const load = async () => {
      setLoading(true);
      try {
        const stats = await window.electron.fileSystem?.getFileStats(filePath);
        if (stats) setFileSize(stats.size);

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
    fileSize,
    onSelectFile: selectFile,
  };

  if (loading) {
    return (
      <div className="file-viewer">
        <FileHeader {...fileHeaderProps} />
        <div className="viewer-body loading">
          <VscodeProgressRing />
          <VscodeLabel>加载中...</VscodeLabel>
        </div>
      </div>
    );
  }

  if (error && viewerType !== 'unsupported') {
    return (
      <div className="file-viewer">
        <FileHeader {...fileHeaderProps} />
        <div className="viewer-body error-state">
          <VscodeIcon name="warning" size={32} />
          <VscodeLabel>{error}</VscodeLabel>
          <VscodeButton icon="link-external" onClick={handleOpenExternal}>
            用系统应用打开
          </VscodeButton>
        </div>
      </div>
    );
  }

  if (viewerType === 'pdf' && pdfData) {
    return (
      <div className="file-viewer pdf-viewer">
        <FileHeader {...fileHeaderProps} />
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
      </div>
    );
  }

  if (viewerType === 'image' && binaryUrl) {
    return (
      <div className="file-viewer image-viewer">
        <FileHeader {...fileHeaderProps} />
        <div className="viewer-body image-container image-container--fabric">
          {showImageAnnotator ? (
            isKeypointAnnotator ? (
              <ImageFabricKeypointAnnotationEditor
                imageUrl={binaryUrl}
                imagePath={filePath}
              />
            ) : isPolygonAnnotator ? (
              <ImageFabricPolygonAnnotationEditor
                imageUrl={binaryUrl}
                imagePath={filePath}
              />
            ) : isRotatedBboxAnnotator ? (
              <ImageFabricRotatedBboxAnnotationEditor
                imageUrl={binaryUrl}
                imagePath={filePath}
              />
            ) : (
              <ImageFabricAnnotationEditor
                imageUrl={binaryUrl}
                imagePath={filePath}
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
      </div>
    );
  }

  if (viewerType === 'markdown') {
    return (
      <div className="file-viewer markdown-viewer">
        <FileHeader {...fileHeaderProps} />
        <VscodeScrollable className="viewer-body markdown-content">
          {textContent ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {textContent}
            </ReactMarkdown>
          ) : (
            <div className="loading">
              <VscodeProgressRing />
            </div>
          )}
        </VscodeScrollable>
      </div>
    );
  }

  if (viewerType === 'docx' && docxHtml) {
    return (
      <div className="file-viewer docx-viewer">
        <FileHeader {...fileHeaderProps} />
        <VscodeScrollable className="viewer-body docx-content">
          <div
            className="docx-html"
            dangerouslySetInnerHTML={{ __html: docxHtml }}
          />
        </VscodeScrollable>
      </div>
    );
  }

  if (viewerType === 'text' && textContent !== null) {
    return (
      <div className="file-viewer text-viewer">
        <FileHeader {...fileHeaderProps} />
        <VscodeScrollable className="viewer-body text-content">
          {highlightLanguage ? (
            <HighlightedCodeBlock content={textContent} filePath={filePath} />
          ) : (
            <pre className="code-block">{textContent}</pre>
          )}
        </VscodeScrollable>
      </div>
    );
  }

  return (
    <div className="file-viewer">
      <FileHeader {...fileHeaderProps} />
      <div className="viewer-body error-state">
        <VscodeIcon name="file-binary" size={32} />
        <VscodeLabel>{error || '暂不支持预览此文件类型'}</VscodeLabel>
        <VscodeButton icon="link-external" onClick={handleOpenExternal}>
          用系统应用打开
        </VscodeButton>
      </div>
    </div>
  );
}
