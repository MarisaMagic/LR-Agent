import { VscodeIcon } from '@vscode-elements/react-elements';
import type { MessageBlock } from '../../types/agent';
import './AgentReasoningBlock.css'; /* shared tool + reasoning tokens */

interface AgentToolCallBlockProps {
  block: Extract<MessageBlock, { type: 'tool_call' }>;
  onToggle: () => void;
}

export default function AgentToolCallBlock({
  block,
  onToggle,
}: AgentToolCallBlockProps) {
  return (
    <div className="agent-tool-block">
      <button type="button" className="agent-block-toggle" onClick={onToggle}>
        <VscodeIcon
          name={block.collapsed ? 'chevron-right' : 'chevron-down'}
          size={12}
        />
        <span>
          {block.name}
          {block.status === 'running' ? ' · 进行中' : ''}
        </span>
      </button>
      {!block.collapsed && (
        <div className="agent-tool-body">
          <div className="agent-tool-section">
            <div className="agent-tool-label">参数</div>
            <pre>{block.arguments || '{}'}</pre>
          </div>
          {block.result && (
            <div className="agent-tool-section">
              <div className="agent-tool-label">结果</div>
              <pre>{block.result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
