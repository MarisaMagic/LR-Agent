import type {
  AgentChatPersistedState,
  AgentInteractionMode,
  AgentSession,
  AnnotationPipelineStep,
  ChatMessage,
  MessageBlock,
  ProjectAgentUiState,
  StreamEvent,
  TurnKind,
} from '../../shared/agentTypes';
import {
  isFileProposalBlock,
  normalizeHistoricalBlocks,
} from '../../shared/agentTypes';
import {
  normalizePipelineKindsInBlocks,
} from './annotationAgent/pipelineKinds';
import {
  isImageDetailPipelineStage,
  upsertImageDetailPipelineStep,
} from './annotationAgent/pipelineImageSteps';
import { labelForPipelineStage } from './annotationAgent/pipelineStages';
import { WORKSPACE_AGENT_UI_KEY } from '../../shared/agentTypes';
import { summarizeToolArgumentsForDisplay } from './toolDisplayUtils';

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
  if (!needsPipelineFix) {
    return {
      ...next,
      blocks: normalizePipelineKindsInBlocks(next.blocks),
    };
  }

  const terminalStatus = next.status === 'error' ? 'error' : 'done';
  next = {
    ...next,
    blocks: next.blocks.map((block) =>
      block.type === 'annotation_pipeline'
        ? finalizeAnnotationPipelineBlock(block, terminalStatus)
        : block,
    ),
  };

  return {
    ...next,
    blocks: normalizePipelineKindsInBlocks(next.blocks),
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
  const pipelineKind = event.pipelineKind ?? 'batch';
  const pipelineIdx = next.findIndex(
    (b) =>
      b.type === 'annotation_pipeline' &&
      (b.pipelineKind ?? 'batch') === pipelineKind,
  );
  const incoming: AnnotationPipelineStep = {
    stage: event.stage,
    label: labelForPipelineStage(event.stage, pipelineKind),
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
      pipelineKind,
    });
    return next;
  }

  const block = next[pipelineIdx];
  if (block.type !== 'annotation_pipeline') return next;
  next[pipelineIdx] = {
    ...block,
    pipelineKind,
    steps: upsertSteps(block.steps),
  };
  return next;
}

/** 合并远端 session 元数据，避免列表 API 用空 messageIds 覆盖本地完整列表。 */
export function mergeSessionFromRemote(
  existing: AgentSession | undefined,
  incoming: AgentSession,
): AgentSession {
  const existingIds = existing?.messageIds ?? [];
  const incomingIds = incoming.messageIds ?? [];
  const messageIds =
    incomingIds.length >= existingIds.length ? incomingIds : existingIds;
  return {
    ...incoming,
    messageIds,
    activeJobId: existing?.activeJobId ?? incoming.activeJobId,
  };
}

