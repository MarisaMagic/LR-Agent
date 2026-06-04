import {
  createAgentId,
  type AgentInteractionMode,
  type AgentSession,
  type AgentChatPersistedState,
} from '../../shared/agentTypes';
import {
  fetchAgentSessionsPage,
  loadRemoteAgentChatStateForProject,
} from './agentChatApi';
import {
  createEmptyProjectUi,
  sessionBelongsToProject,
  sessionHasHistoryContent,
  type AgentChatUiStateV2,
  getProjectUi,
  setProjectUi,
} from './agentChatStore';

export async function fetchProjectAgentSessions(
  annotationProjectId: string,
): Promise<{
  sessions: Record<string, AgentSession>;
  sessionOrder: string[];
  sessionsNextCursor: string | null;
  sessionsHasMore: boolean;
}> {
  const remote = await loadRemoteAgentChatStateForProject(annotationProjectId);
  return {
    sessions: remote.sessions,
    sessionOrder: remote.sessionOrder,
    sessionsNextCursor: remote.sessionsNextCursor,
    sessionsHasMore: remote.sessionsHasMore,
  };
}

export function mergeProjectSessionsIntoState(
  current: AgentChatPersistedState,
  incoming: {
    sessions: Record<string, AgentSession>;
    sessionOrder: string[];
  },
  annotationProjectId: string | null,
): AgentChatPersistedState {
  const sessions = { ...current.sessions };
  for (const [id, session] of Object.entries(incoming.sessions)) {
    if (
      sessionBelongsToProject(session, annotationProjectId) &&
      (session.messageCount ?? 0) > 0
    ) {
      sessions[id] = session;
    }
  }
  const orderSet = new Set(
    current.sessionOrder.filter((id) => sessionHasHistoryContent(id, { sessions, messagesBySession: current.messagesBySession })),
  );
  for (const id of incoming.sessionOrder) {
    if (sessions[id]) orderSet.add(id);
  }
  return {
    ...current,
    sessions,
    sessionOrder: [...orderSet].sort((a, b) => {
      const ta = sessions[a]?.updatedAt ?? 0;
      const tb = sessions[b]?.updatedAt ?? 0;
      return tb - ta;
    }),
  };
}

export function normalizeProjectTabs(
  state: AgentChatPersistedState,
  ui: ReturnType<typeof createEmptyProjectUi>,
  annotationProjectId: string | null,
): { state: AgentChatPersistedState; ui: ReturnType<typeof createEmptyProjectUi> } {
  const validTabIds = ui.openTabIds.filter(
    (id) =>
      state.sessions[id] &&
      sessionBelongsToProject(state.sessions[id], annotationProjectId),
  );
  const openTabIds = validTabIds.length > 0 ? validTabIds : [];
  let activeSessionId = ui.activeSessionId;
  if (!activeSessionId || !openTabIds.includes(activeSessionId)) {
    activeSessionId = openTabIds[openTabIds.length - 1] ?? null;
  }
  return {
    state: { ...state, openTabIds, activeSessionId },
    ui: { ...ui, openTabIds, activeSessionId },
  };
}

/** Local-only draft tab; not synced to server and not listed in history until first message. */
export function createDraftSession(
  annotationProjectId: string | null,
  provider: { id: string; model: string } | null,
  interactionMode?: AgentInteractionMode,
): AgentSession {
  const id = createAgentId('session');
  const now = Date.now();
  const mode: AgentInteractionMode =
    interactionMode ?? (annotationProjectId ? 'annotation' : 'chat');
  return {
    id,
    title: '新对话',
    annotationProjectId: annotationProjectId ?? null,
    interactionMode: mode,
    providerId: provider?.id ?? '',
    model: provider?.model ?? '',
    messageIds: [],
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function saveUiForProject(
  agentUi: AgentChatUiStateV2,
  annotationProjectId: string | null | undefined,
  slice: ReturnType<typeof createEmptyProjectUi>,
): AgentChatUiStateV2 {
  return setProjectUi(agentUi, annotationProjectId, slice);
}

export function loadUiForProject(
  agentUi: AgentChatUiStateV2,
  annotationProjectId: string | null | undefined,
) {
  return getProjectUi(agentUi, annotationProjectId);
}
