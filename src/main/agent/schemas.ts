/**
 * Agent 运行时请求体解析。
 *
 * 线格式为 **snake_case**（见协议文档 §3），内部统一为 camelCase。
 * 解析保持宽松：缺失的可选字段按默认值补齐，不因多余字段报错
 * （对齐 FastAPI 的 `extra="ignore"` 行为）。
 */

import type { ChatMessage } from './llm/client';
import type { ProposalStateLike } from './loop/taskPhase';
import type { ClientContextLike } from './tools/workspacePath';
import type { ClientToolResultInput } from './context/contextService';
import type { AnnotationProjectSnapshot } from './context/snapshot';

/** 客户端上下文（含标注项目快照等运行时附加字段）。 */
export interface ParsedClientContext extends ClientContextLike {
  activeAnnotationProjectId?: string | null;
  annotationProjectModality?: string | null;
  annotationProjectType?: string | null;
  agentMode?: 'chat' | 'annotation' | null;
  workMode?: 'editor' | 'annotation' | null;
  selectedAnnotationIds?: string[];
  annotationProjectSnapshot?: AnnotationProjectSnapshot | null;
  mcpServerUrl?: string | null;
  mcpServerToken?: string | null;
  mcpServers?: Array<{
    id: string;
    url: string;
    transport: 'streamable_http' | 'sse';
    headers: Record<string, string>;
    disabledTools: string[];
  }>;
  projectInstructions?: string | null;
  memoryIndex?: string | null;
  workspaceMemoryEnabled?: boolean;
  skillsCatalog?: Array<{ name: string; description: string }>;
  proposalLedger?: string | null;
  proposalStates?: ProposalStateLike[];
}

export interface ParsedChatRequest {
  apiKey: string;
  baseUrl: string;
  model: string;
  supportsVision: boolean;
  auxModel: string;
  auxApiKey: string;
  auxBaseUrl: string;
  messages: ChatMessage[];
  userContent: string;
  systemPrompt: string | null;
  contextSummary: string | null;
  contextSummaryUpToMessageId: string | null;
  clientContext: ParsedClientContext | null;
  clientToolResults: ClientToolResultInput[];
  clientJobId: string;
}

export class RequestParseError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'RequestParseError';
    this.status = status;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** 解析标注项目快照（snake_case → 内部形态）。 */
function parseSnapshot(value: unknown): AnnotationProjectSnapshot | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const projectId = str(raw.project_id);
  if (!projectId) return null;
  return {
    projectId,
    name: str(raw.name),
    modality: str(raw.modality),
    annotationType: str(raw.annotation_type),
    labels: Array.isArray(raw.labels)
      ? (raw.labels.filter((l) => asRecord(l)) as Array<Record<string, unknown>>)
      : [],
    detectionModels: Array.isArray(raw.detection_models)
      ? (raw.detection_models.filter((m) => asRecord(m)) as Array<
          Record<string, unknown>
        >)
      : [],
    projectDirectoryPath: strOrNull(raw.project_directory_path),
  };
}

function parseClientContext(value: unknown): ParsedClientContext | null {
  const raw = asRecord(value);
  if (!raw) return null;

  return {
    workspaceRoot: strOrNull(raw.workspace_root),
    activeFilePath: strOrNull(raw.active_file_path),
    activeRelativePath: strOrNull(raw.active_relative_path),
    projectDirectoryPath: strOrNull(raw.project_directory_path),
    activeAnnotationProjectId: strOrNull(raw.active_annotation_project_id),
    annotationProjectModality: strOrNull(raw.annotation_project_modality),
    annotationProjectType: strOrNull(raw.annotation_project_type),
    agentMode:
      raw.agent_mode === 'chat' || raw.agent_mode === 'annotation'
        ? raw.agent_mode
        : null,
    workMode:
      raw.work_mode === 'editor' || raw.work_mode === 'annotation'
        ? raw.work_mode
        : null,
    selectedAnnotationIds: strArray(raw.selected_annotation_ids),
    annotationProjectSnapshot: parseSnapshot(raw.annotation_project_snapshot),
    mcpServerUrl: strOrNull(raw.mcp_server_url),
    mcpServerToken: strOrNull(raw.mcp_server_token),
    mcpServers: Array.isArray(raw.mcp_servers)
      ? raw.mcp_servers
          .map((item) => asRecord(item))
          .filter((item): item is Record<string, unknown> => item !== null)
          .map((item) => ({
            id: str(item.id),
            url: str(item.url),
            transport:
              item.transport === 'sse' ? ('sse' as const) : ('streamable_http' as const),
            headers:
              (asRecord(item.headers) as Record<string, string> | null) ?? {},
            disabledTools: strArray(item.disabled_tools),
          }))
      : [],
    projectInstructions: strOrNull(raw.project_instructions),
    memoryIndex: strOrNull(raw.memory_index),
    workspaceMemoryEnabled: raw.workspace_memory_enabled === true,
    skillsCatalog: Array.isArray(raw.skills_catalog)
      ? raw.skills_catalog
          .map((item) => asRecord(item))
          .filter((item): item is Record<string, unknown> => item !== null)
          .map((item) => ({
            name: str(item.name),
            description: str(item.description),
          }))
      : [],
    proposalLedger: strOrNull(raw.proposal_ledger),
    proposalStates: Array.isArray(raw.proposal_states)
      ? raw.proposal_states
          .map((item) => asRecord(item))
          .filter((item): item is Record<string, unknown> => item !== null)
          .map((item) => ({
            path: str(item.path),
            kind: str(item.kind) || 'annotation',
            status: str(item.status) || 'pending',
            annotationIds: strArray(item.annotation_ids),
          }))
      : [],
  };
}

