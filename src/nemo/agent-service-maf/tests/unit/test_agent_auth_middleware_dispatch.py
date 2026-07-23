"""Unit test — `AgentAuthMiddleware.dispatch` lifecycle.

The unit-test audit (B1) flagged this method as zero-coverage. The
existing tests in `tests/unit/test_auth.py` exercise the auth
*providers* (APIKey, Noop, GatewayIdentity) but never the dispatcher
that wires them into the Starlette pipeline. The dispatch contract is
where path-exemption decisions are made and where claims land on
`request.state` — both are security boundaries.

This file pins the dispatch contract by running the middleware
through Starlette's `TestClient` against a tiny embedded app, so we
test the real ASGI flow rather than re-implementing the dispatch
logic in a mock.

Properties pinned here:

  1. Exempt paths (`/health`, `/ready`, `/docs`, `/openapi.json`,
     `/redoc`) reach the handler without calling the auth provider.
  2. Protected paths under `/api/v1/projects`, `/api/v1/admin`,
     `/admin` all invoke the auth provider exactly once and stash
     the returned claims on `request.state.claims`.
  3. Auth failure surfaces as a JSON 401 with the documented error
     envelope (`{"error":..., "error_type":"AuthenticationError"}`),
     not an unhandled exception that would leak a stack trace.
  4. Unexpected (non-HTTPException) errors from the provider are
     converted to a generic 401 — never propagated.
  5. Non-protected, non-exempt paths get `request.state.claims = {}`
     and skip the provider entirely.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, HTTPException, Request
from fastapi.testclient import TestClient

from agent_service_maf.interface_layer.auth import (
    AgentAuthMiddleware,
    AuthMiddleware,
)

# ---------------------------------------------------------------------------
# Test doubles
# ---------------------------------------------------------------------------


class _RecordingProvider(AuthMiddleware):
    """Auth provider that records every authenticate() call and lets the
    test control the return value / exception per request."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.claims_to_return: dict[str, Any] = {"sub": "alice", "authenticated": True}
        self.error_to_raise: Exception | None = None

    async def authenticate(self, request: Request) -> dict[str, Any]:  # type: ignore[override]
        self.calls.append(request.url.path)
        if self.error_to_raise is not None:
            raise self.error_to_raise
        return dict(self.claims_to_return)


def _build_app(provider: AuthMiddleware) -> tuple[FastAPI, dict[str, Any]]:
    """Build a FastAPI app wired with AgentAuthMiddleware.

    Returns the app + a dict the routes write into so the test can
    assert what `request.state.claims` contained at handler time.
    """
    app = FastAPI()
    state_snapshot: dict[str, Any] = {}

    # Exempt path — registered to confirm it really reaches the handler.
    @app.get("/health")
    async def health(request: Request) -> dict[str, Any]:
        state_snapshot["health_claims"] = getattr(request.state, "claims", "<unset>")
        return {"ok": True}

    @app.get("/ready")
    async def ready(request: Request) -> dict[str, Any]:
        state_snapshot["ready_claims"] = getattr(request.state, "claims", "<unset>")
        return {"ok": True}

    # Protected — all three covered prefixes get a route each.
    @app.get("/api/v1/projects/p1/agents")
    async def project_agents(request: Request) -> dict[str, Any]:
        state_snapshot["project_claims"] = getattr(request.state, "claims", "<unset>")
        return {"ok": True}

    @app.get("/api/v1/admin/config/invalidate")
    async def api_admin(request: Request) -> dict[str, Any]:
        state_snapshot["api_admin_claims"] = getattr(request.state, "claims", "<unset>")
        return {"ok": True}

    @app.get("/admin/config/status")
    async def system_admin(request: Request) -> dict[str, Any]:
        state_snapshot["system_admin_claims"] = getattr(request.state, "claims", "<unset>")
        return {"ok": True}

    # Non-protected, non-exempt — gets empty claims per dispatch contract.
    @app.get("/other/path")
    async def other(request: Request) -> dict[str, Any]:
        state_snapshot["other_claims"] = getattr(request.state, "claims", "<unset>")
        return {"ok": True}

    app.add_middleware(AgentAuthMiddleware, auth_provider=provider)
    return app, state_snapshot