/** 合并远端消息与本地缓存（同 id 以 updatedAt 较新者为准；blocks 更完整者优先）。 */
export function mergeMessagesFromRemote(
  existing: Record<string, ChatMessage>,
  incoming: Record<string, ChatMessage>,
): Record<string, ChatMessage> {
  const merged = { ...existing };
  for (const [id, msg] of Object.entries(incoming)) {
    const prev = merged[id];
    const normalized = {
      ...msg,
      blocks: normalizeHistoricalBlocks(msg.blocks),
    };
    if (!prev) {
      merged[id] = normalized;
      continue;
    }
    const prevBlocks = normalizeHistoricalBlocks(prev.blocks);
    const incomingRicher = normalized.blocks.length > prevBlocks.length;
    const prevRicher = prevBlocks.length > normalized.blocks.length;
    if (normalized.updatedAt > prev.updatedAt) {
      merged[id] =
        prevRicher && !incomingRicher
          ? { ...normalized, blocks: prevBlocks }
          : normalized;
    } else if (normalized.updatedAt < prev.updatedAt) {
      merged[id] =
        incomingRicher && !prevRicher
          ? { ...prev, blocks: normalized.blocks }
          : prev;
    } else if (incomingRicher) {
      merged[id] = { ...prev, blocks: normalized.blocks };
    } else {
      merged[id] = prev;
    }
  }
  return merged;
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
        const mergedArgs = block.arguments + event.arguments;
        next[existingIdx] = {
          ...block,
          arguments: summarizeToolArgumentsForDisplay(block.name, mergedArgs),
        };
      }
      return next;
    }
    next.push({
      type: 'tool_call',
      id: event.toolCallId,
      name: event.name,
      arguments: summarizeToolArgumentsForDisplay(event.name, event.arguments),
      status: 'running',
      collapsed: true,
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

  if (event.type === 'analysis_script_proposal') {
    const status = (event.status ?? 'pending') as
      | 'pending'
      | 'running'
      | 'done'
      | 'error'
      | 'dismissed';
    if (status === 'done' || status === 'error') {
      for (let i = 0; i < next.length; i += 1) {
        const b = next[i];
        if (
          b.type === 'annotation_pipeline' &&
          (b.pipelineKind ?? 'batch') === 'analysis'
        ) {
          next[i] = {
            ...b,
            collapsed: true,
            steps: b.steps.map((s) =>
              s.status === 'running' ? { ...s, status: 'done' } : s,
            ),
          };
        }
      }
    }
    const block = {
      type: 'analysis_script_proposal' as const,
      script: event.script,
      explanation: event.explanation,
      status,
      result: event.result,
      error: event.error,
    };
    return [...next.filter((b) => b.type !== 'analysis_script_proposal'), block];
  }

  if (event.type === 'file_proposal_start') {
    const block = {
      type: 'file_proposal' as const,
      title: event.title ?? '文件',
      content: '',
      suggestedRelativePath: event.suggestedRelativePath ?? '',
      status: 'pending' as 'pending' | 'applied' | 'dismissed',
    };
    // 按 suggestedRelativePath 去重：同一路径的创建块只保留一个
    const path = block.suggestedRelativePath;
    const existingIdx = next.findIndex(
      (b) =>
        (b.type === 'file_proposal' || b.type === 'document_proposal') &&
        b.suggestedRelativePath === path,
    );
    if (existingIdx >= 0) {
      const existingStatus = next[existingIdx].status;
      if (existingStatus && existingStatus !== 'pending') {
        block.status = existingStatus;
      }
      next[existingIdx] = block;
    } else {
      next.push(block);
    }
    return next;
  }

  if (event.type === 'file_proposal_delta') {
    const deltaPath = event.suggestedRelativePath;
    for (let i = 0; i < next.length; i += 1) {
      if (next[i].type === 'file_proposal') {
        // 若 delta 携带路径，精确匹配；否则匹配最后一个 file_proposal（兼容旧 SSE）
        if (deltaPath && next[i].suggestedRelativePath !== deltaPath) continue;
        next[i] = {
          ...next[i],
          content: next[i].content + (event.content ?? ''),
        };
        return next;
      }
    }
    return next;
  }

  if (event.type === 'file_proposal' || event.type === 'document_proposal') {
    for (let i = 0; i < next.length; i += 1) {
      const b = next[i];
      if (
        b.type === 'annotation_pipeline' &&
        (b.pipelineKind ?? 'batch') === 'report'
      ) {
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
      type: 'file_proposal' as const,
      title: event.title,
      content: event.content,
      suggestedRelativePath: event.suggestedRelativePath,
      status: (event.status ?? 'pending') as 'pending' | 'applied' | 'dismissed',
    };
    // 按 suggestedRelativePath 去重更新——支持同一消息中多个文件提案
    const path = block.suggestedRelativePath;
    const existingIdx = next.findIndex(
      (b) =>
        (b.type === 'file_proposal' || b.type === 'document_proposal') &&
        b.suggestedRelativePath === path,
    );
    if (existingIdx >= 0) {
      const existingStatus = next[existingIdx].status;
      if (existingStatus && existingStatus !== 'pending') {
        block.status = existingStatus;
      }
      next[existingIdx] = block;
    } else {
      next.push(block);
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

export { resolveUserMessageIdForJob } from './userMessageIdForJob';

/** 重新生成时保持与原助手回复同一条流水线（批量 vs 对话）。 */
export function inferRegenerateTurnKind(
  assistantMessage: ChatMessage,
): TurnKind | undefined {
  if (assistantMessage.role !== 'assistant') {
    return undefined;
  }
  const wasMutation = assistantMessage.blocks.some((block) => {
    if (block.type !== 'annotation_proposal') return false;
    return block.proposal.changes.some(
      (c) => c.operation === 'patch' || c.operation === 'delete',
    );
  });
  if (wasMutation) return 'mutate_annotation';

  const wasBatch = assistantMessage.blocks.some(
    (block) =>
      block.type === 'annotation_proposal' || block.type === 'annotation_pipeline',
  );
  if (wasBatch) return 'execute_batch';

  const wasAnalysis = assistantMessage.blocks.some(
    (block) => block.type === 'analysis_script_proposal',
  );
  if (wasAnalysis) return 'analyze_data';

  const wasDocument = assistantMessage.blocks.some(isFileProposalBlock);
  if (wasDocument) return 'generate_document';

  return 'converse';
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

/** 解析会话消息 id 顺序；messageIds 为空时从 messages 推断。 */
export function resolveSessionMessageIds(
  session: AgentSession | undefined,
  messages: Record<string, ChatMessage>,
): string[] {
  const fromSession = session?.messageIds ?? [];
  if (fromSession.length > 0) {
    return fromSession.filter((id) => messages[id]);
  }
  return Object.values(messages)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((m) => m.id);
}
