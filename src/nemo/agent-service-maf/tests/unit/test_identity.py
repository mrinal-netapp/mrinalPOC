"""Unit tests for the §3 / §A1 identity carrier and ContextVar wiring.

Covers tests I1-I3 + I10-I12 of the identity-propagation plan that are
exercisable without a running FastAPI app:

* I1  validate_project_access rules (in test_routes_identity.py — needs app)
* I2  IdentityContext.user_token never on the wire (here)
* I3  Concurrent invokes see isolated identities (here)
* I10 Missing X-User-ID -> 401 from middleware (here)
* I11 Secret-redactor masks user_token + service tokens (here)
* I12 Inbound Authorization stripped after middleware (here)

The higher-numbered route / MCP / Bifrost / KB / async-task tests live
in their own files (test_routes_identity.py, test_mcp_identity_transport.py,
test_kb_identity.py, test_bifrost_identity.py).
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import MagicMock

import pytest
from fastapi import HTTPException, Request

from agent_service_maf.core.identity import (
    IdentityContext,
    get_current_identity,
    reset_current_identity,
    set_current_identity,
)
from agent_service_maf.gateway.secret_redactor import SecretRedactor
from agent_service_maf.interface_layer.auth import (
    GatewayIdentityAuthMiddleware,
    build_auth_middleware,
)


def _mock_request(
    headers: dict[str, str] | None = None, path: str = "/api/v1/projects/p/x"
) -> MagicMock:
    request = MagicMock(spec=Request)
    request.headers = headers or {}
    request.url = MagicMock()
    request.url.path = path
    request.state = MagicMock()
    return request


# ---------------------------------------------------------------------------
# I2 — IdentityContext.user_token never serializes
# ---------------------------------------------------------------------------


class TestUserTokenNeverSerialized:
    """§I2 — IdentityContext.user_token must never appear in any serialized output."""

    def test_model_dump_excludes_user_token(self) -> None:
        identity = IdentityContext(
            user_id="alice",
            project_id="p1",
            user_token="super-secret-jwt-token-value",
        )
        dump = identity.model_dump()
        assert "user_token" not in dump, "user_token leaked into model_dump()"
        assert "super-secret-jwt-token-value" not in json.dumps(dump), (
            "user_token value leaked through model_dump()"
        )

    def test_model_dump_by_alias_excludes_user_token(self) -> None:
        identity = IdentityContext(
            user_id="alice",
            project_id="p1",
            user_token="super-secret-jwt-token-value",
        )
        dump = identity.model_dump(by_alias=True)
        assert "userToken" not in dump, "userToken (camelCase) leaked into model_dump()"
        assert "user_token" not in dump

    def test_model_dump_json_excludes_user_token(self) -> None:
        identity = IdentityContext(
            user_id="alice",
            project_id="p1",
            user_token="super-secret-jwt-token-value",
        )
        blob = identity.model_dump_json()
        assert "super-secret-jwt-token-value" not in blob, (
            "user_token value leaked through model_dump_json()"
        )
        assert "user_token" not in blob
        assert "userToken" not in blob

    def test_user_token_accessible_via_typed_attribute(self) -> None:
        """The only legal read path -- typed Python attribute -- still works."""
        identity = IdentityContext(
            user_id="alice",
            user_token="super-secret-jwt-token-value",
        )
        assert identity.user_token == "super-secret-jwt-token-value"


# ---------------------------------------------------------------------------
# I3 — Concurrent invokes see isolated identities (ContextVar guarantee)
# ---------------------------------------------------------------------------


class TestConcurrentIdentityIsolation:
    """§I3 — two concurrent invokes on the same process see distinct identities."""

    async def test_two_concurrent_tasks_see_distinct_identity(self) -> None:
        """Each asyncio.Task has its own ContextVar copy. With per-task bind, no leakage."""
        identity_alice = IdentityContext(user_id="alice", project_id="p1")
        identity_bob = IdentityContext(user_id="bob", project_id="p2")

        async def worker(identity: IdentityContext, seen: list[str]) -> None:
            tok = set_current_identity(identity)
            try:
                # Yield to let the peer task run before we read back.
                await asyncio.sleep(0)
                current = get_current_identity()
                assert current is not None
                seen.append(current.user_id)
                # Yield once more so the peer also observes its own bind.
                await asyncio.sleep(0)
                current = get_current_identity()
                assert current is not None
                seen.append(current.user_id)
            finally:
                reset_current_identity(tok)

        seen_alice: list[str] = []
        seen_bob: list[str] = []

        await asyncio.gather(
            worker(identity_alice, seen_alice),
            worker(identity_bob, seen_bob),
        )

        assert seen_alice == ["alice", "alice"], f"Alice's task saw foreign identity: {seen_alice}"
        assert seen_bob == ["bob", "bob"], f"Bob's task saw foreign identity: {seen_bob}"

    def test_unbind_restores_prior_identity(self) -> None:
        """reset_current_identity returns to the previously bound value."""
        outer = IdentityContext(user_id="outer")
        inner = IdentityContext(user_id="inner")

        outer_tok = set_current_identity(outer)
        try:
            assert get_current_identity() == outer
            inner_tok = set_current_identity(inner)
            try:
                assert get_current_identity() == inner
            finally:
                reset_current_identity(inner_tok)
            assert get_current_identity() == outer
        finally:
            reset_current_identity(outer_tok)

        # After full unbind, nothing remains bound.
        assert get_current_identity() is None


# ---------------------------------------------------------------------------
# I10 — Missing X-User-ID -> 401 from the gateway middleware
# ---------------------------------------------------------------------------


class TestGatewayIdentityMiddleware:
    """§I10 + §I12 — middleware behaviour at the edge."""

    async def test_missing_user_id_header_raises_401(self) -> None:
        mw = GatewayIdentityAuthMiddleware()
        request = _mock_request(headers={})  # no X-User-ID
        with pytest.raises(HTTPException) as exc_info:
            await mw.authenticate(request)
        assert exc_info.value.status_code == 401
        detail = str(exc_info.value.detail).lower()
        assert "x-user-id" in detail

    async def test_empty_user_id_header_raises_401(self) -> None:
        mw = GatewayIdentityAuthMiddleware()
        request = _mock_request(headers={"x-user-id": "   "})
        with pytest.raises(HTTPException) as exc_info:
            await mw.authenticate(request)
        assert exc_info.value.status_code == 401

    async def test_minimal_user_id_only_succeeds(self) -> None:
        mw = GatewayIdentityAuthMiddleware()
        request = _mock_request(headers={"x-user-id": "alice"})
        claims = await mw.authenticate(request)
        assert claims["authenticated"] is True
        assert claims["scheme"] == "gateway_identity"
        assert claims["sub"] == "alice"
        identity = claims["_identity"]
        assert isinstance(identity, IdentityContext)
        assert identity.user_id == "alice"
        assert identity.project_id == ""
        assert identity.user_token is None

    async def test_full_identity_envelope(self) -> None:
        mw = GatewayIdentityAuthMiddleware()
        request = _mock_request(
            headers={
                "x-user-id": "alice",
                "x-project-id": "proj-123",
                "x-user-email": "alice@example.com",
                "x-user-name": "Alice Smith",
                "x-user-token": "user-jwt-here",
                "x-correlation-id": "corr-abc",
            }
        )
        claims = await mw.authenticate(request)
        identity: IdentityContext = claims["_identity"]
        assert identity.user_id == "alice"
        assert identity.project_id == "proj-123"
        assert identity.user_email == "alice@example.com"
        assert identity.user_name == "Alice Smith"
        assert identity.user_token == "user-jwt-here"
        assert identity.correlation_id == "corr-abc"

    async def test_user_jwt_extracted_from_authorization_bearer(self) -> None:
        """§B1 — when X-User-Token is absent, Authorization: Bearer <jwt> is used."""
        mw = GatewayIdentityAuthMiddleware()
        request = _mock_request(
            headers={
                "x-user-id": "alice",
                "authorization": "Bearer my-user-jwt",
            }
        )
        claims = await mw.authenticate(request)
        identity: IdentityContext = claims["_identity"]
        assert identity.user_token == "my-user-jwt"

    async def test_explicit_x_user_token_wins_over_authorization(self) -> None:
        mw = GatewayIdentityAuthMiddleware()
        request = _mock_request(
            headers={
                "x-user-id": "alice",
                "x-user-token": "explicit",
                "authorization": "Bearer fallback",
            }
        )
        claims = await mw.authenticate(request)
        identity: IdentityContext = claims["_identity"]
        assert identity.user_token == "explicit"

    async def test_authorization_not_present_in_claims_dict(self) -> None:
        """§I12 — once the middleware runs, raw Authorization is gone from claims."""
        mw = GatewayIdentityAuthMiddleware()
        request = _mock_request(
            headers={
                "x-user-id": "alice",
                "authorization": "Bearer my-user-jwt",
            }
        )
        claims = await mw.authenticate(request)
        # Nothing in the claims dict carries the raw token.
        for key, value in claims.items():
            if key == "_identity":
                continue
            assert "my-user-jwt" not in str(value), f"Authorization leaked into claims[{key!r}]"
        # Only the typed accessor exposes it.
        assert claims["_identity"].user_token == "my-user-jwt"

    async def test_authorization_non_bearer_scheme_ignored(self) -> None:
        mw = GatewayIdentityAuthMiddleware()
        request = _mock_request(
            headers={
                "x-user-id": "alice",
                "authorization": "Basic some-base64",
            }
        )
        claims = await mw.authenticate(request)
        identity: IdentityContext = claims["_identity"]
        # Basic auth headers don't become user_token.
        assert identity.user_token is None

    def test_build_auth_middleware_gateway_identity(self) -> None:
        """§B2 — factory wires the gateway_identity scheme."""
        mw = build_auth_middleware(enabled=True, scheme="gateway_identity")
        assert isinstance(mw, GatewayIdentityAuthMiddleware)

    def test_build_auth_middleware_unknown_scheme_raises(self) -> None:
        with pytest.raises(ValueError) as exc_info:
            build_auth_middleware(enabled=True, scheme="oauth2", api_keys=["x"])
        assert "Supported schemes" in str(exc_info.value)


# ---------------------------------------------------------------------------
# I11 — Secret redaction covers user_token + service tokens
# ---------------------------------------------------------------------------


class TestSecretRedactionIdentityFields:
    """§I11 — explicit fields for the two-token model are wholesale-redacted."""

    @pytest.fixture
    def redactor(self) -> SecretRedactor:
        return SecretRedactor()

    def test_user_token_field_value_redacted(self, redactor: SecretRedactor) -> None:
        event = {"event": "test", "user_token": "raw-user-jwt-value"}
        out = redactor(None, "info", event)
        assert out["user_token"] == "[REDACTED]"
        assert "raw-user-jwt-value" not in json.dumps(out)

    def test_x_user_token_header_field_redacted(self, redactor: SecretRedactor) -> None:
        event = {"event": "test", "x-user-token": "raw-user-jwt-value"}
        out = redactor(None, "info", event)
        assert out["x-user-token"] == "[REDACTED]"

    def test_mcp_service_token_field_redacted(self, redactor: SecretRedactor) -> None:
        event = {"event": "test", "mcp_service_token": "svc-secret"}
        out = redactor(None, "info", event)
        assert out["mcp_service_token"] == "[REDACTED]"

    def test_kb_service_token_field_redacted(self, redactor: SecretRedactor) -> None:
        event = {"event": "test", "kb_service_token": "svc-kb-secret"}
        out = redactor(None, "info", event)
        assert out["kb_service_token"] == "[REDACTED]"

    def test_nested_user_token_in_headers_dict_redacted(self, redactor: SecretRedactor) -> None:
        event = {
            "event": "outbound_call",
            "headers": {
                "X-User-Token": "raw-user-jwt-value",
                "Authorization": "Bearer sk-ant-very-long-anthropic-key-1234567890",
            },
        }
        out = redactor(None, "info", event)
        # X-User-Token via wholesale field redaction.
        assert out["headers"]["X-User-Token"] == "[REDACTED]"
        # Authorization still goes through the regex pattern (masked, not full secret).
        auth_val = out["headers"]["Authorization"]
        assert "very-long-anthropic-key-1234567890" not in auth_val, (
            f"Authorization secret leaked: {auth_val}"
        )
        assert auth_val.startswith("Bearer ") or auth_val == "[REDACTED]"
        assert "***" in auth_val or auth_val == "[REDACTED]"

    def test_case_insensitive_field_match(self, redactor: SecretRedactor) -> None:
        for key in ("USER_TOKEN", "User_Token", "X-User-TOKEN"):
            event = {"event": "t", key: "leak"}
            out = redactor(None, "info", event)
            assert out[key] == "[REDACTED]", f"key {key!r} not redacted"

    def test_user_id_and_project_id_not_treated_as_secrets(self, redactor: SecretRedactor) -> None:
        """user_id / project_id are audit breadcrumbs, NOT secrets."""
        event = {"event": "test", "user_id": "alice", "project_id": "p1"}
        out = redactor(None, "info", event)
        assert out["user_id"] == "alice"
        assert out["project_id"] == "p1"


# ---------------------------------------------------------------------------
# Identity context — frozen guarantee
# ---------------------------------------------------------------------------


class TestIdentityContextFrozen:
    def test_cannot_mutate_in_place(self) -> None:
        identity = IdentityContext(user_id="alice")
        # Pydantic v2 frozen -> ValidationError on assignment.
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            identity.user_id = "bob"  # type: ignore[misc]

    def test_model_copy_returns_new_instance(self) -> None:
        identity = IdentityContext(user_id="alice", project_id="")
        updated = identity.model_copy(update={"project_id": "p1"})
        assert updated.user_id == "alice"
        assert updated.project_id == "p1"
        # Original is untouched.
        assert identity.project_id == ""
        assert updated is not identity
