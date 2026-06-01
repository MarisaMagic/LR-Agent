import { useEffect, useRef } from 'react';
import { VscodeLabel } from '@vscode-elements/react-elements';
import { useAgentChat } from '../../context/AgentChatContext';
import VscodeScrollHost from '../VscodeScrollHost';
import AgentMessageItem from './AgentMessageItem';
import './AgentMessageList.css';

export default function AgentMessageList() {
  const { activeSessionId, getSessionMessages } = useAgentChat();
  const bottomRef = useRef<HTMLDivElement>(null);
  const messages = activeSessionId ? getSessionMessages(activeSessionId) : [];

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, activeSessionId]);

  if (!activeSessionId) {
    return null;
  }

  return (
    <VscodeScrollHost
      className="agent-message-list-scroll"
      scrollableClassName="agent-message-list-scrollable"
    >
      <div className="agent-message-list">
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
