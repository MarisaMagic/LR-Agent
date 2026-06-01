import { AnimatePresence, m, useReducedMotion } from 'framer-motion';
import { useRef, useState } from 'react';
import { motionDuration, motionEase, motionDistance } from '../../motion/tokens';
import VscodeClickableToolbarButton from '../VscodeClickableButton';
import { useAgentChat } from '../../context/AgentChatContext';
import AgentHistoryPopover, {
  computeHistoryPopoverPosition,
} from './AgentHistoryPopover';
import './AgentSessionTabs.css';

export default function AgentSessionTabs() {
  const {
    openTabIds,
    activeSessionId,
    sessions,
    createSession,
    closeTab,
    switchSession,
    historyOpen,
    setHistoryOpen,
    isSessionStreaming,
  } = useAgentChat();
  const reducedMotion = useReducedMotion();
  const historyAnchorRef = useRef<HTMLDivElement>(null);
  const [historyPosition, setHistoryPosition] = useState<{
    top: number;
    right: number;
  } | null>(null);

  const toggleHistory = () => {
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }

    const anchor = historyAnchorRef.current;
    if (anchor) {
      setHistoryPosition(computeHistoryPopoverPosition(anchor));
    }
    setHistoryOpen(true);
  };

  const closeHistory = () => {
    setHistoryOpen(false);
  };

  return (
    <div className="agent-session-tabs">
      <div className="agent-session-tab-list" role="tablist">
        <AnimatePresence initial={false} mode="popLayout">
          {openTabIds.map((sessionId) => {
            const session = sessions[sessionId];
            if (!session) return null;
            const active = sessionId === activeSessionId;
            const streaming = isSessionStreaming(sessionId);
            return (
              <m.div
                key={sessionId}
                role="tab"
                aria-selected={active}
                layout={!reducedMotion}
                className={`agent-session-tab${active ? ' agent-session-tab--active' : ''}`}
                initial={
                  reducedMotion
                    ? { opacity: 0 }
                    : { opacity: 0, x: motionDistance.x, scale: 0.95 }
                }
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={
                  reducedMotion
                    ? { opacity: 0 }
                    : { opacity: 0, x: -motionDistance.x / 2, scale: 0.95 }
                }
                transition={{
                  duration: reducedMotion ? 0.1 : motionDuration.tab,
                  ease: motionEase,
                }}
              >
                <button
                  type="button"
                  className="agent-session-tab-main"
                  onClick={() => switchSession(sessionId)}
                >
                  {streaming && <span className="agent-session-tab-dot" />}
                  <span className="agent-session-tab-title">{session.title}</span>
                </button>
                <button
                  type="button"
                  className="agent-session-tab-close"
                  aria-label="关闭会话"
                  onClick={() => closeTab(sessionId)}
                >
                  ×
                </button>
              </m.div>
            );
          })}
        </AnimatePresence>
      </div>

      <div className="agent-session-tab-actions">
        <VscodeClickableToolbarButton
          icon="add"
          label="新建 Agent 会话"
          onClick={() => createSession()}
        />
        <div ref={historyAnchorRef} className="agent-history-anchor">
          <VscodeClickableToolbarButton
            icon="history"
            label="历史对话"
            onClick={toggleHistory}
          />
          {historyPosition && (
            <AgentHistoryPopover
              open={historyOpen}
              anchorRef={historyAnchorRef}
              initialPosition={historyPosition}
              onClose={closeHistory}
              onExitComplete={() => setHistoryPosition(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
