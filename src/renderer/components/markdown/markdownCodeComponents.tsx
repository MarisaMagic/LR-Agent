import type { ReactNode } from 'react';
import type { Components } from 'react-markdown';
import AgentScrollablePre from '../agent/AgentScrollablePre';
import { highlightMarkdownCode } from '../../utils/syntaxHighlight';
import MarkdownLocalImage from './MarkdownLocalImage';

export interface MarkdownCodeComponentsOptions {
  overlayHorizontalScroll?: boolean;
  /** Markdown 文件所在目录，用于解析相对路径图片 */
  imageBaseDir?: string | null;
  imageClassName?: string;
  resolveImagePath?: (baseDir: string, src: string) => string | null;
}

function extractLanguage(className?: string): string | null {
  const match = /language-([\w-]+)/.exec(className ?? '');
  return match?.[1] ?? null;
}

function normalizeCodeContent(children: ReactNode): string {
  return String(children).replace(/\n$/, '');
}

export function createMarkdownCodeComponents(
  options: MarkdownCodeComponentsOptions = {},
): Components {
  const {
    overlayHorizontalScroll = false,
    imageBaseDir,
    imageClassName,
    resolveImagePath,
  } = options;

  const components: Components = {
    pre({ children, ...props }) {
      if (overlayHorizontalScroll) {
        return <AgentScrollablePre {...props}>{children}</AgentScrollablePre>;
      }
      return <pre {...props}>{children}</pre>;
    },
    code({ className, children, ...props }) {
      const language = extractLanguage(className);
      const content = normalizeCodeContent(children);
      const isBlock =
        language != null || content.includes('\n');

      if (isBlock) {
        const html = highlightMarkdownCode(content, language);
        const hljsClassName = language
          ? `hljs language-${language}`
          : 'hljs';
        return (
          <code
            className={[hljsClassName, className].filter(Boolean).join(' ')}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      }

      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
  };

  if (imageBaseDir !== undefined) {
    components.img = ({ src, alt }) => (
      <MarkdownLocalImage
        src={src}
        alt={alt}
        baseDir={imageBaseDir}
        className={imageClassName}
        resolveAbsolutePath={resolveImagePath}
      />
    );
  }

  return components;
}
