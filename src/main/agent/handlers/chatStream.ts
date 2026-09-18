/**
 * `POST /api/v1/agent/chat/stream` 与 `POST /api/v1/agent/chat/cancel`。
 *
 * 对应 Python 的 `app/api/v1/agent.py` 的 `_stream_local_chat`。
 *
 * 两条分支：
 *   - `has_tools` 为真 → Assist 工具循环（`streamAssist`）
 *   - 否则 → 纯对话（只发 text_delta / reasoning_delta，无工具）
 *
 * 无论哪条分支，流末尾都**无条件**追加一帧裸 `{"type":"done"}`。
 *
 * 取消：Python 用进程内 `asyncio.Event`；这里用 `AbortController`，
 * 并把它同时接到 LLM 请求上，使取消能真正中断上游请求（Python 侧只能等循环
 * 下一个检查点）。
 */

import { LlmClient } from '../llm/client';
import { DONE_FRAME, encodeSseFrame, sse, toSseDict } from '../sse';
import { buildToolSpecs } from '../tools/registry';
import { toolRegistry, resolveImageService, type RuntimeDeps } from './deps';
import { loadMcpToolsFromServers, shouldExposeMcpTool } from '../mcp/client';
import { deriveTaskPhase } from '../loop/taskPhase';
import { resolveAssistToolSet } from '../loop/modeRouter';
import { streamAssist } from '../loop/assistLoop';
import {
  hasToolContext,
  parseChatStreamRequest,
  RequestParseError,
  type ParsedChatRequest,
} from '../schemas';
import {
  buildAssistSystemPrompt,
  buildChatMessages,
  buildChatSystemPrompt,
} from '../context/systemPrompt';
import type { RouteHandler } from '../server';

/** 运行中的任务：clientJobId → 取消控制器。 */
const runningJobs = new Map<string, AbortController>();

/** 供测试与关闭时清理。 */
export function resetRunningJobs(): void {
  for (const controller of runningJobs.values()) controller.abort();
  runningJobs.clear();
}

/** 当前运行中的任务数（自检用）。 */
export function runningJobCount(): number {
  return runningJobs.size;
}

/** 组装 `POST /agent/chat/stream` 处理器。 */
export function createChatStreamHandler(deps: RuntimeDeps): RouteHandler {
  return (req) => {
    let body: ParsedChatRequest;
    try {
      body = parseChatStreamRequest(req.rawBody);
    } catch (err) {
      if (err instanceof RequestParseError) {
        return { kind: 'json', status: err.status, body: { detail: err.message } };
      }
      throw err;
    }

    // 同 jobId 重复发起时，先取消旧的
    runningJobs.get(body.clientJobId)?.abort();
    const controller = new AbortController();
    runningJobs.set(body.clientJobId, controller);

    const frames = streamFrames({
      deps,
      body,
      signal: controller.signal,
      isCancelled: () => controller.signal.aborted,
      onFinish: () => {
        if (runningJobs.get(body.clientJobId) === controller) {
          runningJobs.delete(body.clientJobId);
        }
      },
    });

    return { kind: 'sse', frames };
  };
}

/** 组装 `POST /agent/chat/cancel` 处理器。 */
export function createChatCancelHandler(): RouteHandler {
  return (req) => {
    let clientJobId = '';
    try {
      const parsed = JSON.parse(req.rawBody || '{}') as { client_job_id?: unknown };
      if (typeof parsed.client_job_id === 'string') clientJobId = parsed.client_job_id;
    } catch {
      /* 解析失败按未找到处理 */
    }
    if (clientJobId) runningJobs.get(clientJobId)?.abort();
    // 与 Python 一致：未找到也返回 ok
    return { kind: 'json', body: { ok: true } };
  };
}

interface StreamFramesParams {
  deps: RuntimeDeps;
  body: ParsedChatRequest;
  signal: AbortSignal;
  isCancelled: () => boolean;
  onFinish: () => void;
}

