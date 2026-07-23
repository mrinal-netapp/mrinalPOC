"""Unit tests for ToolSchema, ToolResult, and ToolRegistry.

Tests cover:
- ToolSchema qualified_name property
- ToolResult dataclass defaults
- ToolRegistry register/get/get_all
- filter_tools by name and server
- to_openai_format conversion
- clear/clear_server
- tool_count/server_count properties
- Thread safety via register_batch
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from agent_service_maf.mcp.tool_registry import ToolRegistry, ToolResult, ToolSchema

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_tool(
    name: str = "search",
    server_name: str = "web",
    description: str = "Search the web",
    input_schema: dict[str, Any] | None = None,
    output_schema: dict[str, Any] | None = None,
    annotations: dict[str, Any] | None = None,
) -> ToolSchema:
    """Create a ToolSchema with sensible defaults for testing."""
    return ToolSchema(
        name=name,
        description=description,
        input_schema=input_schema or {"type": "object", "properties": {}},
        output_schema=output_schema,
        server_name=server_name,
        annotations=annotations,
    )


# ---------------------------------------------------------------------------
# ToolSchema tests
# ---------------------------------------------------------------------------


class TestToolSchema:
    """Tests for the ToolSchema dataclass."""

    def test_qualified_name_format(self) -> None:
        """qualified_name returns 'server_name.tool_name'."""
        tool = make_tool(name="my_tool", server_name="my_server")
        assert tool.qualified_name == "my_server.my_tool", (
            "qualified_name should be '{server}.{tool}'"
        )

    def test_qualified_name_with_hyphens(self) -> None:
        """qualified_name handles hyphenated server and tool names."""
        tool = make_tool(name="web-search", server_name="web-search-server")
        assert tool.qualified_name == "web-search-server.web-search", (
            "qualified_name must preserve hyphens"
        )

    def test_qualified_name_matches_docstring_example(self) -> None:
        """qualified_name matches the docstring example exactly."""
        tool = ToolSchema(
            name="web_search",
            description="Search the web",
            input_schema={"type": "object", "properties": {"query": {"type": "string"}}},
            output_schema=None,
            server_name="web-search",
        )
        assert tool.qualified_name == "web-search.web_search", (
            "Docstring example must produce 'web-search.web_search'"
        )

    def test_annotations_default_is_none(self) -> None:
        """annotations field defaults to None when not provided."""
        tool = make_tool()
        assert tool.annotations is None, "annotations should default to None"

    def test_annotations_stored_correctly(self) -> None:
        """annotations stores any dict passed in."""
        annotations = {"readOnly": True, "destructive": False}
        tool = make_tool(annotations=annotations)
        assert tool.annotations == annotations, "annotations should be stored exactly as passed"

    def test_output_schema_can_be_none(self) -> None:
        """output_schema can be None (optional field)."""
        tool = make_tool(output_schema=None)
        assert tool.output_schema is None, "output_schema should accept None"

    def test_output_schema_stored_when_provided(self) -> None:
        """output_schema is stored when a dict is provided."""
        schema = {"type": "string"}
        tool = make_tool(output_schema=schema)
        assert tool.output_schema == schema, "output_schema should store the dict"

    def test_input_schema_stored_correctly(self) -> None:
        """input_schema stores the dict provided."""
        schema = {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]}
        tool = make_tool(input_schema=schema)
        assert tool.input_schema == schema, "input_schema must be stored as-is"


# ---------------------------------------------------------------------------
# ToolResult tests
# ---------------------------------------------------------------------------


class TestToolResult:
    """Tests for the ToolResult dataclass."""

    def test_is_error_defaults_to_false(self) -> None:
        """is_error defaults to False when not specified."""
        result = ToolResult(content="hello")
        assert result.is_error is False, "is_error should default to False"

    def test_raw_defaults_to_none(self) -> None:
        """raw defaults to None when not specified."""
        result = ToolResult(content="hello")
        assert result.raw is None, "raw should default to None"

    def test_string_content_stored(self) -> None:
        """String content is stored verbatim."""
        result = ToolResult(content="Sunny in London")
        assert result.content == "Sunny in London", "string content must be preserved"

    def test_dict_content_stored(self) -> None:
        """Dict content is stored verbatim."""
        data = {"temperature": 22, "unit": "C"}
        result = ToolResult(content=data)
        assert result.content == data, "dict content must be preserved"

    def test_error_result(self) -> None:
        """is_error can be set to True."""
        result = ToolResult(content="Something went wrong", is_error=True)
        assert result.is_error is True, "is_error=True should be stored"

    def test_raw_can_hold_arbitrary_object(self) -> None:
        """raw field can hold any object (used for SDK's CallToolResult)."""
        sentinel = object()
        result = ToolResult(content="ok", raw=sentinel)
        assert result.raw is sentinel, "raw must hold the exact object passed"


# ---------------------------------------------------------------------------
# ToolRegistry — registration and retrieval
# ---------------------------------------------------------------------------


class TestToolRegistryRegistration:
    """Tests for register, get, get_all, and basic counts."""

    def test_register_single_tool_increments_tool_count(self) -> None:
        """Registering one tool raises tool_count to 1."""
        registry = ToolRegistry()
        registry.register(make_tool())
        assert registry.tool_count == 1, "tool_count must be 1 after registering one tool"

    def test_register_single_tool_increments_server_count(self) -> None:
        """Registering a tool for a new server increments server_count."""
        registry = ToolRegistry()
        registry.register(make_tool(server_name="web"))
        assert registry.server_count == 1, "server_count must be 1 after registering for one server"

    def test_two_tools_same_server(self) -> None:
        """Two tools on the same server: tool_count=2, server_count=1."""
        registry = ToolRegistry()
        registry.register(make_tool(name="search", server_name="web"))
        registry.register(make_tool(name="fetch", server_name="web"))
        assert registry.tool_count == 2, "two distinct tools must both be counted"
        assert registry.server_count == 1, "same server must not inflate server_count"

    def test_two_tools_different_servers(self) -> None:
        """Two tools on different servers: tool_count=2, server_count=2."""
        registry = ToolRegistry()
        registry.register(make_tool(name="search", server_name="web"))
        registry.register(make_tool(name="query", server_name="db"))
        assert registry.tool_count == 2, "each tool counts once"
        assert registry.server_count == 2, "each unique server counts once"

    def test_get_returns_registered_tool(self) -> None:
        """get() retrieves the tool by qualified name."""
        registry = ToolRegistry()
        tool = make_tool(name="search", server_name="web")
        registry.register(tool)
        result = registry.get("web.search")
        assert result is not None, "get() must return the tool for a valid qualified name"
        assert result.name == "search", "returned tool must have name 'search'"

    def test_get_returns_none_for_unknown(self) -> None:
        """get() returns None when the qualified name is not registered."""
        registry = ToolRegistry()
        assert registry.get("unknown.tool") is None, (
            "get() must return None for unregistered qualified names"
        )

    def test_register_replaces_existing_tool(self) -> None:
        """Re-registering a tool with the same qualified name replaces it."""
        registry = ToolRegistry()
        old_tool = make_tool(name="search", server_name="web", description="Old")
        new_tool = make_tool(name="search", server_name="web", description="New")
        registry.register(old_tool)
        registry.register(new_tool)
        result = registry.get("web.search")
        assert result is not None, "tool must still exist after re-registration"
        assert result.description == "New", (
            "re-registering should silently replace with new description"
        )
        assert registry.tool_count == 1, "replacing should not increment tool_count"

    def test_get_all_tools_empty_registry(self) -> None:
        """get_all_tools returns empty list for empty registry."""
        registry = ToolRegistry()
        assert registry.get_all_tools() == [], "empty registry must return empty list"

    def test_get_all_tools_returns_all(self) -> None:
        """get_all_tools returns all registered tools."""
        registry = ToolRegistry()
        t1 = make_tool(name="search", server_name="web")
        t2 = make_tool(name="query", server_name="db")
        registry.register(t1)
        registry.register(t2)
        all_tools = registry.get_all_tools()
        assert len(all_tools) == 2, "get_all_tools must return exactly 2 tools"
        names = {t.name for t in all_tools}
        assert names == {"search", "query"}, "both tool names must appear"

    def test_get_by_name_single_match(self) -> None:
        """get_by_name returns a list with one match for unique bare name."""
        registry = ToolRegistry()
        tool = make_tool(name="search", server_name="web")
        registry.register(tool)
        matches = registry.get_by_name("search")
        assert len(matches) == 1, "one tool named 'search' must be returned"
        assert matches[0].server_name == "web", "matched tool must be from server 'web'"

    def test_get_by_name_multiple_servers(self) -> None:
        """get_by_name returns all tools sharing a bare name across servers."""
        registry = ToolRegistry()
        registry.register(make_tool(name="search", server_name="web"))
        registry.register(make_tool(name="search", server_name="db"))
        matches = registry.get_by_name("search")
        assert len(matches) == 2, "both servers expose 'search' — both must be returned"

    def test_get_by_name_no_match(self) -> None:
        """get_by_name returns empty list for unknown bare name."""
        registry = ToolRegistry()
        registry.register(make_tool(name="fetch"))
        assert registry.get_by_name("unknown") == [], (
            "no match for unknown name must return empty list"
        )

    def test_get_tools_for_server(self) -> None:
        """get_tools_for_server returns only tools for the specified server."""
        registry = ToolRegistry()
        registry.register(make_tool(name="search", server_name="web"))
        registry.register(make_tool(name="fetch", server_name="web"))
        registry.register(make_tool(name="query", server_name="db"))
        tools = registry.get_tools_for_server("web")
        assert len(tools) == 2, "must return exactly 2 tools for server 'web'"
        assert all(t.server_name == "web" for t in tools), (
            "all returned tools must belong to server 'web'"
        )

    def test_get_tools_for_server_unknown(self) -> None:
        """get_tools_for_server returns empty list for unknown server."""
        registry = ToolRegistry()
        assert registry.get_tools_for_server("nonexistent") == [], (
            "unknown server must return empty list"
        )


# ---------------------------------------------------------------------------
# ToolRegistry — async register_batch
# ---------------------------------------------------------------------------


class TestToolRegistryRegisterBatch:
    """Tests for async register_batch."""

    @pytest.mark.asyncio
    async def test_register_batch_registers_all_tools(self) -> None:
        """register_batch registers all tools in the list atomically."""
        registry = ToolRegistry()
        tools = [
            make_tool(name="search", server_name="web"),
            make_tool(name="fetch", server_name="web"),
            make_tool(name="query", server_name="db"),
        ]
        await registry.register_batch(tools)
        assert registry.tool_count == 3, "register_batch must register all 3 tools"

    @pytest.mark.asyncio
    async def test_register_batch_empty_list(self) -> None:
        """register_batch with empty list leaves registry unchanged."""
        registry = ToolRegistry()
        await registry.register_batch([])
        assert registry.tool_count == 0, "empty batch must not change tool_count"

    @pytest.mark.asyncio
    async def test_register_batch_concurrent_safety(self) -> None:
        """Concurrent register_batch calls produce consistent state."""
        registry = ToolRegistry()

        async def batch_register(server: str, count: int) -> None:
            tools = [make_tool(name=f"tool_{i}", server_name=server) for i in range(count)]
            await registry.register_batch(tools)

        await asyncio.gather(
            batch_register("server_a", 10),
            batch_register("server_b", 10),
        )
        assert registry.tool_count == 20, (
            "20 unique tools from 2 concurrent batches must all be registered"
        )
        assert registry.server_count == 2, "concurrent batches must register exactly 2 servers"


# ---------------------------------------------------------------------------
# ToolRegistry — filter_tools
# ---------------------------------------------------------------------------


class TestToolRegistryFilterTools:
    """Tests for filter_tools method."""

    def _populated_registry(self) -> ToolRegistry:
        """Create a registry with tools across two servers."""
        registry = ToolRegistry()
        registry.register(make_tool(name="search", server_name="web"))
        registry.register(make_tool(name="fetch", server_name="web"))
        registry.register(make_tool(name="query", server_name="db"))
        registry.register(make_tool(name="insert", server_name="db"))
        return registry

    def test_filter_no_args_returns_all(self) -> None:
        """filter_tools with no args returns all tools."""
        registry = self._populated_registry()
        results = registry.filter_tools()
        assert len(results) == 4, "filter with no args must return all 4 tools"

    def test_filter_by_tool_names_bare(self) -> None:
        """filter_tools with bare tool_names filters correctly."""
        registry = self._populated_registry()
        results = registry.filter_tools(tool_names=["search"])
        assert len(results) == 1, "only one tool named 'search'"
        assert results[0].name == "search", "returned tool must be 'search'"

    def test_filter_by_tool_names_qualified(self) -> None:
        """filter_tools accepts qualified tool names."""
        registry = self._populated_registry()
        results = registry.filter_tools(tool_names=["web.search"])
        assert len(results) == 1, "qualified 'web.search' must match exactly one tool"
        assert results[0].name == "search", "matched tool must be 'search'"

    def test_filter_by_server_names(self) -> None:
        """filter_tools filters by server name."""
        registry = self._populated_registry()
        results = registry.filter_tools(server_names=["web"])
        assert len(results) == 2, "server 'web' has 2 tools"
        assert all(t.server_name == "web" for t in results), "all results must belong to 'web'"

    def test_filter_by_both_tool_and_server(self) -> None:
        """filter_tools applies both tool_names and server_names (AND logic)."""
        registry = self._populated_registry()
        results = registry.filter_tools(tool_names=["search"], server_names=["web"])
        assert len(results) == 1, "AND filter must return exactly 1 match"
        assert results[0].name == "search", "result must be 'search'"

    def test_filter_by_both_mismatch(self) -> None:
        """filter_tools returns empty when tool is not on the specified server."""
        registry = self._populated_registry()
        results = registry.filter_tools(tool_names=["query"], server_names=["web"])
        assert results == [], "'query' is not on server 'web' — must return empty list"

    def test_filter_by_multiple_tool_names(self) -> None:
        """filter_tools with multiple tool_names returns all matches."""
        registry = self._populated_registry()
        results = registry.filter_tools(tool_names=["search", "query"])
        assert len(results) == 2, "filtering by ['search', 'query'] must return 2 tools"

    def test_filter_by_multiple_server_names(self) -> None:
        """filter_tools with multiple server_names returns all from those servers."""
        registry = self._populated_registry()
        results = registry.filter_tools(server_names=["web", "db"])
        assert len(results) == 4, "all 4 tools are on either 'web' or 'db'"

    def test_filter_empty_tool_names_returns_all(self) -> None:
        """filter_tools with None tool_names and None server_names returns all."""
        registry = self._populated_registry()
        results = registry.filter_tools(tool_names=None, server_names=None)
        assert len(results) == 4, "explicit None args must return all 4 tools"


# ---------------------------------------------------------------------------
# ToolRegistry — to_openai_format
# ---------------------------------------------------------------------------


class TestToolRegistryToOpenAIFormat:
    """Tests for to_openai_format conversion."""

    def test_to_openai_format_structure(self) -> None:
        """Each entry has 'type' and 'function' keys in OpenAI format."""
        registry = ToolRegistry()
        registry.register(make_tool(name="search", server_name="web", description="Search"))
        result = registry.to_openai_format()
        assert len(result) == 1, "one tool must produce one OpenAI entry"
        entry = result[0]
        assert entry["type"] == "function", "type must be 'function'"
        assert "function" in entry, "must have 'function' key"

    def test_to_openai_format_function_name(self) -> None:
        """Function name in OpenAI format is the qualified tool name."""
        registry = ToolRegistry()
        registry.register(make_tool(name="search", server_name="web"))
        result = registry.to_openai_format()
        assert result[0]["function"]["name"] == "web.search", (
            "function name must be the qualified name 'web.search'"
        )

    def test_to_openai_format_description(self) -> None:
        """Function description matches the tool's description."""
        registry = ToolRegistry()
        registry.register(make_tool(description="Find information on the web"))
        result = registry.to_openai_format()
        assert result[0]["function"]["description"] == "Find information on the web", (
            "description must be passed through unchanged"
        )

    def test_to_openai_format_parameters(self) -> None:
        """Function parameters match the tool's input_schema."""
        schema = {"type": "object", "properties": {"q": {"type": "string"}}}
        registry = ToolRegistry()
        registry.register(make_tool(input_schema=schema))
        result = registry.to_openai_format()
        assert result[0]["function"]["parameters"] == schema, (
            "parameters must match the tool's input_schema"
        )

    def test_to_openai_format_empty_description_coerced(self) -> None:
        """Empty description is coerced to empty string, not None."""
        registry = ToolRegistry()
        registry.register(make_tool(description=""))
        result = registry.to_openai_format()
        assert result[0]["function"]["description"] == "", (
            "empty description must be an empty string in output"
        )

    def test_to_openai_format_subset(self) -> None:
        """to_openai_format accepts a subset of tools to convert."""
        registry = ToolRegistry()
        t1 = make_tool(name="search", server_name="web")
        t2 = make_tool(name="query", server_name="db")
        registry.register(t1)
        registry.register(t2)
        result = registry.to_openai_format(tools=[t1])
        assert len(result) == 1, "only the provided subset must be converted"
        assert result[0]["function"]["name"] == "web.search", "converted tool must be 'web.search'"

    def test_to_openai_format_defaults_to_all(self) -> None:
        """to_openai_format with no args converts all registered tools."""
        registry = ToolRegistry()
        registry.register(make_tool(name="search", server_name="web"))
        registry.register(make_tool(name="query", server_name="db"))
        result = registry.to_openai_format()
        assert len(result) == 2, "all 2 tools must be in the output"

    def test_to_openai_format_empty_registry(self) -> None:
        """to_openai_format on empty registry returns empty list."""
        registry = ToolRegistry()
        result = registry.to_openai_format()
        assert result == [], "empty registry must produce empty list"


# ---------------------------------------------------------------------------
# ToolRegistry — clear and clear_server
# ---------------------------------------------------------------------------


class TestToolRegistryClear:
    """Tests for clear() and clear_server()."""

    def test_clear_removes_all_tools(self) -> None:
        """clear() removes every registered tool."""
        registry = ToolRegistry()
        registry.register(make_tool(name="search", server_name="web"))
        registry.register(make_tool(name="query", server_name="db"))
        registry.clear()
        assert registry.tool_count == 0, "tool_count must be 0 after clear()"
        assert registry.server_count == 0, "server_count must be 0 after clear()"

    def test_clear_allows_re_registration(self) -> None:
        """After clear(), the registry can accept new registrations."""
        registry = ToolRegistry()
        registry.register(make_tool())
        registry.clear()
        registry.register(make_tool(name="new_tool"))
        assert registry.tool_count == 1, "re-registration after clear must succeed"

    def test_clear_server_removes_only_that_server(self) -> None:
        """clear_server() removes only tools for the specified server."""
        registry = ToolRegistry()
        registry.register(make_tool(name="search", server_name="web"))
        registry.register(make_tool(name="fetch", server_name="web"))
        registry.register(make_tool(name="query", server_name="db"))
        registry.clear_server("web")
        assert registry.tool_count == 1, "only the 'db' tool must remain after clearing 'web'"
        assert registry.server_count == 1, "server_count must be 1 after removing 'web'"
        assert registry.get("web.search") is None, (
            "'web.search' must not exist after clear_server('web')"
        )
        assert registry.get("db.query") is not None, "'db.query' must still exist"

    def test_clear_server_unknown_server_is_noop(self) -> None:
        """clear_server() on an unknown server name does nothing."""
        registry = ToolRegistry()
        registry.register(make_tool(name="search", server_name="web"))
        registry.clear_server("nonexistent")
        assert registry.tool_count == 1, "clearing unknown server must not affect existing tools"

    def test_clear_server_updates_server_count(self) -> None:
        """server_count decrements when all tools for a server are removed."""
        registry = ToolRegistry()
        registry.register(make_tool(name="a", server_name="s1"))
        registry.register(make_tool(name="b", server_name="s2"))
        assert registry.server_count == 2, "precondition: two servers"
        registry.clear_server("s1")
        assert registry.server_count == 1, "server_count must drop to 1 after removing s1"
