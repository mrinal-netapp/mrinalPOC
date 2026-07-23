"""Backward-compatible re-export shim for the old MCPRegistry.

The functionality previously in ``MCPRegistry`` has been replaced by:

* :class:`~agent_service_maf.mcp.mcp_manager.MCPManager` — full facade
* :class:`~agent_service_maf.mcp.tool_registry.ToolRegistry` — tool catalog

This module re-exports the new classes under their canonical names.
``MCPRegistry`` is retained as an alias for ``MCPManager`` to avoid
breaking existing imports during the transition period.
"""

from __future__ import annotations

from agent_service_maf.mcp.mcp_manager import MCPManager
from agent_service_maf.mcp.tool_registry import ToolRegistry

# Alias for backward compatibility.
MCPRegistry = MCPManager

__all__ = ["MCPManager", "MCPRegistry", "ToolRegistry"]
