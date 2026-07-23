"""Tool registry — aggregated catalog of all discovered MCP tools.

This module is framework-agnostic. It does NOT import any agent framework
libraries (Microsoft Agent Framework, etc.).
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ToolSchema:
    """Normalized tool definition from an MCP server.

    Attributes:
        name: Tool name (unique per server).
        description: Human-readable description of the tool.
        input_schema: JSON Schema object defining expected parameters.
        output_schema: Optional JSON Schema for the tool's return value.
        server_name: Identifier of the MCP server that owns this tool.
        annotations: Optional MCP tool annotations (read-only hints, etc.).

    Example:
        >>> tool = ToolSchema(
        ...     name="web_search",
        ...     description="Search the web",
        ...     input_schema={"type": "object", "properties": {"query": {"type": "string"}}},
        ...     output_schema=None,
        ...     server_name="web-search",
        ... )
        >>> tool.qualified_name
        'web-search.web_search'
    """

    name: str
    description: str
    input_schema: dict[str, Any]
    output_schema: dict[str, Any] | None
    server_name: str
    annotations: dict[str, Any] | None = field(default=None)

    @property
    def qualified_name(self) -> str:
        """Globally unique name: ``'server_name.tool_name'``.

        Returns:
            Dot-separated qualified tool name.
        """
        return f"{self.server_name}.{self.name}"


@dataclass
class ToolResult:
    """Normalized result from an MCP tool call.

    Attributes:
        content: Extracted content — either a plain string or a structured dict.
        is_error: Whether the MCP server reported the tool call as an error.
        raw: The raw ``CallToolResult`` object from the MCP SDK (useful for
            debugging). May be ``None`` when constructed synthetically in tests.

    Example:
        >>> result = ToolResult(content="Sunny in London", is_error=False)
        >>> result.content
        'Sunny in London'
    """

    content: str | dict[str, Any]
    is_error: bool = False
    raw: Any = None


class ToolRegistry:
    """Aggregated catalog of all discovered tools across MCP servers.

    This class is the single source of truth for available tools. Both the
    LLMGateway and agent adapters read from it to know what tools exist.

    Thread-safe for concurrent reads and writes via an ``asyncio.Lock``.

    Example:
        >>> registry = ToolRegistry()
        >>> tool = ToolSchema(
        ...     name="search", description="Search", input_schema={}, output_schema=None,
        ...     server_name="web",
        ... )
        >>> registry.register(tool)
        >>> registry.tool_count
        1
        >>> registry.get("web.search")
        ToolSchema(name='search', ...)
    """

    def __init__(self) -> None:
        # qualified_name → ToolSchema
        self._tools: dict[str, ToolSchema] = {}
        # server_name → [qualified_names]
        self._by_server: dict[str, list[str]] = {}
        self._lock: asyncio.Lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Mutation helpers (acquire lock before calling)
    # ------------------------------------------------------------------

    def _register_unsafe(self, tool: ToolSchema) -> None:
        """Register a single tool without acquiring the lock.

        Args:
            tool: The :class:`ToolSchema` to register.
        """
        qname = tool.qualified_name
        self._tools[qname] = tool
        if tool.server_name not in self._by_server:
            self._by_server[tool.server_name] = []
        if qname not in self._by_server[tool.server_name]:
            self._by_server[tool.server_name].append(qname)

    # ------------------------------------------------------------------
    # Public synchronous interface (safe for sync callers)
    # ------------------------------------------------------------------

    def register(self, tool: ToolSchema) -> None:
        """Register a single tool in the catalog.

        If a tool with the same :attr:`~ToolSchema.qualified_name` already
        exists it is silently replaced.

        Args:
            tool: The :class:`ToolSchema` to register.
        """
        # Use a synchronous path so callers that are already inside an async
        # context do not have to await.  The asyncio.Lock is not needed here
        # because CPython's GIL protects single dict mutations.  For
        # concurrent coroutine safety use ``register_batch`` (which acquires
        # the async lock).
        self._register_unsafe(tool)

    async def register_batch(self, tools: list[ToolSchema]) -> None:
        """Register multiple tools atomically under a single lock acquisition.

        Args:
            tools: List of :class:`ToolSchema` objects to register.
        """
        async with self._lock:
            for tool in tools:
                self._register_unsafe(tool)

    def get(self, qualified_name: str) -> ToolSchema | None:
        """Retrieve a tool by its qualified name (``server.tool``).

        Args:
            qualified_name: Dot-separated qualified name, e.g. ``"web.search"``.

        Returns:
            The matching :class:`ToolSchema` or ``None`` if not found.
        """
        return self._tools.get(qualified_name)

    def get_by_name(self, tool_name: str) -> list[ToolSchema]:
        """Return all tools whose bare name matches *tool_name*.

        This supports cases where the same logical tool name exists on multiple
        servers.

        Args:
            tool_name: Bare tool name (not qualified), e.g. ``"search"``.

        Returns:
            List of :class:`ToolSchema` objects — may be empty or contain
            multiple entries if multiple servers expose the same tool name.
        """
        return [t for t in self._tools.values() if t.name == tool_name]

    def get_tools_for_server(self, server_name: str) -> list[ToolSchema]:
        """Return all tools registered for a specific MCP server.

        Args:
            server_name: MCP server identifier, e.g. ``"vector-db"``.

        Returns:
            List of :class:`ToolSchema` for that server (may be empty).
        """
        qnames = self._by_server.get(server_name, [])
        return [self._tools[qn] for qn in qnames if qn in self._tools]

    def get_all_tools(self) -> list[ToolSchema]:
        """Return all registered tools across all servers.

        Returns:
            Unordered list of all :class:`ToolSchema` objects in the registry.
        """
        return list(self._tools.values())

    def filter_tools(
        self,
        tool_names: list[str] | None = None,
        server_names: list[str] | None = None,
    ) -> list[ToolSchema]:
        """Return tools matching optional name and server filters.

        Both *tool_names* and *server_names* act as **inclusion** filters.
        When both are ``None`` all tools are returned.  When both are given,
        a tool must satisfy **both** criteria.

        *tool_names* entries may be either bare names (``"search"``) or fully
        qualified names (``"web.search"``).

        Args:
            tool_names: Optional list of bare or qualified tool names to include.
            server_names: Optional list of MCP server names to include.

        Returns:
            Filtered list of :class:`ToolSchema` objects.

        Example:
            >>> registry.filter_tools(tool_names=["search"], server_names=["web"])
            [ToolSchema(name='search', server_name='web', ...)]
        """
        results: list[ToolSchema] = []
        for tool in self._tools.values():
            if tool_names is not None:
                # Accept both bare names and qualified names.
                match = tool.name in tool_names or tool.qualified_name in tool_names
                if not match:
                    continue
            if server_names is not None and tool.server_name not in server_names:
                continue
            results.append(tool)
        return results

    def to_openai_format(self, tools: list[ToolSchema] | None = None) -> list[dict[str, Any]]:
        """Convert tools to OpenAI function-calling format.

        This is the format the LLMGateway sends to Bifrost/LiteLLM in the
        ``tools`` parameter of a completion request.

        Args:
            tools: Subset of tools to convert. Defaults to all registered tools.

        Returns:
            List of dicts in OpenAI function-calling format::

                [
                    {
                        "type": "function",
                        "function": {
                            "name": "web.search",
                            "description": "Search the web",
                            "parameters": {...},
                        },
                    },
                    ...
                ]

        Example:
            >>> openai_tools = registry.to_openai_format()
            >>> openai_tools[0]["type"]
            'function'
        """
        target = tools if tools is not None else self.get_all_tools()
        return [
            {
                "type": "function",
                "function": {
                    "name": t.qualified_name,
                    "description": t.description or "",
                    "parameters": t.input_schema,
                },
            }
            for t in target
        ]

    def clear(self) -> None:
        """Remove all tools from the registry.

        Useful when reconnecting servers to avoid stale tool definitions.
        """
        self._tools.clear()
        self._by_server.clear()

    def clear_server(self, server_name: str) -> None:
        """Remove all tools belonging to a specific server.

        Args:
            server_name: MCP server identifier whose tools should be removed.
        """
        qnames = self._by_server.pop(server_name, [])
        for qn in qnames:
            self._tools.pop(qn, None)

    @property
    def tool_count(self) -> int:
        """Total number of registered tools across all servers.

        Returns:
            Integer count of tools.
        """
        return len(self._tools)

    @property
    def server_count(self) -> int:
        """Number of servers that have registered at least one tool.

        Returns:
            Integer count of servers.
        """
        return len(self._by_server)
