import type {
  AgentChatPersistedState,
  ChatMessage,
  MessageBlock,
  StreamEvent,
} from '../../shared/agentTypes';

const STORAGE_KEY = 'lr-agent:agentChatState';
const UI_STORAGE_KEY = 'lr-agent:agentChatUi';

export interface AgentChatUiState {
  openTabIds: string[];
  activeSessionId: string | null;
}

export function createEmptyUiState(): AgentChatUiState {
  return { openTabIds: [], activeSessionId: null };
}

export function loadAgentChatUiState(): AgentChatUiState {
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY);
    if (!raw) return createEmptyUiState();
    const parsed = JSON.parse(raw) as AgentChatUiState;
    return {
      openTabIds: parsed.openTabIds ?? [],
      activeSessionId: parsed.activeSessionId ?? null,
    };
  } catch {
    return createEmptyUiState();
  }
}

export function persistAgentChatUiState(state: AgentChatUiState): void {
  localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(state));
}

export function createEmptyChatState(): AgentChatPersistedState {
  return {
    sessions: {},
    sessionOrder: [],
    openTabIds: [],
    activeSessionId: null,
    messagesBySession: {},
  };
}

export function loadAgentChatState(): AgentChatPersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createEmptyChatState();
    const parsed = JSON.parse(raw) as AgentChatPersistedState;
    if (!parsed || typeof parsed !== 'object') return createEmptyChatState();
    return {
      sessions: parsed.sessions ?? {},
      sessionOrder: parsed.sessionOrder ?? [],
      openTabIds: parsed.openTabIds ?? [],
      activeSessionId: parsed.activeSessionId ?? null,
      messagesBySession: parsed.messagesBySession ?? {},
    };
  } catch {
    return createEmptyChatState();
  }
}

export function persistAgentChatState(state: AgentChatPersistedState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function applyStreamEventToBlocks(
  blocks: MessageBlock[],
  event: StreamEvent,
): MessageBlock[] {
  const next = [...blocks];

  if (event.type === 'text_delta') {
    const last = next[next.length - 1];
    if (last?.type === 'text') {
      next[next.length - 1] = {
        ...last,
        content: last.content + event.content,
      };
      return next;
    }
    next.push({ type: 'text', content: event.content });
    return next;
  }

  if (event.type === 'reasoning_delta') {
    const idx = next.findIndex((block) => block.type === 'reasoning');
    if (idx >= 0) {
      const block = next[idx];
      if (block.type === 'reasoning') {
        next[idx] = {
          ...block,
          content: block.content + event.content,
        };
      }
      return next;
    }
    next.push({
      type: 'reasoning',
      content: event.content,
      collapsed: false,
    });
    return next;
  }

  if (event.type === 'tool_start') {
    const existingIdx = next.findIndex(
      (block) => block.type === 'tool_call' && block.id === event.toolCallId,
    );
    if (existingIdx >= 0) {
      const block = next[existingIdx];
      if (block.type === 'tool_call') {
        next[existingIdx] = {
          ...block,
          arguments: block.arguments + event.arguments,
        };
      }
      return next;
    }
    next.push({
      type: 'tool_call',
      id: event.toolCallId,
      name: event.name,
      arguments: event.arguments,
      status: 'running',
      collapsed: false,
    });
    return next;
  }

  if (event.type === 'tool_result') {
    const idx = next.findIndex(
      (block) => block.type === 'tool_call' && block.id === event.toolCallId,
    );
    if (idx >= 0) {
      const block = next[idx];
      if (block.type === 'tool_call') {
        next[idx] = {
          ...block,
          result: event.result,
          status: 'done',
          collapsed: true,
        };
      }
    }
    return next;
  }

  return next;
}

export function getUserTextFromMessage(message: ChatMessage): string {
  if (message.role !== 'user') return '';
  return message.blocks
    .filter((block): block is Extract<MessageBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.content)
    .join('\n');
}

export function buildApiMessages(
  messageIds: string[],
  messages: Record<string, ChatMessage>,
): Array<{ role: string; content: string }> {
  return messageIds
    .map((id) => messages[id])
    .filter((message): message is ChatMessage => Boolean(message))
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => {
      const text = message.blocks
        .filter(
          (block): block is Extract<MessageBlock, { type: 'text' }> =>
            block.type === 'text',
        )
        .map((block) => block.content)
        .join('\n');
      return { role: message.role, content: text };
    })
    .filter((message) => message.content.trim());
}
