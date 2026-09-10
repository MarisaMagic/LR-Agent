import type {
  AgentChatPersistedState,
  AgentInteractionMode,
  AgentSession,
  ChatMessage,
  MessageBlock,
  PipelineKind,
  ProjectAgentUiState,
  ProposalBlockStatus,
  StreamEvent,
} from '../../shared/agentTypes';
import {
  isFileProposalBlock,
  normalizeHistoricalBlocks,
  WORKSPACE_AGENT_UI_KEY,
} from '../../shared/agentTypes';
import { isLrAgentRelativePath } from '../../shared/workspacePathGuards';
import type { AnnotationBatchProposal } from '../../shared/annotationAgentTypes';
import { normalizePipelineKindsInBlocks } from './annotationAgent/pipelineKinds';
import {
  upsertPipelineSteps,
  buildPipelineStepFromProgressEvent,
} from './annotationAgent/pipelineStepAccumulator';
import {
  summarizeToolArgumentsForDisplay,
  summarizeToolResultForDisplay,
} from './toolDisplayUtils';

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

export function projectUiKey(
  annotationProjectId: string | null | undefined,
): string {
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
  // Always persist to localStorage as a fast in-memory-like cache
  // The SQLite DB is the source of truth, updated through AgentChatContext
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

/**
 * 历史兼容：不再把标注卡挪到消息尾，保持工具 → 提案 → 后续叙述的时间顺序。
 */
export function normalizeAnnotationCardOrder(
  blocks: MessageBlock[],
): MessageBlock[] {
  return blocks;
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
    message.status === 'awaiting_confirmation' ||
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
  // 暂停待确认的 job 不跨重启存活：历史加载时落为 done
  // （提案块状态保留，Keep All 栏仍可用，只是不再续跑）
  if (next.status === 'awaiting_confirmation') {
    next = {
      ...next,
      status: 'done',
      updatedAt: Date.now(),
    };
  }

  const needsPipelineFix = next.blocks.some(
    (block) =>
      block.type === 'annotation_pipeline' &&
      block.steps.some((step) => step.status === 'running'),
  );
  if (!needsPipelineFix) {
    return ensureFinishedAt({
      ...next,
      blocks: normalizeAnnotationCardOrder(
        normalizePipelineKindsInBlocks(next.blocks),
      ),
    });
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

  return ensureFinishedAt({
    ...next,
    blocks: normalizeAnnotationCardOrder(
      normalizePipelineKindsInBlocks(next.blocks),
    ),
  });
}

function ensureFinishedAt(message: ChatMessage): ChatMessage {
  if (message.finishedAt != null) return message;
  if (
    message.status !== 'done' &&
    message.status !== 'stopped' &&
    message.status !== 'error' &&
    message.status !== 'awaiting_confirmation'
  ) {
    return message;
  }
  return { ...message, finishedAt: message.updatedAt };
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

function inferAnnotationProposalKind(
  proposal: AnnotationBatchProposal,
): 'batch' | 'mutation' {
  const mutationOps = new Set(['delete', 'patch']);
  if (
    proposal.changes.length > 0 &&
    proposal.changes.every((change) => mutationOps.has(change.operation))
  ) {
    return 'mutation';
  }
  return 'batch';
}

/**
 * 定位标注卡片组（batch pipeline / annotation_proposal）首个块的索引，无则 -1。
 * 标注卡片应作为消息尾部展示；晚到的叙述/工具块需插入到该组之前。
 */
function findAnnotationCardIndex(blocks: MessageBlock[]): number {
  const pipelineIdx = blocks.findIndex((b) => b.type === 'annotation_pipeline');
  const proposalIdx = blocks.findIndex((b) => b.type === 'annotation_proposal');
  if (pipelineIdx < 0) return proposalIdx;
  if (proposalIdx < 0) return pipelineIdx;
  return Math.min(pipelineIdx, proposalIdx);
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
  const incoming = buildPipelineStepFromProgressEvent(event, pipelineKind);

  if (pipelineIdx < 0) {
    const block: MessageBlock = {
      type: 'annotation_pipeline',
      collapsed: false,
      steps: [incoming],
      pipelineKind,
    };
    // 防御性兜底：正常情况 pipeline 先于 proposal 到达；若 proposal 已存在则插入其前
    if (pipelineKind === 'batch') {
      const proposalIdx = next.findIndex(
        (b) => b.type === 'annotation_proposal',
      );
      if (proposalIdx >= 0) {
        next.splice(proposalIdx, 0, block);
        return next;
      }
    }
    next.push(block);
    return next;
  }

  const block = next[pipelineIdx];
  if (block.type !== 'annotation_pipeline') return next;
  next[pipelineIdx] = {
    ...block,
    pipelineKind,
    steps: upsertPipelineSteps(block.steps, event, pipelineKind),
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

/** 兼容 model_dump 与 to_sse_dict 两种 SSE 字段名。 */
export function resolveFileProposalPath(
  event: Record<string, unknown>,
): string {
  const path =
    event.suggestedRelativePath ??
    event.image_path ??
    event.relative_path ??
    event.relativePath;
  return typeof path === 'string' ? path : '';
}

export function resolveFileProposalTitle(
  event: Record<string, unknown>,
  fallback = '文件',
): string {
  const title = event.title ?? event.summary ?? event.detail;
  return typeof title === 'string' && title.trim() ? title : fallback;
}

function normalizeProposalRelPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function toolCallRelativePath(
  block: Extract<MessageBlock, { type: 'tool_call' }>,
): string {
  try {
    const parsed = JSON.parse(block.arguments) as Record<string, unknown>;
    const path = parsed.relative_path ?? parsed.relativePath ?? parsed.path;
    return typeof path === 'string' ? normalizeProposalRelPath(path) : '';
  } catch {
    return '';
  }
}

function messageHasMatchingDeleteTool(
  blocks: MessageBlock[],
  relativePath: string,
): boolean {
  const target = normalizeProposalRelPath(relativePath);
  if (!target) return false;
  return blocks.some((block) => {
    if (block.type !== 'tool_call' || block.name !== 'delete_workspace_file') {
      return false;
    }
    return toolCallRelativePath(block) === target;
  });
}

function preserveDeleteOperation(
  resolved: 'write' | 'delete',
  existing: MessageBlock | undefined,
): 'write' | 'delete' {
  if (resolved === 'delete') return 'delete';
  if (
    existing &&
    isFileProposalBlock(existing) &&
    existing.operation === 'delete'
  ) {
    return 'delete';
  }
  return 'write';
}

function isProposalLikeBlock(
  block: MessageBlock | undefined,
): block is Extract<
  MessageBlock,
  { type: 'annotation_proposal' | 'file_proposal' | 'document_proposal' }
> {
  return Boolean(
    block &&
    (block.type === 'annotation_proposal' || isFileProposalBlock(block)),
  );
}

/** Keep All 后的 status / hasCheckpoint 不能被后续同块 SSE 冲掉。 */
function preserveAppliedProposalMeta<
  T extends { status: ProposalBlockStatus; hasCheckpoint?: boolean },
>(block: T, existing: MessageBlock | undefined, alwaysKeepStatus = false): T {
  if (!isProposalLikeBlock(existing)) return block;
  const keepStatus = alwaysKeepStatus || existing.status !== 'pending';
  if (!keepStatus) return block;
  return {
    ...block,
    status: existing.status,
    hasCheckpoint: existing.hasCheckpoint,
  };
}

export function resolveFileProposalOperation(
  event: Record<string, unknown>,
  blocks: MessageBlock[] = [],
): 'write' | 'delete' {
  const raw = event.operation ?? event.mode;
  if (raw === 'delete') return 'delete';

  const path = resolveFileProposalPath(event);
  if (path && messageHasMatchingDeleteTool(blocks, path)) {
    return 'delete';
  }

  const content = typeof event.content === 'string' ? event.content : '';
  const title = resolveFileProposalTitle(event, '');
  if (
    !content.trim() &&
    (/删除/.test(title) || /^\s*deleted?(\s|$)/i.test(title))
  ) {
    return 'delete';
  }

  return 'write';
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
    const last = next[next.length - 1];
    if (last?.type === 'reasoning') {
      next[next.length - 1] = {
        ...last,
        content: last.content + event.content,
      };
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
    const toolCallId =
      ((event as Record<string, unknown>).toolCallId as string | undefined) ??
      ((event as Record<string, unknown>).tool_call_id as string | undefined) ??
      '';
    const existingIdx = next.findIndex(
      (block) => block.type === 'tool_call' && block.id === toolCallId,
    );
    if (existingIdx >= 0) {
      const block = next[existingIdx];
      if (block.type === 'tool_call') {
        // 仅当已有 arguments 为合法 JSON 且非空对象时才合并；否则直接覆盖
        let argsValid = false;
        try {
          const parsed = JSON.parse(block.arguments);
          argsValid =
            typeof parsed === 'object' &&
            parsed !== null &&
            Object.keys(parsed as Record<string, unknown>).length > 0;
        } catch {
          // block.arguments 已损坏，不合并
        }
        const resolved = argsValid
          ? block.arguments + event.arguments
          : event.arguments;
        next[existingIdx] = {
          ...block,
          arguments: summarizeToolArgumentsForDisplay(block.name, resolved),
        };
      }
      return next;
    }
    const toolBlock: MessageBlock = {
      type: 'tool_call',
      id: toolCallId,
      name: event.name,
      arguments: summarizeToolArgumentsForDisplay(event.name, event.arguments),
      status: 'running',
      collapsed: true,
    };
    next.push(toolBlock);
    return next;
  }

  if (event.type === 'tool_result') {
    const toolCallId =
      ((event as Record<string, unknown>).toolCallId as string | undefined) ??
      ((event as Record<string, unknown>).tool_call_id as string | undefined) ??
      '';
    const idx = next.findIndex(
      (block) => block.type === 'tool_call' && block.id === toolCallId,
    );
    if (idx >= 0) {
      const block = next[idx];
      if (block.type === 'tool_call') {
        next[idx] = {
          ...block,
          result: summarizeToolResultForDisplay(block.name, event.result),
          status: 'done',
          collapsed: true,
        };
        // 标注工具出结果（含 phase_blocked）时收掉对应 pipeline 的 running step，
        // 避免没有 annotation_proposal 时卡片一直转圈。
        if (
          block.name === 'auto_annotate' ||
          block.name === 'mutate_annotation'
        ) {
          const kind: PipelineKind =
            block.name === 'mutate_annotation' ? 'mutation' : 'batch';
          const terminal = /phase_blocked|"status"\s*:\s*"error"/.test(
            event.result ?? '',
          )
            ? 'error'
            : 'done';
          for (let i = 0; i < next.length; i += 1) {
            const b = next[i];
            if (
              b.type === 'annotation_pipeline' &&
              (b.pipelineKind ?? 'batch') === kind
            ) {
              next[i] = {
                ...b,
                steps: b.steps.map((s) =>
                  s.status === 'running' || s.status === 'pending'
                    ? { ...s, status: terminal }
                    : s,
                ),
              };
            }
          }
        }
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
    const incoming = {
      type: 'annotation_proposal' as const,
      proposal: event.proposal,
      status: 'pending' as const,
    };
    const existingIdx = next.findIndex(
      (b) =>
        b.type === 'annotation_proposal' && b.proposal.id === event.proposal.id,
    );
    if (existingIdx >= 0) {
      const existing = next[existingIdx];
      next[existingIdx] = preserveAppliedProposalMeta(incoming, existing, true);
      return next;
    }
    const kind = inferAnnotationProposalKind(event.proposal);
    const pipelineIdx = next.findIndex(
      (b) =>
        b.type === 'annotation_pipeline' &&
        (b.pipelineKind ?? 'batch') === kind,
    );
    if (pipelineIdx >= 0) {
      next.splice(pipelineIdx + 1, 0, incoming);
    } else {
      next.push(incoming);
    }
    return next;
  }

  if (event.type === 'file_proposal_start') {
    const raw = event as Record<string, unknown>;
    const suggestedRelativePath = resolveFileProposalPath(raw);
    if (isLrAgentRelativePath(suggestedRelativePath)) {
      return next;
    }
    const existingIdx = next.findIndex(
      (b) =>
        (b.type === 'file_proposal' || b.type === 'document_proposal') &&
        b.suggestedRelativePath === suggestedRelativePath,
    );
    const existing = existingIdx >= 0 ? next[existingIdx] : undefined;
    const block = preserveAppliedProposalMeta(
      {
        type: 'file_proposal' as const,
        title: resolveFileProposalTitle(raw),
        content: '',
        suggestedRelativePath,
        status: 'pending' as ProposalBlockStatus,
        operation: preserveDeleteOperation(
          resolveFileProposalOperation(raw, next),
          existing,
        ),
      },
      existing,
    );
    if (existingIdx >= 0) {
      next[existingIdx] = block;
    } else {
      next.push(block);
    }
    return next;
  }

  if (event.type === 'file_proposal_delta') {
    const deltaPath = resolveFileProposalPath(event as Record<string, unknown>);
    if (deltaPath && isLrAgentRelativePath(deltaPath)) {
      return next;
    }
    for (let i = 0; i < next.length; i += 1) {
      const candidate = next[i];
      if (!isFileProposalBlock(candidate)) continue;
      // 若 delta 携带路径，精确匹配；否则匹配最后一个 file_proposal（兼容旧 SSE）
      if (deltaPath && candidate.suggestedRelativePath !== deltaPath) continue;
      next[i] = {
        ...candidate,
        content: candidate.content + (event.content ?? ''),
      };
      return next;
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
    const raw = event as Record<string, unknown>;
    let path = resolveFileProposalPath(raw);
    if (path && isLrAgentRelativePath(path)) {
      return next;
    }
    let existingIdx = -1;
    if (path) {
      existingIdx = next.findIndex(
        (b) =>
          (b.type === 'file_proposal' || b.type === 'document_proposal') &&
          b.suggestedRelativePath === path,
      );
    } else {
      for (let i = next.length - 1; i >= 0; i -= 1) {
        const candidate = next[i];
        if (!isFileProposalBlock(candidate)) continue;
        existingIdx = i;
        path = candidate.suggestedRelativePath;
        break;
      }
    }
    const existing = existingIdx >= 0 ? next[existingIdx] : undefined;
    const block = preserveAppliedProposalMeta(
      {
        type: 'file_proposal' as const,
        title: resolveFileProposalTitle(raw),
        content: event.content ?? '',
        suggestedRelativePath: path,
        status: (event.status ?? 'pending') as ProposalBlockStatus,
        operation: preserveDeleteOperation(
          resolveFileProposalOperation(raw, next),
          existing,
        ),
      },
      existing,
    );
    if (existingIdx >= 0) {
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
    .filter(
      (block): block is Extract<MessageBlock, { type: 'text' }> =>
        block.type === 'text',
    )
    .map((block) => block.content)
    .join('\n');
}

export { resolveUserMessageIdForJob } from './userMessageIdForJob';

export function buildApiMessages(
  messageIds: string[],
  messages: Record<string, ChatMessage>,
): Array<{ role: string; content: string }> {
  return messageIds
    .map((id) => messages[id])
    .filter((message): message is ChatMessage => Boolean(message))
    .filter(
      (message) => message.role === 'user' || message.role === 'assistant',
    )
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
