import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  buildSessionTitle,
  createAgentId,
  type AgentChatPersistedState,
  type AgentSession,
  type ChatMessage,
  type MessageBlock,
} from '../../shared/agentTypes';
import {
  applyStreamEventToBlocks,
  buildApiMessages,
  createEmptyChatState,
  getUserTextFromMessage,
  loadAgentChatState,
  persistAgentChatState,
} from '../services/agentChatStore';
import {
  isJobRunning,
  startChatJob,
  stopJob,
  subscribeJobEvents,
} from '../services/agentJobRegistry';
import { useLlmProviders } from './LlmProvidersContext';

interface AgentChatContextValue {
  sessions: Record<string, AgentSession>;
  sessionOrder: string[];
  openTabIds: string[];
  activeSessionId: string | null;
  activeSession: AgentSession | null;
  messagesBySession: Record<string, Record<string, ChatMessage>>;
  historyOpen: boolean;
  composerDraft: string;
  editTargetMessageId: string | null;
  setHistoryOpen: (open: boolean) => void;
  setComposerDraft: (draft: string) => void;
  createSession: () => string;
  closeTab: (sessionId: string) => void;
  switchSession: (sessionId: string) => void;
  openSessionTab: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  sendMessage: (content: string) => Promise<void>;
  stopGeneration: (sessionId?: string) => void;
  beginEditMessage: (messageId: string) => void;
  cancelEdit: () => void;
  toggleBlockCollapse: (
    sessionId: string,
    messageId: string,
    blockIndex: number,
  ) => void;
  setSessionProvider: (sessionId: string, providerId: string) => void;
  isSessionStreaming: (sessionId: string) => boolean;
  getSessionMessages: (sessionId: string) => ChatMessage[];
}

const AgentChatContext = createContext<AgentChatContextValue | null>(null);

function normalizeLoadedState(state: AgentChatPersistedState): AgentChatPersistedState {
  const next = { ...state };
  for (const sessionId of Object.keys(next.messagesBySession)) {
    const messages = next.messagesBySession[sessionId] ?? {};
    for (const messageId of Object.keys(messages)) {
      const message = messages[messageId];
      if (message.status === 'streaming') {
        messages[messageId] = {
          ...message,
          status: 'stopped',
          updatedAt: Date.now(),
        };
      }
    }
    const session = next.sessions[sessionId];
    if (session?.activeJobId) {
      next.sessions[sessionId] = { ...session, activeJobId: undefined };
    }
  }
  return next;
}

