import { useCallback, useEffect, useRef, useState } from 'react';
import { VscodeLabel } from '@vscode-elements/react-elements';
import { useAgentChat } from '../../context/AgentChatContext';
import OverlayVerticalScrollArea from '../OverlayVerticalScrollArea';
import AgentMessageItem from './AgentMessageItem';
import ContextMenu, { type ContextMenuItem } from '../ContextMenu';
import './AgentMessageList.css';

/** 检查选区是否在消息列表容器内 */
function isSelectionInside(containerEl: HTMLElement): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return false;
  const { anchorNode, focusNode } = sel;
  return (
    (anchorNode && containerEl.contains(anchorNode)) ||
    (focusNode && containerEl.contains(focusNode))
  );
}

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
  const containerRef = useRef<HTMLDivElement>(null);
  const messages = activeSessionId ? getSessionMessages(activeSessionId) : [];
  const lastMessage =
    messages.length > 0 ? messages[messages.length - 1] : null;
  const scrollKey = activeSessionId
    ? `${activeSessionId}:${lastMessage?.id ?? '_empty'}:${lastMessage?.updatedAt ?? 0}`
    : '';

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (editTargetMessageId || !scrollKey) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [scrollKey, editTargetMessageId]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const container = containerRef.current;
    if (!container) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !isSelectionInside(container)) return;
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const contextMenuItems: ContextMenuItem[] = [
    {
      id: 'copy',
      label: '复制',
      shortcut: 'Ctrl+C',
      onClick: () => {
        document.execCommand('copy');
      },
    },
  ];

  if (!activeSessionId) {
    return null;
  }

  return (
    <OverlayVerticalScrollArea
      className="agent-message-list-scroll"
      contentClassName="agent-message-list-scrollable"
      fillHost
      observeKey={scrollKey}
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
      <div
        ref={containerRef}
        className="agent-message-list"
        onContextMenu={handleContextMenu}
      >
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
      {contextMenu && (
        <ContextMenu
          items={contextMenuItems}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
        />
      )}
    </OverlayVerticalScrollArea>
  );
}
