/**
 * 只读查阅子代理：嵌套短循环，产出 `subagent_*` SSE，最终回中文摘要。
 *
 * 移植自 `vendor/local-agent/app/agent/assist/explore_readonly.py`。
 *
 * 与主循环的三处关键差异（不要"顺手统一"）：
 *
 *   1. **不走父级的去重与阶段门禁**。子代理只有白名单校验：不在内层工具集内、
 *      或命中禁用名单，一律按 `blocked` 处理。
 *   2. **回灌原文而非显示文本**。`allowed` 调用把工具结果**原文**写进 `ToolMessage`；
 *      但发给前端的 `subagent_tool_result.result` 是经显示格式化并截断到 4000 字符的。
 *      `blocked` 调用则相反：`ToolMessage` 与显示值都用 `buildToolResult` 的完整 JSON。
 *   3. **收尾摘要轮不带工具**（`self.llm` 而非 `llm_bound`），防止它继续调工具。
 *
 * 内层工具集与禁用名单（与 Python 一致）：
 *   - BASE：grep/glob/list/read_workspace_file/read_document_file/
 *     describe_client_context/get_lr_agent_help
 *   - ANNOTATION：read_file_annotation/describe_annotation_project（视父级工具集而定）
 *   - FORBIDDEN：explore_readonly、auto_annotate、mutate_annotation、四个写文件工具、
 *     memory_write、memory_create、read_image_for_vision（**注意含记忆工具**）
 */

import { sse, type StreamEventPayload } from '../sse';
import type { ChatMessage, LlmClient, ToolSpec } from '../llm/client';
import { ToolCallAccumulator } from '../llm/client';
import { buildToolResult, formatToolResultForDisplay } from '../tools/result';
import {
  resolveRoundToolCalls,
  type ResolvedToolCall,
} from '../loop/toolInvocation';
import type { ToolDefinition, ToolContext } from '../tools/registry';

export const EXPLORE_READONLY_TOOL_NAME = 'explore_readonly';

const EXPLORE_READONLY_BASE_INNER: ReadonlySet<string> = new Set([
  'grep_workspace',
  'glob_workspace',
  'list_workspace_directory',
  'read_workspace_file',
  'read_document_file',
  'describe_client_context',
  'get_lr_agent_help',
]);

const EXPLORE_READONLY_ANNOTATION_INNER: ReadonlySet<string> = new Set([
  'read_file_annotation',
  'describe_annotation_project',
]);

export const EXPLORE_READONLY_FORBIDDEN_INNER: ReadonlySet<string> = new Set([
  EXPLORE_READONLY_TOOL_NAME,
  'auto_annotate',
  'mutate_annotation',
  'write_workspace_file',
  'str_replace_workspace_file',
  'delete_workspace_file',
  'memory_write',
  'memory_create',
  'read_image_for_vision',
]);

/** 子代理系统提示词（行为契约，需原样保留）。 */
export const SUBAGENT_SYSTEM = `你是只读查阅子代理。只用只读工具查看代码、文档或已有标注，然后用简洁中文写一份摘要。
禁止改文件、写标注、调用 explore_readonly，也禁止声称已经改过文件或完成标注。
调用工具前先用一两句中文说明正在查什么。
查到足够信息后直接给出结论，不要输出工具伪代码。`;

/** 内层工具结果回灌上限。 */
const INNER_RESULT_LIMIT = 4000;

/** 允许的内层工具名集合。 */
export function resolveExploreInnerNames(
  includeAnnotationReads: boolean,
): Set<string> {
  const names = new Set(EXPLORE_READONLY_BASE_INNER);
  if (includeAnnotationReads) {
    for (const name of EXPLORE_READONLY_ANNOTATION_INNER) names.add(name);
  }
  for (const name of EXPLORE_READONLY_FORBIDDEN_INNER) names.delete(name);
  return names;
}

/**
 * 是否把标注只读工具纳入子代理。
 *
 * 编辑器模式一律排除；无父级工具集时默认包含；否则取决于父级工具集是否含标注只读工具。
 */
export function shouldIncludeAnnotationReads(
  clientContext: { workMode?: string | null } | null,
  parentToolNames: ReadonlySet<string> | null,
): boolean {
  if (clientContext && clientContext.workMode === 'editor') return false;
  if (parentToolNames === null) return true;
  for (const name of EXPLORE_READONLY_ANNOTATION_INNER) {
    if (parentToolNames.has(name)) return true;
  }
  return false;
}

