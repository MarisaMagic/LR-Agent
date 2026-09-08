import type { AnnotationBatchProposal } from './annotationAgentTypes';

/** Agent 流水线类型：与 UI 标题、阶段标签一一对应 */
export type PipelineKind = 'batch' | 'mutation' | 'report';

/** Agent 任务生命周期状态（与后端 JobState 一致）。 */
export enum JobState {
  Registered = 'registered',
  Streaming = 'streaming',
  ToolPending = 'tool_pending',
  Resuming = 'resuming',
  Done = 'done',
  Error = 'error',
  Cancelled = 'cancelled',
}

export interface LlmProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  /** 主进程 API 视觉探针结果（图文 chat/completions，HTTP 2xx 视为多模态） */
  supportsVision: boolean;
  visionProbedAt: number | null;
  visionProbeDetail: string;
  createdAt: number;
  updatedAt: number;
}

export type MessageBlock =
  | { type: 'text'; content: string }
  | {
      type: 'reasoning';
      content: string;
      collapsed: boolean;
    }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      arguments: string;
      status: 'running' | 'done' | 'error';
      result?: string;
      collapsed: boolean;
    }
  | {
      type: 'annotation_proposal';
      proposal: AnnotationBatchProposal;
      status: 'pending' | 'applied' | 'dismissed';
    }
  | {
      type: 'annotation_pipeline';
      collapsed: boolean;
      steps: AnnotationPipelineStep[];
      /** 流水线类型，默认 batch */
      pipelineKind?: PipelineKind;
    }
  | {
      type: 'file_proposal';
      title: string;
      content: string;
      suggestedRelativePath: string;
      status: 'pending' | 'applied' | 'dismissed';
    }
  | {
      /** @deprecated 历史消息兼容，加载时 normalize 为 file_proposal */
      type: 'document_proposal';
      title: string;
      content: string;
      suggestedRelativePath: string;
      status: 'pending' | 'applied' | 'dismissed';
    };

export type AnnotationPipelineStepStatus =
  'pending' | 'running' | 'done' | 'error' | 'skipped';

export interface AnnotationPipelineStep {
  stage: string;
  label: string;
  message: string;
  status: AnnotationPipelineStepStatus;
  detail?: string;
  /** 图片相对路径，用于批量明细按图聚合 */
  imagePath?: string;
}

export type ChatMessageStatus =
  'pending' | 'streaming' | 'done' | 'stopped' | 'error';

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  blocks: MessageBlock[];
  status: ChatMessageStatus;
  /** 该轮 UI 模式：chat=Ask，annotation=Agent */
  interactionMode?: AgentInteractionMode | null;
  providerId: string;
  model: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ChatContextConfig {
  maxContextTokens: number;
  reserveCompletionTokens: number;
  maxTurnsInWindow: number;
  summarizeTriggerRatio: number;
  minTurnsBeforeSummarize: number;
}

export const DEFAULT_CHAT_CONTEXT_CONFIG: ChatContextConfig = {
  maxContextTokens: 12_000,
  reserveCompletionTokens: 2_048,
  maxTurnsInWindow: 20,
  summarizeTriggerRatio: 0.85,
  minTurnsBeforeSummarize: 6,
};

export type AgentInteractionMode = 'chat' | 'annotation';

export interface ProjectAgentUiState {
  openTabIds: string[];
  activeSessionId: string | null;
  agentMode: AgentInteractionMode;
}

export const WORKSPACE_AGENT_UI_KEY = '__workspace';

