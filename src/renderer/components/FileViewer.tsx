import {
  VscodeButton,
  VscodeIcon,
  VscodeLabel,
  VscodeProgressRing,
  VscodeScrollable,
} from '@vscode-elements/react-elements';
import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Document, Page, pdfjs } from 'react-pdf';
import { basename, getExtension } from '../types/file';
import FileTypeIcon from './FileTypeIcon';
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

const PREVIEW_BINARY_EXTENSIONS = new Set(['pdf', ...IMAGE_EXTENSIONS]);

type ViewerType =
  | 'empty'
  | 'markdown'
  | 'pdf'
  | 'image'
  | 'text'
  | 'unsupported';

function getViewerType(filePath: string | null): ViewerType {
  if (!filePath) return 'empty';
  const ext = getExtension(filePath);
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
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
}: {
  filePath: string;
  fileName: string;
  fileSize: number | null;
}) {
  const sizeLabel = fileSize !== null ? ` (${formatBytes(fileSize)})` : '';

  const handleCopyPath = async () => {
    await navigator.clipboard.writeText(filePath);
  };

  return (
    <div className="file-header">
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
  const viewerType = useMemo(() => getViewerType(filePath), [filePath]);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [binaryUrl, setBinaryUrl] = useState<string | null>(null);
  const [pdfData, setPdfData] = useState<Uint8Array | null>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);

  useEffect(() => {
    setTextContent(null);
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

  if (loading) {
    return (
      <div className="file-viewer">
        <FileHeader
          filePath={filePath}
          fileName={fileName}
          fileSize={fileSize}
        />
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
        <FileHeader
          filePath={filePath}
          fileName={fileName}
          fileSize={fileSize}
        />
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
        <FileHeader
          filePath={filePath}
          fileName={fileName}
          fileSize={fileSize}
        />
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
        <FileHeader
          filePath={filePath}
          fileName={fileName}
          fileSize={fileSize}
        />
        <div className="viewer-body image-container">
          <img src={binaryUrl} alt={fileName} />
        </div>
      </div>
    );
  }

  if (viewerType === 'markdown') {
    return (
      <div className="file-viewer markdown-viewer">
        <FileHeader
          filePath={filePath}
          fileName={fileName}
          fileSize={fileSize}
        />
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

  if (viewerType === 'text' && textContent !== null) {
    return (
      <div className="file-viewer text-viewer">
        <FileHeader
          filePath={filePath}
          fileName={fileName}
          fileSize={fileSize}
        />
        <VscodeScrollable className="viewer-body text-content">
          <pre className="code-block">{textContent}</pre>
        </VscodeScrollable>
      </div>
    );
  }

  return (
    <div className="file-viewer">
      <FileHeader filePath={filePath} fileName={fileName} fileSize={fileSize} />
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
