"""Bifrost aggregated ``/mcp`` tool-name prefix helpers.

Config-service registers tools with an underscore separator
(``{clientName}_{toolName}`` — see ``bifrostPrefixedToolName`` in
``config-service/services/bifrost/bifrostMcpOps.ts``). Some older
fixtures/docs used a hyphen separator; both are recognised here so
discovery and dispatch stay aligned with the live gateway.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any


def bifrost_prefixed_tool_name(gateway_server_name: str, bare_tool_name: str) -> str:
    """Build the wire name Bifrost expects for ``tools/call`` dispatch."""
    for sep in ("_", "-"):
        prefix = f"{gateway_server_name}{sep}"
        if bare_tool_name.startswith(prefix):
            return bare_tool_name
    return f"{gateway_server_name}_{bare_tool_name}"


def strip_bifrost_tool_prefix(raw_name: str, gateway_server_name: str) -> str | None:
    """Return the bare tool name when *raw_name* belongs to *gateway_server_name*."""
    for sep in ("_", "-"):
        prefix = f"{gateway_server_name}{sep}"
        if raw_name.startswith(prefix):
            return raw_name[len(prefix) :]
    return None


def tool_belongs_to_bifrost_client(raw_name: str, gateway_server_name: str) -> bool:
    """True when *raw_name* is namespaced to the given Bifrost MCP client."""
    return strip_bifrost_tool_prefix(raw_name, gateway_server_name) is not None


def resolve_bifrost_dispatch_name(
    gateway_server_name: str,
    bare_tool_name: str,
    available_tools: Mapping[str, Any] | None = None,
) -> str:
    """Pick the wire name present in a Bifrost ``tools/list`` snapshot."""
    primary = bifrost_prefixed_tool_name(gateway_server_name, bare_tool_name)
    if available_tools is None:
        return primary
    if primary in available_tools:
        return primary
    legacy = f"{gateway_server_name}-{bare_tool_name}"
    if legacy in available_tools:
        return legacy
    return primary


def is_aggregated_bifrost_mcp_url(url: str | None) -> bool:
    """True when the URL targets Bifrost's multiplexed ``/mcp`` proxy."""
    if not url:
        return False
    return url.rstrip("/").endswith("/mcp")
