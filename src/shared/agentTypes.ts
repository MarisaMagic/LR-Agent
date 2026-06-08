import type { AnnotationBatchProposal } from './annotationAgentTypes';

export interface LlmProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  /** API 视觉探针结果（64×64 图 + 图文请求） */
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
    };

export type AnnotationPipelineStepStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'error'
  | 'skipped';

export interface AnnotationPipelineStep {
  stage: string;
  label: string;
  message: string;
  status: AnnotationPipelineStepStatus;
  detail?: string;
}

export type ChatMessageStatus =
  | 'pending'
  | 'streaming'
  | 'done'
  | 'stopped'
  | 'error';

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

export type TurnKind =
  | 'execute_batch'
  | 'converse'
  | 'clarify_scope'
  | 'wants_batch'
  | 'unsupported';

export type TaskIntent =
  | 'converse'
  | 'query_annotation'
  | 'execute_batch'
  | 'clarify_scope'
  | 'wants_batch'
  | 'unsupported';

export function isBatchAnnotationTurnKind(
  turnKind: TurnKind | null | undefined,
): boolean {
  return turnKind === 'execute_batch' || turnKind === 'wants_batch';
}

export interface TurnUnderstandingResult {
  resolvedUserContent: string;
  referencedRelativePaths: string[];
  resolvedActiveRelativePath?: string | null;
  taskIntent: TaskIntent;
  turnKind: TurnKind;
  needsVisionInput: boolean;
  confidence: number;
  scopeNotes: string;
  reason: string;
  userVisibleHint?: string | null;
}

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
    }
  | { type: 'annotation_proposal'; proposal: AnnotationBatchProposal }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface ClientContextPayload {
  workspaceRoot?: string | null;
  activeFilePath?: string | null;
  activeRelativePath?: string | null;
  projectDirectoryPath?: string | null;
  activeAnnotationProjectId?: string | null;
  annotationProjectModality?: string | null;
  annotationProjectType?: string | null;
  agentMode?: AgentInteractionMode | null;
  turnKind?: TurnKind | null;
  turnUnderstanding?: TurnUnderstandingResult | null;
  annotationProjectSnapshot?: {
    projectId: string;
    name: string;
    directoryPath?: string;
    modality: string;
    annotationType: string;
    annotationTypeLabel?: string;
    labels: Array<{ id: string; name: string; color?: string }>;
    detectionModels: Array<{ id: string; name: string; isDefault?: boolean }>;
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
