import { useMemo } from 'react';
import type { DiffDisplayLine } from '../../utils/fileDiffStats';
import { highlightCode } from '../../utils/syntaxHighlight';
import './AgentFileChangeBlock.css';

function isEllipsisLine(text: string): boolean {
  return text === '…' || text.startsWith('… 省略');
}

function DiffLineContent({
  text,
  relativePath,
}: {
  text: string;
  relativePath: string;
}) {
  const html = useMemo(() => {
    if (!text || isEllipsisLine(text)) return null;
    return highlightCode(text, relativePath);
  }, [text, relativePath]);

  if (html === null) {
    return (
      <span className="agent-file-change-block__diff-plain">{text || ' '}</span>
    );
  }

  return (
    <code
      className="agent-file-change-block__diff-code"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function AgentFileDiffLines({
  lines,
  relativePath,
}: {
  lines: DiffDisplayLine[];
  relativePath: string;
}) {
  return (
    <>
      {lines.map((line, index) => (
        <div
          key={`${line.kind}-${index}`}
          className={`agent-file-change-block__diff-line${
            line.kind === 'added'
              ? ' agent-file-change-block__diff-line--added'
              : line.kind === 'removed'
                ? ' agent-file-change-block__diff-line--removed'
                : ''
          }`}
        >
          <span className="agent-file-change-block__diff-prefix">
            {line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}
          </span>
          <DiffLineContent text={line.text} relativePath={relativePath} />
        </div>
      ))}
    </>
  );
}

export default function AgentFileDiffView({
  lines,
  relativePath,
  fill,
}: {
  lines: DiffDisplayLine[];
  relativePath: string;
  fill?: boolean;
}) {
  return (
    <pre
      className={`agent-file-change-block__diff${
        fill ? ' agent-file-diff-view--fill' : ''
      }`}
    >
      <AgentFileDiffLines lines={lines} relativePath={relativePath} />
    </pre>
  );
}