/** 截断内层结果（与 Python 的 `_truncate_result` 文案一致）。 */
export function truncateInnerResult(
  text: string,
  limit = INNER_RESULT_LIMIT,
): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…\n[已截断，共 ${text.length} 字符]`;
}

export interface ExploreRunnerParams {
  llm: LlmClient;
  settings: { subagentMaxToolRounds: number };
  isCancelled: () => boolean;
  signal?: AbortSignal;
  /** 内层工具（已按父级工具集过滤后的定义表）。 */
  innerTools: Map<string, ToolDefinition>;
  /** 内层工具声明。 */
  innerToolSpecs: ToolSpec[];
  /** 内层执行上下文（复用父级的 clientContext / imageService / settings）。 */
  toolContext: ToolContext;
}

export interface ExploreStreamParams {
  query: string;
  focusPath: string | null;
  parentToolId: string;
}

/**
 * 运行一次只读查阅。
 *
 * 产出 `subagent_start` / `subagent_text_delta` / `subagent_tool_start` /
 * `subagent_tool_result` / `subagent_done`。
 */
export async function* streamExploreReadonly(
  params: ExploreRunnerParams,
  call: ExploreStreamParams,
): AsyncGenerator<StreamEventPayload> {
  const query = (call.query ?? '').trim();
  const focus = (call.focusPath ?? '').trim() || null;

  yield sse.subagentStart({
    toolCallId: call.parentToolId,
    query,
    focusPath: focus,
  });

  if (!query) {
    yield sse.subagentDone({
      toolCallId: call.parentToolId,
      summary: '查阅任务缺少 query。',
      status: 'error',
    });
    return;
  }

  if (params.innerTools.size === 0) {
    yield sse.subagentDone({
      toolCallId: call.parentToolId,
      summary: '没有可用的只读查阅工具。',
      status: 'error',
    });
    return;
  }

  let userText = `查阅任务：${query}`;
  if (focus) userText = `${userText}\n优先关注路径：${focus}`;

  const messages: ChatMessage[] = [
    { role: 'system', content: SUBAGENT_SYSTEM },
    { role: 'user', content: userText },
  ];

  const maxRounds = Math.max(1, params.settings.subagentMaxToolRounds || 8);
  let summary = '';
  let status: 'done' | 'error' = 'done';
  let stopped = false;
  /**
   * 是否可以进入收尾摘要轮。
   *
   * 对应 Python 的 `last_had_tools`（`for...else` 语义）：只有**自然走完所有轮次**
   * 才为真；中途因「本轮无 tool call」退出时置 false（已拿到结论，无需再逼摘要）。
   * 异常与取消分支由 `status` / `stopped` 守卫拦住，不依赖本标志。
   */
  let canWrapUp = true;

  for (let roundIdx = 0; roundIdx < maxRounds; roundIdx += 1) {
    if (params.isCancelled()) {
      status = 'error';
      summary = summary || '已停止';
      stopped = true;
      break;
    }

    const accumulator = new ToolCallAccumulator();
    let pendingText = '';
    let gatheredAny = false;

    try {
      for await (const delta of params.llm.streamChat({
        messages,
        tools: params.innerToolSpecs,
        toolChoice: 'auto',
        signal: params.signal,
      })) {
        if (params.isCancelled()) {
          status = 'error';
          summary = summary || '已停止';
          stopped = true;
          break;
        }
        if (delta.content) {
          pendingText += delta.content;
          gatheredAny = true;
          yield sse.subagentTextDelta(call.parentToolId, delta.content);
        }
        if (delta.toolCallChunks?.length) {
          accumulator.push(delta.toolCallChunks);
          gatheredAny = true;
        }
      }
    } catch (err) {
      status = 'error';
      summary = `查阅失败：${errMessage(err)}`;
      break;
    }

    if (stopped) break;
    if (!gatheredAny) break;

    // 子代理不做父级的去重/门禁，只按白名单分类
    const resolved = resolveRoundToolCalls({
      apiToolCalls: accumulator.resolve(),
      completedTools: new Set(),
    });

    const allowed: ResolvedToolCall[] = [];
    const blocked: ResolvedToolCall[] = [];
    for (const c of resolved) {
      if (
        !params.innerTools.has(c.name) ||
        EXPLORE_READONLY_FORBIDDEN_INNER.has(c.name)
      ) {
        blocked.push(c);
      } else {
        allowed.push(c);
      }
    }

    if (allowed.length === 0 && blocked.length === 0) {
      summary = pendingText.trim();
      canWrapUp = false;
      break;
    }

    messages.push({
      role: 'assistant',
      content: pendingText,
      toolCalls: [...blocked, ...allowed].map((c) => ({
        id: c.toolCallId,
        name: c.name,
        args: c.arguments,
      })),
    });

    // 被禁调用：完整 JSON 同时用于 ToolMessage 与显示值
    for (const c of blocked) {
      yield sse.subagentToolStart({
        toolCallId: call.parentToolId,
        innerToolCallId: c.toolCallId,
        name: c.name,
        args: c.arguments,
      });
      const blockedText = buildToolResult({
        ok: false,
        tool: c.name,
        status: 'error',
        summary: '此工具不可用于只读查阅。',
      });
      yield sse.subagentToolResult({
        toolCallId: call.parentToolId,
        innerToolCallId: c.toolCallId,
        result: formatToolResultForDisplay(blockedText),
        status: 'error',
      });
      messages.push({
        role: 'tool',
        content: blockedText,
        toolCallId: c.toolCallId,
      });
    }

    for (const c of allowed) {
      if (params.isCancelled()) {
        status = 'error';
        summary = summary || '已停止';
        stopped = true;
        break;
      }

      yield sse.subagentToolStart({
        toolCallId: call.parentToolId,
        innerToolCallId: c.toolCallId,
        name: c.name,
        args: c.arguments,
      });

      const resultText = await invokeInner(
        c,
        params.innerTools,
        params.toolContext,
      );
      const display = truncateInnerResult(
        formatToolResultForDisplay(resultText),
      );

      let stepStatus: 'done' | 'error' = 'done';
      try {
        const parsed = JSON.parse(resultText);
        if (parsed && typeof parsed === 'object' && parsed.ok === false) {
          stepStatus = 'error';
        }
      } catch {
        /* 非 JSON 结果保持 done */
      }

      yield sse.subagentToolResult({
        toolCallId: call.parentToolId,
        innerToolCallId: c.toolCallId,
        result: display,
        status: stepStatus,
      });
      // 注意：回灌**原文**，不是 display
      messages.push({
        role: 'tool',
        content: resultText,
        toolCallId: c.toolCallId,
      });
    }

    if (stopped) break;
  }

  if (canWrapUp && !stopped && status === 'done' && !summary) {
    // 轮次预算耗尽且尚未有结论：用**不带工具**的调用逼一份摘要
    try {
      if (params.isCancelled()) {
        status = 'error';
        summary = '已停止';
      } else {
        let pending = '';
        messages.push({
          role: 'user',
          content: '请用中文给出查阅摘要，不要再调用工具。',
        });
        for await (const delta of params.llm.streamChat({
          messages,
          signal: params.signal,
        })) {
          if (params.isCancelled()) {
            status = 'error';
            summary = '已停止';
            pending = '';
            break;
          }
          if (delta.content) {
            pending += delta.content;
            yield sse.subagentTextDelta(call.parentToolId, delta.content);
          }
        }
        if (status === 'done') summary = pending.trim();
      }
    } catch (err) {
      summary = summary || `已达查阅轮次上限：${errMessage(err)}`;
    }
  }

  if (!summary) {
    summary = status === 'error' ? '查阅失败' : '未找到可用结论。';
  }

  yield sse.subagentDone({
    toolCallId: call.parentToolId,
    summary,
    status,
  });
}

/** 执行内层工具；未知工具与异常都转成统一失败 JSON。 */
async function invokeInner(
  call: ResolvedToolCall,
  tools: Map<string, ToolDefinition>,
  ctx: ToolContext,
): Promise<string> {
  const tool = tools.get(call.name);
  if (!tool || typeof tool.execute !== 'function') {
    return buildToolResult({
      ok: false,
      tool: call.name,
      status: 'error',
      summary: `未知工具: ${call.name}`,
    });
  }
  try {
    return await tool.execute(call.arguments, ctx);
  } catch (err) {
    return buildToolResult({
      ok: false,
      tool: call.name,
      status: 'error',
      summary: `工具执行失败: ${errMessage(err)}`,
    });
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
