"""Bifrost aggregated ``/mcp`` tool-name scoping helpers for Agno MCPTools."""

from __future__ import annotations

from typing import Any


def tool_belongs_to_gateway(tool_name: str, gateway_server_name: str) -> bool:
    return tool_name.startswith(f"{gateway_server_name}_") or tool_name.startswith(
        f"{gateway_server_name}-"
    )


def bare_bifrost_tool_name(prefixed_name: str, gateway_server_name: str) -> str:
    for sep in ("_", "-"):
        prefix = f"{gateway_server_name}{sep}"
        if prefixed_name.startswith(prefix):
            return prefixed_name[len(prefix):]
    return prefixed_name


def mcp_tool_names(mcp_tools: Any) -> list[str]:
    """Return registered MCP tool names from an Agno MCPTools toolkit."""
    functions = getattr(mcp_tools, "functions", None)
    if functions is None:
        return []
    if isinstance(functions, dict):
        return list(functions.keys())
    return [getattr(fn, "name", str(fn)) for fn in functions]


def set_mcp_tool_names(mcp_tools: Any, names_to_keep: set[str]) -> int:
    """Drop tools not in ``names_to_keep``. Agno stores tools in an OrderedDict."""
    functions = getattr(mcp_tools, "functions", None)
    if functions is None:
        return 0
    if isinstance(functions, dict):
        for name in list(functions):
            if name not in names_to_keep:
                del functions[name]
        return len(functions)
    kept = [
        fn for fn in functions
        if getattr(fn, "name", str(fn)) in names_to_keep
    ]
    mcp_tools.functions = kept
    return len(kept)


def lock_mcp_include_tools(mcp_tools: Any) -> None:
    """Pin Agno's include_tools so rebuilds cannot re-register filtered tools."""
    names = mcp_tool_names(mcp_tools)
    if names:
        mcp_tools.include_tools = names


def scope_mcp_toolkit_to_server(mcp_tools: Any, gateway_server_name: str) -> int:
    """Keep only tools belonging to one Bifrost MCP client. Returns count kept."""
    names_to_keep = {
        name
        for name in mcp_tool_names(mcp_tools)
        if tool_belongs_to_gateway(name, gateway_server_name)
    }
    kept = set_mcp_tool_names(mcp_tools, names_to_keep)
    if kept:
        lock_mcp_include_tools(mcp_tools)
    return kept


def apply_mcp_tool_policy(
    mcp_tools: Any,
    gateway_server_name: str,
    server_config: dict,
) -> int:
    """Apply per-server allow/block lists after Bifrost client scoping."""
    allowed = server_config.get("allowedTools")
    blocked = set(server_config.get("disallowedTools") or [])

    names_to_keep: set[str] = set()
    for name in mcp_tool_names(mcp_tools):
        bare = bare_bifrost_tool_name(name, gateway_server_name)
        if blocked and (bare in blocked or name in blocked):
            continue
        if allowed is not None and bare not in allowed and name not in allowed:
            continue
        names_to_keep.add(name)
    kept = set_mcp_tool_names(mcp_tools, names_to_keep)
    if kept:
        lock_mcp_include_tools(mcp_tools)
    return kept
