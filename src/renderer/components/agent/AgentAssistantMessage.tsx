import { VscodeIcon } from '@vscode-elements/react-elements';
import { useCallback, useEffect, useState } from 'react';
import type { ChatMessage, MessageBlock } from '../../types/agent';
import { isFileProposalBlock } from '../../../shared/agentTypes';
import { useAgentChat } from '../../context/AgentChatContext';
import AgentMarkdown from './AgentMarkdown';
import AgentReasoningBlock from './AgentReasoningBlock';
import AgentToolCallBlock from './AgentToolCallBlock';
import AgentExplorationBlock from './AgentExplorationBlock';
import AgentWorkHistory from './AgentWorkHistory';
import {
  buildAssistantRenderSegments,
  type AssistantRenderSegment,
} from './explorationRenderUtils';
import {
  collectThoughtContent,
  formatThoughtLabel,
  formatWorkedDuration,
  splitWorkHistory,
  workHistoryDurationMs,
  type IndexedBlock,
} from './workHistoryUtils';
import AgentAnnotationPipelineBlock from './AgentAnnotationPipelineBlock';
import AgentFileChangeBlock from './AgentFileChangeBlock';
import AgentAnnotationChangeBlock from './AgentAnnotationChangeBlock';
import AgentFilesChangedSummary from './AgentFilesChangedSummary';
import { shouldSkipRedundantProposalText } from './agentAssistantRenderUtils';

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

  const [thoughtCollapsed, setThoughtCollapsed] = useState(true);

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

  const sessionMessages = activeSessionId
    ? getSessionMessages(activeSessionId)
    : [];
  const messageIndex = sessionMessages.findIndex(
    (item) => item.id === message.id,
  );
  const lastAssistantId = (() => {
    for (let i = sessionMessages.length - 1; i >= 0; i -= 1) {
      if (sessionMessages[i].role === 'assistant') {
        return sessionMessages[i].id;
      }
    }
    return null;
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
    setThoughtCollapsed(true);
  }, [message.id]);

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
  }, [message]);

  const handleRegenerate = useCallback(() => {
    regenerateAssistant(message.id).catch(() => undefined);
  }, [message.id, regenerateAssistant]);

  const { history, rest } = splitWorkHistory(message.blocks);
  const foldWorkHistory = !isStreaming && history.length > 0;
  const liveBlocks: IndexedBlock[] = message.blocks.map((block, index) => ({
    block,
    index,
  }));
  const durationMs = workHistoryDurationMs(
    message.createdAt,
    message.finishedAt,
  );
  const workedLabel = formatWorkedDuration(durationMs);
  const thoughtContent = collectThoughtContent(message.blocks);
  const showThoughtFold = !isStreaming && thoughtContent.length > 0;
  const hasToolCall = message.blocks.some(
    (block) => block.type === 'tool_call',
  );
  const thoughtLabel = formatThoughtLabel(durationMs, { hasToolCall });

  const renderBlock = (block: MessageBlock, index: number) => {
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
          operation={block.operation}
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

  const renderSegments = (items: IndexedBlock[]) => {
    if (items.length === 0) return null;
    const segments = buildAssistantRenderSegments(
      message.blocks,
      items.map((item) => item.index),
    );
    return segments.map((segment: AssistantRenderSegment) => {
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
    });
  };

  return (
    <div className="agent-message-item agent-message-item--assistant">
      <div className="agent-assistant-content">
        {showThoughtFold ? (
          <AgentReasoningBlock
            key={`thought-${message.id}`}
            block={{
              type: 'reasoning',
              content: thoughtContent,
              collapsed: thoughtCollapsed,
            }}
            label={thoughtLabel}
            onToggle={() => setThoughtCollapsed((value) => !value)}
          />
        ) : null}
        {isStreaming ? (
          renderSegments(liveBlocks)
        ) : foldWorkHistory ? (
          <AgentWorkHistory key={`${message.id}-work`} label={workedLabel}>
            {renderSegments(history)}
          </AgentWorkHistory>
        ) : null}
        {isStreaming ? null : renderSegments(rest)}

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
            <div className="agent-assistant-actions">
              <button
                type="button"
                className="agent-assistant-action"
                aria-label="复制"
                title="复制"
                disabled={!textContent.trim()}
                onClick={() => {
                  handleCopy().catch(() => undefined);
                }}
              >
                <VscodeIcon name="copy" size={18} />
              </button>
              <button
                type="button"
                className="agent-assistant-action"
                aria-label="重新生成"
                title="重新生成"
                disabled={!canRegenerate}
                onClick={handleRegenerate}
              >
                <VscodeIcon name="refresh" size={18} />
              </button>
            </div>
          </div>
        )}
        {showActions && lastAssistantId === message.id ? (
          <AgentFilesChangedSummary message={message} />
        ) : null}
      </div>
    </div>
  );
}
