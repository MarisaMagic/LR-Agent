import { VscodeIcon } from '@vscode-elements/react-elements';
import { AnimatePresence, m, useReducedMotion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getFloatingMenuMotionProps } from '../../motion/PopoverMotion';
import type { ChatMessage } from '../../types/agent';
import { useAgentChat } from '../../context/AgentChatContext';
import AgentMarkdown from './AgentMarkdown';
import AgentReasoningBlock from './AgentReasoningBlock';
import AgentToolCallBlock from './AgentToolCallBlock';

interface AgentAssistantMessageProps {
  message: ChatMessage;
}

function getAssistantPlainText(message: ChatMessage): string {
  return message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.content)
    .join('\n');
}

export default function AgentAssistantMessage({
  message,
}: AgentAssistantMessageProps) {
  const {
    toggleBlockCollapse,
    regenerateAssistant,
    isSessionStreaming,
    getSessionMessages,
    activeSessionId,
  } = useAgentChat();

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const menuMotion = getFloatingMenuMotionProps('above-anchor', reducedMotion);

  const isStreaming = message.status === 'streaming';
  const textContent = getAssistantPlainText(message);
  const streamingSession =
    activeSessionId != null && isSessionStreaming(activeSessionId);

  const messageIndex = (() => {
    if (!activeSessionId) return -1;
    const messages = getSessionMessages(activeSessionId);
    return messages.findIndex((item) => item.id === message.id);
  })();

  const hasPriorUser = messageIndex > 0;

  const canRegenerate =
    (message.status === 'done' || message.status === 'stopped') &&
    !streamingSession &&
    hasPriorUser &&
    Boolean(textContent.trim() || message.blocks.length > 0);

  const showActions =
    !isStreaming &&
    (message.status === 'done' ||
      message.status === 'error' ||
      message.status === 'stopped');

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDocClick = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuOpen]);

  const handleToggle = useCallback(
    (blockIndex: number) => {
      toggleBlockCollapse(message.sessionId, message.id, blockIndex);
    },
    [message.id, message.sessionId, toggleBlockCollapse],
  );

  const handleCopy = useCallback(async () => {
    const text = getAssistantPlainText(message);
    if (!text.trim()) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
    setMenuOpen(false);
  }, [message]);

  const handleRegenerate = useCallback(() => {
    setMenuOpen(false);
    regenerateAssistant(message.id).catch(() => undefined);
  }, [message.id, regenerateAssistant]);

  return (
    <div className="agent-message-item agent-message-item--assistant">
      <div className="agent-assistant-content">
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

        {message.status === 'stopped' && (
          <div className="agent-message-meta">已停止生成</div>
        )}
        {message.status === 'error' && (
          <div className="agent-message-meta agent-message-meta--error">
            {message.error ?? '生成失败'}
          </div>
        )}

        {showActions && (
          <div className="agent-assistant-toolbar">
            <div className="agent-assistant-actions" ref={menuRef}>
              <button
                type="button"
                className="agent-assistant-menu-trigger"
                aria-label="更多操作"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <VscodeIcon name="ellipsis" size={16} />
              </button>
              <AnimatePresence>
                {menuOpen && (
                  <m.div
                    className="agent-assistant-menu"
                    role="menu"
                    style={{ transformOrigin: 'bottom right' }}
                    {...menuMotion}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!textContent.trim()}
                      onClick={() => {
                        handleCopy().catch(() => undefined);
                      }}
                    >
                      复制
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!canRegenerate}
                      onClick={handleRegenerate}
                    >
                      重新生成
                    </button>
                  </m.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