/** 解析历史消息（对齐 Python `ChatMessageInput`）。 */
function parseMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  const out: ChatMessage[] = [];

  for (const item of value) {
    const raw = asRecord(item);
    if (!raw) continue;
    const role = raw.role;
    if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') {
      continue;
    }

    if (role === 'tool') {
      // tool 消息缺少 tool_call_id 时整条跳过，避免非法 ToolMessage
      const toolCallId = str(raw.tool_call_id).trim();
      if (!toolCallId) continue;
      out.push({ role: 'tool', content: str(raw.content), toolCallId });
      continue;
    }

    if (role === 'assistant') {
      const toolCalls = Array.isArray(raw.tool_calls)
        ? raw.tool_calls
            .map((tc) => asRecord(tc))
            .filter((tc): tc is Record<string, unknown> => tc !== null)
            .map((tc) => ({
              id: str(tc.id),
              name: str(tc.name),
              args: (asRecord(tc.args) as Record<string, unknown> | null) ?? {},
            }))
        : [];
      out.push(
        toolCalls.length
          ? { role: 'assistant', content: str(raw.content), toolCalls }
          : { role: 'assistant', content: str(raw.content) },
      );
      continue;
    }

    out.push({ role, content: str(raw.content) });
  }

  return out;
}

function parseClientToolResults(value: unknown): ClientToolResultInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({
      toolCallId: str(item.tool_call_id),
      name: str(item.name),
      result: str(item.result),
    }))
    .filter((item) => item.toolCallId.length > 0);
}

/** 解析 `/agent/chat/stream` 请求体。 */
export function parseChatStreamRequest(rawBody: string): ParsedChatRequest {
  let parsed: unknown;
  try {
    parsed = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    throw new RequestParseError('请求体不是合法 JSON');
  }
  const raw = asRecord(parsed);
  if (!raw) throw new RequestParseError('请求体必须是对象');

  const apiKey = str(raw.api_key);
  const baseUrl = str(raw.base_url);
  const model = str(raw.model);
  const userContent = str(raw.user_content);
  const clientJobId = str(raw.client_job_id);

  const missing: string[] = [];
  if (!apiKey) missing.push('api_key');
  if (!baseUrl) missing.push('base_url');
  if (!model) missing.push('model');
  if (!userContent) missing.push('user_content');
  if (!clientJobId) missing.push('client_job_id');
  if (missing.length) {
    throw new RequestParseError(`缺少必填字段: ${missing.join(', ')}`);
  }

  return {
    apiKey,
    baseUrl,
    model,
    supportsVision: raw.supports_vision === true,
    auxModel: str(raw.aux_model),
    auxApiKey: str(raw.aux_api_key),
    auxBaseUrl: str(raw.aux_base_url),
    messages: parseMessages(raw.messages),
    userContent,
    systemPrompt: strOrNull(raw.system_prompt),
    contextSummary: strOrNull(raw.context_summary),
    contextSummaryUpToMessageId: strOrNull(raw.context_summary_up_to_message_id),
    clientContext: parseClientContext(raw.client_context),
    clientToolResults: parseClientToolResults(raw.client_tool_results),
    clientJobId,
  };
}

/**
 * 是否具备工具上下文（决定走 Agent 分支还是纯对话分支）。
 *
 * 条件：`client_context` 存在，且（工作区根非空 或 有标注项目 id 或 有项目快照）。
 */
export function hasToolContext(ctx: ParsedClientContext | null): boolean {
  if (!ctx) return false;
  return Boolean(
    (ctx.workspaceRoot ?? '').trim() ||
      ctx.activeAnnotationProjectId ||
      ctx.annotationProjectSnapshot,
  );
}
