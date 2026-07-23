"""MCP integration — framework-agnostic MCP server connectivity and tool management.

Public API
----------
:class:`MCPManager`
    Facade for managing MCP server connections, tool discovery, and invocation.

:class:`MCPServerConfig`
    Validated Pydantic model describing how to connect to a single MCP server.

:func:`load_mcp_configs_from_list`
    Parse inline ``mcp_servers`` array into :class:`MCPServerConfig` objects.

:class:`ToolRegistry`
    Aggregated catalog of all discovered tools across connected MCP servers.

:class:`ToolSchema`
    Normalised tool definition (name, description, input/output schemas, server).

:class:`ToolResult`
    Normalised result returned from an MCP tool call.

:class:`TransportFactory`
    Registry of transport builders (stdio, SSE, streamable-HTTP).

:class:`MCPClientProtocol`
    Abstract interface for DIP / mock testing of MCP client behaviour.

Example
-------
>>> from agent_service_maf.mcp import MCPManager, ToolRegistry, ToolSchema
>>> from agent_service_maf.config.validators import MCPSection
>>> config = MCPSection()
>>> async with MCPManager(config) as manager:
...     await manager.connect_all()
...     tools = manager.tool_registry.get_all_tools()
"""

from __future__ import annotations

from agent_service_maf.mcp.config_loader import MCPServerConfig, load_mcp_configs_from_list
from agent_service_maf.mcp.mcp_manager import (
    MCPClientProtocol,
    MCPConnectionManager,
    MCPDiscovery,
    MCPHealthCheck,
    MCPManager,
    MCPToolInvoker,
)
from agent_service_maf.mcp.tool_registry import ToolRegistry, ToolResult, ToolSchema
from agent_service_maf.mcp.transport_factory import TransportFactory

__all__ = [
    # Primary facade
    "MCPManager",
    # SRP components (for advanced usage / testing)
    "MCPConnectionManager",
    "MCPDiscovery",
    "MCPToolInvoker",
    "MCPHealthCheck",
    # DIP abstraction
    "MCPClientProtocol",
    # Config
    "MCPServerConfig",
    "load_mcp_configs_from_list",
    # Tool catalog
    "ToolRegistry",
    "ToolSchema",
    "ToolResult",
    # Transport
    "TransportFactory",
]
