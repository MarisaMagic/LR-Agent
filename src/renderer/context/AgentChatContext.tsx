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
  type AgentInteractionMode,
  type AgentSession,
  type ChatMessage,
  type ClientContextPayload,
  type MessageBlock,
  type TurnKind,
  type TurnUnderstandingResult,
  isBatchAnnotationTurnKind,
} from '../../shared/agentTypes';
import {
  deleteAgentSessionRemote,
  fetchAgentSessionDetail,
  fetchAgentSessionsPage,
  loadRemoteAgentChatStateForProject,
  patchAgentSessionRemote,
} from '../services/agentChatApi';
import {
  applyStreamEventToBlocks,
  createEmptyChatState,
  createEmptyProjectUi,
  getUserTextFromMessage,
  inferRegenerateTurnKind,
  resolveUserMessageIdForJob,
  getProjectUi,
  loadAgentChatState,
  loadAgentChatUiState,
  persistAgentChatState,
  persistAgentChatUiState,
  sessionBelongsToProject,
  sessionHasHistoryContent,
  setProjectUi,
} from '../services/agentChatStore';
import {
  createDraftSession,
  mergeProjectSessionsIntoState,
  normalizeProjectTabs,
} from '../services/agentProjectBootstrap';
import { buildAnnotationProjectSnapshot } from '../services/buildProjectSnapshot';
import { understandTurn } from '../services/agentTurnRouter';
import { getRelativeProjectPath } from '../utils/projectPaths';
import tokenHolder from '../services/tokenHolder';
import { useAuth } from './AuthContext';
import {
  isJobRunning,
  startAnnotationBatchJobRunner,
  startChatJob,
  stopJob,
  subscribeJobEvents,
} from '../services/agentJobRegistry';
import {
  AnnotationRunPersistence,
} from '../services/annotationRunPersistence';
import type { AnnotationProjectSnapshot } from '../../shared/annotationAgentTypes';
import type { AnnotationProject } from '../types/annotation';
import type { PretrainedModelConfig } from '../types/pretrainedModel';
import { usePretrainedModels } from './PretrainedModelsContext';
import { shouldClearSummaryOnEdit } from '../services/chatContextUtils';
import { useAnnotation } from './AnnotationContext';
import { useApp } from './AppContext';
import { useLlmProviders } from './LlmProvidersContext';
import { useToast } from './ToastContext';
import { ApiError } from '../types/auth';
import translateError from '../utils/errors';

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
    options?: { editMessageId?: string; forceTurnKind?: TurnKind },
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
  updateMessageBlocks: (
    sessionId: string,
    messageId: string,
    updater: (blocks: MessageBlock[]) => MessageBlock[],
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
  /** 当前标注项目下的会话顺序（已过滤） */
  sessionOrderForProject: string[];
  currentAnnotationProjectId: string | null;
  agentMode: AgentInteractionMode;
  setAgentMode: (mode: AgentInteractionMode) => void;
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

function buildClientContextPayload(
  options: {
    rootPath: string | null;
    activeFilePath: string | null;
    activeProject: AnnotationProject | null;
    agentMode: AgentInteractionMode;
    detectionModels: PretrainedModelConfig[];
    turnKind?: TurnKind | null;
    turnUnderstanding?: TurnUnderstandingResult | null;
  },
): ClientContextPayload {
  const activeRelativePath =
    options.activeProject && options.activeFilePath
      ? getRelativeProjectPath(
          options.activeProject.directoryPath,
          options.activeFilePath,
        )
      : null;

  const base: ClientContextPayload = {
    workspaceRoot: options.rootPath,
    activeFilePath: options.activeFilePath,
    activeRelativePath,
    projectDirectoryPath: options.activeProject?.directoryPath ?? null,
    activeAnnotationProjectId: options.activeProject?.id ?? null,
    annotationProjectModality: options.activeProject?.modality ?? null,
    annotationProjectType: options.activeProject?.annotationType ?? null,
    agentMode: options.agentMode,
    turnKind: options.turnKind ?? null,
    turnUnderstanding: options.turnUnderstanding ?? null,
  };
  if (!options.activeProject) return base;
  const snap = buildAnnotationProjectSnapshot(
    options.activeProject,
    options.detectionModels,
  );
  return {
    ...base,
    annotationProjectSnapshot: {
      projectId: snap.projectId,
      name: snap.name,
      directoryPath: snap.directoryPath,
      modality: snap.modality,
      annotationType: snap.annotationType,
      annotationTypeLabel: snap.annotationTypeLabel,
      labels: snap.labels,
      detectionModels: snap.detectionModels ?? [],
    },
  };
}

export function AgentChatProvider({ children }: { children: ReactNode }) {
  const { providers, defaultProvider } = useLlmProviders();
  const { showToast } = useToast();
  const { status: authStatus } = useAuth();
  const { rootPath, activeFilePath } = useApp();
  const { activeProject } = useAnnotation();
  const { models: pretrainedModels } = usePretrainedModels();
  const [state, setState] = useState<AgentChatPersistedState>(() =>
    createEmptyChatState(),
  );
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
  const agentUiRef = useRef(loadAgentChatUiState());
  const activeProjectIdRef = useRef<string | null>(activeProject?.id ?? null);
  activeProjectIdRef.current = activeProject?.id ?? null;
  const [agentMode, setAgentModeState] = useState<AgentInteractionMode>(() =>
    getProjectUi(agentUiRef.current, activeProject?.id).agentMode,
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const currentAnnotationProjectId = activeProject?.id ?? null;

  const persistUiSlice = useCallback(
    (slice: Partial<ReturnType<typeof createEmptyProjectUi>>) => {
      const pid = activeProjectIdRef.current;
      const currentUi = getProjectUi(agentUiRef.current, pid);
      const nextUi = { ...currentUi, ...slice };
      agentUiRef.current = setProjectUi(agentUiRef.current, pid, nextUi);
      if (tokenHolder.getAccessToken()) {
        persistAgentChatUiState(agentUiRef.current);
      }
      if (slice.agentMode) {
        setAgentModeState(slice.agentMode);
      }
    },
    [],
  );

  const persist = useCallback(
    (next: AgentChatPersistedState) => {
      stateRef.current = next;
      setState(next);
      persistUiSlice({
        openTabIds: next.openTabIds,
        activeSessionId: next.activeSessionId,
      });
      if (!tokenHolder.getAccessToken()) {
        persistAgentChatState(next);
      }
    },
    [persistUiSlice],
  );

  const setAgentMode = useCallback(
    (mode: AgentInteractionMode) => {
      setAgentModeState(mode);
      persistUiSlice({ agentMode: mode });
    },
    [persistUiSlice],
  );

  const removeGhostSession = useCallback(
    (sessionId: string) => {
      const current = stateRef.current;
      if (!current.sessions[sessionId]) return;
      const { [sessionId]: _removedSession, ...sessions } = current.sessions;
      const { [sessionId]: _removedMessages, ...messagesBySession } =
        current.messagesBySession;
      const sessionOrder = current.sessionOrder.filter((id) => id !== sessionId);
      const openTabIds = current.openTabIds.filter((id) => id !== sessionId);
      let activeSessionId = current.activeSessionId;
      if (activeSessionId === sessionId) {
        activeSessionId = openTabIds[openTabIds.length - 1] ?? null;
      }
      loadedSessionsRef.current.delete(sessionId);
      persist({
        ...current,
        sessions,
        sessionOrder,
        openTabIds,
        activeSessionId,
        messagesBySession,
      });
    },
    [persist],
  );

  const reportRemoteSessionError = useCallback(
    (err: unknown, fallback: string) => {
      const message =
        err instanceof ApiError ? translateError(err.detail) : fallback;
      showToast(message, { type: 'error' });
    },
    [showToast],
  );

  const ensureSessionLoaded = useCallback(
    async (sessionId: string): Promise<boolean> => {
      if (!tokenHolder.getAccessToken()) return true;
      const current = stateRef.current;
      if (!sessionHasHistoryContent(sessionId, current)) {
        return true;
      }
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
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          if (sessionHasHistoryContent(sessionId, stateRef.current)) {
            removeGhostSession(sessionId);
            showToast('该对话未同步到云端，已从列表移除', { type: 'info' });
          }
          return false;
        }
        if (err instanceof ApiError && err.status === 429) {
          reportRemoteSessionError(err, '操作过于频繁，请稍后再试');
          return false;
        }
        reportRemoteSessionError(err, '加载对话失败，请重试');
        return false;
      }
    },
    [persist, removeGhostSession, reportRemoteSessionError, showToast],
  );

  const loadMoreSessions = useCallback(async () => {
    if (!tokenHolder.getAccessToken() || !sessionsHasMore || loadingMoreSessions) {
      return;
    }
    const cursor = sessionsNextCursorRef.current;
    if (!cursor) return;
    setLoadingMoreSessions(true);
    try {
      const page = await fetchAgentSessionsPage({
        cursor,
        annotationProjectId: activeProjectIdRef.current,
        workspaceOnly: !activeProjectIdRef.current,
      });
      sessionsNextCursorRef.current = page.nextCursor;
      setSessionsHasMore(page.hasMore);
      const latest = stateRef.current;
      const sessions = { ...latest.sessions };
      const messagesBySession = { ...latest.messagesBySession };
      const orderSeen = new Set(latest.sessionOrder);
      const sessionOrder = [...latest.sessionOrder];
      for (const session of page.sessions) {
        if (
          !sessionBelongsToProject(session, activeProjectIdRef.current)
        ) {
          continue;
        }
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
  }, [loadingMoreSessions, persist, sessionsHasMore, showToast, activeProject?.id]);

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

  const bootstrapProjectAgent = useCallback(async () => {
    loadedSessionsRef.current.clear();
    const projectId = activeProjectIdRef.current;
    const remote = await loadRemoteAgentChatStateForProject(projectId);
    const ui = getProjectUi(agentUiRef.current, projectId);
    let merged = mergeProjectSessionsIntoState(
      createEmptyChatState(),
      remote,
      projectId,
    );
    let { state: nextState, ui: nextUi } = normalizeProjectTabs(
      merged,
      ui,
      projectId,
    );

    if (nextUi.openTabIds.length === 0) {
      const provider = defaultProvider;
      const session = createDraftSession(
        projectId,
        provider ? { id: provider.id, model: provider.model } : null,
        getProjectUi(agentUiRef.current, projectId).agentMode,
      );
      nextState = {
        ...nextState,
        sessions: { ...nextState.sessions, [session.id]: session },
        openTabIds: [session.id],
        activeSessionId: session.id,
        messagesBySession: {
          ...nextState.messagesBySession,
          [session.id]: nextState.messagesBySession[session.id] ?? {},
        },
      };
      nextUi = {
        ...nextUi,
        openTabIds: [session.id],
        activeSessionId: session.id,
      };
    }

    sessionsNextCursorRef.current = remote.sessionsNextCursor;
    setSessionsHasMore(remote.sessionsHasMore);
    agentUiRef.current = setProjectUi(agentUiRef.current, projectId, nextUi);
    persistAgentChatUiState(agentUiRef.current);
    stateRef.current = nextState;
    setState(nextState);
    setAgentModeState(nextUi.agentMode);
    if (
      nextState.activeSessionId &&
      sessionHasHistoryContent(nextState.activeSessionId, nextState)
    ) {
      void ensureSessionLoaded(nextState.activeSessionId);
    }
  }, [defaultProvider, ensureSessionLoaded]);

  useEffect(() => {
    if (authStatus !== 'authenticated') {
      remoteHydratedRef.current = false;
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        await bootstrapProjectAgent();
        if (!cancelled) remoteHydratedRef.current = true;
      } catch (err) {
        if (!cancelled) {
          reportRemoteSessionError(err, '加载对话列表失败，请重试');
          remoteHydratedRef.current = true;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authStatus, activeProject?.id, bootstrapProjectAgent, reportRemoteSessionError]);

  useEffect(() => {
    if (authStatus === 'loading') return;
    if (authStatus === 'authenticated') return;
    loadedSessionsRef.current.clear();
    persist(normalizeLoadedState(loadAgentChatState()));
    const projectId = activeProject?.id ?? null;
    const ui = getProjectUi(agentUiRef.current, projectId);
    setAgentModeState(ui.agentMode);
    const current = stateRef.current;
    const openTabIds = ui.openTabIds.filter(
      (id) =>
        current.sessions[id] &&
        sessionBelongsToProject(current.sessions[id], projectId),
    );
    let activeSessionId = ui.activeSessionId;
    if (!activeSessionId || !openTabIds.includes(activeSessionId)) {
      activeSessionId = openTabIds[openTabIds.length - 1] ?? null;
    }
    if (
      openTabIds.join(',') !== current.openTabIds.join(',') ||
      activeSessionId !== current.activeSessionId
    ) {
      persist({ ...current, openTabIds, activeSessionId });
    }
  }, [activeProject?.id, authStatus, persist]);

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

    const projectId = activeProject?.id ?? null;
    const provider = defaultProvider;
    const session = createDraftSession(
      projectId,
      provider ? { id: provider.id, model: provider.model } : null,
      getProjectUi(agentUiRef.current, projectId).agentMode,
    );
    const latest = stateRef.current;
    persist({
      ...latest,
      sessions: { ...latest.sessions, [session.id]: session },
      openTabIds: [session.id],
      activeSessionId: session.id,
      messagesBySession: {
        ...latest.messagesBySession,
        [session.id]: {},
      },
    });
  }, [activeProject?.id, authStatus, defaultProvider, persist]);

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

  const updateMessageBlocks = useCallback(
    (
      sessionId: string,
      messageId: string,
      updater: (blocks: MessageBlock[]) => MessageBlock[],
    ) => {
      updateMessage(sessionId, messageId, (message) => ({
        ...message,
        blocks: updater(message.blocks),
        updatedAt: Date.now(),
      }));
    },
    [updateMessage],
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
              block.type === 'reasoning' ||
              block.type === 'tool_call' ||
              block.type === 'annotation_pipeline'
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
            blocks: existing.blocks.map((block) =>
              block.type === 'annotation_pipeline'
                ? {
                    ...block,
                    collapsed: true,
                    steps: block.steps.map((s) =>
                      s.status === 'running' ? { ...s, status: 'error' as const } : s,
                    ),
                  }
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

        if (
          event.type === 'preparing' ||
          event.type === 'route_decided'
        ) {
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
    const session = createDraftSession(
      activeProject?.id ?? null,
      provider ? { id: provider.id, model: provider.model } : null,
      agentMode,
    );
    persist({
      ...current,
      sessions: { ...current.sessions, [session.id]: session },
      openTabIds: [...current.openTabIds, session.id],
      activeSessionId: session.id,
      messagesBySession: {
        ...current.messagesBySession,
        [session.id]: current.messagesBySession[session.id] ?? {},
      },
    });
    setEditTargetMessageId(null);
    setComposerDraft('');
    return session.id;
  }, [activeProject?.id, agentMode, defaultProvider, persist]);

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

      let sessions = current.sessions;
      let sessionOrder = current.sessionOrder;
      let messagesBySession = current.messagesBySession;
      if (!sessionHasHistoryContent(sessionId, current)) {
        const { [sessionId]: _removed, ...restSessions } = sessions;
        sessions = restSessions;
        const { [sessionId]: _msgs, ...restMessages } = messagesBySession;
        messagesBySession = restMessages;
        sessionOrder = sessionOrder.filter((id) => id !== sessionId);
      }

      if (openTabIds.length === 0) {
        const provider = defaultProvider;
        const session = createDraftSession(
          activeProject?.id ?? null,
          provider ? { id: provider.id, model: provider.model } : null,
          agentMode,
        );
        persist({
          ...current,
          sessions: { ...sessions, [session.id]: session },
          sessionOrder,
          openTabIds: [session.id],
          activeSessionId: session.id,
          messagesBySession: { ...messagesBySession, [session.id]: {} },
        });
        return;
      }
      persist({ ...current, sessions, sessionOrder, openTabIds, activeSessionId, messagesBySession });
    },
    [activeProject?.id, agentMode, defaultProvider, persist],
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      const current = stateRef.current;
      const session = current.sessions[sessionId];
      if (session?.activeJobId && isJobRunning(session.activeJobId)) {
        stopJob(session.activeJobId);
      }

      if (tokenHolder.getAccessToken() && sessionHasHistoryContent(sessionId, current)) {
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
        const provider = defaultProvider;
        const session = createDraftSession(
          activeProject?.id ?? null,
          provider ? { id: provider.id, model: provider.model } : null,
          agentMode,
        );
        persist({
          sessions: { ...sessions, [session.id]: session },
          sessionOrder,
          openTabIds: [session.id],
          activeSessionId: session.id,
          messagesBySession: { ...messagesBySession, [session.id]: {} },
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
      if (activeSessionId && sessionHasHistoryContent(activeSessionId, {
        sessions,
        messagesBySession,
      })) {
        void ensureSessionLoaded(activeSessionId);
      }
    },
    [
      activeProject?.id,
      agentMode,
      defaultProvider,
      ensureSessionLoaded,
      persist,
      showToast,
    ],
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
    async (
      content: string,
      options?: { editMessageId?: string; forceTurnKind?: TurnKind },
    ) => {
      const trimmed = content.trim();
      if (!trimmed) return;

      const current = stateRef.current;
      const sessionId = current.activeSessionId;
      if (!sessionId) return;

      const wasDraft = !sessionHasHistoryContent(sessionId, current);

      if (tokenHolder.getAccessToken() && !wasDraft) {
        const loaded = await ensureSessionLoaded(sessionId);
        if (!loaded) return;
      }

      const session = stateRef.current.sessions[sessionId];
      if (!session) return;

      if (session.activeJobId && isJobRunning(session.activeJobId)) {
        showToast('当前任务仍在进行，请先停止后再发送', { type: 'info' });
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
      let newUserMessageId: string | null = null;

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
        newUserMessageId = userMessageId;
        const userMessage: ChatMessage = {
          id: userMessageId,
          sessionId,
          role: 'user',
          blocks: [{ type: 'text', content: trimmed }],
          status: 'done',
          interactionMode: agentMode,
          providerId: selectedProvider.id,
          model: selectedProvider.model,
          createdAt: now,
          updatedAt: now,
        };
        sessionMessages[userMessageId] = userMessage;
        messageIds.push(userMessageId);
      }

      const userMessageIdForJob = resolveUserMessageIdForJob({
        editMessageId,
        newUserMessageId,
      });
      const assistantMessageId = createAgentId('msg');
      const assistantMessage: ChatMessage = {
        id: assistantMessageId,
        sessionId,
        role: 'assistant',
        blocks: [],
        status: 'streaming',
        interactionMode: agentMode,
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
      const baseClientContext = buildClientContextPayload({
        rootPath,
        activeFilePath,
        activeProject: activeProject ?? null,
        agentMode,
        detectionModels: pretrainedModels,
      });

      let turnUnderstanding: TurnUnderstandingResult | null = null;
      let effectiveUserContent = trimmed;

      if (tokenHolder.getAccessToken() && !options?.forceTurnKind) {
        try {
          turnUnderstanding = await understandTurn({
            providerId: selectedProvider.id,
            userContent: trimmed,
            clientContext: baseClientContext,
            sessionId,
            userMessageId: userMessageIdForJob,
            assistantMessageId,
            truncateFromMessageId,
          });
          effectiveUserContent = turnUnderstanding.resolvedUserContent;
        } catch {
          showToast('回合理解失败，已按原文处理', { type: 'info' });
        }
      }

      const clientContext = buildClientContextPayload({
        rootPath,
        activeFilePath,
        activeProject: activeProject ?? null,
        agentMode,
        detectionModels: pretrainedModels,
        turnKind: options?.forceTurnKind ?? turnUnderstanding?.turnKind ?? null,
        turnUnderstanding,
      });

      try {
        const turnKind: TurnKind =
          options?.forceTurnKind ?? turnUnderstanding?.turnKind ?? 'converse';

        if (turnKind === 'unsupported') {
          throw new Error('当前无法处理该请求，请检查项目类型或描述');
        }

        const canAnnotate =
          Boolean(activeProject) &&
          activeProject?.modality === 'image' &&
          activeProject?.annotationType === 'bbox';

        if (isBatchAnnotationTurnKind(turnKind) && !canAnnotate) {
          throw new Error('批量标注需要已打开的图片 bbox 标注项目');
        }

        if (isBatchAnnotationTurnKind(turnKind)) {
          if (!tokenHolder.getAccessToken()) {
            throw new Error('请先登录后再使用标注功能');
          }
          const snapshot: AnnotationProjectSnapshot =
            buildAnnotationProjectSnapshot(activeProject!, pretrainedModels);
          const persistence = new AnnotationRunPersistence();
          let persistenceStarted = false;
          try {
            await persistence.start({
              providerId: selectedProvider.id,
              sessionId,
              clientJobId: jobId,
              userContent: effectiveUserContent,
              userMessageId: userMessageIdForJob,
              assistantMessageId,
              truncateFromMessageId,
              clientContext,
            });
            persistenceStarted = true;
            await startAnnotationBatchJobRunner({
              jobId,
              providerId: selectedProvider.id,
              userRequest: effectiveUserContent,
              sessionId,
              project: snapshot,
              currentFileAbsolutePath: activeFilePath,
              detectionModels: pretrainedModels,
              onPersistEvent: (event) => persistence.push(event),
            });
            const finalMessage =
              stateRef.current.messagesBySession[sessionId]?.[
                assistantMessageId
              ];
            if (finalMessage?.status === 'stopped') {
              await persistence.finalize({ status: 'stopped' });
            } else if (finalMessage?.status === 'error') {
              await persistence.finalize({
                status: 'error',
                error: finalMessage.error ?? '批量标注失败',
              });
            } else {
              await persistence.finalize({ status: 'done' });
            }
          } catch (innerErr) {
            if (persistenceStarted) {
              await persistence
                .finalize({
                  status: 'error',
                  error:
                    innerErr instanceof Error
                      ? innerErr.message
                      : '批量标注失败',
                })
                .catch(() => undefined);
            }
            throw innerErr;
          }
        } else {
          await startChatJob({
            jobId,
            session: nextSession,
            messageIds,
            sessionMessages,
            providerId: selectedProvider.id,
            userMessageId: userMessageIdForJob,
            assistantMessageId,
            userContent: effectiveUserContent,
            truncateFromMessageId,
            clientContext,
          });
        }
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
      activeProject,
      agentMode,
      attachJobListener,
      pretrainedModels,
      editTargetMessageId,
      ensureSessionLoaded,
      persist,
      resolveProvider,
      rootPath,
      showToast,
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

      const assistantIndex = session.messageIds.indexOf(assistantMessageId);
      if (assistantIndex < 0) return;

      const assistantMessage =
        current.messagesBySession[sessionId]?.[assistantMessageId];
      if (!assistantMessage || assistantMessage.role !== 'assistant') {
        return;
      }

      if (session.activeJobId && isJobRunning(session.activeJobId)) {
        stopGeneration(sessionId);
      }

      const sessionMessages = {
        ...(current.messagesBySession[sessionId] ?? {}),
      };
      let markedStopped = false;
      for (const id of session.messageIds) {
        const msg = sessionMessages[id];
        if (msg?.status === 'streaming') {
          sessionMessages[id] = {
            ...msg,
            status: 'stopped',
            updatedAt: Date.now(),
          };
          markedStopped = true;
        }
      }
      if (markedStopped) {
        persist({
          ...stateRef.current,
          messagesBySession: {
            ...stateRef.current.messagesBySession,
            [sessionId]: sessionMessages,
          },
        });
      }

      let userMessageId: string | null = null;
      let userContent = '';
      for (let i = assistantIndex - 1; i >= 0; i -= 1) {
        const id = session.messageIds[i];
        const msg = stateRef.current.messagesBySession[sessionId]?.[id];
        if (msg?.role === 'user') {
          userMessageId = id;
          userContent = getUserTextFromMessage(msg);
          break;
        }
      }
      if (!userMessageId || !userContent.trim()) return;

      const forceTurnKind = inferRegenerateTurnKind(assistantMessage);
      await sendMessage(userContent, {
        editMessageId: userMessageId,
        forceTurnKind,
      });
    },
    [agentMode, persist, sendMessage, stopGeneration],
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
          if (block.type === 'annotation_pipeline') {
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

  const sessionOrderForProject = useMemo(
    () =>
      state.sessionOrder.filter(
        (id) =>
          sessionBelongsToProject(state.sessions[id], currentAnnotationProjectId) &&
          sessionHasHistoryContent(id, state),
      ),
    [state.sessionOrder, state.sessions, state.messagesBySession, currentAnnotationProjectId],
  );

  const value = useMemo(
    () => ({
      sessions: state.sessions,
      sessionOrder: state.sessionOrder,
      sessionOrderForProject,
      currentAnnotationProjectId,
      agentMode,
      setAgentMode,
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
      updateMessageBlocks,
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
      sessionOrderForProject,
      currentAnnotationProjectId,
      agentMode,
      setAgentMode,
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
      updateMessageBlocks,
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
