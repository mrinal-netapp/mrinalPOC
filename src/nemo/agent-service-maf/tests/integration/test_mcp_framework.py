"""Integration tests for MCP ↔ Framework adapter boundary.

Validates that:
- ToolRegistry provides tool schemas to framework adapters
- MCPManager lifecycle (init → discover → invoke → shutdown) works end-to-end
- Tool results flow back correctly through the framework layer
- MCPManager handles connection/tool errors appropriately
- ToolRegistry query API works correctly for framework adapter consumption
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from mcp import ClientSession, ClientSessionGroup

from agent_service_maf.config.validators import AgentConfig, MCPSection
from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.exceptions import MCPConnectionError, MCPToolError
from agent_service_maf.mcp.mcp_manager import (
    MCPClientProtocol,
    MCPDiscovery,
    MCPManager,
    MCPToolInvoker,
)
from agent_service_maf.mcp.mcp_registry import MCPRegistry
from agent_service_maf.mcp.tool_registry import ToolRegistry, ToolResult, ToolSchema

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_mcp_section(**kwargs: object) -> MCPSection:
    """Build an MCPSection with sensible test defaults."""
    defaults: dict[str, object] = {
        "connection_timeout_seconds": 5,
        "lazy_connect": True,
        "tool_call_timeout_seconds": 10,
        "max_tool_retries": 0,
        "retry_on_timeout": False,
        "discovery_on_connect": False,
    }
    defaults.update(kwargs)
    return MCPSection(**defaults)


def _make_tool_schema(
    name: str = "search",
    server_name: str = "web",
    description: str = "Search the web",
) -> ToolSchema:
    """Build a ToolSchema for test use."""
    return ToolSchema(
        name=name,
        description=description,
        input_schema={"type": "object", "properties": {"query": {"type": "string"}}},
        output_schema=None,
        server_name=server_name,
    )


def _make_context(mcp_registry: MCPRegistry | None = None) -> AgentExecutionContext:
    """Create a minimal execution context."""
    config = AgentConfig()
    return AgentExecutionContext(
        config=config,
        mcp_registry=mcp_registry,
        correlation_id=str(uuid.uuid4()),
    )


# ---------------------------------------------------------------------------
# Tests: ToolRegistry provides tools to framework adapters
# ---------------------------------------------------------------------------


def test_tool_registry_register_and_get_by_qualified_name() -> None:
    """ToolRegistry.register() should allow retrieval by qualified name."""
    registry = ToolRegistry()
    tool = _make_tool_schema(name="search", server_name="web")

    registry.register(tool)
    retrieved = registry.get("web.search")

    assert retrieved is not None, "ToolRegistry.get('web.search') should return the registered tool"
    assert retrieved.name == "search", "Retrieved tool must have the correct bare name"
    assert retrieved.server_name == "web", (
        "Retrieved tool must preserve the server_name it was registered under"
    )


def test_tool_registry_get_tools_for_server() -> None:
    """ToolRegistry should filter tools by server name for adapters."""
    registry = ToolRegistry()
    registry.register(_make_tool_schema(name="search", server_name="web"))
    registry.register(_make_tool_schema(name="weather", server_name="web"))
    registry.register(_make_tool_schema(name="unrelated", server_name="db"))

    web_tools = registry.get_tools_for_server("web")

    assert len(web_tools) == 2, (
        "get_tools_for_server() should return only the 2 tools from the 'web' server"
    )
    web_names = {t.name for t in web_tools}
    assert "search" in web_names, "search tool should appear in the 'web' server's tool list"
    assert "weather" in web_names, "weather tool should appear in the 'web' server's tool list"
    assert "unrelated" not in web_names, (
        "A tool from a different server must not appear in the 'web' server's list"
    )


def test_tool_registry_to_openai_format_for_llm_gateway() -> None:
    """ToolRegistry.to_openai_format() should produce valid tool definitions for LLM calls."""
    registry = ToolRegistry()
    registry.register(_make_tool_schema(name="search", server_name="web"))

    openai_tools = registry.to_openai_format()

    assert len(openai_tools) == 1, "to_openai_format() should produce one entry per registered tool"
    tool_def = openai_tools[0]
    assert tool_def["type"] == "function", (
        "OpenAI format requires 'type': 'function' for each tool definition"
    )
    assert "function" in tool_def, (
        "OpenAI format requires a 'function' key with the tool's metadata"
    )
    assert tool_def["function"]["name"] == "web.search", (
        "Tool name in OpenAI format should be the qualified name (server.tool)"
    )
    assert "parameters" in tool_def["function"], (
        "OpenAI format must include 'parameters' with the JSON Schema for tool inputs"
    )


def test_tool_registry_filter_tools_by_name() -> None:
    """ToolRegistry.filter_tools() should filter by bare tool name."""
    registry = ToolRegistry()
    registry.register(_make_tool_schema(name="search", server_name="web"))
    registry.register(_make_tool_schema(name="weather", server_name="web"))

    results = registry.filter_tools(tool_names=["search"])

    assert len(results) == 1, (
        "filter_tools(tool_names=['search']) should return exactly 1 matching tool"
    )
    assert results[0].name == "search", "The filtered result must be the 'search' tool"


def test_tool_registry_filter_tools_by_server_name() -> None:
    """ToolRegistry.filter_tools() should filter by server name."""
    registry = ToolRegistry()
    registry.register(_make_tool_schema(name="search", server_name="web"))
    registry.register(_make_tool_schema(name="query", server_name="db"))

    results = registry.filter_tools(server_names=["db"])

    assert len(results) == 1, (
        "filter_tools(server_names=['db']) should return only the 'db' server's tools"
    )
    assert results[0].server_name == "db", "Filtered result must come from the 'db' server"


async def test_tool_registry_register_batch_atomically() -> None:
    """register_batch() should register all tools atomically."""
    registry = ToolRegistry()
    tools = [
        _make_tool_schema(name="alpha", server_name="s1"),
        _make_tool_schema(name="beta", server_name="s1"),
        _make_tool_schema(name="gamma", server_name="s2"),
    ]

    await registry.register_batch(tools)

    assert registry.tool_count == 3, "register_batch() should register all 3 tools atomically"
    assert registry.server_count == 2, "register_batch() should track 2 distinct servers (s1, s2)"


def test_tool_registry_qualified_name_property() -> None:
    """ToolSchema.qualified_name should return 'server.tool'."""
    tool = _make_tool_schema(name="search", server_name="web")

    assert tool.qualified_name == "web.search", (
        "ToolSchema.qualified_name must return the dot-separated 'server.tool' format"
    )


def test_tool_registry_clear_removes_all_tools() -> None:
    """ToolRegistry.clear() should remove all registered tools."""
    registry = ToolRegistry()
    registry.register(_make_tool_schema(name="search", server_name="web"))
    registry.register(_make_tool_schema(name="weather", server_name="web"))

    registry.clear()

    assert registry.tool_count == 0, "ToolRegistry.clear() must remove all registered tools"
    assert registry.get("web.search") is None, (
        "After clear(), previously registered tools should not be retrievable"
    )


def test_tool_registry_clear_server_removes_only_that_server() -> None:
    """ToolRegistry.clear_server() should remove only tools from the specified server."""
    registry = ToolRegistry()
    registry.register(_make_tool_schema(name="search", server_name="web"))
    registry.register(_make_tool_schema(name="weather", server_name="web"))
    registry.register(_make_tool_schema(name="query", server_name="db"))

    registry.clear_server("web")

    assert registry.get("web.search") is None, (
        "clear_server('web') must remove the 'web.search' tool"
    )
    assert registry.get("db.query") is not None, (
        "clear_server('web') must not remove tools from other servers"
    )


# ---------------------------------------------------------------------------
# Tests: MCPManager lifecycle (init → discover → invoke → shutdown)
# ---------------------------------------------------------------------------


def _make_mock_mcp_client(tools: list[Any] | None = None) -> MCPClientProtocol:
    """Build a mock MCPClientProtocol that returns preset tools."""
    mock_client = MagicMock(spec=MCPClientProtocol)
    mock_client.connect = AsyncMock(return_value=MagicMock(spec=ClientSession))
    mock_client.list_tools = AsyncMock(return_value=tools or [])
    mock_client.ping = AsyncMock(return_value=None)
    return mock_client


def _build_mock_mcp_group(tools_dict: dict[str, Any] | None = None) -> MagicMock:
    """Build a mock ClientSessionGroup with configurable .tools dict."""
    group = MagicMock(spec=ClientSessionGroup)
    group.tools = tools_dict or {}
    group.call_tool = AsyncMock()
    group.connect_to_server = AsyncMock(return_value=MagicMock(spec=ClientSession))
    return group


def test_tool_registry_available_on_mcp_manager_after_construction() -> None:
    """MCPManager should expose its ToolRegistry via the tool_registry attribute."""
    config = _make_mcp_section()
    manager = MCPManager(config=config)

    assert manager.tool_registry is not None, (
        "MCPManager must expose a non-None tool_registry attribute after construction"
    )
    assert isinstance(manager.tool_registry, ToolRegistry), (
        "MCPManager.tool_registry must be a ToolRegistry instance"
    )


def test_mcp_manager_connected_servers_initially_empty() -> None:
    """A newly created MCPManager should have no connected servers."""
    config = _make_mcp_section()
    manager = MCPManager(config=config)

    servers = manager.connected_servers()

    assert servers == [], "A freshly created MCPManager should have no connected servers"


async def test_mcp_manager_list_tools_returns_empty_before_discovery() -> None:
    """list_tools() should return an empty list before any tools are discovered."""
    config = _make_mcp_section()
    manager = MCPManager(config=config)

    tools = await manager.list_tools()

    assert tools == [], "list_tools() must return an empty list when no tools have been registered"


async def test_mcp_manager_list_tools_after_manual_registry_population() -> None:
    """Tools registered directly in the registry should be returned by list_tools()."""
    config = _make_mcp_section()
    manager = MCPManager(config=config)

    tool = _make_tool_schema(name="test_tool", server_name="test_server")
    manager.tool_registry.register(tool)

    tools = await manager.list_tools()

    assert len(tools) == 1, "list_tools() should return all tools currently in the registry"
    assert tools[0].name == "test_tool", "list_tools() should return the correct tool name"


async def test_mcp_manager_list_tools_filter_by_server() -> None:
    """list_tools(server_name=...) should filter by the given server name."""
    config = _make_mcp_section()
    manager = MCPManager(config=config)

    manager.tool_registry.register(_make_tool_schema(name="a", server_name="s1"))
    manager.tool_registry.register(_make_tool_schema(name="b", server_name="s2"))

    s1_tools = await manager.list_tools(server_name="s1")

    assert len(s1_tools) == 1, (
        "list_tools(server_name='s1') should return only the 1 tool from server s1"
    )
    assert s1_tools[0].server_name == "s1", "The returned tool must belong to the 's1' server"


async def test_mcp_discovery_registers_tools_in_registry() -> None:
    """MCPDiscovery.discover_server() should populate the ToolRegistry from group.tools."""
    registry = ToolRegistry()
    discovery = MCPDiscovery(tool_registry=registry)

    # Build a mock ClientSessionGroup with one mock tool
    mock_mcp_tool = MagicMock()
    mock_mcp_tool.name = "web_search"
    mock_mcp_tool.description = "Search the web"
    mock_mcp_tool.inputSchema = {"type": "object", "properties": {"query": {"type": "string"}}}
    mock_mcp_tool.outputSchema = None
    mock_mcp_tool.annotations = None

    group = _build_mock_mcp_group(tools_dict={"web.web_search": mock_mcp_tool})

    schemas = await discovery.discover_server("web", group)

    assert len(schemas) == 1, "MCPDiscovery should discover exactly 1 tool from the mock group"
    assert schemas[0].name == "web_search", (
        "Discovered tool schema should have the tool's bare name 'web_search'"
    )
    assert registry.tool_count == 1, (
        "ToolRegistry should have 1 tool after MCPDiscovery.discover_server()"
    )


async def test_mcp_discovery_tags_tools_with_server_name() -> None:
    """Each discovered tool should be tagged with the server_name passed to discover_server."""
    registry = ToolRegistry()
    discovery = MCPDiscovery(tool_registry=registry)

    mock_tool = MagicMock()
    mock_tool.name = "my_tool"
    mock_tool.description = ""
    mock_tool.inputSchema = {}
    mock_tool.outputSchema = None
    mock_tool.annotations = None

    group = _build_mock_mcp_group(tools_dict={"my_server.my_tool": mock_tool})

    schemas = await discovery.discover_server("my_server", group)

    assert schemas[0].server_name == "my_server", (
        "Discovered tool schema must be tagged with the server_name passed to discover_server()"
    )
    assert registry.get("my_server.my_tool") is not None, (
        "Tool must be retrievable from ToolRegistry by its qualified name"
    )


# ---------------------------------------------------------------------------
# Tests: tool results flow back through the framework layer
# ---------------------------------------------------------------------------


async def test_mcp_tool_invoker_validates_arguments_against_schema() -> None:
    """MCPToolInvoker should reject tool calls with missing required arguments."""
    registry = ToolRegistry()
    schema = ToolSchema(
        name="search",
        description="Search",
        input_schema={
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
        output_schema=None,
        server_name="web",
    )
    registry.register(schema)

    config = _make_mcp_section()
    invoker = MCPToolInvoker(config=config, tool_registry=registry)

    group = _build_mock_mcp_group()

    with pytest.raises(MCPToolError) as exc_info:
        await invoker.call_tool(
            server_name="web",
            tool_name="search",
            arguments={},  # Missing required 'query' argument
            group=group,
        )

    assert "search" in str(exc_info.value), (
        "MCPToolError should identify the tool name that failed argument validation"
    )
    assert exc_info.value.tool_name == "search", (
        "MCPToolError.tool_name attribute must be set to the failing tool name"
    )
    assert exc_info.value.server_name == "web", (
        "MCPToolError.server_name attribute must be set to the server name"
    )


async def test_mcp_tool_invoker_returns_tool_result_on_success() -> None:
    """MCPToolInvoker should return a ToolResult with content from the MCP server."""
    registry = ToolRegistry()
    # Register schema with no required fields so validation passes
    schema = ToolSchema(
        name="echo",
        description="Echo",
        input_schema={"type": "object", "properties": {}},
        output_schema=None,
        server_name="test",
    )
    registry.register(schema)

    # Build a mock CallToolResult
    mock_text_block = MagicMock()
    mock_text_block.type = "text"
    mock_text_block.text = "Hello from MCP tool"

    mock_call_result = MagicMock()
    mock_call_result.structuredContent = None
    mock_call_result.content = [mock_text_block]
    mock_call_result.isError = False

    group = _build_mock_mcp_group()
    group.call_tool = AsyncMock(return_value=mock_call_result)

    config = _make_mcp_section()
    invoker = MCPToolInvoker(config=config, tool_registry=registry)

    result = await invoker.call_tool(
        server_name="test",
        tool_name="echo",
        arguments={},
        group=group,
    )

    assert isinstance(result, ToolResult), (
        "MCPToolInvoker must return a ToolResult instance on successful tool invocation"
    )
    assert result.content == "Hello from MCP tool", (
        "ToolResult.content must contain the text returned by the MCP server"
    )
    assert result.is_error is False, (
        "ToolResult.is_error must be False when the MCP server reports success"
    )


async def test_mcp_tool_invoker_on_call_start_hook_is_called() -> None:
    """on_tool_call_start hook should be invoked before each tool call."""
    hook_calls: list[tuple[str, str, dict[str, Any]]] = []

    async def on_start(server: str, tool: str, args: dict[str, Any]) -> None:
        hook_calls.append((server, tool, args))

    registry = ToolRegistry()
    schema = ToolSchema(
        name="hook_test",
        description="",
        input_schema={"type": "object", "properties": {}},
        output_schema=None,
        server_name="srv",
    )
    registry.register(schema)

    mock_call_result = MagicMock()
    mock_call_result.structuredContent = None
    mock_call_result.content = []
    mock_call_result.isError = False

    group = _build_mock_mcp_group()
    group.call_tool = AsyncMock(return_value=mock_call_result)

    config = _make_mcp_section()
    invoker = MCPToolInvoker(
        config=config,
        tool_registry=registry,
        on_tool_call_start=on_start,
    )

    await invoker.call_tool(
        server_name="srv",
        tool_name="hook_test",
        arguments={"param": "value"},
        group=group,
    )

    assert len(hook_calls) == 1, (
        "on_tool_call_start hook should be called exactly once per tool invocation"
    )
    assert hook_calls[0] == ("srv", "hook_test", {"param": "value"}), (
        "on_tool_call_start hook must receive the correct (server, tool, args) tuple"
    )


async def test_mcp_tool_invoker_on_call_end_hook_is_called() -> None:
    """on_tool_call_end hook should be invoked after each successful tool call."""
    hook_calls: list[tuple[str, str, ToolResult]] = []

    async def on_end(server: str, tool: str, result: ToolResult) -> None:
        hook_calls.append((server, tool, result))

    registry = ToolRegistry()
    schema = ToolSchema(
        name="end_hook_test",
        description="",
        input_schema={"type": "object", "properties": {}},
        output_schema=None,
        server_name="srv",
    )
    registry.register(schema)

    mock_text = MagicMock()
    mock_text.type = "text"
    mock_text.text = "result-content"

    mock_call_result = MagicMock()
    mock_call_result.structuredContent = None
    mock_call_result.content = [mock_text]
    mock_call_result.isError = False

    group = _build_mock_mcp_group()
    group.call_tool = AsyncMock(return_value=mock_call_result)

    config = _make_mcp_section()
    invoker = MCPToolInvoker(
        config=config,
        tool_registry=registry,
        on_tool_call_end=on_end,
    )

    await invoker.call_tool(
        server_name="srv",
        tool_name="end_hook_test",
        arguments={},
        group=group,
    )

    assert len(hook_calls) == 1, (
        "on_tool_call_end hook should be called exactly once per tool invocation"
    )
    assert hook_calls[0][0] == "srv", "on_tool_call_end hook should receive the correct server_name"
    assert isinstance(hook_calls[0][2], ToolResult), (
        "on_tool_call_end hook should receive a ToolResult as its third argument"
    )


# ---------------------------------------------------------------------------
# Tests: MCPManager context_manager (shutdown)
# ---------------------------------------------------------------------------


async def test_mcp_manager_context_manager_calls_disconnect_on_exit() -> None:
    """MCPManager __aexit__ should call disconnect_all and release sessions."""
    config = _make_mcp_section()

    async with MCPManager(config=config) as manager:
        # Manually inject a mock session to verify it gets cleared
        manager._connection_manager._server_sessions["test_server"] = MagicMock(spec=ClientSession)
        assert "test_server" in manager.connected_servers(), (
            "Server should be in connected_servers before context exit"
        )

    # After exiting the context, sessions should be cleared
    assert "test_server" not in manager.connected_servers(), (
        "MCPManager __aexit__ must clear all connected server sessions"
    )


async def test_mcp_manager_not_connected_raises_on_call_tool() -> None:
    """Calling a tool on a disconnected server (lazy_connect=False) should raise."""
    config = _make_mcp_section(lazy_connect=False)
    manager = MCPManager(config=config)

    with pytest.raises(MCPConnectionError) as exc_info:
        await manager.call_tool("not_connected", "some_tool", {})

    assert "not_connected" in str(exc_info.value), (
        "MCPConnectionError should identify the server name that is not connected"
    )


async def test_mcp_manager_health_check_raises_when_not_connected() -> None:
    """check_health() on an unconnected server should raise MCPConnectionError."""
    config = _make_mcp_section()
    manager = MCPManager(config=config)

    with pytest.raises(MCPConnectionError) as exc_info:
        await manager.check_health("unconnected_server")

    assert "unconnected_server" in str(exc_info.value), (
        "MCPConnectionError should identify which server has no active session"
    )


async def test_mcp_manager_check_all_health_returns_empty_for_no_connections() -> None:
    """check_all_health() with no connected servers should return an empty list."""
    config = _make_mcp_section()
    manager = MCPManager(config=config)

    results = await manager.check_all_health()

    assert results == [], (
        "check_all_health() must return an empty list when no servers are connected"
    )


# ---------------------------------------------------------------------------
# Tests: ToolRegistry is available through context.mcp_registry
# ---------------------------------------------------------------------------


def test_execution_context_exposes_mcp_registry() -> None:
    """The execution context should carry mcp_registry for adapters to access tools."""
    config = _make_mcp_section()
    mcp_manager = MCPManager(config=config)
    context = _make_context(mcp_registry=mcp_manager)  # type: ignore[arg-type]

    assert context.mcp_registry is not None, (
        "AgentExecutionContext.mcp_registry must be set when a registry is provided"
    )
    assert context.mcp_registry is mcp_manager, (
        "AgentExecutionContext.mcp_registry must be the exact MCPManager instance provided"
    )


def test_tool_registry_get_all_tools_returns_all_registered() -> None:
    """ToolRegistry.get_all_tools() should return every tool regardless of server."""
    registry = ToolRegistry()
    registry.register(_make_tool_schema(name="a", server_name="s1"))
    registry.register(_make_tool_schema(name="b", server_name="s2"))
    registry.register(_make_tool_schema(name="c", server_name="s2"))

    all_tools = registry.get_all_tools()

    assert len(all_tools) == 3, (
        "get_all_tools() should return all 3 registered tools across both servers"
    )


def test_tool_result_creation_with_string_content() -> None:
    """ToolResult should be constructable with plain string content."""
    result = ToolResult(content="some text output", is_error=False)

    assert result.content == "some text output", (
        "ToolResult.content should store the string content as provided"
    )
    assert result.is_error is False, (
        "ToolResult.is_error should be False when not explicitly set to True"
    )


def test_tool_result_creation_with_dict_content() -> None:
    """ToolResult should support structured dict content for JSON tool results."""
    result = ToolResult(content={"key": "value", "count": 42}, is_error=False)

    assert isinstance(result.content, dict), (
        "ToolResult.content should preserve dict content as a dict, not a string"
    )
    assert result.content["count"] == 42, (  # type: ignore[index]
        "ToolResult.content dict values must be preserved correctly"
    )
