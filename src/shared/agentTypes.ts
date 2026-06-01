export interface LlmProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
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
    };

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
  providerId: string;
  model: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentSession {
  id: string;
  title: string;
  providerId: string;
  model: string;
  messageIds: string[];
  activeJobId?: string;
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
  | { type: 'done' }
  | { type: 'error'; message: string };

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
