"""Unified tool-binding subsystem.

This package introduces the **tool binding** abstraction: a single
addressable list of named tools an agent can call, regardless of whether
the underlying tool is served by an MCP server or implemented as a
Python function registered via :mod:`agent_service_maf.tools.functions`.

Public exports:
    * :class:`ToolBinding` — discriminated union over ``type``.
    * :class:`FunctionBinding` — a Python-registered tool instance.
      ``function_ref`` points at a callable in
      :mod:`agent_service_maf.tools.functions`; ``params`` carries
      deployment-fixed values that are injected into the function's
      keyword-only ``params`` argument (and thus invisible to the LLM).
    * :class:`MCPBinding` — an MCP-server-backed tool source (transport
      details live inline; no separate ``mcp_servers[]`` array required).
    * :class:`FunctionToolProvider` — runtime dispatcher that looks up
      the registered function and invokes it with the binding's
      ``params``.
"""

from __future__ import annotations

from agent_service_maf.tools.binding import (
    FunctionBinding,
    MCPBinding,
    ToolBinding,
    parse_tool_bindings,
)
from agent_service_maf.tools.function_provider import FunctionToolProvider

__all__ = [
    "FunctionBinding",
    "FunctionToolProvider",
    "MCPBinding",
    "ToolBinding",
    "parse_tool_bindings",
]
