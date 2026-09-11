"""后端 MCP 客户端：连接本机 Electron MCP Server 与用户配置的远程 MCP，动态获取工具并注入 Agent 工具集。

使用 langchain-mcp-adapters 将 MCP 工具 schema 转换为 LangChain StructuredTool。
本机 Server 地址由 client_context.mcp_server_url 传入；
远程 Server（userData/mcp.json 已启用项）由 client_context.mcp_servers 传入，
支持 streamable_http 与 sse 两种传输。

工具发现流程：
  1. 逐台连接 MCP Server（本机强制 /mcp 端点；远程 URL 原样使用）
  2. 调用 get_tools() 获取所有工具
  3. 按 ToolCapability + 名称去重后返回 list[StructuredTool]（不与内置工具能力冲突）

已知 MCP 工具（前端 server.ts 暴露）：
  - memory_read           读取工作区记忆 topic 文件（需任务开关）
  - memory_write          覆盖已有工作区记忆 topic（需任务开关）
  - memory_create         新建工作区记忆 topic（需任务开关）
  - read_agent_skill      读取全局 Agent Skill 的 SKILL.md 或附属文本文件
  - list_agent_skill_files 列出 skill 目录内文件（只读，不执行脚本）
                          （二者走默认 SYNC runner，与 canonical 无能力冲突）
"""

from __future__ import annotations

import logging

from langchain_core.tools import StructuredTool

from app.agent.tools.tool_registry_meta import (
    CANONICAL_CAPABILITIES,
    ToolCapability,
)

logger = logging.getLogger(__name__)


def should_expose_mcp_tool(
    tool_name: str,
    *,
    workspace_memory_enabled: bool,
    agent_mode: str | None = None,
) -> bool:
    """工作区记忆关闭时不向 Agent 暴露 memory_*，保留 read_agent_skill。

    Ask（agent_mode 非 annotation）只暴露 memory_read，禁止 memory_write / memory_create。
    """
    if tool_name.startswith("memory_"):
        if not workspace_memory_enabled:
            return False
        if agent_mode != "annotation":
            return tool_name == "memory_read"
        return True
    return True


def _infer_mcp_capability(tool_name: str) -> ToolCapability | None:
    """从 MCP 工具名称推断其能力类型。

    当前 Electron MCP 工具（memory_* / read_agent_skill / list_agent_skill_files）
    与内置能力不冲突，返回 None。
    若将来再暴露与 canonical 重叠的名字，在此登记以免双轨注入。
    """
    _ = tool_name
    return None


def _local_connection(mcp_server_url: str, token: str | None = None) -> dict:
    """本机 Electron MCP Server 连接参数（端点固定 /mcp，见 src/main/mcp/server.ts）。

    token 由 client_context.mcp_server_token 传入，作为 Bearer 头注入。
    """
    conn: dict = {
        "url": mcp_server_url.rstrip("/") + "/mcp",
        "transport": "streamable_http",
        "timeout": 60,
        "sse_read_timeout": 300,
        "terminate_on_close": True,
    }
    if token and token.strip():
        conn["headers"] = {"Authorization": f"Bearer {token.strip()}"}
    return conn


def _remote_connection(server) -> dict:
    """远程 MCP Server 连接参数：URL 原样使用（不拼 /mcp），协议按配置。"""
    transport = getattr(server, "transport", None) or "streamable_http"
    conn: dict = {
        "url": (getattr(server, "url", "") or "").strip(),
        "transport": transport if transport in ("streamable_http", "sse") else "streamable_http",
        "timeout": 60,
        "sse_read_timeout": 300,
    }
    headers = getattr(server, "headers", None)
    if headers:
        conn["headers"] = dict(headers)
    return conn


def _filter_tools(
    tools: list[StructuredTool],
    *,
    existing_capabilities: set[ToolCapability],
    seen_names: set[str],
) -> tuple[list[StructuredTool], list[str]]:
    """按能力 + 名称去重：跳过已有 canonical 实现及前序 server 已提供的工具。"""
    filtered: list[StructuredTool] = []
    skipped: list[str] = []
    for t in tools:
        cap = _infer_mcp_capability(t.name)
        if cap is not None and cap in existing_capabilities:
            skipped.append(t.name)
            continue
        if t.name in seen_names:
            skipped.append(t.name)
            continue
        seen_names.add(t.name)
        filtered.append(t)
    return filtered, skipped


