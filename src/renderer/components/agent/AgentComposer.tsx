import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { useAgentChat } from '../../context/AgentChatContext';
import { useLlmProviders } from '../../context/LlmProvidersContext';
import AgentModelPicker from './AgentModelPicker';
import './AgentComposer.css';

const COMPOSER_MAX_HEIGHT_PX = 160;

export default function AgentComposer() {
  const {
    activeSessionId,
    activeSession,
    composerDraft,
    setComposerDraft,
    sendMessage,
    stopGeneration,
    isSessionStreaming,
    preparingContext,
    setSessionProvider,
  } = useAgentChat();
  const { providers, defaultProvider } = useLlmProviders();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const enabledProviders = useMemo(
    () => providers.filter((item) => item.enabled),
    [providers],
  );

  const streaming =
    activeSessionId != null && isSessionStreaming(activeSessionId);

  const busy = streaming || preparingContext;

  const canSend =
    Boolean(composerDraft.trim()) &&
    enabledProviders.length > 0 &&
    Boolean(activeSessionId) &&
    !busy;

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [composerDraft, resizeTextarea]);

  const handleSubmit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || !composerDraft.trim()) return;
    await sendMessage(composerDraft);
    requestAnimationFrame(resizeTextarea);
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
      <form className="agent-composer-form" onSubmit={handleSubmit}>
        <div className="agent-composer-box">
          <textarea
            ref={textareaRef}
            className="agent-composer-input"
            value={composerDraft}
            placeholder="Plan, Build, / for skills, @ for context"
            rows={1}
            onChange={(event) => {
              setComposerDraft(event.target.value);
              resizeTextarea();
            }}
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

            {busy ? (
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
