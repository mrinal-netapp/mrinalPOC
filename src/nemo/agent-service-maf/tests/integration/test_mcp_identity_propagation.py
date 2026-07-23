"""Integration test — identity propagation through MCP tool invocation.

The unit tier (`tests/unit/test_mcp_identity_transport.py`) exhaustively
exercises `build_identity_headers` / `build_identity_meta` as pure
functions. This integration test pins the *contract* that
`MCPToolInvoker.call_tool` actually reads the active
:class:`IdentityContext` from the ContextVar and forwards it to the
underlying ``ClientSessionGroup.call_tool(..., meta=...)`` call — which
the unit tier cannot prove because it never invokes the real
invoker.

The audit (B3) flagged this as a BLOCKER-tier integration gap: the
identity-on-behalf-of payload is what downstream MCP servers use to
authorize per-user actions, and the user JWT must never appear in
transport-frame ``_meta`` (frames are loggable; the JWT lives only on
the typed ``IdentityContext.user_token`` accessor and the dedicated
``X-User-Token`` header for HTTP transports).
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

from mcp import ClientSessionGroup

from agent_service_maf.config.validators import MCPSection
from agent_service_maf.core.identity import (
    IdentityContext,
    reset_current_identity,
    set_current_identity,
)
from agent_service_maf.mcp.mcp_manager import MCPToolInvoker
from agent_service_maf.mcp.tool_registry import ToolRegistry, ToolSchema

# ---------------------------------------------------------------------------
# Helpers (mirror test_mcp_framework.py shapes)
# ---------------------------------------------------------------------------


def _make_mcp_section(**kwargs: Any) -> MCPSection:
    defaults: dict[str, Any] = {
        "connection_timeout_seconds": 5,
        "tool_call_timeout_seconds": 10,
        "max_tool_result_size_bytes": 1024 * 1024,
    }
    defaults.update(kwargs)
    return MCPSection(**defaults)


def _registry_with_echo() -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(
        ToolSchema(
            name="echo",
            description="echo",
            input_schema={"type": "object", "properties": {}},
            output_schema=None,
            server_name="test",
        )
    )
    return registry


def _ok_call_result() -> MagicMock:
    block = MagicMock()
    block.type = "text"
    block.text = "ok"
    result = MagicMock()
    result.structuredContent = None
    result.content = [block]
    result.isError = False
    return result


def _build_group_capturing_meta(captured: dict[str, Any]) -> MagicMock:
    """Build a mock ClientSessionGroup whose call_tool records the kwargs."""
    group = MagicMock(spec=ClientSessionGroup)
    group.tools = {}

    async def _capture(tool_name: str, arguments: dict[str, Any], meta: Any = None) -> Any:  # noqa: ANN401
        captured["tool_name"] = tool_name
        captured["arguments"] = arguments
        captured["meta"] = meta
        return _ok_call_result()

    group.call_tool = AsyncMock(side_effect=_capture)
    return group


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


async def test_identity_meta_forwarded_to_mcp_call_tool() -> None:
    """Bound IdentityContext → MCP `_meta.identity` payload.

    Asserts the MCPToolInvoker.call_tool path reads from the active
    ContextVar and forwards the §E3 identity envelope to the
    underlying ClientSessionGroup.
    """
    identity = IdentityContext(
        user_id="alice",
        project_id="proj-123",
        user_email="alice@example.com",
        user_name="Alice",
        user_token="raw-user-jwt-must-never-be-on-the-wire",
        correlation_id="corr-abc-123",
    )

    captured: dict[str, Any] = {}
    group = _build_group_capturing_meta(captured)
    invoker = MCPToolInvoker(config=_make_mcp_section(), tool_registry=_registry_with_echo())

    token = set_current_identity(identity)
    try:
        await invoker.call_tool(
            server_name="test",
            tool_name="echo",
            arguments={},
            group=group,
        )
    finally:
        reset_current_identity(token)

    meta = captured["meta"]
    assert meta is not None, (
        "MCPToolInvoker.call_tool must forward identity meta when an IdentityContext is bound"
    )
    assert "identity" in meta, (
        f"meta payload must wrap the identity under an 'identity' key, got: {meta}"
    )
    payload = meta["identity"]
    assert payload["userId"] == "alice"
    assert payload["projectId"] == "proj-123"
    assert payload["userEmail"] == "alice@example.com"
    assert payload["userName"] == "Alice"
    assert payload["correlationId"] == "corr-abc-123"


async def test_user_token_never_serialized_into_mcp_meta() -> None:
    """`_meta.identity` MUST never include the user JWT.

    MCP transport frames are loggable; the user JWT lives only on
    the typed `IdentityContext.user_token` accessor and on the
    dedicated `X-User-Token` HTTP header. This test pins the
    boundary so a future change to `build_identity_meta` can't
    silently leak the token through `_meta`.
    """
    secret_jwt = "eyJhbGciOiJSUzI1NiJ9.SECRET_PAYLOAD.SIGNATURE"
    identity = IdentityContext(
        user_id="alice",
        project_id="proj-123",
        user_token=secret_jwt,
    )

    captured: dict[str, Any] = {}
    group = _build_group_capturing_meta(captured)
    invoker = MCPToolInvoker(config=_make_mcp_section(), tool_registry=_registry_with_echo())

    token = set_current_identity(identity)
    try:
        await invoker.call_tool(
            server_name="test",
            tool_name="echo",
            arguments={},
            group=group,
        )
    finally:
        reset_current_identity(token)

    # Direct field check.
    payload = captured["meta"]["identity"]
    assert "userToken" not in payload, (
        f"user_token MUST NOT appear in MCP _meta payload (found: {payload})"
    )
    assert "user_token" not in payload, (
        "snake_case user_token MUST NOT appear in MCP _meta payload either"
    )

    # Full-string scan over the captured meta — defensive against the
    # JWT slipping into a different key name.
    serialized = repr(captured["meta"])
    assert secret_jwt not in serialized, f"user JWT leaked into MCP _meta payload: {serialized}"
    assert "SECRET_PAYLOAD" not in serialized, "user JWT body leaked into MCP _meta payload"


async def test_no_identity_bound_passes_none_meta() -> None:
    """When no IdentityContext is bound, meta is None (the SDK elides it).

    Locks the "no identity = no _meta" contract — the SDK happily
    accepts None and drops the field on the wire. Forwarding an
    empty dict instead would still emit the field; forwarding a
    placeholder string would corrupt the MCP frame.
    """
    captured: dict[str, Any] = {}
    group = _build_group_capturing_meta(captured)
    invoker = MCPToolInvoker(config=_make_mcp_section(), tool_registry=_registry_with_echo())

    # Ensure no identity is bound — the ContextVar default is None.
    await invoker.call_tool(
        server_name="test",
        tool_name="echo",
        arguments={},
        group=group,
    )

    assert captured["meta"] is None, (
        f"meta must be None when no IdentityContext is bound, got: {captured['meta']!r}"
    )


async def test_identity_with_only_required_fields_emits_minimal_meta() -> None:
    """Optional identity fields are elided from _meta when unset.

    `user_id` is required; everything else is optional. The meta
    payload must mirror that — optional keys are absent rather
    than set to None / empty string, so consumers can use truthy
    `key in payload` checks.
    """
    identity = IdentityContext(user_id="bob", project_id="proj-min")

    captured: dict[str, Any] = {}
    group = _build_group_capturing_meta(captured)
    invoker = MCPToolInvoker(config=_make_mcp_section(), tool_registry=_registry_with_echo())

    token = set_current_identity(identity)
    try:
        await invoker.call_tool(
            server_name="test",
            tool_name="echo",
            arguments={},
            group=group,
        )
    finally:
        reset_current_identity(token)

    payload = captured["meta"]["identity"]
    assert payload["userId"] == "bob"
    assert payload["projectId"] == "proj-min"
    # Optional fields elided.
    assert "userEmail" not in payload
    assert "userName" not in payload
    assert "correlationId" not in payload
