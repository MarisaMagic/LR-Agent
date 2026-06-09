import type {
  AgentChatPersistedState,
  AgentInteractionMode,
  AnnotationPipelineStep,
  ChatMessage,
  MessageBlock,
  ProjectAgentUiState,
  StreamEvent,
  TurnKind,
} from '../../shared/agentTypes';
import {
  isImageDetailPipelineStage,
  upsertImageDetailPipelineStep,
} from './annotationAgent/pipelineImageSteps';
import { labelForPipelineStage } from './annotationAgent/pipelineStages';
import { WORKSPACE_AGENT_UI_KEY } from '../../shared/agentTypes';

const STORAGE_KEY = 'lr-agent:agentChatState';
const UI_STORAGE_KEY = 'lr-agent:agentChatUi';

export interface AgentChatUiStateV2 {
  byProject: Record<string, ProjectAgentUiState>;
  /** @deprecated migrated into byProject[WORKSPACE_AGENT_UI_KEY] */
  openTabIds?: string[];
  activeSessionId?: string | null;
}

export function normalizeAgentMode(mode: unknown): AgentInteractionMode {
  if (mode === 'annotation' || mode === 'annotate') return 'annotation';
  return 'chat';
}

export function createEmptyProjectUi(
  agentMode: AgentInteractionMode = 'chat',
): ProjectAgentUiState {
  return { openTabIds: [], activeSessionId: null, agentMode };
}

export function createEmptyUiStateV2(): AgentChatUiStateV2 {
  return {
    byProject: {
      [WORKSPACE_AGENT_UI_KEY]: createEmptyProjectUi(),
    },
  };
}

export function projectUiKey(annotationProjectId: string | null | undefined): string {
  return annotationProjectId ?? WORKSPACE_AGENT_UI_KEY;
}

export function loadAgentChatUiState(): AgentChatUiStateV2 {
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY);
    if (!raw) return createEmptyUiStateV2();
    const parsed = JSON.parse(raw) as AgentChatUiStateV2 & {
      openTabIds?: string[];
      activeSessionId?: string | null;
    };
    if (parsed.byProject && typeof parsed.byProject === 'object') {
      const byProject: Record<string, ProjectAgentUiState> = {};
      for (const [key, slice] of Object.entries(parsed.byProject)) {
        if (!slice || typeof slice !== 'object') continue;
        byProject[key] = {
          openTabIds: slice.openTabIds ?? [],
          activeSessionId: slice.activeSessionId ?? null,
          agentMode: normalizeAgentMode(slice.agentMode),
        };
      }
      return {
        byProject: {
          ...createEmptyUiStateV2().byProject,
          ...byProject,
        },
      };
    }
    return {
      byProject: {
        [WORKSPACE_AGENT_UI_KEY]: {
          openTabIds: parsed.openTabIds ?? [],
          activeSessionId: parsed.activeSessionId ?? null,
          agentMode: normalizeAgentMode(
            (parsed as { agentMode?: unknown }).agentMode,
          ),
        },
      },
    };
  } catch {
    return createEmptyUiStateV2();
  }
}

export function getProjectUi(
  state: AgentChatUiStateV2,
  annotationProjectId: string | null | undefined,
): ProjectAgentUiState {
  const key = projectUiKey(annotationProjectId);
  const slice = state.byProject[key];
  if (!slice) return createEmptyProjectUi();
  return {
    ...slice,
    agentMode: normalizeAgentMode(slice.agentMode),
  };
}

export function setProjectUi(
  state: AgentChatUiStateV2,
  annotationProjectId: string | null | undefined,
  slice: ProjectAgentUiState,
): AgentChatUiStateV2 {
  const key = projectUiKey(annotationProjectId);
  return {
    byProject: {
      ...state.byProject,
      [key]: slice,
    },
  };
}

export function persistAgentChatUiState(state: AgentChatUiStateV2): void {
  localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(state));
}

