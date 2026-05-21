import { VscodeLabel } from '@vscode-elements/react-elements';
import VscodeScrollHost from './VscodeScrollHost';
import './AgentPanel.css';

/** AI Agent 面板 — 当前仅占位，后续接入对话能力 */
export default function AgentPanel() {
  return (
    <div className="agent-panel-root">
      <VscodeScrollHost
        className="agent-panel-scroll-host"
        scrollableClassName="agent-panel-scrollable"
      >
        <div className="agent-panel agent-panel-placeholder">
          <VscodeLabel className="placeholder-title">AI Agent</VscodeLabel>
          <p className="placeholder-desc">功能开发中，敬请期待。</p>
        </div>
      </VscodeScrollHost>
    </div>
  );
}
