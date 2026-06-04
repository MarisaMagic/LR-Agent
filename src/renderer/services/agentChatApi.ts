import type {
  AgentChatPersistedState,
  AgentSession,
  ChatMessage,
  MessageBlock,
} from '../../shared/agentTypes';
import { apiFetch } from './api';

const DEFAULT_SESSION_PAGE_SIZE = 50;
const DEFAULT_MESSAGE_PAGE_SIZE = 50;

interface AgentMessageApiRow {
  id: string;
  session_id: string;
  role: string;
  blocks: MessageBlock[];
  status: ChatMessage['status'];
  provider_id: string;
  model: string;
  error?: string | null;
  created_at: number;
  updated_at: number;
}

interface AgentSessionApiRow {
  id: string;
  title: string;
  annotation_project_id?: string | null;
  interaction_mode?: string | null;
  provider_id: string;
  model: string;
  message_ids: string[];
  message_count?: number;
  last_message_preview?: string | null;
  context_summary?: string | null;
  summary_up_to_message_id?: string | null;
  last_context_token_estimate?: number | null;
  created_at: number;
  updated_at: number;
}

interface AgentSessionListApiResponse {
  sessions: AgentSessionApiRow[];
  next_cursor?: string | null;
  has_more?: boolean;
}

interface AgentSessionDetailApiResponse {
  session: AgentSessionApiRow;
  messages: AgentMessageApiRow[];
  has_more_before?: boolean;
}

function mapMessage(row: AgentMessageApiRow): ChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role as ChatMessage['role'],
    blocks: row.blocks ?? [],
    status: row.status,
    providerId: row.provider_id,
    model: row.model,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSession(row: AgentSessionApiRow): AgentSession {
  return {
    id: row.id,
    title: row.title,
    annotationProjectId: row.annotation_project_id ?? null,
    interactionMode:
      row.interaction_mode === 'annotation' || row.interaction_mode === 'chat'
        ? row.interaction_mode
        : null,
    providerId: row.provider_id,
    model: row.model,
    messageIds: row.message_ids ?? [],
    messageCount: row.message_count,
    lastMessagePreview: row.last_message_preview ?? undefined,
    contextSummary: row.context_summary ?? undefined,
    summaryUpToMessageId: row.summary_up_to_message_id ?? undefined,
    lastContextTokenEstimate: row.last_context_token_estimate ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface AgentSessionsPage {
  sessions: AgentSession[];
  nextCursor: string | null;
  hasMore: boolean;
}

export async function fetchAgentSessionsPage(
  options: {
    limit?: number;
    cursor?: string | null;
    annotationProjectId?: string | null;
    workspaceOnly?: boolean;
  } = {},
): Promise<AgentSessionsPage> {
  const params = new URLSearchParams();
  const limit = options.limit ?? DEFAULT_SESSION_PAGE_SIZE;
  params.set('limit', String(limit));
  if (options.cursor) {
    params.set('cursor', options.cursor);
  }
  if (options.workspaceOnly) {
    params.set('workspace_only', 'true');
  } else if (options.annotationProjectId) {
    params.set('annotation_project_id', options.annotationProjectId);
  }
  const data = await apiFetch<AgentSessionListApiResponse>(
    `/agent/sessions?${params.toString()}`,
  );
  return {
    sessions: data.sessions.map(mapSession),
    nextCursor: data.next_cursor ?? null,
    hasMore: Boolean(data.has_more),
  };
}

export async function fetchAgentSessionDetail(
  sessionId: string,
  options: { limit?: number; beforeMessageId?: string | null } = {},
): Promise<{
  session: AgentSession;
  messages: Record<string, ChatMessage>;
  hasMoreBefore: boolean;
}> {
  const params = new URLSearchParams();
  const limit = options.limit ?? DEFAULT_MESSAGE_PAGE_SIZE;
  params.set('limit', String(limit));
  if (options.beforeMessageId) {
    params.set('before_message_id', options.beforeMessageId);
  }
  const query = params.toString();
  const path = `/agent/sessions/${encodeURIComponent(sessionId)}${query ? `?${query}` : ''}`;
  const data = await apiFetch<AgentSessionDetailApiResponse>(path);

  const session = mapSession(data.session);
  const messages: Record<string, ChatMessage> = {};
  for (const row of data.messages) {
    messages[row.id] = mapMessage(row);
  }
  return {
    session: {
      ...session,
      hasMoreMessagesBefore: Boolean(data.has_more_before),
    },
    messages,
    hasMoreBefore: Boolean(data.has_more_before),
  };
}

export async function createAgentSessionRemote(
  session: Pick<
    AgentSession,
    'id' | 'title' | 'providerId' | 'model' | 'annotationProjectId' | 'interactionMode'
  >,
): Promise<AgentSession> {
  const row = await apiFetch<AgentSessionApiRow>('/agent/sessions', {
    method: 'POST',
    body: JSON.stringify({
      id: session.id,
      title: session.title,
      provider_id: session.providerId || null,
      model: session.model || null,
      annotation_project_id: session.annotationProjectId ?? null,
      interaction_mode: session.interactionMode ?? null,
    }),
  });
  return mapSession(row);
}

export async function patchAgentSessionRemote(
  sessionId: string,
  patch: Partial<Pick<AgentSession, 'title' | 'providerId' | 'model'>>,
): Promise<AgentSession> {
  const row = await apiFetch<AgentSessionApiRow>(
    `/agent/sessions/${encodeURIComponent(sessionId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        title: patch.title,
        provider_id: patch.providerId,
        model: patch.model,
      }),
    },
  );
  return mapSession(row);
}

export async function deleteAgentSessionRemote(sessionId: string): Promise<void> {
  await apiFetch<void>(`/agent/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  });
}

export async function loadRemoteAgentChatStateForProject(
  annotationProjectId: string | null,
): Promise<
  AgentChatPersistedState & { sessionsNextCursor: string | null; sessionsHasMore: boolean }
> {
  const page = await fetchAgentSessionsPage(
    annotationProjectId
      ? { annotationProjectId }
      : { workspaceOnly: true },
  );
  const sessionsMap: Record<string, AgentSession> = {};
  const messagesBySession: AgentChatPersistedState['messagesBySession'] = {};
  const sessionOrder = page.sessions
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((session) => session.id);

  for (const session of page.sessions) {
    if ((session.messageCount ?? 0) <= 0) continue;
    sessionsMap[session.id] = session;
    messagesBySession[session.id] = {};
  }

  const openTabIds = sessionOrder.length > 0 ? [sessionOrder[0]] : [];

  return {
    sessions: sessionsMap,
    sessionOrder,
    openTabIds: [],
    activeSessionId: null,
    messagesBySession,
    sessionsNextCursor: page.nextCursor,
    sessionsHasMore: page.hasMore,
  };
}

/** @deprecated prefer loadRemoteAgentChatStateForProject */
export async function loadRemoteAgentChatState(): Promise<
  AgentChatPersistedState & { sessionsNextCursor: string | null; sessionsHasMore: boolean }
> {
  return loadRemoteAgentChatStateForProject(null);
}
