import { useCallback } from 'react';
import { VscodeButton } from '@vscode-elements/react-elements';
import type { ChatMessage } from '../../types/agent';
import { useAgentChat } from '../../context/AgentChatContext';
import AgentMarkdown from './AgentMarkdown';
import AgentReasoningBlock from './AgentReasoningBlock';
import AgentToolCallBlock from './AgentToolCallBlock';
import './AgentMessageItem.css';

interface AgentMessageItemProps {
  message: ChatMessage;
}

export default function AgentMessageItem({ message }: AgentMessageItemProps) {
  const { beginEditMessage, toggleBlockCollapse } = useAgentChat();
  const isUser = message.role === 'user';
  const isStreaming = message.status === 'streaming';

  const handleToggle = useCallback(
    (blockIndex: number) => {
      toggleBlockCollapse(message.sessionId, message.id, blockIndex);
    },
    [message.id, message.sessionId, toggleBlockCollapse],
  );

  const textContent = message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.content)
    .join('\n');

  return (
    <div
      className={`agent-message-item ${isUser ? 'agent-message-item--user' : 'agent-message-item--assistant'}`}
    >
      <div className="agent-message-bubble">
        {isUser ? (
          <div className="agent-message-user-text">{textContent}</div>
        ) : (
          <>
            {message.blocks.map((block, index) => {
              if (block.type === 'reasoning') {
                return (
                  <AgentReasoningBlock
                    key={`reasoning-${index}`}
                    block={block}
                    streaming={isStreaming && index === message.blocks.length - 1}
                    onToggle={() => handleToggle(index)}
                  />
                );
              }
              if (block.type === 'tool_call') {
                return (
                  <AgentToolCallBlock
                    key={block.id}
                    block={block}
                    onToggle={() => handleToggle(index)}
                  />
                );
              }
              if (block.type === 'text' && block.content) {
                return (
                  <AgentMarkdown key={`text-${index}`} content={block.content} />
                );
              }
              return null;
            })}
            {isStreaming && !textContent && message.blocks.length === 0 && (
              <span className="agent-stream-cursor">▍</span>
            )}
            {isStreaming && textContent && (
              <span className="agent-stream-cursor">▍</span>
            )}
          </>
        )}

        {message.status === 'stopped' && (
          <div className="agent-message-meta">已停止生成</div>
        )}
        {message.status === 'error' && (
          <div className="agent-message-meta agent-message-meta--error">
            {message.error ?? '生成失败'}
          </div>
        )}
      </div>

      {isUser && message.status === 'done' && (
        <div className="agent-message-actions">
          <VscodeButton secondary onClick={() => beginEditMessage(message.id)}>
            编辑
          </VscodeButton>
        </div>
      )}
    </div>
  );
}
