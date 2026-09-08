"""测试 MCP 工具注入时的 capability 去重。"""

from app.agent.tools.mcp_client import _infer_mcp_capability
from app.agent.tools.tool_registry_meta import TOOL_CAPABILITY_MAP


def test_current_mcp_unique_tools_have_no_capability():
    """现有 MCP 工具不与 canonical 能力冲突，应全部注入。"""
    for name in ("memory_read", "memory_write", "read_agent_skill"):
        assert _infer_mcp_capability(name) is None


def test_infer_unknown_tool():
    assert _infer_mcp_capability("some_unknown_tool") is None


def test_all_canonical_tools_have_capability():
    from app.agent.tools.tool_registry_meta import TOOL_RUNNERS

    for name in TOOL_RUNNERS:
        assert name in TOOL_CAPABILITY_MAP, f"工具 {name} 缺少能力映射"