async def load_mcp_tools_from_servers(
    local_server_url: str | None,
    remote_servers: list | None = None,
    *,
    local_server_token: str | None = None,
    existing_capabilities: set[ToolCapability] | None = None,
) -> list[StructuredTool]:
    """连接本机 + 远程 MCP Server，动态发现并按能力/名称去重后返回工具列表。

    逐台建连：单台失败仅跳过该 server，不影响其他 server 与 Agent 主流程。
    """
    if existing_capabilities is None:
        existing_capabilities = CANONICAL_CAPABILITIES

    try:
        from langchain_mcp_adapters.client import MultiServerMCPClient
    except ImportError:
        logger.warning("langchain-mcp-adapters 未安装，跳过 MCP 工具加载")
        return []

    connections: dict[str, dict] = {}
    disabled_by_conn: dict[str, set[str]] = {}
    if local_server_url and local_server_url.strip():
        connections["lr-agent-local"] = _local_connection(
            local_server_url, local_server_token
        )
    for server in remote_servers or []:
        server_id = getattr(server, "id", "") or f"remote-{len(connections)}"
        conn = _remote_connection(server)
        if not conn["url"]:
            continue
        conn_name = f"mcp-remote-{server_id}"
        connections[conn_name] = conn
        disabled_by_conn[conn_name] = {
            name
            for name in (getattr(server, "disabled_tools", None) or [])
            if isinstance(name, str) and name.strip()
        }

    tools_all: list[StructuredTool] = []
    seen_names: set[str] = set()
    skipped_all: list[str] = []
    for name, conn in connections.items():
        try:
            client = MultiServerMCPClient({name: conn})
            tools = await client.get_tools()
        except Exception as exc:
            logger.warning(
                "MCP: 连接 %s (%s) 失败，跳过该 server：%s",
                name,
                conn.get("url"),
                exc,
            )
            continue
        disabled = disabled_by_conn.get(name) or set()
        if disabled:
            skipped_all.extend(t.name for t in tools if t.name in disabled)
            tools = [t for t in tools if t.name not in disabled]
        filtered, skipped = _filter_tools(
            tools,
            existing_capabilities=existing_capabilities,
            seen_names=seen_names,
        )
        tools_all.extend(filtered)
        skipped_all.extend(skipped)

    if tools_all or skipped_all:
        logger.info(
            "MCP: 已加载 %d 个工具：%s (跳过: %s)",
            len(tools_all),
            [t.name for t in tools_all],
            skipped_all or ["无"],
        )
    return tools_all


async def load_mcp_tools_from_server(
    mcp_server_url: str,
    *,
    existing_capabilities: set[ToolCapability] | None = None,
) -> list[StructuredTool]:
    """连接本地 MCP Server，动态发现并按能力去重后返回工具列表。

    失败时返回空列表（不影响 Agent 正常运行）。
    """
    return await load_mcp_tools_from_servers(
        mcp_server_url,
        None,
        existing_capabilities=existing_capabilities,
    )


async def probe_mcp_tools(
    url: str,
    *,
    transport: str = "streamable_http",
    headers: dict[str, str] | None = None,
) -> list[StructuredTool]:
    """连接单个 MCP Server 并列出工具（配置页「测试连接」用）。

    失败时抛出异常，由调用方转为错误响应。
    """
    from langchain_mcp_adapters.client import MultiServerMCPClient

    conn: dict = {
        "url": url.strip(),
        "transport": transport if transport in ("streamable_http", "sse") else "streamable_http",
        "timeout": 30,
        "sse_read_timeout": 60,
    }
    if headers:
        conn["headers"] = dict(headers)
    client = MultiServerMCPClient({"mcp-probe": conn})
    return await client.get_tools()
