"""多轮 LLM ↔ 工具循环：stream_chunks → execute_round → 追加 ToolMessage。

拆分为两个阶段：
  1. stream_chunks: 流式产出 text/reasoning + 拦截 proposal chunks
  2. execute_round: 解析 tool_calls → 执行 SYNC / 发射 ASYNC pending
"""

import asyncio
import inspect
import json
from collections.abc import AsyncIterator

from langchain_core.messages import AIMessage, ToolMessage
from langchain_core.tools import StructuredTool
from langchain_openai import ChatOpenAI

from app.agent.assist.proposal_streamer import ProposalStreamInterceptor
from app.agent.chat_message_builder import build_multimodal_user_message
from app.agent.stream_adapter import events_from_chunk
from app.agent.tool_dispatcher import resolve_round_tool_calls, split_resolved_calls
from app.agent.tool_invocation import ResolvedToolCall
from app.agent.tools.workspace_path import is_lr_agent_relative
from app.agent.tools.tool_result import (
    build_tool_result,
    format_tool_result_for_display,
    stringify_tool_output,
)
from app.agent.tools.workspace_file_reader import (
    FILE_PROPOSAL_TOOLS,
    VISION_TOOL_NAME,
    extract_vision_path_from_tool_result,
    extract_doc_proposal_from_tool_result,
    format_vision_tool_result_for_display,
    format_write_tool_result_for_display,
)
from app.core.config import Settings
from app.schemas.agent import StreamEventPayload


def _api_call_name_and_id(call: object) -> tuple[str, str]:
    if isinstance(call, dict):
        name = str(call.get("name") or "").strip()
        tool_id = str(call.get("id") or "").strip()
        return name, tool_id
    name = str(getattr(call, "name", "") or "").strip()
    tool_id = str(getattr(call, "id", "") or "").strip()
    return name, tool_id


TOOL_CALLS_ALREADY_COMPLETED = "tool_calls_already_completed"
ALREADY_COMPLETED_SUMMARY = (
    "该工具本轮已执行，请勿重复调用。请总结，勿重跑标注工具。"
)

PARALLEL_SYNC_TOOLS = frozenset(
    {
        "get_account_summary",
        "get_lr_agent_help",
        "describe_client_context",
        "describe_annotation_project",
        "read_file_annotation",
        "read_workspace_file",
        "grep_workspace",
        "glob_workspace",
        "list_workspace_directory",
        "read_document_file",
    }
)


async def _invoke_tool_fn(name: str, args: dict, fn_map: dict[str, object]) -> str:
    fn = fn_map.get(name)
    try:
        if fn is None:
            return json.dumps(
                {"ok": False, "tool": name, "status": "error", "summary": f"未知工具: {name}"},
                ensure_ascii=False,
            )
        raw = fn(**args)
        if inspect.isawaitable(raw):
            raw = await raw
        return stringify_tool_output(raw)
    except Exception as exc:
        return json.dumps(
            {"ok": False, "tool": name, "status": "error", "summary": f"工具执行失败: {exc}"},
            ensure_ascii=False,
        )


async def _try_tool_choice_retry(
    llm: ChatOpenAI,
    tools: list[StructuredTool],
    messages: list,
    user_content: str,
) -> list[ResolvedToolCall]:
    """tool_choice="any" 强制 LLM 发起 tool call（伪代码回退用）。"""
    try:
        llm_forced = llm.bind_tools(tools, tool_choice="any")
        response = await llm_forced.ainvoke(messages)
        api_calls = getattr(response, "tool_calls", None) or []
        return resolve_round_tool_calls(
            api_tool_calls=api_calls,
            response_text=str(getattr(response, "content", "") or ""),
            user_content=user_content,
        )
    except Exception:
        return []


async def _stream_tool_execution(
    *,
    tool_id: str,
    name: str,
    args: dict,
    fn_map: dict[str, object],
    provider_is_vision: bool,
    settings: Settings,
    messages: list,
    omit_file_proposal_start_delta: set[str] | None = None,
    result_text: str | None = None,
) -> AsyncIterator[StreamEventPayload]:
    """执行单个同步工具，产出 tool_start / tool_result / file_proposal* 事件。"""
    if omit_file_proposal_start_delta is None:
        omit_file_proposal_start_delta = set()
    yield StreamEventPayload(
        type="tool_start",
        tool_call_id=tool_id,
        name=name,
        arguments=json.dumps(args, ensure_ascii=False, indent=2),
    )

    if result_text is None:
        result_text = await _invoke_tool_fn(name, args, fn_map)

    display_result = result_text
    vision_path: str | None = None
    doc_proposal: dict | None = None

    if name == VISION_TOOL_NAME:
        vision_path = extract_vision_path_from_tool_result(name, result_text)
        if vision_path:
            display_result = format_vision_tool_result_for_display(result_text)
    elif name in FILE_PROPOSAL_TOOLS:
        doc_proposal = extract_doc_proposal_from_tool_result(name, result_text)
        if doc_proposal:
            display_result = format_write_tool_result_for_display(result_text)
    else:
        display_result = format_tool_result_for_display(result_text)

    yield StreamEventPayload(
        type="tool_result",
        tool_call_id=tool_id,
        result=display_result,
    )
    messages.append(ToolMessage(content=display_result, tool_call_id=tool_id))

    if doc_proposal:
        full_content = doc_proposal["content"]
        rel_path = doc_proposal["relative_path"]
        if not is_lr_agent_relative(rel_path):
            operation = str(doc_proposal.get("operation") or "write")
            omit_for_path = rel_path in omit_file_proposal_start_delta if omit_file_proposal_start_delta else False
            if operation != "delete" and not omit_for_path:
                yield StreamEventPayload(
                    type="file_proposal_start",
                    summary=doc_proposal["title"],
                    image_path=rel_path,
                    detail=str(len(full_content)),
                    mode=operation,
                )
                chunk_size = 200
                offset = 0
                while offset < len(full_content):
                    end = min(offset + chunk_size, len(full_content))
                    chunk = full_content[offset:end]
                    yield StreamEventPayload(
                        type="file_proposal_delta",
                        content=chunk,
                        image_path=rel_path,
                        mode=operation,
                    )
                    offset = end
            yield StreamEventPayload(
                type="file_proposal",
                summary=doc_proposal["title"],
                content=full_content,
                image_path=rel_path,
                mode=operation,
            )

    if vision_path and provider_is_vision:
        messages.append(
            build_multimodal_user_message(
                "【附图】请根据上图回答用户关于该图片的问题。",
                image_absolute_path=vision_path,
                max_edge=settings.agent_chat_vision_max_edge,
                jpeg_quality=settings.agent_chat_vision_jpeg_quality,
            ),
        )


