import { VscodeIcon } from '@vscode-elements/react-elements';
import type { MessageBlock } from '../../types/agent';
import {
  formatToolCallLabel,
  summarizeToolResultForDisplay,
} from '../../services/toolDisplayUtils';
import AgentScrollablePre from './AgentScrollablePre';
import './AgentReasoningBlock.css'; /* shared tool + reasoning tokens */

interface AgentToolCallBlockProps {
  block: Extract<MessageBlock, { type: 'tool_call' }>;
  onToggle: () => void;
}

export default function AgentToolCallBlock({
  block,
  onToggle,
}: AgentToolCallBlockProps) {
  const label = formatToolCallLabel(block.name, block.arguments);
  const displayResult = block.result
    ? summarizeToolResultForDisplay(block.name, block.result)
    : undefined;

  return (
    <div className="agent-tool-block">
      <button type="button" className="agent-block-toggle" onClick={onToggle}>
        <VscodeIcon
          name={block.collapsed ? 'chevron-right' : 'chevron-down'}
          size={12}
        />
        <span>
          {label}
          {block.status === 'running' ? ' · 进行中' : ''}
        </span>
      </button>
      {!block.collapsed && (
        <div className="agent-tool-body">
          <div className="agent-tool-section">
            <div className="agent-tool-label">参数</div>
            <AgentScrollablePre>{block.arguments || '{}'}</AgentScrollablePre>
          </div>
          {displayResult && (
            <div className="agent-tool-section">
              <div className="agent-tool-label">结果</div>
              <AgentScrollablePre>{displayResult}</AgentScrollablePre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