/** 生成 SSE 帧序列（不含最终 done 帧，由本函数统一追加）。 */
async function* streamFrames(
  params: StreamFramesParams,
): AsyncGenerator<string> {
  const { deps, body } = params;
  try {
    const llm = new LlmClient({
      apiKey: body.apiKey,
      baseUrl: body.baseUrl,
      model: body.model,
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.llmTimeoutMs,
    });

    const toolContext = hasToolContext(body.clientContext);
    const taskPhaseContext = deriveTaskPhase(
      body.clientContext?.proposalStates ?? null,
    );

    let events: AsyncGenerator<import('../sse').StreamEventPayload>;

    if (toolContext) {
      const systemPrompt = buildAssistSystemPrompt({
        clientContext: body.clientContext,
        model: body.model,
        supportsVision: body.supportsVision,
        taskPhaseContext,
      });
      const messages = buildChatMessages({
        systemPrompt,
        contextSummary: body.contextSummary,
        messages: body.messages,
      });

      const clientCtx = body.clientContext;
      const toolSet = new Set(
        resolveAssistToolSet({
          hasProjectSnapshot: Boolean(clientCtx?.annotationProjectSnapshot),
          agentMode: clientCtx?.agentMode ?? null,
          isEditor: clientCtx?.workMode === 'editor',
          hasWorkspace: Boolean((clientCtx?.workspaceRoot ?? '').trim()),
        }),
      );

      const tools = new Map(toolRegistry());

      // MCP 工具发现：仅在配置了 MCP server 时进行。
      // 先发一条 preparing(stage="mcp")，让渲染层在建连期间就有反馈。
      const mcpUrl = (clientCtx?.mcpServerUrl ?? '').trim();
      const remoteMcp = clientCtx?.mcpServers ?? [];
      if (mcpUrl || remoteMcp.length > 0) {
        yield encodeSseFrame(toSseDict(sse.preparing('mcp')));
        try {
          const mcpTools = await loadMcpToolsFromServers({
            localServerUrl: mcpUrl || null,
            localServerToken: clientCtx?.mcpServerToken ?? null,
            remoteServers: remoteMcp,
            ttlSeconds: deps.settings.mcpToolsTtlSeconds,
            onLog: (level, message) => {
              if (level === 'warn') console.warn(`[agentRuntime] ${message}`);
            },
          });
          const memoryOn = Boolean(clientCtx?.workspaceMemoryEnabled);
          for (const tool of mcpTools) {
            // 与内置工具重名时不注入；记忆工具按开关与模式过滤
            if (tools.has(tool.name)) continue;
            if (
              !shouldExposeMcpTool(tool.name, {
                workspaceMemoryEnabled: memoryOn,
                agentMode: clientCtx?.agentMode ?? null,
              })
            ) {
              continue;
            }
            tools.set(tool.name, tool);
            toolSet.add(tool.name);
          }
        } catch (err) {
          // MCP 发现失败不影响主流程（与 Python 一致：只告警不降级）
          console.warn(
            `[agentRuntime] MCP 工具加载失败：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // 工具声明按名称排序后固定：避免破坏 LLM 前缀缓存
      const toolSpecs = buildToolSpecs(toolSet, tools);

      events = streamAssist({
        llm,
        messages,
        toolSpecs,
        tools,
        toolSet,
        settings: deps.settings,
        clientContext: clientCtx,
        providerIsVision: body.supportsVision,
        userContent: body.userContent,
        clientToolResults: body.clientToolResults,
        taskPhaseContext,
        isCancelled: params.isCancelled,
        signal: params.signal,
        imageService: resolveImageService(deps),
      });
    } else {
      const systemPrompt = buildChatSystemPrompt(body.systemPrompt);
      const messages = buildChatMessages({
        systemPrompt,
        contextSummary: body.contextSummary,
        messages: body.messages,
      });
      events = streamChat(llm, messages, params);
    }

    for await (const event of events) {
      if (params.isCancelled()) break;
      yield encodeSseFrame(toSseDict(event));
    }
  } finally {
    params.onFinish();
    // 收尾帧无条件发出（与 Python 一致）
    yield DONE_FRAME;
  }
}

/** 纯对话分支：无工具，只转发文本与推理增量。 */
async function* streamChat(
  llm: LlmClient,
  messages: import('../llm/client').ChatMessage[],
  params: StreamFramesParams,
): AsyncGenerator<import('../sse').StreamEventPayload> {
  // 与 Python 的 chat_service 一致：先发 preparering(streaming)，再转发增量
  yield sse.preparing('streaming');
  for await (const delta of llm.streamChat({
    messages,
    signal: params.signal,
  })) {
    if (params.isCancelled()) return;
    if (delta.content) yield sse.textDelta(delta.content);
    if (delta.reasoning) yield sse.reasoningDelta(delta.reasoning);
  }
}
