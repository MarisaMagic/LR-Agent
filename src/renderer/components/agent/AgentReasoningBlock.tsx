import { VscodeIcon } from '@vscode-elements/react-elements';
import type { MessageBlock } from '../../types/agent';
import AgentMarkdown from './AgentMarkdown';
import './AgentReasoningBlock.css';

interface AgentReasoningBlockProps {
  block: Extract<MessageBlock, { type: 'reasoning' }>;
  streaming?: boolean;
  onToggle: () => void;
}

export default function AgentReasoningBlock({
  block,
  streaming = false,
  onToggle,
}: AgentReasoningBlockProps) {
  const label = streaming
    ? '思考中…'
    : block.content.trim()
      ? '已思考'
      : '思考过程';

  return (
    <div className="agent-reasoning-block">
      <button type="button" className="agent-reasoning-toggle" onClick={onToggle}>
        <VscodeIcon
          name={block.collapsed ? 'chevron-right' : 'chevron-down'}
          size={12}
        />
        <span>{label}</span>
      </button>
      {!block.collapsed && block.content.trim() && (
        <div className="agent-reasoning-body">
          <AgentMarkdown content={block.content} />
        </div>
      )}
    </div>
  );
}