/** @deprecated use AgentChatUiStateV2 */
export interface AgentChatUiState {
  openTabIds: string[];
  activeSessionId: string | null;
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

export function finalizeAnnotationPipelineBlock(
  block: Extract<MessageBlock, { type: 'annotation_pipeline' }>,
  terminalStatus: 'done' | 'error' = 'done',
): Extract<MessageBlock, { type: 'annotation_pipeline' }> {
  return {
    ...block,
    collapsed: true,
    steps: block.steps.map((step) =>
      step.status === 'running' ? { ...step, status: terminalStatus } : step,
    ),
  };
}

/** 历史会话加载时修正残留的 streaming / pipeline running 状态。 */
export function normalizeHistoricalAssistantMessage(
  message: ChatMessage,
): ChatMessage {
  if (message.role !== 'assistant') return message;

  const hasProposal = message.blocks.some(
    (block) => block.type === 'annotation_proposal',
  );
  const isTerminal =
    message.status === 'done' ||
    message.status === 'stopped' ||
    message.status === 'error' ||
    (hasProposal && message.status === 'streaming');

  if (!isTerminal) return message;

  let next = message;
  if (message.status === 'streaming') {
    next = {
      ...next,
      status: hasProposal ? 'done' : 'stopped',
      updatedAt: Date.now(),
    };
  }

  const needsPipelineFix = next.blocks.some(
    (block) =>
      block.type === 'annotation_pipeline' &&
      block.steps.some((step) => step.status === 'running'),
  );
  if (!needsPipelineFix) return next;

  const terminalStatus = next.status === 'error' ? 'error' : 'done';
  return {
    ...next,
    blocks: next.blocks.map((block) =>
      block.type === 'annotation_pipeline'
        ? finalizeAnnotationPipelineBlock(block, terminalStatus)
        : block,
    ),
  };
}

export function normalizeHistoricalMessages(
  messages: Record<string, ChatMessage>,
): Record<string, ChatMessage> {
  const next: Record<string, ChatMessage> = {};
  for (const [id, message] of Object.entries(messages)) {
    next[id] = normalizeHistoricalAssistantMessage(message);
  }
  return next;
}

function applyAnnotationProgressToBlocks(
  blocks: MessageBlock[],
  event: Extract<StreamEvent, { type: 'annotation_progress' }>,
): MessageBlock[] {
  const next = [...blocks];
  const pipelineIdx = next.findIndex((b) => b.type === 'annotation_pipeline');
  const incoming: AnnotationPipelineStep = {
    stage: event.stage,
    label: labelForPipelineStage(event.stage),
    message: event.message,
    status: event.status ?? 'running',
    detail: event.detail,
    imagePath: event.imagePath,
  };

  const upsertSteps = (steps: AnnotationPipelineStep[]): AnnotationPipelineStep[] => {
    const updated = steps.map((s) =>
      s.status === 'running' &&
      s.stage !== event.stage &&
      !isImageDetailPipelineStage(event.stage)
        ? { ...s, status: 'done' as const }
        : s,
    );
    if (isImageDetailPipelineStage(event.stage)) {
      return upsertImageDetailPipelineStep(updated, incoming);
    }
    const idx = updated.findIndex((s) => s.stage === event.stage);
    if (idx >= 0) {
      updated[idx] = incoming;
      return updated;
    }
    return [...updated, incoming];
  };

  if (pipelineIdx < 0) {
    next.push({
      type: 'annotation_pipeline',
      collapsed: false,
      steps: [incoming],
    });
    return next;
  }

  const block = next[pipelineIdx];
  if (block.type !== 'annotation_pipeline') return next;
  next[pipelineIdx] = {
    ...block,
    steps: upsertSteps(block.steps),
  };
  return next;
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

  if (event.type === 'annotation_progress') {
    return applyAnnotationProgressToBlocks(next, event);
  }

  if (event.type === 'annotation_proposal') {
    for (let i = 0; i < next.length; i += 1) {
      const b = next[i];
      if (b.type === 'annotation_pipeline') {
        next[i] = {
          ...b,
          collapsed: true,
          steps: b.steps.map((s) =>
            s.status === 'running' ? { ...s, status: 'done' } : s,
          ),
        };
      }
    }
    const block = {
      type: 'annotation_proposal' as const,
      proposal: event.proposal,
      status: 'pending' as const,
    };
    const withoutProposal: MessageBlock[] = next.filter(
      (b) => b.type !== 'annotation_proposal',
    );
    const existing = next.find((b) => b.type === 'annotation_proposal');
    const status =
      existing?.type === 'annotation_proposal' ? existing.status : block.status;
    withoutProposal.push({ ...block, status });
    return withoutProposal;
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

export { resolveUserMessageIdForJob } from './userMessageIdForJob';

/** 重新生成时保持与原助手回复同一条流水线（批量 vs 对话）。 */
export function inferRegenerateTurnKind(
  assistantMessage: ChatMessage,
): TurnKind | undefined {
  if (assistantMessage.role !== 'assistant') {
    return undefined;
  }
  const wasBatch = assistantMessage.blocks.some(
    (block) =>
      block.type === 'annotation_proposal' || block.type === 'annotation_pipeline',
  );
  return wasBatch ? 'execute_batch' : 'converse';
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

export function sessionHasHistoryContent(
  sessionId: string,
  state: Pick<AgentChatPersistedState, 'sessions' | 'messagesBySession'>,
): boolean {
  const session = state.sessions[sessionId];
  if (!session) return false;
  if ((session.messageCount ?? 0) > 0) return true;
  const messages = state.messagesBySession[sessionId];
  return Boolean(messages && Object.keys(messages).length > 0);
}

export function sessionBelongsToProject(
  session: { annotationProjectId?: string | null },
  annotationProjectId: string | null | undefined,
): boolean {
  const sid = session.annotationProjectId ?? null;
  const pid = annotationProjectId ?? null;
  return sid === pid;
}
