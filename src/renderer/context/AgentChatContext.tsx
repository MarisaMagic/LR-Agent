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
  createAgentSessionRemote,
  deleteAgentSessionRemote,
  fetchAgentSessionDetail,
  fetchAgentSessionsPage,
  loadRemoteAgentChatState,
  patchAgentSessionRemote,
} from '../services/agentChatApi';
import {
  applyStreamEventToBlocks,
  createEmptyChatState,
  getUserTextFromMessage,
  loadAgentChatState,
  loadAgentChatUiState,
  persistAgentChatState,
  persistAgentChatUiState,
} from '../services/agentChatStore';
import tokenHolder from '../services/tokenHolder';
import { useAuth } from './AuthContext';
import {
  isJobRunning,
  startChatJob,
  stopJob,
  subscribeJobEvents,
} from '../services/agentJobRegistry';
import { shouldClearSummaryOnEdit } from '../services/chatContextUtils';
import { useAnnotation } from './AnnotationContext';
import { useApp } from './AppContext';
import { useLlmProviders } from './LlmProvidersContext';
import { useToast } from './ToastContext';

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
  editDraft: string;
  setHistoryOpen: (open: boolean) => void;
  setComposerDraft: (draft: string) => void;
  setEditDraft: (draft: string) => void;
  createSession: () => string;
  closeTab: (sessionId: string) => void;
  switchSession: (sessionId: string) => void;
  openSessionTab: (sessionId: string) => void;
  deleteSession: (sessionId: string) => void;
  sendMessage: (
    content: string,
    options?: { editMessageId?: string },
  ) => Promise<void>;
  stopGeneration: (sessionId?: string) => void;
  beginEditMessage: (messageId: string) => void;
  cancelEdit: () => void;
  regenerateAssistant: (assistantMessageId: string) => Promise<void>;
  toggleBlockCollapse: (
    sessionId: string,
    messageId: string,
    blockIndex: number,
  ) => void;
  setSessionProvider: (sessionId: string, providerId: string) => void;
  isSessionStreaming: (sessionId: string) => boolean;
  preparingContext: boolean;
  sessionsHasMore: boolean;
  loadingMoreSessions: boolean;
  loadingOlderMessages: boolean;
  getSessionMessages: (sessionId: string) => ChatMessage[];
  loadMoreSessions: () => Promise<void>;
  loadOlderMessages: (sessionId?: string) => Promise<void>;
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
  const { showToast } = useToast();
  const { status: authStatus } = useAuth();
  const { rootPath, activeFilePath } = useApp();
  const { activeProject } = useAnnotation();
  const [state, setState] = useState<AgentChatPersistedState>(() => {
    if (tokenHolder.getAccessToken()) {
      return createEmptyChatState();
    }
    return normalizeLoadedState(loadAgentChatState());
  });
  const initializedRef = useRef(false);
  const remoteHydratedRef = useRef(false);
  const loadedSessionsRef = useRef<Set<string>>(new Set());
  const sessionsNextCursorRef = useRef<string | null>(null);
  const [sessionsHasMore, setSessionsHasMore] = useState(false);
  const [loadingMoreSessions, setLoadingMoreSessions] = useState(false);
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [composerDraft, setComposerDraft] = useState('');
  const [editTargetMessageId, setEditTargetMessageId] = useState<string | null>(
    null,
  );
  const [editDraft, setEditDraft] = useState('');
  const [preparingContext, setPreparingContext] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  const persist = useCallback((next: AgentChatPersistedState) => {
    stateRef.current = next;
    setState(next);
    if (tokenHolder.getAccessToken()) {
      persistAgentChatUiState({
        openTabIds: next.openTabIds,
        activeSessionId: next.activeSessionId,
      });
    } else {
      persistAgentChatState(next);
    }
  }, []);

  const ensureSessionLoaded = useCallback(
    async (sessionId: string): Promise<boolean> => {
      if (!tokenHolder.getAccessToken()) return true;
      const current = stateRef.current;
      const existing = current.messagesBySession[sessionId];
      const sessionMeta = current.sessions[sessionId];
      const messageCount = sessionMeta?.messageCount ?? 0;
      if (
        loadedSessionsRef.current.has(sessionId) &&
        ((existing && Object.keys(existing).length > 0) || messageCount === 0)
      ) {
        return true;
      }
      try {
        const detail = await fetchAgentSessionDetail(sessionId);
        loadedSessionsRef.current.add(sessionId);
        const latest = stateRef.current;
        persist({
          ...latest,
          sessions: {
            ...latest.sessions,
            [sessionId]: {
              ...detail.session,
              activeJobId: latest.sessions[sessionId]?.activeJobId,
            },
          },
          messagesBySession: {
            ...latest.messagesBySession,
            [sessionId]: detail.messages,
          },
        });
        return true;
      } catch {
        showToast('加载对话失败，请重试', { type: 'error' });
        return false;
      }
    },
    [persist, showToast],
  );

  const loadMoreSessions = useCallback(async () => {
    if (!tokenHolder.getAccessToken() || !sessionsHasMore || loadingMoreSessions) {
      return;
    }
    const cursor = sessionsNextCursorRef.current;
    if (!cursor) return;
    setLoadingMoreSessions(true);
    try {
      const page = await fetchAgentSessionsPage({ cursor });
      sessionsNextCursorRef.current = page.nextCursor;
      setSessionsHasMore(page.hasMore);
      const latest = stateRef.current;
      const sessions = { ...latest.sessions };
      const messagesBySession = { ...latest.messagesBySession };
      const orderSeen = new Set(latest.sessionOrder);
      const sessionOrder = [...latest.sessionOrder];
      for (const session of page.sessions) {
        sessions[session.id] = {
          ...session,
          activeJobId: latest.sessions[session.id]?.activeJobId,
        };
        if (!messagesBySession[session.id]) {
          messagesBySession[session.id] = {};
        }
        if (!orderSeen.has(session.id)) {
          orderSeen.add(session.id);
          sessionOrder.push(session.id);
        }
      }
      persist({ ...latest, sessions, sessionOrder, messagesBySession });
    } catch {
      showToast('加载更多历史失败', { type: 'error' });
    } finally {
      setLoadingMoreSessions(false);
    }
  }, [loadingMoreSessions, persist, sessionsHasMore, showToast]);

  const loadOlderMessages = useCallback(
    async (sessionId?: string) => {
      const targetId = sessionId ?? stateRef.current.activeSessionId;
      if (!targetId || !tokenHolder.getAccessToken() || loadingOlderMessages) {
        return;
      }
      const current = stateRef.current;
      const session = current.sessions[targetId];
      if (!session?.hasMoreMessagesBefore) return;
      const oldestId = session.messageIds[0];
      if (!oldestId) return;

      setLoadingOlderMessages(true);
      try {
        const detail = await fetchAgentSessionDetail(targetId, {
          beforeMessageId: oldestId,
        });
        const latest = stateRef.current;
        const mergedMessages = {
          ...(latest.messagesBySession[targetId] ?? {}),
          ...detail.messages,
        };
        const newIds = detail.session.messageIds.filter(
          (id) => !session.messageIds.includes(id),
        );
        persist({
          ...latest,
          sessions: {
            ...latest.sessions,
            [targetId]: {
              ...latest.sessions[targetId],
              ...detail.session,
              messageIds: [...newIds, ...session.messageIds],
              activeJobId: session.activeJobId,
            },
          },
          messagesBySession: {
            ...latest.messagesBySession,
            [targetId]: mergedMessages,
          },
        });
      } catch {
        showToast('加载更早消息失败', { type: 'error' });
      } finally {
        setLoadingOlderMessages(false);
      }
    },
    [loadingOlderMessages, persist, showToast],
  );

  useEffect(() => {
    if (authStatus !== 'authenticated') {
      remoteHydratedRef.current = false;
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const remote = await loadRemoteAgentChatState();
        if (cancelled) return;
        const ui = loadAgentChatUiState();
        const openTabIds =
          ui.openTabIds.length > 0
            ? ui.openTabIds.filter((id) => remote.sessions[id])
            : remote.openTabIds;
        const activeSessionId =
          ui.activeSessionId && remote.sessions[ui.activeSessionId]
            ? ui.activeSessionId
            : remote.activeSessionId;

        sessionsNextCursorRef.current = remote.sessionsNextCursor;
        setSessionsHasMore(remote.sessionsHasMore);

        const { sessionsNextCursor: _c, sessionsHasMore: _h, ...remoteState } = remote;
        const merged: AgentChatPersistedState = {
          ...remoteState,
          openTabIds,
          activeSessionId,
        };
        remoteHydratedRef.current = true;
        stateRef.current = merged;
        setState(merged);
        persistAgentChatUiState({
          openTabIds: merged.openTabIds,
          activeSessionId: merged.activeSessionId,
        });
        if (merged.activeSessionId) {
          void ensureSessionLoaded(merged.activeSessionId);
        }
      } catch {
        if (!cancelled) {
          remoteHydratedRef.current = true;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authStatus, ensureSessionLoaded]);

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
    if (authStatus === 'loading') return;
    if (authStatus === 'authenticated' && !remoteHydratedRef.current) return;
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

    if (tokenHolder.getAccessToken()) {
      createAgentSessionRemote(session).catch(() => undefined);
    }
  }, [authStatus, defaultProvider, persist]);

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
        if (event.type === 'done') {
          const latest = stateRef.current;
          const sessionMessages = {
            ...(latest.messagesBySession[sessionId] ?? {}),
          };
          const existing = sessionMessages[messageId];
          if (!existing) return;

          sessionMessages[messageId] = {
            ...existing,
            status: 'done',
            updatedAt: Date.now(),
            blocks: existing.blocks.map((block) =>
              block.type === 'reasoning' || block.type === 'tool_call'
                ? { ...block, collapsed: true }
                : block,
            ),
          };

          const session = latest.sessions[sessionId];
          persist({
            ...latest,
            messagesBySession: {
              ...latest.messagesBySession,
              [sessionId]: sessionMessages,
            },
            sessions: session
              ? {
                  ...latest.sessions,
                  [sessionId]: {
                    ...session,
                    activeJobId: undefined,
                    updatedAt: Date.now(),
                  },
                }
              : latest.sessions,
          });
          return;
        }

        if (event.type === 'error') {
          const latest = stateRef.current;
          const sessionMessages = {
            ...(latest.messagesBySession[sessionId] ?? {}),
          };
          const existing = sessionMessages[messageId];
          if (!existing) return;

          sessionMessages[messageId] = {
            ...existing,
            status: 'error',
            error: event.message,
            updatedAt: Date.now(),
          };

          const session = latest.sessions[sessionId];
          persist({
            ...latest,
            messagesBySession: {
              ...latest.messagesBySession,
              [sessionId]: sessionMessages,
            },
            sessions: session
              ? {
                  ...latest.sessions,
                  [sessionId]: {
                    ...session,
                    activeJobId: undefined,
                    updatedAt: Date.now(),
                  },
                }
              : latest.sessions,
          });
          return;
        }

        if (event.type === 'context_updated') {
          const latest = stateRef.current;
          const session = latest.sessions[sessionId];
          if (!session) return;

          persist({
            ...latest,
            sessions: {
              ...latest.sessions,
              [sessionId]: {
                ...session,
                contextSummary: event.summary,
                summaryUpToMessageId: event.summaryUpToMessageId,
                lastContextTokenEstimate: event.tokenEstimate,
                updatedAt: Date.now(),
              },
            },
          });
          return;
        }

        if (event.type === 'preparing' || event.type === 'route_decided') {
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
    if (tokenHolder.getAccessToken()) {
      createAgentSessionRemote(session).catch(() => undefined);
    }
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
      void ensureSessionLoaded(sessionId);
    },
    [persist, ensureSessionLoaded],
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
      void ensureSessionLoaded(sessionId);
    },
    [persist, ensureSessionLoaded],
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
        if (tokenHolder.getAccessToken()) {
          createAgentSessionRemote(session).catch(() => undefined);
        }
        return;
      }
      persist({ ...current, openTabIds, activeSessionId });
    },
    [defaultProvider, persist],
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      const current = stateRef.current;
      const session = current.sessions[sessionId];
      if (session?.activeJobId && isJobRunning(session.activeJobId)) {
        stopJob(session.activeJobId);
      }

      if (tokenHolder.getAccessToken()) {
        try {
          await deleteAgentSessionRemote(sessionId);
        } catch {
          showToast('删除对话失败，请重试', { type: 'error' });
          return;
        }
      }

      loadedSessionsRef.current.delete(sessionId);

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
        if (tokenHolder.getAccessToken()) {
          createAgentSessionRemote(newSession).catch(() => undefined);
        }
        return;
      }
      persist({
        sessions,
        sessionOrder,
        openTabIds,
        activeSessionId,
        messagesBySession,
      });
      if (activeSessionId) {
        void ensureSessionLoaded(activeSessionId);
      }
    },
    [defaultProvider, persist, showToast, ensureSessionLoaded],
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
    async (content: string, options?: { editMessageId?: string }) => {
      const trimmed = content.trim();
      if (!trimmed) return;

      const current = stateRef.current;
      const sessionId = current.activeSessionId;
      if (!sessionId) return;

      if (tokenHolder.getAccessToken()) {
        const loaded = await ensureSessionLoaded(sessionId);
        if (!loaded) return;
      }

      const session = stateRef.current.sessions[sessionId];
      if (!session) return;

      if (session.activeJobId && isJobRunning(session.activeJobId)) {
        return;
      }

      const selectedProvider = resolveProvider(session.providerId);
      if (!selectedProvider) return;

      const editMessageId =
        options?.editMessageId ?? editTargetMessageId ?? null;
      const isEdit = Boolean(editMessageId);

      const now = Date.now();
      let messageIds = [...session.messageIds];
      const sessionMessages = {
        ...(stateRef.current.messagesBySession[sessionId] ?? {}),
      };

      let truncateFromMessageId: string | null = null;
      let sessionForContext: AgentSession = { ...session };

      if (editMessageId) {
        const editIndex = messageIds.indexOf(editMessageId);
        if (editIndex >= 0) {
          truncateFromMessageId = editMessageId;
          const clearSummary = shouldClearSummaryOnEdit(
            session,
            messageIds,
            editMessageId,
          );
          const removedIds = messageIds.slice(editIndex + 1);
          messageIds = messageIds.slice(0, editIndex + 1);
          for (const removedId of removedIds) {
            delete sessionMessages[removedId];
          }
          sessionMessages[editMessageId] = {
            ...sessionMessages[editMessageId],
            blocks: [{ type: 'text', content: trimmed }],
            updatedAt: now,
          };
          if (clearSummary) {
            sessionForContext = {
              ...sessionForContext,
              contextSummary: undefined,
              summaryUpToMessageId: undefined,
            };
          }
        }
        setEditTargetMessageId(null);
        setEditDraft('');
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

      const userMessageIdForJob = isEdit
        ? editMessageId!
        : messageIds[messageIds.length - 2] ?? createAgentId('msg');
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
        session.title === '新对话' || isEdit
          ? buildSessionTitle(trimmed)
          : session.title;

      const nextSession: AgentSession = {
        ...sessionForContext,
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

      attachJobListener(jobId, sessionId, assistantMessageId);
      setPreparingContext(true);
      try {
        await startChatJob({
          jobId,
          session: nextSession,
          messageIds,
          sessionMessages,
          providerId: selectedProvider.id,
          userMessageId: userMessageIdForJob,
          assistantMessageId,
          userContent: trimmed,
          truncateFromMessageId,
          clientContext: {
            workspaceRoot: rootPath,
            activeFilePath,
            activeAnnotationProjectId: activeProject?.id ?? null,
          },
        });
      } catch (err) {
        updateMessage(sessionId, assistantMessageId, (message) => ({
          ...message,
          status: 'error',
          error: err instanceof Error ? err.message : '对话请求失败',
          updatedAt: Date.now(),
        }));
        const latest = stateRef.current.sessions[sessionId];
        if (latest) {
          persist({
            ...stateRef.current,
            sessions: {
              ...stateRef.current.sessions,
              [sessionId]: {
                ...latest,
                activeJobId: undefined,
                updatedAt: Date.now(),
              },
            },
          });
        }
      } finally {
        setPreparingContext(false);
      }
    },
    [
      activeFilePath,
      activeProject?.id,
      attachJobListener,
      editTargetMessageId,
      ensureSessionLoaded,
      persist,
      resolveProvider,
      rootPath,
      updateMessage,
    ],
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
      if (tokenHolder.getAccessToken()) {
        patchAgentSessionRemote(sessionId, {
          providerId: provider.id,
          model: provider.model,
        }).catch(() => undefined);
      }
    },
    [persist, resolveProvider],
  );

  const beginEditMessage = useCallback(
    (messageId: string) => {
      const current = stateRef.current;
      const sessionId = current.activeSessionId;
      if (!sessionId) return;
      const session = current.sessions[sessionId];
      if (session?.activeJobId && isJobRunning(session.activeJobId)) return;
      const message = current.messagesBySession[sessionId]?.[messageId];
      if (!message || message.role !== 'user' || message.status !== 'done') {
        return;
      }
      setEditTargetMessageId(messageId);
      setEditDraft(getUserTextFromMessage(message));
    },
    [],
  );

  const cancelEdit = useCallback(() => {
    setEditTargetMessageId(null);
    setEditDraft('');
  }, []);

  const regenerateAssistant = useCallback(
    async (assistantMessageId: string) => {
      const current = stateRef.current;
      const sessionId = current.activeSessionId;
      if (!sessionId) return;

      const session = current.sessions[sessionId];
      if (!session) return;
      if (session.activeJobId && isJobRunning(session.activeJobId)) return;

      const assistantIndex = session.messageIds.indexOf(assistantMessageId);
      if (assistantIndex < 0) return;

      let userMessageId: string | null = null;
      let userContent = '';
      for (let i = assistantIndex - 1; i >= 0; i -= 1) {
        const id = session.messageIds[i];
        const msg = current.messagesBySession[sessionId]?.[id];
        if (msg?.role === 'user') {
          userMessageId = id;
          userContent = getUserTextFromMessage(msg);
          break;
        }
      }
      if (!userMessageId || !userContent.trim()) return;

      await sendMessage(userContent, { editMessageId: userMessageId });
    },
    [sendMessage],
  );

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
      editDraft,
      setHistoryOpen,
      setComposerDraft,
      setEditDraft,
      createSession,
      closeTab,
      switchSession,
      openSessionTab,
      deleteSession,
      sendMessage,
      stopGeneration,
      beginEditMessage,
      cancelEdit,
      regenerateAssistant,
      toggleBlockCollapse,
      setSessionProvider,
      isSessionStreaming,
      preparingContext,
      sessionsHasMore,
      loadingMoreSessions,
      loadingOlderMessages,
      getSessionMessages,
      loadMoreSessions,
      loadOlderMessages,
    }),
    [
      state,
      activeSession,
      historyOpen,
      composerDraft,
      editTargetMessageId,
      editDraft,
      preparingContext,
      sessionsHasMore,
      loadingMoreSessions,
      loadingOlderMessages,
      createSession,
      closeTab,
      switchSession,
      openSessionTab,
      deleteSession,
      sendMessage,
      stopGeneration,
      beginEditMessage,
      cancelEdit,
      regenerateAssistant,
      toggleBlockCollapse,
      setSessionProvider,
      isSessionStreaming,
      getSessionMessages,
      loadMoreSessions,
      loadOlderMessages,
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