export interface AgentSession {
  id: string;
  title: string;
  /** 绑定标注任务；null 表示工作区通用会话 */
  annotationProjectId?: string | null;
  interactionMode?: 'chat' | 'annotation' | null;
  providerId: string;
  model: string;
  messageIds: string[];
  messageCount?: number;
  lastMessagePreview?: string;
  hasMoreMessagesBefore?: boolean;
  activeJobId?: string;
  /** 被窗口挤出历史的压缩摘要 */
  contextSummary?: string;
  /** 摘要已覆盖到的最后一条消息 id */
  summaryUpToMessageId?: string;
  lastContextTokenEstimate?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentJob {
  id: string;
  sessionId: string;
  messageId: string;
  status: 'running' | 'done' | 'stopped' | 'error';
  startedAt: number;
  finishedAt?: number;
}

export type StreamEvent =
  | { type: 'text_delta'; content: string }
  | { type: 'reasoning_delta'; content: string }
  | {
      type: 'tool_start';
      toolCallId: string;
      name: string;
      arguments: string;
    }
  | { type: 'tool_result'; toolCallId: string; result: string }
  | { type: 'preparing'; stage: 'summarize' | 'streaming' | 'build_messages' }
  | {
      type: 'context_updated';
      summary: string;
      summaryUpToMessageId: string;
      tokenEstimate?: number;
    }
  | {
      type: 'route_decided';
      mode: 'chat' | 'assist';
      domain: string;
    }
  | {
      type: 'annotation_progress';
      stage: string;
      message: string;
      status?: AnnotationPipelineStepStatus;
      detail?: string;
      imagePath?: string;
      pipelineKind?: PipelineKind;
    }
  | { type: 'annotation_proposal'; proposal: AnnotationBatchProposal }
  | {
      type: 'file_proposal_start';
      title: string;
      suggestedRelativePath: string;
      detail: string;
    }
  | {
      type: 'file_proposal_delta';
      content: string;
      /** 所属文件相对路径，用于多文件场景下匹配对应的 file_proposal 块 */
      suggestedRelativePath?: string;
    }
  | {
      type: 'file_proposal';
      title: string;
      content: string;
      suggestedRelativePath: string;
      status?: 'pending' | 'applied' | 'dismissed';
    }
  | {
      /** @deprecated 旧 SSE 事件 */
      type: 'document_proposal';
      title: string;
      content: string;
      suggestedRelativePath: string;
      status?: 'pending' | 'applied' | 'dismissed';
    }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | {
      type: 'tool_pending';
      toolCalls: ClientToolCall[];
    };

/** 异步工具调用描述（来自 tool_pending 事件）。 */
export interface ClientToolCall {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 客户端工具名称枚举，与后端 CLIENT_TOOL_NAMES 保持一致。 */
export type ClientToolName = 'auto_annotate' | 'mutate_annotation';

/** 客户端工具执行结果，随 resume 请求一并发送给后端。 */
export interface ClientToolResult {
  toolCallId: string;
  name: string;
  result: string;
}

/** 全局 Agent Skill 目录条目（catalog，仅 name + description 注入 prompt）。 */
export interface AgentSkillEntry {
  name: string;
  description: string;
  /** 预留来源字段：目前仅 'user'（~/.agents/skills），未来支持项目级 */
  scope: 'user';
}

export interface ClientContextPayload {
  workspaceRoot?: string | null;
  activeFilePath?: string | null;
  activeRelativePath?: string | null;
  projectDirectoryPath?: string | null;
  activeAnnotationProjectId?: string | null;
  annotationProjectModality?: string | null;
  annotationProjectType?: string | null;
  agentMode?: AgentInteractionMode | null;
  workMode?: 'editor' | 'annotation' | null;
  selectedAnnotationId?: string | null;
  selectedAnnotationIds?: string[];
  /** 本地 MCP Server 地址（Electron 启动时分配，如 "http://127.0.0.1:PORT"） */
  mcpServerUrl?: string | null;
  /** 项目级指令（.lragent/INSTRUCTIONS.md 内容，注入 system prompt） */
  projectInstructions?: string | null;
  /** Auto Memory 索引（MEMORY.md 截断内容，注入 system prompt） */
  memoryIndex?: string | null;
  /** 全局 Agent Skills catalog（~/.agents/skills 扫描结果，注入 system prompt） */
  skillsCatalog?: AgentSkillEntry[] | null;
  annotationProjectSnapshot?: {
    projectId: string;
    name: string;
    directoryPath?: string;
    modality: string;
    annotationType: string;
    annotationTypeLabel?: string;
    labels: Array<{ id: string; name: string; color?: string }>;
    detectionModels: Array<{ id: string; name: string; isDefault?: boolean }>;
    keypointTemplateId?: string;
  } | null;
}

export interface AgentChatPersistedState {
  sessions: Record<string, AgentSession>;
  sessionOrder: string[];
  openTabIds: string[];
  activeSessionId: string | null;
  messagesBySession: Record<string, Record<string, ChatMessage>>;
}

export function createAgentId(prefix = 'agent'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function maskApiKey(apiKey: string): string {
  if (!apiKey) return '';
  if (apiKey.length <= 8) return '****';
  return `${apiKey.slice(0, 3)}****${apiKey.slice(-4)}`;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export function buildSessionTitle(content: string): string {
  const line = content.trim().replace(/\s+/g, ' ');
  if (!line) return '新对话';
  return line.length > 24 ? `${line.slice(0, 24)}…` : line;
}

export type FileProposalLikeBlock =
  | Extract<MessageBlock, { type: 'file_proposal' }>
  | Extract<MessageBlock, { type: 'document_proposal' }>;

export function isFileProposalBlock(
  block: MessageBlock,
): block is FileProposalLikeBlock {
  return block.type === 'file_proposal' || block.type === 'document_proposal';
}

/** 将历史 document_proposal 块统一为 file_proposal。 */
export function normalizeHistoricalBlocks(
  blocks: MessageBlock[],
): MessageBlock[] {
  return blocks.map((block) => {
    if (block.type === 'document_proposal') {
      return { ...block, type: 'file_proposal' as const };
    }
    return block;
  });
}
