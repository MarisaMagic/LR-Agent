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
  return (
    <div className="agent-reasoning-block">
      <button type="button" className="agent-block-toggle" onClick={onToggle}>
        <VscodeIcon
          name={block.collapsed ? 'chevron-right' : 'chevron-down'}
          size={14}
        />
        <span>思考过程{streaming ? '…' : ''}</span>
      </button>
      {!block.collapsed && (
        <div className="agent-reasoning-body">
          <AgentMarkdown content={block.content || ' ' } />
        </div>
      )}
    </div>
  );
}
