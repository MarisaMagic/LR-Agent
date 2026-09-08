import { VscodeIcon } from '@vscode-elements/react-elements';
import { AnimatePresence, m, useReducedMotion } from 'framer-motion';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getFloatingMenuMotionProps } from '../../motion/PopoverMotion';
import type { ChatMessage } from '../../types/agent';
import { isFileProposalBlock } from '../../../shared/agentTypes';
import { useAgentChat } from '../../context/AgentChatContext';
import AgentMarkdown from './AgentMarkdown';
import AgentReasoningBlock from './AgentReasoningBlock';
import AgentToolCallBlock from './AgentToolCallBlock';
import AgentExplorationBlock from './AgentExplorationBlock';
import { buildAssistantRenderSegments } from './explorationRenderUtils';
import AgentAnnotationPipelineBlock from './AgentAnnotationPipelineBlock';
import AgentFileChangeBlock from './AgentFileChangeBlock';
import AgentAnnotationChangeBlock from './AgentAnnotationChangeBlock';
import {
  shouldHideToolCallInChat,
  shouldSkipRedundantProposalText,
} from './agentAssistantRenderUtils';

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
  const hasAnnotationProposal = message.blocks.some(
    (block) => block.type === 'annotation_proposal',
  );
  const documentProposalBlock = message.blocks.find(isFileProposalBlock);
  const messageTerminal =
    message.status === 'done' ||
    message.status === 'stopped' ||
    message.status === 'error';
  const pipelineCompleted =
    (hasAnnotationProposal && messageTerminal) ||
    (documentProposalBlock != null &&
      documentProposalBlock.status !== 'pending' &&
      messageTerminal);
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
    (message.status === 'done' ||
      message.status === 'stopped' ||
      message.status === 'error') &&
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

  const renderSegments = buildAssistantRenderSegments(message.blocks);

  const renderBlock = (block: ChatMessage['blocks'][number], index: number) => {
    if ((block as { type: string }).type === 'mode_suggestion') {
      return null;
    }
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
      if (shouldHideToolCallInChat(block, message.blocks)) {
        return null;
      }
      return (
        <AgentToolCallBlock
          key={block.id}
          block={block}
          onToggle={() => handleToggle(index)}
        />
      );
    }
    if (block.type === 'annotation_pipeline') {
      return (
        <AgentAnnotationPipelineBlock
          key={`pipeline-${block.pipelineKind ?? 'batch'}`}
          steps={block.steps}
          collapsed={block.collapsed}
          streaming={isStreaming}
          pipelineCompleted={pipelineCompleted}
          pipelineKind={block.pipelineKind ?? 'batch'}
          onToggle={() => handleToggle(index)}
        />
      );
    }
    if (block.type === 'text' && block.content) {
      if (shouldSkipRedundantProposalText(block.content, message.blocks)) {
        return null;
      }
      return <AgentMarkdown key={`text-${index}`} content={block.content} />;
    }
    if (isFileProposalBlock(block)) {
      if (block.status === 'dismissed') {
        return null;
      }
      return (
        <AgentFileChangeBlock
          key={`file-${index}`}
          messageId={message.id}
          blockIndex={index}
          relativePath={block.suggestedRelativePath}
          newContent={block.content}
          status={block.status}
        />
      );
    }
    if (block.type === 'annotation_proposal') {
      if (block.status === 'dismissed') {
        return null;
      }
      return (
        <AgentAnnotationChangeBlock
          key={`annotation-${index}`}
          messageId={message.id}
          blockIndex={index}
          proposal={block.proposal}
          status={block.status}
        />
      );
    }
    return null;
  };

  return (
    <div className="agent-message-item agent-message-item--assistant">
      <div className="agent-assistant-content">
        {renderSegments.map((segment) => {
          if (segment.kind === 'exploration') {
            const streamingExploration =
              isStreaming &&
              segment.tools.some((tool) => tool.status === 'running');
            return (
              <AgentExplorationBlock
                key={segment.key}
                tools={segment.tools}
                summary={segment.summary}
                streaming={streamingExploration}
              />
            );
          }
          return renderBlock(segment.block, segment.index);
        })}

        {isStreaming && <span className="agent-stream-cursor">▍</span>}

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
                      <VscodeIcon name="copy" size={14} />
                      复制
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!canRegenerate}
                      onClick={handleRegenerate}
                    >
                      <VscodeIcon name="refresh" size={14} />
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
