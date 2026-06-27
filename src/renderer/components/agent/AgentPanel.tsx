import { useEffect } from 'react';
import { useAgentChat } from '../../context/AgentChatContext';
import AgentComposer from './AgentComposer';
import AgentKeepAllBar from './AgentKeepAllBar';
import AgentMessageList from './AgentMessageList';
import AgentSessionTabs from './AgentSessionTabs';
import './AgentPanel.css';

export default function AgentPanel() {
  const { editTargetMessageId, cancelEdit } = useAgentChat();

  useEffect(() => {
    if (!editTargetMessageId) return undefined;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (document.querySelector('[data-editing-bubble="true"]')?.contains(target)) {
        return;
      }
      cancelEdit();
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [editTargetMessageId, cancelEdit]);

  return (
    <div className="agent-panel-root">
      <AgentSessionTabs />
      <AgentMessageList />
      <AgentKeepAllBar />
      <AgentComposer />
    </div>
  );
}
