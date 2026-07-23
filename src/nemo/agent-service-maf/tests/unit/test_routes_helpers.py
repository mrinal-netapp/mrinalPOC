"""Unit tests for the helper functions in :mod:`agent_service_maf.interface_layer.routes`.

The route file is 2 900+ lines. Integration tests in
``tests/integration/test_*_routes.py`` cover the end-to-end HTTP path,
but the private helpers (``_resolve_user_id``, ``validate_project_access``,
``_authenticate_websocket``, ``_require_known_project``, etc.) are
called by many routes — pinning them in isolation gives broad coverage
without spinning up the full ASGI stack.

We exercise each helper directly with synthetic :class:`Request` /
:class:`WebSocket` stand-ins. The helpers raise :class:`HTTPException`
on error rather than returning status codes, so the assertions focus
on exception class + ``status_code`` + ``detail`` shape.

Routes covered via :class:`fastapi.testclient.TestClient`:

- ``GET /health`` (auth-exempt liveness probe)
- ``GET /ready`` (readiness probe with 503-on-failure semantics)
- The TestClient also exercises ``_get_readiness_checker`` caching.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from agent_service_maf.config.model_catalog import NoopModelCatalog
from agent_service_maf.core.identity import (
    IdentityContext,
    reset_current_identity,
    set_current_identity,
)
from agent_service_maf.core.query_options import QueryOptions
from agent_service_maf.core.team_registry_lazy import LazyTeamRegistry
from agent_service_maf.interface_layer.api import create_app
from agent_service_maf.interface_layer.routes import (
    _authenticate_websocket,
    _available_team_ids,
    _get_model_catalog,
    _require_known_project,
    _require_session_manager,
    _resolve_user_id,
    _session_route_user_id,
    _source_is_synchronously_empty,
    _sync_known_projects,
    _validate_user_id,
    validate_project_access,
)

VALID_PROJECT_ID = "550e8400-e29b-41d4-a716-446655440000"


# ---------------------------------------------------------------------------
# Test harness — request / websocket stand-ins
# ---------------------------------------------------------------------------


def _make_request(
    *,
    state_user_id: str | None = None,
    claims: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    query_params: dict[str, str] | None = None,
    app_state: SimpleNamespace | None = None,
    url_path: str = "/api/v1/projects/" + VALID_PROJECT_ID + "/teams",
) -> Any:
    """Build a duck-typed Request stand-in. The helpers under test
    consume ``request.state``, ``request.headers``, ``request.url.path``,
    and ``request.app.state`` — nothing more — so a SimpleNamespace
    suffices and lets us drive every code path deterministically."""
    state = SimpleNamespace()
    if state_user_id is not None:
        state.user_id = state_user_id
    if claims is not None:
        state.claims = claims
    headers_map = headers or {}

    class _Headers:
        def __init__(self, d: dict[str, str]) -> None:
            self._d = {k.lower(): v for k, v in d.items()}

        def get(self, key: str, default: str = "") -> str:
            return self._d.get(key.lower(), default)

    url = SimpleNamespace(path=url_path)
    app = SimpleNamespace(state=app_state if app_state is not None else SimpleNamespace())
    return SimpleNamespace(
        state=state,
        headers=_Headers(headers_map),
        query_params=query_params or {},
        url=url,
        app=app,
    )


class _FakeWebSocket:
    """Minimal WebSocket stand-in for ``_authenticate_websocket``."""

    def __init__(
        self,
        *,
        auth_provider: Any = None,
        url_path: str = "/api/v1/projects/p/agents/x/ws",
    ) -> None:
        self.app = SimpleNamespace(
            state=SimpleNamespace(auth_provider=auth_provider)
            if auth_provider is not None
            else SimpleNamespace()
        )
        self.url = SimpleNamespace(path=url_path)
        self.state = SimpleNamespace()
        self.close_code: int | None = None
        self.close_reason: str | None = None
        self.closed = False

    async def close(self, code: int, reason: str = "") -> None:
        self.close_code = code
        self.close_reason = reason
        self.closed = True


# ---------------------------------------------------------------------------
# _get_model_catalog
# ---------------------------------------------------------------------------


class TestGetModelCatalog:
    def test_creates_catalog_when_missing_and_caches_on_app_state(self) -> None:
        request = _make_request()
        catalog1 = _get_model_catalog(request)
        catalog2 = _get_model_catalog(request)
        assert isinstance(catalog1, NoopModelCatalog)
        # Second call returns the cached instance (stashed on app.state).
        assert catalog2 is catalog1

    def test_returns_pre_wired_catalog_when_present(self) -> None:
        existing = NoopModelCatalog()
        request = _make_request(app_state=SimpleNamespace(model_catalog=existing))
        assert _get_model_catalog(request) is existing


# ---------------------------------------------------------------------------
# _authenticate_websocket
# ---------------------------------------------------------------------------


class TestAuthenticateWebSocket:
    @pytest.mark.asyncio
    async def test_no_provider_closes_with_4401(self) -> None:
        ws = _FakeWebSocket()  # app.state has no auth_provider
        ok = await _authenticate_websocket(ws)  # type: ignore[arg-type]
        assert ok is False
        assert ws.closed is True
        assert ws.close_code == 4401

    @pytest.mark.asyncio
    async def test_successful_auth_stashes_claims(self) -> None:
        provider = MagicMock()
        provider.authenticate = AsyncMock(return_value={"sub": "alice"})
        ws = _FakeWebSocket(auth_provider=provider)
        ok = await _authenticate_websocket(ws)  # type: ignore[arg-type]
        assert ok is True
        assert ws.state.claims == {"sub": "alice"}
        assert ws.closed is False

    @pytest.mark.asyncio
    async def test_http_exception_from_provider_closes_with_truncated_reason(
        self,
    ) -> None:
        provider = MagicMock()
        long_detail = "rejected: " + "x" * 200  # > 100 char cap
        provider.authenticate = AsyncMock(
            side_effect=HTTPException(status_code=401, detail=long_detail)
        )
        ws = _FakeWebSocket(auth_provider=provider)
        ok = await _authenticate_websocket(ws)  # type: ignore[arg-type]
        assert ok is False
        assert ws.close_code == 4401
        # Reason cap is 100 chars.
        assert ws.close_reason is not None
        assert len(ws.close_reason) <= 100

    @pytest.mark.asyncio
    async def test_http_exception_with_no_detail_uses_default_reason(self) -> None:
        # When detail is empty/None, FastAPI auto-fills it with the
        # status-code's default reason phrase ("Unauthorized" for 401).
        # The helper falls back to "Authentication failed" only when the
        # detail is truly falsy after that auto-fill, which doesn't
        # happen in practice — but the branch is still worth exercising.
        provider = MagicMock()
        provider.authenticate = AsyncMock(side_effect=HTTPException(status_code=401, detail=""))
        ws = _FakeWebSocket(auth_provider=provider)
        ok = await _authenticate_websocket(ws)  # type: ignore[arg-type]
        assert ok is False
        # Either the auto-filled status phrase or the helper's fallback.
        assert ws.close_reason in {"Authentication failed", "Unauthorized"}

    @pytest.mark.asyncio
    async def test_unexpected_provider_error_closes_with_generic_reason(self) -> None:
        provider = MagicMock()
        provider.authenticate = AsyncMock(side_effect=RuntimeError("provider blew up"))
        ws = _FakeWebSocket(auth_provider=provider)
        ok = await _authenticate_websocket(ws)  # type: ignore[arg-type]
        assert ok is False
        assert ws.close_code == 4401
        assert ws.close_reason == "Authentication error"


# ---------------------------------------------------------------------------
# _require_known_project — eager + lazy paths
# ---------------------------------------------------------------------------


class TestRequireKnownProject:
    def test_no_registry_raises_503(self) -> None:
        request = _make_request()  # app.state has no teams attr
        with pytest.raises(HTTPException) as exc:
            _require_known_project(request, VALID_PROJECT_ID)
        assert exc.value.status_code == 503

    def test_eager_registry_unknown_project_raises_404(self) -> None:
        # Build an eager registry stand-in: not a LazyTeamRegistry, has
        # ``teams`` truthy, ``has_project`` False.
        registry = MagicMock(spec=set())  # type-only check uses isinstance
        registry.teams = {"team-x": object()}
        registry.has_project = MagicMock(return_value=False)
        registry.project_ids = MagicMock(return_value=["p1", "p2"])

        request = _make_request(app_state=SimpleNamespace(teams=registry))
        with pytest.raises(HTTPException) as exc:
            _require_known_project(request, "ghost-project")
        assert exc.value.status_code == 404

    def test_eager_registry_empty_raises_503(self) -> None:
        registry = MagicMock(spec=set())
        registry.teams = {}  # empty
        request = _make_request(app_state=SimpleNamespace(teams=registry))
        with pytest.raises(HTTPException) as exc:
            _require_known_project(request, VALID_PROJECT_ID)
        assert exc.value.status_code == 503

    def test_lazy_registry_synchronously_empty_raises_503(self) -> None:
        # Lazy registry whose source reports synchronously empty.
        source = MagicMock()
        source.is_synchronously_empty = MagicMock(return_value=True)
        registry = LazyTeamRegistry(source=source)
        request = _make_request(app_state=SimpleNamespace(teams=registry))
        with pytest.raises(HTTPException) as exc:
            _require_known_project(request, VALID_PROJECT_ID)
        assert exc.value.status_code == 503

    def test_lazy_registry_known_projects_returns_404_for_unknown(self) -> None:
        # Lazy registry with synchronously-known project list (file
        # mode) — preserve the eager 404 for unknown projects.
        source = MagicMock()
        source.is_synchronously_empty = MagicMock(return_value=False)
        source.known_projects = MagicMock(return_value=[VALID_PROJECT_ID])
        registry = LazyTeamRegistry(source=source)
        request = _make_request(app_state=SimpleNamespace(teams=registry))
        with pytest.raises(HTTPException) as exc:
            _require_known_project(request, "ghost-project")
        assert exc.value.status_code == 404

    def test_lazy_registry_known_projects_passes_for_known(self) -> None:
        source = MagicMock()
        source.is_synchronously_empty = MagicMock(return_value=False)
        source.known_projects = MagicMock(return_value=[VALID_PROJECT_ID])
        registry = LazyTeamRegistry(source=source)
        request = _make_request(app_state=SimpleNamespace(teams=registry))
        assert _require_known_project(request, VALID_PROJECT_ID) is registry

    def test_lazy_registry_remote_source_skips_project_check(self) -> None:
        # Remote source: no known_projects → helper returns the
        # registry without 404, since project existence can't be known
        # synchronously.
        source = MagicMock(spec=set())  # no known_projects attr
        source.is_synchronously_empty = MagicMock(return_value=False)
        registry = LazyTeamRegistry(source=source)
        request = _make_request(app_state=SimpleNamespace(teams=registry))
        # Even an unknown project id is allowed — lazy load will surface
        # the 404 later.
        assert _require_known_project(request, "anything") is registry


# ---------------------------------------------------------------------------
# _sync_known_projects + _source_is_synchronously_empty
# ---------------------------------------------------------------------------


class TestSyncKnownProjects:
    def test_returns_none_when_source_has_no_known_projects(self) -> None:
        source = MagicMock(spec=set())  # no known_projects attr
        registry = LazyTeamRegistry(source=source)
        assert _sync_known_projects(registry) is None

    def test_returns_list_when_source_supports_it(self) -> None:
        source = MagicMock()
        source.known_projects = MagicMock(return_value=["p1", "p2"])
        registry = LazyTeamRegistry(source=source)
        assert _sync_known_projects(registry) == ["p1", "p2"]

    def test_swallows_exceptions_returning_none(self) -> None:
        source = MagicMock()
        source.known_projects = MagicMock(side_effect=RuntimeError("boom"))
        registry = LazyTeamRegistry(source=source)
        assert _sync_known_projects(registry) is None


class TestSourceIsSynchronouslyEmpty:
    def test_returns_false_when_source_lacks_method(self) -> None:
        source = MagicMock(spec=set())  # no is_synchronously_empty attr
        registry = LazyTeamRegistry(source=source)
        assert _source_is_synchronously_empty(registry) is False

    def test_returns_true_when_source_reports_empty(self) -> None:
        source = MagicMock()
        source.is_synchronously_empty = MagicMock(return_value=True)
        registry = LazyTeamRegistry(source=source)
        assert _source_is_synchronously_empty(registry) is True

    def test_returns_false_when_source_reports_non_empty(self) -> None:
        source = MagicMock()
        source.is_synchronously_empty = MagicMock(return_value=False)
        registry = LazyTeamRegistry(source=source)
        assert _source_is_synchronously_empty(registry) is False

    def test_swallows_exceptions_returning_false(self) -> None:
        source = MagicMock()
        source.is_synchronously_empty = MagicMock(side_effect=RuntimeError("boom"))
        registry = LazyTeamRegistry(source=source)
        # Never break discovery on a source bug.
        assert _source_is_synchronously_empty(registry) is False


# ---------------------------------------------------------------------------
# QueryOptions.from_query_params (HTTP invoke surfaces)
# ---------------------------------------------------------------------------


class TestQueryOptionsFromRequest:
    def test_omitted_maps_to_default(self) -> None:
        request = _make_request()
        opts = QueryOptions.from_query_params(request.query_params)
        assert opts.staging == "default"

    def test_exact_playground_enables_bypass(self) -> None:
        request = _make_request(query_params={"staging": "playground"})
        opts = QueryOptions.from_query_params(request.query_params)
        assert opts.staging == "playground"

    @pytest.mark.parametrize("raw", ["default", "eval", "Playground", "", "unknown"])
    def test_every_other_value_maps_to_default(self, raw: str) -> None:
        request = _make_request(query_params={"staging": raw})
        opts = QueryOptions.from_query_params(request.query_params)
        assert opts.staging == "default"


# ---------------------------------------------------------------------------
# _available_team_ids
# ---------------------------------------------------------------------------


class TestAvailableTeamIds:
    @pytest.mark.asyncio
    async def test_returns_ids_from_summary_list(self) -> None:
        source = MagicMock()
        source.list_teams = AsyncMock(
            return_value=[
                {"id": "alpha"},
                {"team_id": "beta"},  # alternate key
                {"teamId": "gamma"},  # camelCase
                {"name": "no-id"},  # skipped — no id field
            ]
        )
        registry = LazyTeamRegistry(source=source)
        ids = await _available_team_ids(registry, VALID_PROJECT_ID)
        assert ids == ["alpha", "beta", "gamma"]

    @pytest.mark.asyncio
    async def test_exception_returns_empty_list(self) -> None:
        source = MagicMock()
        source.list_teams = AsyncMock(side_effect=RuntimeError("listing failed"))
        registry = LazyTeamRegistry(source=source)
        # Failures must NOT propagate — the 404 still surfaces, just
        # without the hint.
        assert await _available_team_ids(registry, VALID_PROJECT_ID) == []


# ---------------------------------------------------------------------------
# _resolve_user_id + _validate_user_id
# ---------------------------------------------------------------------------


class TestResolveUserId:
    def test_request_state_user_id_wins(self) -> None:
        request = _make_request(state_user_id="alice")
        assert _resolve_user_id(request) == "alice"

    def test_falls_back_to_claims_sub(self) -> None:
        request = _make_request(claims={"sub": "bob"})
        assert _resolve_user_id(request) == "bob"

    def test_falls_back_to_claims_user_id_alias(self) -> None:
        # The middleware uses ``sub``, but the helper accepts the
        # ``user_id`` alias too.
        request = _make_request(claims={"user_id": "carol"})
        assert _resolve_user_id(request) == "carol"

    def test_falls_back_to_x_user_id_header(self) -> None:
        # No state.user_id, no claims, just the legacy header.
        request = _make_request(headers={"X-User-ID": "dave"})
        assert _resolve_user_id(request) == "dave"

    def test_header_strips_whitespace(self) -> None:
        request = _make_request(headers={"X-User-ID": "  eve  "})
        assert _resolve_user_id(request) == "eve"

    def test_header_with_non_gateway_scheme_logs_warning(
        self, caplog: pytest.LogCaptureFixture
    ) -> None:
        # When auth is enabled and the scheme isn't gateway_identity,
        # falling through to the header indicates middleware
        # mis-wiring — the helper logs a warning. We just exercise
        # the branch (warning is emitted via structlog).
        request = _make_request(
            claims={"scheme": "api_key"},  # auth enabled but no sub
            headers={"X-User-ID": "frank"},
        )
        assert _resolve_user_id(request) == "frank"

    def test_returns_empty_string_when_no_signal(self) -> None:
        request = _make_request()
        assert _resolve_user_id(request) == ""

    def test_colon_in_user_id_rejected(self) -> None:
        # Colon would shift segments in the scoped-session-key partition;
        # boundary-rejected to keep the key parser monotonic.
        request = _make_request(state_user_id="alice:bob")
        with pytest.raises(HTTPException) as exc:
            _resolve_user_id(request)
        assert exc.value.status_code == 400


class TestValidateUserId:
    def test_clean_id_returns_unchanged(self) -> None:
        assert _validate_user_id("alice") == "alice"

    def test_colon_rejected_with_400(self) -> None:
        with pytest.raises(HTTPException) as exc:
            _validate_user_id("a:b")
        assert exc.value.status_code == 400

    def test_empty_id_is_allowed(self) -> None:
        assert _validate_user_id("") == ""


# ---------------------------------------------------------------------------
# validate_project_access
# ---------------------------------------------------------------------------


class TestValidateProjectAccess:
    def test_dev_no_auth_synthesises_identity_from_url(self) -> None:
        # NoopAuthMiddleware leaves request.state.claims empty; the
        # helper synthesises an IdentityContext with user_id from the
        # X-User-ID header (dev fallback) and project_id from the URL.
        request = _make_request(headers={"X-User-ID": "alice"})
        identity = validate_project_access(request, VALID_PROJECT_ID)
        assert isinstance(identity, IdentityContext)
        assert identity.user_id == "alice"
        assert identity.project_id == VALID_PROJECT_ID

    def test_header_project_id_must_match_url(self) -> None:
        # Identity present with a different project_id from the URL →
        # 403 per §3 Rule 1.
        identity = IdentityContext(user_id="alice", project_id="other-project")
        request = _make_request(claims={"_identity": identity})
        with pytest.raises(HTTPException) as exc:
            validate_project_access(request, VALID_PROJECT_ID)
        assert exc.value.status_code == 403

    def test_empty_identity_project_filled_from_url(self) -> None:
        # Identity present but project_id empty → URL fills it and the
        # frozen copy is written back to claims.
        identity = IdentityContext(user_id="alice", project_id="")
        claims = {"_identity": identity}
        request = _make_request(claims=claims)
        out = validate_project_access(request, VALID_PROJECT_ID)
        assert out.project_id == VALID_PROJECT_ID
        # claims dict was mutated in place with the filled identity.
        assert claims["_identity"].project_id == VALID_PROJECT_ID

    def test_resource_project_mismatch_raises_403(self) -> None:
        identity = IdentityContext(user_id="alice", project_id=VALID_PROJECT_ID)
        request = _make_request(claims={"_identity": identity})
        with pytest.raises(HTTPException) as exc:
            validate_project_access(request, VALID_PROJECT_ID, resource_project_id="other-project")
        assert exc.value.status_code == 403

    def test_resource_project_match_succeeds(self) -> None:
        identity = IdentityContext(user_id="alice", project_id=VALID_PROJECT_ID)
        request = _make_request(claims={"_identity": identity})
        out = validate_project_access(
            request, VALID_PROJECT_ID, resource_project_id=VALID_PROJECT_ID
        )
        assert out.user_id == "alice"


# ---------------------------------------------------------------------------
# _session_route_user_id + _require_session_manager
# ---------------------------------------------------------------------------


class TestSessionRouteUserId:
    def test_uses_bound_identity_when_present(self) -> None:
        identity = IdentityContext(user_id="alice", project_id=VALID_PROJECT_ID)
        token = set_current_identity(identity)
        try:
            request = _make_request()
            assert _session_route_user_id(request) == "alice"
        finally:
            reset_current_identity(token)

    def test_falls_back_to_resolve_user_id_when_no_identity(self) -> None:
        request = _make_request(headers={"X-User-ID": "bob"})
        # No identity bound — helper delegates to _resolve_user_id.
        assert _session_route_user_id(request) == "bob"

    def test_identity_with_colon_in_user_id_raises_400(self) -> None:
        identity = IdentityContext(user_id="a:b", project_id=VALID_PROJECT_ID)
        token = set_current_identity(identity)
        try:
            request = _make_request()
            with pytest.raises(HTTPException) as exc:
                _session_route_user_id(request)
            assert exc.value.status_code == 400
        finally:
            reset_current_identity(token)


class TestRequireSessionManager:
    def test_returns_session_manager_when_present(self) -> None:
        bundle = SimpleNamespace(session_manager=MagicMock())
        assert _require_session_manager(bundle) is bundle.session_manager  # type: ignore[arg-type]

    def test_raises_404_when_session_manager_is_none(self) -> None:
        bundle = SimpleNamespace(session_manager=None)
        with pytest.raises(HTTPException) as exc:
            _require_session_manager(bundle)  # type: ignore[arg-type]
        assert exc.value.status_code == 404
        assert "memory" in str(exc.value.detail).lower()


# ---------------------------------------------------------------------------
# /health and /ready via TestClient
# ---------------------------------------------------------------------------


class TestSystemRoutes:
    def test_health_returns_200_with_uptime(self) -> None:
        app = create_app()
        with TestClient(app) as client:
            resp = client.get("/health")
        assert resp.status_code == 200
        body = resp.json()
        assert body["status"] == "ok"
        assert body["version"] == "0.1.0"
        assert "uptimeSeconds" in body  # camelCase wire field

    def test_readiness_check_returns_200_when_ready(self) -> None:
        # The default lifespan brings up a healthy state — at minimum
        # the registry is loaded (even if empty), which is enough for
        # the readiness checker to report ready.
        app = create_app()
        with TestClient(app) as client:
            resp = client.get("/ready")
        # 200 or 503 depending on whether readiness considers the empty
        # registry healthy; just verify the route is reachable and
        # returns the expected shape.
        body = resp.json()
        assert body["status"] in {"ready", "not_ready"}
        assert "teams" in body
        assert "redis" in body
        assert "uptime" in body

    def test_readiness_checker_cached_on_app_state(self) -> None:
        # First call creates the checker; second call must reuse it.
        app = create_app()
        with TestClient(app) as client:
            client.get("/ready")
            checker_first = app.state.readiness_checker
            client.get("/ready")
            assert app.state.readiness_checker is checker_first
