import {
  FormEvent,
  KeyboardEvent,
  useMemo,
} from 'react';
import { useAgentChat } from '../../context/AgentChatContext';
import { useLlmProviders } from '../../context/LlmProvidersContext';
import AgentModelPicker from './AgentModelPicker';
import './AgentComposer.css';

export default function AgentComposer() {
  const {
    activeSessionId,
    activeSession,
    composerDraft,
    setComposerDraft,
    editTargetMessageId,
    cancelEdit,
    sendMessage,
    stopGeneration,
    isSessionStreaming,
    setSessionProvider,
  } = useAgentChat();
  const { providers, defaultProvider } = useLlmProviders();

  const enabledProviders = useMemo(
    () => providers.filter((item) => item.enabled),
    [providers],
  );

  const streaming =
    activeSessionId != null && isSessionStreaming(activeSessionId);

  const canSend =
    Boolean(composerDraft.trim()) &&
    enabledProviders.length > 0 &&
    Boolean(activeSessionId) &&
    !streaming;

  const handleSubmit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (streaming || !composerDraft.trim()) return;
    await sendMessage(composerDraft);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSubmit().catch(() => undefined);
    }
  };

  const selectedProviderId =
    activeSession?.providerId || defaultProvider?.id || '';

  return (
    <div className="agent-composer">
      {editTargetMessageId && (
        <div className="agent-composer-edit-banner">
          <span>正在编辑消息，发送后将截断后续对话并重发。</span>
          <button type="button" onClick={cancelEdit}>
            取消
          </button>
        </div>
      )}

      <form className="agent-composer-form" onSubmit={handleSubmit}>
        <div className="agent-composer-box">
          <textarea
            className="agent-composer-input"
            value={composerDraft}
            placeholder="Plan, Build, / for skills, @ for context"
            rows={3}
            onChange={(event) => setComposerDraft(event.target.value)}
            onKeyDown={handleKeyDown}
          />

          <div className="agent-composer-footer">
            <AgentModelPicker
              providers={enabledProviders}
              selectedId={selectedProviderId}
              disabled={!activeSessionId}
              onSelect={(providerId) => {
                if (!activeSessionId) return;
                setSessionProvider(activeSessionId, providerId);
              }}
            />

            {streaming ? (
              <button
                type="button"
                className="agent-composer-send agent-composer-send--stop"
                aria-label="停止生成"
                onClick={() => stopGeneration()}
              >
                <span className="codicon codicon-debug-stop" />
              </button>
            ) : (
              <button
                type="submit"
                className={`agent-composer-send${
                  canSend ? ' agent-composer-send--ready' : ''
                }`}
                disabled={!canSend}
                aria-label="发送"
              >
                <span className="codicon codicon-arrow-up" />
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