class ToolLoopRunner:
    """多轮 LLM ↔ 工具循环执行器。"""

    def __init__(
        self,
        llm: ChatOpenAI,
        tools: list[StructuredTool],
        fn_map: dict[str, object],
        settings: Settings,
        is_cancelled,
        user_content: str,
        provider_is_vision: bool = False,
    ) -> None:
        self.llm = llm
        self.tools = tools
        self.fn_map = fn_map
        self.settings = settings
        self.is_cancelled = is_cancelled
        self.user_content = user_content
        self.provider_is_vision = provider_is_vision
        self.vision_bootstrapped = False
        self.completed_tools: set[str] = set()
        self.tool_choice_retries = 0

    def mark_completed(self, tool_call_ids: set[str]) -> None:
        """标记已 resume 的 tool_call_id（允许同名新调用）。"""
        self.completed_tools |= tool_call_ids

    async def stream_chunks(
        self,
        messages: list,
        interceptor: ProposalStreamInterceptor,
    ) -> AsyncIterator[StreamEventPayload]:
        """流式产出 text_delta / reasoning_delta + 拦截 proposal chunks。"""
        llm_with_tools = self.llm.bind_tools(self.tools)

        async for chunk in llm_with_tools.astream(messages):
            if await self.is_cancelled():
                return

            for event in events_from_chunk(chunk, emit_tool_chunks=False):
                if event.type in ("text_delta", "reasoning_delta") and event.content:
                    yield event

            for proposal_event in interceptor.on_chunk(chunk):
                yield proposal_event

    async def execute_round(
        self,
        gathered: AIMessage,
        full_text: str,
        messages: list,
        interceptor: ProposalStreamInterceptor,
    ) -> AsyncIterator[StreamEventPayload]:
        """解析 tool_calls → 执行 SYNC / 发射 ASYNC pending → 产出事件。"""
        api_tool_calls = gathered.tool_calls or []

        resolved = resolve_round_tool_calls(
            api_tool_calls=api_tool_calls,
            completed_tools=frozenset(self.completed_tools),
        )

        if not resolved:
            if not api_tool_calls:
                return
            messages.append(gathered)
            for call in api_tool_calls:
                name, tool_id = _api_call_name_and_id(call)
                if not name or not tool_id:
                    continue
                result_text = build_tool_result(
                    ok=False,
                    tool=name,
                    status="already_completed",
                    summary=ALREADY_COMPLETED_SUMMARY,
                )
                messages.append(
                    ToolMessage(content=result_text, tool_call_id=tool_id)
                )
            yield StreamEventPayload(type=TOOL_CALLS_ALREADY_COMPLETED)
            return

        messages.append(gathered)
        split = split_resolved_calls(resolved)
        streamed_paths = interceptor.collected_paths()

        parallel_calls = [
            call for call in split.immediate if call.name in PARALLEL_SYNC_TOOLS
        ]
        precomputed: dict[str, str] = {}
        if parallel_calls:
            async def _run_parallel(call: ResolvedToolCall) -> tuple[str, str]:
                text = await _invoke_tool_fn(call.name, call.arguments, self.fn_map)
                return call.tool_call_id, text

            pairs = await asyncio.gather(*[_run_parallel(call) for call in parallel_calls])
            precomputed = dict(pairs)

        for call in split.immediate:
            if await self.is_cancelled():
                return
            async for event in _stream_tool_execution(
                tool_id=call.tool_call_id,
                name=call.name,
                args=call.arguments,
                fn_map=self.fn_map,
                provider_is_vision=self.provider_is_vision,
                settings=self.settings,
                messages=messages,
                omit_file_proposal_start_delta=streamed_paths,
                result_text=precomputed.get(call.tool_call_id),
            ):
                yield event
            if call.name == VISION_TOOL_NAME:
                self.vision_bootstrapped = True

        if split.async_pending:
            from app.agent.assist.pending_emitter import emit_tool_pending

            async for event in emit_tool_pending(split.async_pending):
                yield event