export function AgentChatProvider({ children }: { children: ReactNode }) {
  const { providers, defaultProvider } = useLlmProviders();
  const [state, setState] = useState<AgentChatPersistedState>(() =>
    normalizeLoadedState(loadAgentChatState()),
  );
  const initializedRef = useRef(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [composerDraft, setComposerDraft] = useState('');
  const [editTargetMessageId, setEditTargetMessageId] = useState<string | null>(
    null,
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const persist = useCallback((next: AgentChatPersistedState) => {
    stateRef.current = next;
    setState(next);
    persistAgentChatState(next);
  }, []);

  const resolveProvider = useCallback(
    (providerId?: string) => {
      if (providerId) {
        const matched = providers.find(
          (item) => item.id === providerId && item.enabled,
        );
        if (matched) return matched;
      }
      return defaultProvider;
    },
    [providers, defaultProvider],
  );

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    const current = stateRef.current;
    if (current.openTabIds.length > 0) return;

    const id = createAgentId('session');
    const provider = defaultProvider;
    const now = Date.now();
    const session: AgentSession = {
      id,
      title: '新对话',
      providerId: provider?.id ?? '',
      model: provider?.model ?? '',
      messageIds: [],
      createdAt: now,
      updatedAt: now,
    };
    persist({
      ...current,
      sessions: { ...current.sessions, [id]: session },
      sessionOrder: [id, ...current.sessionOrder],
      openTabIds: [id],
      activeSessionId: id,
      messagesBySession: { ...current.messagesBySession, [id]: {} },
    });
  }, [defaultProvider, persist]);

  const updateMessage = useCallback(
    (
      sessionId: string,
      messageId: string,
      updater: (message: ChatMessage) => ChatMessage,
    ) => {
      const current = stateRef.current;
      const sessionMessages = {
        ...(current.messagesBySession[sessionId] ?? {}),
      };
      const existing = sessionMessages[messageId];
      if (!existing) return;
      sessionMessages[messageId] = updater(existing);
      persist({
        ...current,
        messagesBySession: {
          ...current.messagesBySession,
          [sessionId]: sessionMessages,
        },
      });
    },
    [persist],
  );

  const attachJobListener = useCallback(
    (jobId: string, sessionId: string, messageId: string) => {
      return subscribeJobEvents(jobId, (event) => {
        const current = stateRef.current;

        if (event.type === 'done') {
          updateMessage(sessionId, messageId, (message) => ({
            ...message,
            status: 'done',
            updatedAt: Date.now(),
            blocks: message.blocks.map((block) =>
              block.type === 'reasoning' || block.type === 'tool_call'
                ? { ...block, collapsed: true }
                : block,
            ),
          }));
          const session = current.sessions[sessionId];
          if (session) {
            persist({
              ...current,
              sessions: {
                ...current.sessions,
                [sessionId]: {
                  ...session,
                  activeJobId: undefined,
                  updatedAt: Date.now(),
                },
              },
            });
          }
          return;
        }

        if (event.type === 'error') {
          updateMessage(sessionId, messageId, (message) => ({
            ...message,
            status: 'error',
            error: event.message,
            updatedAt: Date.now(),
          }));
          const session = current.sessions[sessionId];
          if (session) {
            persist({
              ...current,
              sessions: {
                ...current.sessions,
                [sessionId]: {
                  ...session,
                  activeJobId: undefined,
                  updatedAt: Date.now(),
                },
              },
            });
          }
          return;
        }

        updateMessage(sessionId, messageId, (message) => ({
          ...message,
          status: 'streaming',
          blocks: applyStreamEventToBlocks(message.blocks, event),
          updatedAt: Date.now(),
        }));
      });
    },
    [persist, updateMessage],
  );

  const createSession = useCallback(() => {
    const current = stateRef.current;
    const provider = defaultProvider;
    const id = createAgentId('session');
    const now = Date.now();
    const session: AgentSession = {
      id,
      title: '新对话',
      providerId: provider?.id ?? '',
      model: provider?.model ?? '',
      messageIds: [],
      createdAt: now,
      updatedAt: now,
    };
    persist({
      ...current,
      sessions: { ...current.sessions, [id]: session },
      sessionOrder: [id, ...current.sessionOrder.filter((item) => item !== id)],
      openTabIds: [...current.openTabIds, id],
      activeSessionId: id,
      messagesBySession: {
        ...current.messagesBySession,
        [id]: current.messagesBySession[id] ?? {},
      },
    });
    setEditTargetMessageId(null);
    setComposerDraft('');
    return id;
  }, [defaultProvider, persist]);

  const switchSession = useCallback(
    (sessionId: string) => {
      const current = stateRef.current;
      if (!current.sessions[sessionId]) return;
      persist({ ...current, activeSessionId: sessionId });
      setEditTargetMessageId(null);
      setComposerDraft('');
    },
    [persist],
  );

  const openSessionTab = useCallback(
    (sessionId: string) => {
      const current = stateRef.current;
      if (!current.sessions[sessionId]) return;
      const openTabIds = current.openTabIds.includes(sessionId)
        ? current.openTabIds
        : [...current.openTabIds, sessionId];
      persist({
        ...current,
        openTabIds,
        activeSessionId: sessionId,
      });
      setHistoryOpen(false);
      setEditTargetMessageId(null);
      setComposerDraft('');
    },
    [persist],
  );

  const closeTab = useCallback(
    (sessionId: string) => {
      const current = stateRef.current;
      const openTabIds = current.openTabIds.filter((id) => id !== sessionId);
      let activeSessionId = current.activeSessionId;
      if (activeSessionId === sessionId) {
        activeSessionId = openTabIds[openTabIds.length - 1] ?? null;
      }
      if (openTabIds.length === 0) {
        const id = createAgentId('session');
        const provider = defaultProvider;
        const now = Date.now();
        const session: AgentSession = {
          id,
          title: '新对话',
          providerId: provider?.id ?? '',
          model: provider?.model ?? '',
          messageIds: [],
          createdAt: now,
          updatedAt: now,
        };
        persist({
          ...current,
          sessions: { ...current.sessions, [id]: session },
          sessionOrder: [id, ...current.sessionOrder],
          openTabIds: [id],
          activeSessionId: id,
          messagesBySession: {
            ...current.messagesBySession,
            [id]: {},
          },
        });
        return;
      }
      persist({ ...current, openTabIds, activeSessionId });
    },
    [defaultProvider, persist],
  );

  const deleteSession = useCallback(
    (sessionId: string) => {
      const current = stateRef.current;
      const session = current.sessions[sessionId];
      if (session?.activeJobId && isJobRunning(session.activeJobId)) {
        stopJob(session.activeJobId);
      }
      const { [sessionId]: _removed, ...sessions } = current.sessions;
      const { [sessionId]: _msgs, ...messagesBySession } =
        current.messagesBySession;
      const sessionOrder = current.sessionOrder.filter((id) => id !== sessionId);
      const openTabIds = current.openTabIds.filter((id) => id !== sessionId);
      let activeSessionId = current.activeSessionId;
      if (activeSessionId === sessionId) {
        activeSessionId = openTabIds[openTabIds.length - 1] ?? null;
      }
      if (openTabIds.length === 0) {
        const id = createAgentId('session');
        const provider = defaultProvider;
        const now = Date.now();
        const newSession: AgentSession = {
          id,
          title: '新对话',
          providerId: provider?.id ?? '',
          model: provider?.model ?? '',
          messageIds: [],
          createdAt: now,
          updatedAt: now,
        };
        persist({
          sessions: { ...sessions, [id]: newSession },
          sessionOrder: [id, ...sessionOrder],
          openTabIds: [id],
          activeSessionId: id,
          messagesBySession: { ...messagesBySession, [id]: {} },
        });
        return;
      }
      persist({
        sessions,
        sessionOrder,
        openTabIds,
        activeSessionId,
        messagesBySession,
      });
    },
    [defaultProvider, persist],
  );

  const stopGeneration = useCallback(
    (sessionId?: string) => {
      const current = stateRef.current;
      const targetSessionId = sessionId ?? current.activeSessionId;
      if (!targetSessionId) return;
      const session = current.sessions[targetSessionId];
      if (!session?.activeJobId) return;
      stopJob(session.activeJobId);
      const assistantId = session.messageIds[session.messageIds.length - 1];
      if (assistantId) {
        updateMessage(targetSessionId, assistantId, (message) => ({
          ...message,
          status: 'stopped',
          updatedAt: Date.now(),
        }));
      }
      persist({
        ...current,
        sessions: {
          ...current.sessions,
          [targetSessionId]: {
            ...session,
            activeJobId: undefined,
            updatedAt: Date.now(),
          },
        },
      });
    },
    [persist, updateMessage],
  );

  const sendMessage = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) return;

      const current = stateRef.current;
      const sessionId = current.activeSessionId;
      if (!sessionId) return;

      const session = current.sessions[sessionId];
      if (!session) return;

      if (session.activeJobId && isJobRunning(session.activeJobId)) {
        return;
      }

      const selectedProvider = resolveProvider(session.providerId);
      if (!selectedProvider) return;

      const now = Date.now();
      let messageIds = [...session.messageIds];
      const sessionMessages = {
        ...(current.messagesBySession[sessionId] ?? {}),
      };

      if (editTargetMessageId) {
        const editIndex = messageIds.indexOf(editTargetMessageId);
        if (editIndex >= 0) {
          const removedIds = messageIds.slice(editIndex + 1);
          messageIds = messageIds.slice(0, editIndex + 1);
          for (const removedId of removedIds) {
            delete sessionMessages[removedId];
          }
          sessionMessages[editTargetMessageId] = {
            ...sessionMessages[editTargetMessageId],
            blocks: [{ type: 'text', content: trimmed }],
            updatedAt: now,
          };
        }
        setEditTargetMessageId(null);
      } else {
        const userMessageId = createAgentId('msg');
        const userMessage: ChatMessage = {
          id: userMessageId,
          sessionId,
          role: 'user',
          blocks: [{ type: 'text', content: trimmed }],
          status: 'done',
          providerId: selectedProvider.id,
          model: selectedProvider.model,
          createdAt: now,
          updatedAt: now,
        };
        sessionMessages[userMessageId] = userMessage;
        messageIds.push(userMessageId);
      }

      const assistantMessageId = createAgentId('msg');
      const assistantMessage: ChatMessage = {
        id: assistantMessageId,
        sessionId,
        role: 'assistant',
        blocks: [],
        status: 'streaming',
        providerId: selectedProvider.id,
        model: selectedProvider.model,
        createdAt: now + 1,
        updatedAt: now + 1,
      };
      sessionMessages[assistantMessageId] = assistantMessage;
      messageIds.push(assistantMessageId);

      const jobId = createAgentId('job');
      const nextTitle =
        session.title === '新对话' || editTargetMessageId
          ? buildSessionTitle(trimmed)
          : session.title;

      const nextSession: AgentSession = {
        ...session,
        title: nextTitle,
        providerId: selectedProvider.id,
        model: selectedProvider.model,
        messageIds,
        activeJobId: jobId,
        updatedAt: now,
      };

      persist({
        ...current,
        sessions: { ...current.sessions, [sessionId]: nextSession },
        sessionOrder: [
          sessionId,
          ...current.sessionOrder.filter((id) => id !== sessionId),
        ],
        messagesBySession: {
          ...current.messagesBySession,
          [sessionId]: sessionMessages,
        },
      });

      setComposerDraft('');

      const apiMessages = buildApiMessages(messageIds, sessionMessages);
      attachJobListener(jobId, sessionId, assistantMessageId);
      await startChatJob({
        jobId,
        provider: selectedProvider,
        apiMessages,
        userContent: trimmed,
      });
    },
    [attachJobListener, editTargetMessageId, persist, resolveProvider],
  );

  const setSessionProvider = useCallback(
    (sessionId: string, providerId: string) => {
      const current = stateRef.current;
      const session = current.sessions[sessionId];
      const provider = resolveProvider(providerId);
      if (!session || !provider) return;
      persist({
        ...current,
        sessions: {
          ...current.sessions,
          [sessionId]: {
            ...session,
            providerId: provider.id,
            model: provider.model,
            updatedAt: Date.now(),
          },
        },
      });
    },
    [persist, resolveProvider],
  );

  const beginEditMessage = useCallback(
    (messageId: string) => {
      const current = stateRef.current;
      const sessionId = current.activeSessionId;
      if (!sessionId) return;
      const message = current.messagesBySession[sessionId]?.[messageId];
      if (!message || message.role !== 'user') return;
      setEditTargetMessageId(messageId);
      setComposerDraft(getUserTextFromMessage(message));
    },
    [],
  );

  const cancelEdit = useCallback(() => {
    setEditTargetMessageId(null);
    setComposerDraft('');
  }, []);

  const toggleBlockCollapse = useCallback(
    (sessionId: string, messageId: string, blockIndex: number) => {
      updateMessage(sessionId, messageId, (message) => ({
        ...message,
        blocks: message.blocks.map((block, index) => {
          if (index !== blockIndex) return block;
          if (block.type === 'reasoning' || block.type === 'tool_call') {
            return { ...block, collapsed: !block.collapsed };
          }
          return block;
        }),
        updatedAt: Date.now(),
      }));
    },
    [updateMessage],
  );

  const isSessionStreaming = useCallback((sessionId: string) => {
    const session = stateRef.current.sessions[sessionId];
    return Boolean(
      session?.activeJobId && isJobRunning(session.activeJobId),
    );
  }, []);

  const getSessionMessages = useCallback(
    (sessionId: string) => {
      const session = state.messagesBySession[sessionId] ?? {};
      const ids = state.sessions[sessionId]?.messageIds ?? [];
      return ids
        .map((id) => session[id])
        .filter((message): message is ChatMessage => Boolean(message));
    },
    [state.messagesBySession, state.sessions],
  );

  const activeSession = useMemo(
    () =>
      state.activeSessionId
        ? (state.sessions[state.activeSessionId] ?? null)
        : null,
    [state.activeSessionId, state.sessions],
  );

  const value = useMemo(
    () => ({
      sessions: state.sessions,
      sessionOrder: state.sessionOrder,
      openTabIds: state.openTabIds,
      activeSessionId: state.activeSessionId,
      activeSession,
      messagesBySession: state.messagesBySession,
      historyOpen,
      composerDraft,
      editTargetMessageId,
      setHistoryOpen,
      setComposerDraft,
      createSession,
      closeTab,
      switchSession,
      openSessionTab,
      deleteSession,
      sendMessage,
      stopGeneration,
      beginEditMessage,
      cancelEdit,
      toggleBlockCollapse,
      setSessionProvider,
      isSessionStreaming,
      getSessionMessages,
    }),
    [
      state,
      activeSession,
      historyOpen,
      composerDraft,
      editTargetMessageId,
      createSession,
      closeTab,
      switchSession,
      openSessionTab,
      deleteSession,
      sendMessage,
      stopGeneration,
      beginEditMessage,
      cancelEdit,
      toggleBlockCollapse,
      setSessionProvider,
      isSessionStreaming,
      getSessionMessages,
    ],
  );

  return (
    <AgentChatContext.Provider value={value}>
      {children}
    </AgentChatContext.Provider>
  );
}

export function useAgentChat(): AgentChatContextValue {
  const ctx = useContext(AgentChatContext);
  if (!ctx) {
    throw new Error('useAgentChat must be used within AgentChatProvider');
  }
  return ctx;
}

export { createEmptyChatState };