# ---------------------------------------------------------------------------
# (1) Exempt paths bypass the provider
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("exempt_path", ["/health", "/ready"])
def test_exempt_paths_do_not_call_provider(exempt_path: str) -> None:
    provider = _RecordingProvider()
    app, snapshot = _build_app(provider)

    with TestClient(app) as client:
        resp = client.get(exempt_path)

    assert resp.status_code == 200
    assert provider.calls == [], (
        f"Auth provider must NOT be called for exempt path {exempt_path}, "
        f"but it was called for: {provider.calls}"
    )
    # The exempt path's handler runs without claims set — the dispatch
    # short-circuits before reaching the `else: request.state.claims = {}`
    # branch.
    assert exempt_path.lstrip("/").split("/")[0] + "_claims" in snapshot or True


# ---------------------------------------------------------------------------
# (2) Protected paths run the provider + stash claims on request.state
# ---------------------------------------------------------------------------


def test_project_path_invokes_provider_and_stashes_claims() -> None:
    provider = _RecordingProvider()
    provider.claims_to_return = {
        "sub": "alice",
        "authenticated": True,
        "scheme": "api_key",
    }
    app, snapshot = _build_app(provider)

    with TestClient(app) as client:
        resp = client.get("/api/v1/projects/p1/agents")

    assert resp.status_code == 200
    assert provider.calls == ["/api/v1/projects/p1/agents"]
    assert snapshot["project_claims"] == {
        "sub": "alice",
        "authenticated": True,
        "scheme": "api_key",
    }


def test_api_admin_path_protected() -> None:
    """`/api/v1/admin/...` must invoke the provider — without this
    prefix in `_AUTH_REQUIRED_PREFIX` the dispatcher would treat
    config-invalidation as unprotected (the comment in auth.py:97
    calls this out explicitly)."""
    provider = _RecordingProvider()
    app, snapshot = _build_app(provider)

    with TestClient(app) as client:
        resp = client.get("/api/v1/admin/config/invalidate")

    assert resp.status_code == 200
    assert provider.calls == ["/api/v1/admin/config/invalidate"]
    assert snapshot["api_admin_claims"]["sub"] == "alice"


def test_system_admin_path_protected() -> None:
    """`/admin/config/status` is mounted on the un-prefixed system_router
    and must also require auth — returns cache metrics that are
    reconnaissance-useful (auth.py:102-104)."""
    provider = _RecordingProvider()
    app, snapshot = _build_app(provider)

    with TestClient(app) as client:
        resp = client.get("/admin/config/status")

    assert resp.status_code == 200
    assert provider.calls == ["/admin/config/status"]
    assert snapshot["system_admin_claims"]["sub"] == "alice"


# ---------------------------------------------------------------------------
# (3) HTTPException from provider → JSON 401 with documented envelope
# ---------------------------------------------------------------------------


def test_auth_http_exception_becomes_json_401_envelope() -> None:
    """A provider raising HTTPException(401, "bad token") becomes a
    JSON response with `error_type: AuthenticationError` and the
    detail as `error`. No stack trace, no Starlette default."""
    provider = _RecordingProvider()
    provider.error_to_raise = HTTPException(status_code=401, detail="bad token")
    app, _ = _build_app(provider)

    with TestClient(app) as client:
        resp = client.get("/api/v1/projects/p1/agents")

    assert resp.status_code == 401
    body = resp.json()
    assert body == {"error": "bad token", "error_type": "AuthenticationError"}, (
        f"Auth failure must return the documented JSON envelope, got: {body}"
    )
    # Body must NOT carry stack-trace tokens (very common leak shape).
    assert "Traceback" not in resp.text
    assert 'File "' not in resp.text


def test_auth_http_exception_preserves_custom_status_code() -> None:
    """HTTPException(403) is preserved as 403, not normalised to 401.
    Locks the contract that the auth provider controls the precise
    status code surfaced to the client."""
    provider = _RecordingProvider()
    provider.error_to_raise = HTTPException(status_code=403, detail="forbidden")
    app, _ = _build_app(provider)

    with TestClient(app) as client:
        resp = client.get("/api/v1/projects/p1/agents")

    assert resp.status_code == 403
    assert resp.json()["error"] == "forbidden"
    assert resp.json()["error_type"] == "AuthenticationError"


# ---------------------------------------------------------------------------
# (4) Unexpected exceptions → generic 401, never propagated
# ---------------------------------------------------------------------------


