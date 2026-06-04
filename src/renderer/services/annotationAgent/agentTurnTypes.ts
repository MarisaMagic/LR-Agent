export type AgentTurnRole = 'system' | 'human' | 'assistant' | 'tool';

export interface AgentToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AgentTurnMessage {
  role: AgentTurnRole;
  content: string;
  tool_call_id?: string;
  tool_calls?: AgentToolCall[];
}

export interface AgentTurnResponse {
  content: string;
  tool_calls: AgentToolCall[];
  finish_reason?: string | null;
}
