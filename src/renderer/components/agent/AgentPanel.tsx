import AgentComposer from './AgentComposer';
import AgentMessageList from './AgentMessageList';
import AgentSessionTabs from './AgentSessionTabs';
import './AgentPanel.css';

export default function AgentPanel() {
  return (
    <div className="agent-panel-root">
      <AgentSessionTabs />
      <AgentMessageList />
      <AgentComposer />
    </div>
  );
}
