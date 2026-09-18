/**
 * 工具调用解析与归一化。
 *
 * 移植自 `vendor/local-agent/app/agent/tool_invocation.py` 与 `tool_dispatcher.py`。
 */

import { randomUUID } from 'crypto';
import type { ChatToolCall } from '../llm/client';
import type { ToolKind } from '../tools/registry';

/** 已解析、可执行的工具调用。 */
export interface ResolvedToolCall {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  source: 'api';
}

/** `tool_choice="any"` 兜底只针对 ASYNC 工具（部分模型会把标注工具写成伪代码）。 */
export const ASYNC_TOOL_NAMES: ReadonlySet<string> = new Set([
  'auto_annotate',
  'mutate_annotation',
  'start_terminal_command',
]);

/**
 * 正文中是否提及某个 ASYNC 工具名（形如 `name(`）。
 *
 * 按名称长度降序匹配，避免短名先命中造成误判。
 */
export function clientToolMentionedInText(text: string): string | null {
  const names = [...ASYNC_TOOL_NAMES].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`${escaped}\\s*\\(`, 'i').test(text)) return name;
  }
  return null;
}

/**
 * 归一化 LLM API 返回的 tool_calls。
 *
 * - 丢弃 name 为空的调用
 * - 丢弃 id 已在「已完成」集合中的调用（resume 后模型重复发起同一调用）
 * - 无 id 时生成 `tool-{12位}`，保证后续 ToolMessage 有归属
 */
export function normalizeApiToolCalls(
  apiToolCalls: ChatToolCall[] | null | undefined,
  completedTools: ReadonlySet<string> = new Set(),
): ResolvedToolCall[] {
  const calls: ResolvedToolCall[] = [];
  for (const call of apiToolCalls ?? []) {
    const name = String(call?.name ?? '').trim();
    if (!name) continue;

    let toolId = String(call?.id ?? '').trim();
    if (toolId && completedTools.has(toolId)) continue;
    if (!toolId) toolId = `tool-${randomUUID().replace(/-/g, '').slice(0, 12)}`;

    let args = call?.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
    calls.push({
      toolCallId: toolId,
      name,
      arguments: args as Record<string, unknown>,
      source: 'api',
    });
  }
  return calls;
}

/** 按执行器类型拆分：立即执行 vs 需前端执行的异步调用。 */
export function splitResolvedCalls(
  calls: ResolvedToolCall[],
  kindOf: (name: string) => ToolKind,
): { immediate: ResolvedToolCall[]; asyncPending: ResolvedToolCall[] } {
  const immediate: ResolvedToolCall[] = [];
  const asyncPending: ResolvedToolCall[] = [];
  for (const call of calls) {
    if (kindOf(call.name) === 'async') asyncPending.push(call);
    else immediate.push(call);
  }
  return { immediate, asyncPending };
}

/**
 * 从本轮 tool_calls 解析可执行调用。
 *
 * 仅使用 API tool_calls；不再回退「正文里的伪代码」——那条路径由
 * `tool_choice="any"` 强制重试承担。
 */
export function resolveRoundToolCalls(params: {
  apiToolCalls: ChatToolCall[] | null | undefined;
  completedTools: ReadonlySet<string>;
}): ResolvedToolCall[] {
  return normalizeApiToolCalls(params.apiToolCalls, params.completedTools);
}

/**
 * 同批异步调用的去重键：`(name, 目标路径集合)`。
 *
 * 同一批里对同一工具、同一范围的重复调用会被拒。
 */
export function asyncDedupeKey(call: ResolvedToolCall): string {
  const rawPaths = call.arguments?.paths;
  const paths = Array.isArray(rawPaths)
    ? rawPaths.map((p) => String(p).trim()).sort()
    : [];
  const scopeHint =
    typeof call.arguments?.scope_hint === 'string'
      ? String(call.arguments.scope_hint).trim()
      : '';
  return `${call.name}::${paths.join(',')}::${scopeHint}`;
}
