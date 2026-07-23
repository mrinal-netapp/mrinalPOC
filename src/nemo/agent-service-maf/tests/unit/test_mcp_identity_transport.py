"""Unit tests for §E1-E4 MCP identity transport helpers.

Covers test plan items:
* I5 — Two-token MCP HTTP/SSE headers (Authorization = service token,
       X-User-Token = user JWT).
* I6 — Legacy fallback: no service token -> user JWT routed to
       Authorization, still also on X-User-Token.
* I7 — MCP stdio `_meta` carries identity attribution but NEVER the
       user JWT or any service token.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock

import pytest

from agent_service_maf.core.identity import (
    IdentityContext,
    reset_current_identity,
    set_current_identity,
)
from agent_service_maf.mcp._identity_transport import (
    HDR_AUTHORIZATION,
    HDR_CORRELATION_ID,
    HDR_PROJECT_ID,
    HDR_USER_EMAIL,
    HDR_USER_ID,
    HDR_USER_NAME,
    HDR_USER_TOKEN,
    IdentityAwareHTTPTransport,
    build_identity_headers,
    build_identity_meta,
)


@pytest.fixture
def identity() -> IdentityContext:
    return IdentityContext(
        user_id="alice",
        project_id="proj-123",
        user_email="alice@example.com",
        user_name="Alice Smith",
        user_token="raw-user-jwt-value",
        correlation_id="corr-xyz",
    )


# ---------------------------------------------------------------------------
# §I5 — Two-token model: service token + user JWT propagated separately
# ---------------------------------------------------------------------------


class TestBuildIdentityHeadersTwoToken:
    """§I5 -- Authorization carries the service-account token; X-User-Token
    carries the user JWT. Identity attribution headers always present.
    """

    def test_two_token_model_when_service_token_present(self, identity: IdentityContext) -> None:
        headers = build_identity_headers(identity, service_token="svc-token-abc")
        assert headers[HDR_AUTHORIZATION] == "Bearer svc-token-abc"
        assert headers[HDR_USER_TOKEN] == "raw-user-jwt-value"
        assert headers[HDR_USER_ID] == "alice"
        assert headers[HDR_PROJECT_ID] == "proj-123"
        assert headers[HDR_USER_EMAIL] == "alice@example.com"
        assert headers[HDR_USER_NAME] == "Alice Smith"
        assert headers[HDR_CORRELATION_ID] == "corr-xyz"

    def test_service_token_only_no_identity_bound(self) -> None:
        """Service-to-service trust still established without an inbound user."""
        headers = build_identity_headers(None, service_token="svc-token-abc")
        assert headers == {HDR_AUTHORIZATION: "Bearer svc-token-abc"}

    def test_x_user_token_omitted_when_user_jwt_absent(self) -> None:
        identity = IdentityContext(user_id="alice", project_id="p")
        headers = build_identity_headers(identity, service_token="svc-abc")
        assert HDR_USER_TOKEN not in headers
        assert headers[HDR_USER_ID] == "alice"

    def test_optional_identity_fields_omitted_when_empty(self) -> None:
        identity = IdentityContext(user_id="alice")  # only user_id set
        headers = build_identity_headers(identity, service_token="svc-abc")
        assert HDR_PROJECT_ID not in headers
        assert HDR_USER_EMAIL not in headers
        assert HDR_USER_NAME not in headers
        assert HDR_CORRELATION_ID not in headers
        assert headers[HDR_USER_ID] == "alice"

    def test_returns_string_only_values(self, identity: IdentityContext) -> None:
        headers = build_identity_headers(identity, service_token="svc-abc")
        for key, value in headers.items():
            assert isinstance(key, str), f"non-str header key: {key!r}"
            assert isinstance(value, str), f"non-str header value at {key}: {value!r}"

    def test_empty_dict_when_nothing_to_send(self) -> None:
        """No identity, no service token -> empty dict (safe to splat)."""
        assert build_identity_headers(None, service_token=None) == {}
        assert build_identity_headers(None, service_token="") == {}


# ---------------------------------------------------------------------------
# §I6 — Legacy compat: no service token -> user JWT routed to Authorization
# ---------------------------------------------------------------------------


class TestLegacyFallback:
    """§I6 -- When MCP_SERVICE_TOKEN is unset, the user JWT moves to the
    Authorization header so legacy MCP servers (mcp_pool.py:28-29 shape)
    keep working. X-User-Token is also emitted so the same server can
    migrate at its own pace.
    """

    def test_user_jwt_becomes_authorization_when_no_service_token(
        self, identity: IdentityContext
    ) -> None:
        headers = build_identity_headers(identity, service_token=None)
        assert headers[HDR_AUTHORIZATION] == "Bearer raw-user-jwt-value"
        # Migration aid: the same token also appears on X-User-Token.
        assert headers[HDR_USER_TOKEN] == "raw-user-jwt-value"

    def test_empty_service_token_treated_as_unset(self, identity: IdentityContext) -> None:
        headers = build_identity_headers(identity, service_token="")
        assert headers[HDR_AUTHORIZATION] == "Bearer raw-user-jwt-value"

    def test_no_authorization_when_no_token_anywhere(self) -> None:
        identity = IdentityContext(user_id="alice", project_id="p")
        headers = build_identity_headers(identity, service_token=None)
        assert HDR_AUTHORIZATION not in headers
        # Identity attribution still flows.
        assert headers[HDR_USER_ID] == "alice"

    def test_service_token_takes_precedence_when_both_available(
        self, identity: IdentityContext
    ) -> None:
        headers = build_identity_headers(identity, service_token="svc-abc")
        assert headers[HDR_AUTHORIZATION] == "Bearer svc-abc"
        assert "raw-user-jwt-value" not in headers[HDR_AUTHORIZATION]


# ---------------------------------------------------------------------------
# §I7 — stdio `_meta` propagates attribution but NEVER the user JWT
# ---------------------------------------------------------------------------


class TestBuildIdentityMeta:
    """§I7 -- MCP transport frames are loggable; _meta MUST NOT include
    the user JWT or any service token.
    """

    def test_meta_payload_shape(self, identity: IdentityContext) -> None:
        meta = build_identity_meta(identity)
        assert meta is not None
        assert "identity" in meta
        payload = meta["identity"]
        assert payload["userId"] == "alice"
        assert payload["projectId"] == "proj-123"
        assert payload["userEmail"] == "alice@example.com"
        assert payload["userName"] == "Alice Smith"
        assert payload["correlationId"] == "corr-xyz"

    def test_meta_never_includes_user_token(self, identity: IdentityContext) -> None:
        meta = build_identity_meta(identity)
        blob = json.dumps(meta)
        assert "raw-user-jwt-value" not in blob, f"user_token leaked into _meta JSON: {blob}"
        assert "userToken" not in blob
        assert "user_token" not in blob

    def test_meta_returns_none_when_no_identity(self) -> None:
        assert build_identity_meta(None) is None

    def test_meta_omits_empty_optional_fields(self) -> None:
        identity = IdentityContext(user_id="alice")
        meta = build_identity_meta(identity)
        assert meta is not None
        payload = meta["identity"]
        assert payload == {"userId": "alice"}, f"unexpected optional fields in meta: {payload!r}"

    def test_meta_uses_camelcase_on_the_wire(self, identity: IdentityContext) -> None:
        """MCP protocol convention is camelCase; downstream parsers depend on this."""
        meta = build_identity_meta(identity)
        assert meta is not None
        for key in meta["identity"]:
            assert "_" not in key, f"snake_case leaked into _meta: {key!r}"


# ---------------------------------------------------------------------------
# IdentityAwareHTTPTransport — per-call header injection
# ---------------------------------------------------------------------------


class TestIdentityAwareHTTPTransport:
    """Phase-1 wrapper used by direct-httpx integrations (KB-retrieval
    tool). Verifies the wrapper reads the bound ContextVar and threads
    the two-token headers into the inner transport's call_tool kwargs.
    """

    async def test_injects_headers_from_bound_identity(self, identity: IdentityContext) -> None:
        inner = AsyncMock()
        inner.call_tool.return_value = {"ok": True}
        transport = IdentityAwareHTTPTransport(inner=inner, mcp_service_token="svc-abc")

        tok = set_current_identity(identity)
        try:
            result = await transport.call_tool("search", {"q": "hello"})
        finally:
            reset_current_identity(tok)

        assert result == {"ok": True}
        inner.call_tool.assert_awaited_once()
        call_args = inner.call_tool.await_args
        assert call_args.args == ("search", {"q": "hello"})
        headers = call_args.kwargs["headers"]
        assert headers[HDR_AUTHORIZATION] == "Bearer svc-abc"
        assert headers[HDR_USER_TOKEN] == "raw-user-jwt-value"
        assert headers[HDR_USER_ID] == "alice"
        assert headers[HDR_PROJECT_ID] == "proj-123"

    async def test_does_not_overwrite_explicit_caller_headers(
        self, identity: IdentityContext
    ) -> None:
        """setdefault semantics -- caller-provided headers win."""
        inner = AsyncMock()
        transport = IdentityAwareHTTPTransport(inner=inner, mcp_service_token="svc-abc")

        tok = set_current_identity(identity)
        try:
            await transport.call_tool(
                "search",
                {"q": "x"},
                headers={HDR_AUTHORIZATION: "Bearer caller-override"},
            )
        finally:
            reset_current_identity(tok)

        headers = inner.call_tool.await_args.kwargs["headers"]
        assert headers[HDR_AUTHORIZATION] == "Bearer caller-override"
        # Identity attribution still added because it wasn't passed in.
        assert headers[HDR_USER_ID] == "alice"

    async def test_no_identity_bound_only_service_token_present(self) -> None:
        inner = AsyncMock()
        transport = IdentityAwareHTTPTransport(inner=inner, mcp_service_token="svc-abc")
        await transport.call_tool("search", {"q": "x"})

        headers = inner.call_tool.await_args.kwargs["headers"]
        assert headers == {HDR_AUTHORIZATION: "Bearer svc-abc"}

    async def test_no_identity_and_no_service_token_no_auth_headers(self) -> None:
        inner = AsyncMock()
        transport = IdentityAwareHTTPTransport(inner=inner, mcp_service_token=None)
        await transport.call_tool("search", {"q": "x"})

        headers = inner.call_tool.await_args.kwargs["headers"]
        assert headers == {}

    async def test_forwards_arbitrary_extra_kwargs(self, identity: IdentityContext) -> None:
        inner = AsyncMock()
        transport = IdentityAwareHTTPTransport(inner=inner, mcp_service_token="svc-abc")
        tok = set_current_identity(identity)
        try:
            await transport.call_tool("search", {"q": "x"}, timeout=10.0)
        finally:
            reset_current_identity(tok)

        assert inner.call_tool.await_args.kwargs["timeout"] == 10.0
