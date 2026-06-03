import { useEffect, useRef } from 'react';
import { VscodeLabel } from '@vscode-elements/react-elements';
import { useAgentChat } from '../../context/AgentChatContext';
import VscodeScrollHost from '../VscodeScrollHost';
import AgentMessageItem from './AgentMessageItem';
import './AgentMessageList.css';

export default function AgentMessageList() {
  const {
    activeSessionId,
    activeSession,
    editTargetMessageId,
    getSessionMessages,
    loadOlderMessages,
    loadingOlderMessages,
  } = useAgentChat();
  const bottomRef = useRef<HTMLDivElement>(null);
  const messages = activeSessionId ? getSessionMessages(activeSessionId) : [];

  useEffect(() => {
    if (editTargetMessageId) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, activeSessionId, editTargetMessageId]);

  if (!activeSessionId) {
    return null;
  }

  return (
    <VscodeScrollHost
      className="agent-message-list-scroll"
      scrollableClassName="agent-message-list-scrollable"
      onScroll={(event) => {
        const el = event.currentTarget;
        if (
          activeSession?.hasMoreMessagesBefore &&
          !loadingOlderMessages &&
          el.scrollTop < 64
        ) {
          void loadOlderMessages(activeSessionId);
        }
      }}
    >
      <div className="agent-message-list">
        {loadingOlderMessages ? (
          <div className="agent-message-list-loading">加载更早的消息…</div>
        ) : null}
        {messages.length === 0 ? (
          <div className="agent-message-empty">
            <VscodeLabel>开始与 Agent 对话</VscodeLabel>
            <p>在下方输入问题，支持 Markdown 与数学公式渲染。</p>
          </div>
        ) : (
          messages.map((message) => (
            <AgentMessageItem key={message.id} message={message} />
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </VscodeScrollHost>
  );
}
