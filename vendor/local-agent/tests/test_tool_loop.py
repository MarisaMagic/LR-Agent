"""测试 ToolLoopRunner：单轮/多轮 mock LLM，含 tool call 解析与执行。"""

import pytest
from app.agent.assist.tool_loop import ToolLoopRunner
from app.agent.assist.proposal_streamer import ProposalStreamInterceptor


# ── Helpers ──────────────────────────────────────────────────────────────

class MockChatOpenAI:
    """Mock ChatOpenAI，astream 返回预设 chunk 序列。"""
    def __init__(self, chunks):
        self._chunks = chunks

    def bind_tools(self, tools, tool_choice=None):
        return self

    async def astream(self, messages):
        for chunk in self._chunks:
            yield chunk

    async def ainvoke(self, messages):
        # tool_choice="any" retry 使用
        return self._chunks[-1] if self._chunks else type("MockMsg", (), {"tool_calls": [], "content": ""})()


class MockChunk:
    """Mock AIMessageChunk。"""
    def __init__(self, content="", tool_call_chunks=None, tool_calls=None, additional_kwargs=None):
        self.content = content
        self.tool_call_chunks = tool_call_chunks or []
        self.tool_calls = tool_calls
        self.additional_kwargs = additional_kwargs or {}

    def __add__(self, other):
        # merge tool_calls
        merged_tool_calls = (self.tool_calls or []) + (other.tool_calls or [])
        return MockChunk(
            content=(self.content or "") + (other.content or ""),
            tool_call_chunks=self.tool_call_chunks + other.tool_call_chunks,
            tool_calls=merged_tool_calls,
            additional_kwargs={**self.additional_kwargs, **other.additional_kwargs},
        )


async def _collect_events(async_iter):
    return [e async for e in async_iter]


async def _never_cancel() -> bool:
    """取消检查桩：会话永不取消。"""
    return False


# ── Tests ───────────────────────────────────────────────────────────────

class TestToolLoopStreamChunks:
    async def test_stream_chunks_yields_text_delta(self):
        """LLM 返回纯文本，应产出 text_delta。"""
        llm = MockChatOpenAI([MockChunk(content="hello")])
        loop = ToolLoopRunner(llm, [], {}, None, _never_cancel, "test")
        interceptor = ProposalStreamInterceptor()

        events = await _collect_events(loop.stream_chunks([], interceptor))
        text_events = [e for e in events if e.type == "text_delta"]
        assert len(text_events) == 1
        assert text_events[0].content == "hello"

    async def test_stream_chunks_respects_cancellation(self):
        cancelled = [False]

        async def check_cancel():
            cancelled[0] = True
            return True

        llm = MockChatOpenAI([MockChunk(content="hello")])
        loop = ToolLoopRunner(llm, [], {}, None, check_cancel, "test")
        interceptor = ProposalStreamInterceptor()

        events = await _collect_events(loop.stream_chunks([], interceptor))
        assert len(events) == 0  # 第一个 chunk 前就被取消了

    async def test_stream_chunks_yields_reasoning_delta(self):
        llm = MockChatOpenAI([
            MockChunk(content="", additional_kwargs={"reasoning_content": "thinking..."})
        ])
        loop = ToolLoopRunner(llm, [], {}, None, _never_cancel, "test")
        interceptor = ProposalStreamInterceptor()

        events = await _collect_events(loop.stream_chunks([], interceptor))
        reasoning_events = [e for e in events if e.type == "reasoning_delta"]
        assert len(reasoning_events) >= 1


class TestToolLoopExecuteRound:
    def _make_gathered(self, tool_calls=None, content=""):
        return MockChunk(content=content, tool_calls=tool_calls)

    async def test_no_tool_calls_returns_empty(self):
        llm = MockChatOpenAI([])
        loop = ToolLoopRunner(llm, [], {}, None, _never_cancel, "test")
        gather = self._make_gathered(tool_calls=[])
        interceptor = ProposalStreamInterceptor()

        events = await _collect_events(
            loop.execute_round(gather, "hello", [], interceptor)
        )
        assert len(events) == 0

    async def test_execute_round_runs_coroutine_only_tool(self):
        """MCP 风格工具只有 coroutine：执行层必须 await，不能报未知工具。"""
        import json

        from langchain_core.tools import StructuredTool

        from app.agent.tools.registry import tool_fn_map

        async def memory_create(
            topic_file: str, content: str, index_line: str
        ) -> str:
            return json.dumps(
                {"ok": True, "created": True, "topic_file": topic_file},
                ensure_ascii=False,
            )

        tool = StructuredTool(
            name="memory_create",
            description="create topic",
            coroutine=memory_create,
            args_schema={
                "type": "object",
                "properties": {
                    "topic_file": {"type": "string"},
                    "content": {"type": "string"},
                    "index_line": {"type": "string"},
                },
            },
        )
        fn_map = tool_fn_map([tool])
        llm = MockChatOpenAI([])
        loop = ToolLoopRunner(llm, [tool], fn_map, None, _never_cancel, "test")
        gather = self._make_gathered(
            tool_calls=[
                {
                    "id": "c1",
                    "name": "memory_create",
                    "args": {
                        "topic_file": "annotated-files.md",
                        "content": "# x",
                        "index_line": "- [已标文件](topics/annotated-files.md)",
                    },
                }
            ]
        )
        interceptor = ProposalStreamInterceptor()
        events = await _collect_events(
            loop.execute_round(gather, "", [], interceptor)
        )
        results = [e for e in events if e.type == "tool_result"]
        assert len(results) == 1
        assert "未知工具" not in (results[0].result or "")
        payload = json.loads(results[0].result or "{}")
        assert payload.get("ok") is True
        assert payload.get("topic_file") == "annotated-files.md"

    async def test_execute_round_unwraps_mcp_content_and_artifact(self):
        import json

        from langchain_core.tools import StructuredTool

        from app.agent.tools.registry import tool_fn_map

        async def memory_create(
            topic_file: str, content: str, index_line: str
        ):
            payload = json.dumps(
                {"ok": True, "created": True, "topic_file": topic_file},
                ensure_ascii=False,
            )
            return (
                [{"type": "text", "text": payload}],
                {"structured_content": None},
            )

        tool = StructuredTool(
            name="memory_create",
            description="create topic",
            coroutine=memory_create,
            args_schema={
                "type": "object",
                "properties": {
                    "topic_file": {"type": "string"},
                    "content": {"type": "string"},
                    "index_line": {"type": "string"},
                },
            },
            response_format="content_and_artifact",
        )
        loop = ToolLoopRunner(
            MockChatOpenAI([]),
            [tool],
            tool_fn_map([tool]),
            None,
            _never_cancel,
            "test",
        )
        gather = self._make_gathered(
            tool_calls=[
                {
                    "id": "c1",
                    "name": "memory_create",
                    "args": {
                        "topic_file": "annotated-files.md",
                        "content": "# x",
                        "index_line": "- idx",
                    },
                }
            ]
        )
        events = await _collect_events(
            loop.execute_round(gather, "", [], ProposalStreamInterceptor())
        )
        results = [e for e in events if e.type == "tool_result"]
        assert len(results) == 1
        payload = json.loads(results[0].result or "{}")
        assert payload.get("ok") is True
        assert payload.get("topic_file") == "annotated-files.md"