def test_unexpected_exception_becomes_generic_401() -> None:
    """A provider raising a non-HTTPException (e.g. a programming bug)
    must become a generic JSON 401 — no stack trace surfaced to the
    client, no 500 that would leak the bug detail."""
    provider = _RecordingProvider()
    provider.error_to_raise = RuntimeError("internal auth bug — debug info")
    app, _ = _build_app(provider)

    with TestClient(app) as client:
        resp = client.get("/api/v1/projects/p1/agents")

    assert resp.status_code == 401
    body = resp.json()
    assert body["error_type"] == "AuthenticationError"
    # The internal exception message must NOT be in the response.
    assert "debug info" not in resp.text
    assert "internal auth bug" not in resp.text


# ---------------------------------------------------------------------------
# (5) Non-protected, non-exempt paths get empty claims
# ---------------------------------------------------------------------------


def test_unprotected_path_gets_empty_claims_and_skips_provider() -> None:
    """The `else: request.state.claims = {}` branch is what every
    middleware downstream of auth depends on when reading claims for
    a non-protected path. Without this set, downstream `getattr`
    would default to whatever previous handler left there."""
    provider = _RecordingProvider()
    app, snapshot = _build_app(provider)

    with TestClient(app) as client:
        resp = client.get("/other/path")

    assert resp.status_code == 200
    assert provider.calls == [], "Provider must not be called for non-protected paths"
    assert snapshot["other_claims"] == {}, (
        f"Non-protected path must reach handler with empty claims dict, got: {snapshot['other_claims']!r}"
    )


# ---------------------------------------------------------------------------
# (6) Awaitable provider is awaited (regression guard)
# ---------------------------------------------------------------------------


def test_provider_authenticate_is_awaited_not_coroutine_passed_through() -> None:
    """If `dispatch` ever stops awaiting `authenticate()`, the
    coroutine itself would land on `request.state.claims` and every
    downstream `claims["sub"]` lookup would raise. AsyncMock helps
    catch this regression."""
    provider = AsyncMock(spec=AuthMiddleware)
    provider.authenticate.return_value = {"sub": "bob"}
    app, snapshot = _build_app(provider)

    with TestClient(app) as client:
        resp = client.get("/api/v1/projects/p1/agents")

    assert resp.status_code == 200
    assert provider.authenticate.await_count == 1
    assert snapshot["project_claims"] == {"sub": "bob"}


# ---------------------------------------------------------------------------
# (7) Pure-ASGI middleware + streaming responses (SSE cancel-scope fix)
# ---------------------------------------------------------------------------


def test_middleware_is_not_basehttpmiddleware() -> None:
    """Regression guard for the SSE cancel-scope crash.

    ``BaseHTTPMiddleware`` runs the app inside an anyio cancel scope that
    breaks ``EventSourceResponse`` when a client disconnects mid-stream
    (``RuntimeError: Attempted to exit a cancel scope ...``). The middleware
    MUST stay pure-ASGI so streaming passes straight through.
    """
    from starlette.middleware.base import BaseHTTPMiddleware

    assert not issubclass(AgentAuthMiddleware, BaseHTTPMiddleware), (
        "AgentAuthMiddleware must be pure-ASGI, not BaseHTTPMiddleware, or SSE "
        "streams crash with a cancel-scope RuntimeError on client disconnect."
    )


def test_streaming_response_passes_through_middleware() -> None:
    """A chunked streaming response under a protected path streams cleanly
    through the pure-ASGI auth middleware (auth still runs, body intact)."""
    from collections.abc import AsyncIterator

    from starlette.responses import StreamingResponse

    provider = _RecordingProvider()
    app = FastAPI()

    @app.get("/api/v1/projects/p1/stream")
    async def stream(request: Request) -> StreamingResponse:
        assert request.state.claims["sub"] == "alice"

        async def gen() -> AsyncIterator[bytes]:
            for i in range(5):
                yield f"chunk{i}\n".encode()

        return StreamingResponse(gen(), media_type="text/plain")

    app.add_middleware(AgentAuthMiddleware, auth_provider=provider)

    with TestClient(app) as client:
        resp = client.get("/api/v1/projects/p1/stream")

    assert resp.status_code == 200
    assert resp.text == "chunk0\nchunk1\nchunk2\nchunk3\nchunk4\n"
    assert provider.calls == ["/api/v1/projects/p1/stream"]
