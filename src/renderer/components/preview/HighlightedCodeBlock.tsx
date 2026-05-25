import { useMemo } from 'react';
import { highlightCode } from '../../utils/syntaxHighlight';
import './HighlightedCodeBlock.css';

interface HighlightedCodeBlockProps {
  content: string;
  filePath: string;
}

export default function HighlightedCodeBlock({
  content,
  filePath,
}: HighlightedCodeBlockProps) {
  const html = useMemo(
    () => highlightCode(content, filePath),
    [content, filePath],
  );

  return (
    <pre className="hljs code-block highlighted-code-block">
      <code dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}
