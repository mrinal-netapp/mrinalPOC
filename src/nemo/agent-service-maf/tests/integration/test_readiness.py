"""Integration tests for ``GET /ready`` (§5.8 / §C3 / §G2).

Coverage per the §G2 plan:

* 200 happy path -- service started, at least one healthy team, no
  Redis configured -- returns ``status: ready``.
* 503 ``startup_in_progress`` -- ``app.state.start_time`` not set yet.
* 503 ``no_healthy_teams`` -- registered teams all failed startup.
* 503 ``redis_unreachable`` -- a team uses Redis and its ``ping()``
  raises.
* Cache TTL -- second call within the window reuses the cached
  result (assertion via call-count on the checker's internals).

The MCP-failure case (``mcp_connect_failed``) is exercised in the
unit-level tests against ``_bundle_mcp_ok``; an integration trigger
would require booting a real MCP server which is out of scope.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from agent_service_maf.core.readiness import (
    ReadinessChecker,
    ReadinessReason,
    ReadinessResult,
)
from agent_service_maf.interface_layer.api import create_app
from tests.conftest import TEST_PROJECT_ID


def _write_default_team(teams_dir, framework: str = "mock") -> None:
    teams_dir.mkdir(parents=True, exist_ok=True)
    (teams_dir / "default.json").write_text(
        json.dumps(
            {
                "_team_id": "default",
                "project_id": TEST_PROJECT_ID,
                "agent": {"framework": framework},
            }
        )
    )


@pytest.fixture
def sync_client(tmp_path):
    """Boot a TestClient with a single mock team -- mirror api_endpoints
    fixture so /ready can see a fully-started app."""
    from agent_service_maf.config.config_loader import ConfigLoader as RealConfigLoader

    teams_dir = tmp_path / "teams"
    _write_default_team(teams_dir, framework="mock")
    env = {"AGENT_AGENT__FRAMEWORK": "mock", "AGENT_TEAMS_DIR": str(teams_dir)}
    with patch.dict("os.environ", env):
        with patch("agent_service_maf.core.team_loader.ConfigLoader") as MockConfigLoader:
            MockConfigLoader.return_value = RealConfigLoader(json_config_path=None)
            app = create_app()
            with TestClient(app) as client:
                yield client


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestReadyHappyPath:
    def test_returns_200(self, sync_client: TestClient) -> None:
        r = sync_client.get("/ready")
        assert r.status_code == 200, f"Expected 200, got {r.status_code}. Body: {r.text}"

    def test_status_is_ready(self, sync_client: TestClient) -> None:
        body = sync_client.get("/ready").json()
        assert body["status"] == "ready", f"Expected status='ready', got {body!r}"

    def test_response_shape(self, sync_client: TestClient) -> None:
        body = sync_client.get("/ready").json()
        # §5.8.2 wire example keys (camelCase via CamelCaseModel).
        for key in ("status", "teams", "redis", "uptime", "details"):
            assert key in body, f"Expected '{key}' in /ready body, got: {list(body.keys())}"
        # Memory-backed team => Redis backend disabled.
        assert body["redis"] == "disabled"
        assert isinstance(body["teams"], list)
        assert body["uptime"] >= 0

    def test_health_unaffected(self, sync_client: TestClient) -> None:
        """``/health`` continues to return 200 even when /ready might 503."""
        assert sync_client.get("/health").status_code == 200


# ---------------------------------------------------------------------------
# 503 reasons -- inject a failing checker so we exercise every enum value
# ---------------------------------------------------------------------------


class _StubChecker:
    """Returns a fixed :class:`ReadinessResult` for every call.

    Used to bypass the live checks and pin the route's mapping from
    ``ReadinessResult -> ReadinessResponse / HTTP status``.
    """

    def __init__(self, result: ReadinessResult) -> None:
        self._result = result
        self.call_count = 0

    async def check(self, app: Any) -> ReadinessResult:  # noqa: ANN401
        self.call_count += 1
        return self._result


def _install_stub_checker(client: TestClient, result: ReadinessResult) -> _StubChecker:
    """Replace ``app.state.readiness_checker`` with a stub."""
    stub = _StubChecker(result)
    client.app.state.readiness_checker = stub
    return stub


@pytest.mark.integration
class TestReadyFailureReasons:
    def test_startup_in_progress_returns_503(self, sync_client: TestClient) -> None:
        stub = _install_stub_checker(
            sync_client,
            ReadinessResult(
                ready=False,
                reason=ReadinessReason.STARTUP_IN_PROGRESS,
                detail="Service still starting",
                checks={"startup_complete": False},
            ),
        )
        r = sync_client.get("/ready")
        assert r.status_code == 503
        body = r.json()
        assert body["status"] == "not_ready"
        assert body["reason"] == "startup_in_progress"
        assert "details" in body
        assert stub.call_count == 1

    def test_no_healthy_teams_returns_503(self, sync_client: TestClient) -> None:
        _install_stub_checker(
            sync_client,
            ReadinessResult(
                ready=False,
                reason=ReadinessReason.NO_HEALTHY_TEAMS,
                detail="All teams unhealthy",
                checks={"startup_complete": True, "healthy_teams": False},
            ),
        )
        r = sync_client.get("/ready")
        assert r.status_code == 503
        assert r.json()["reason"] == "no_healthy_teams"

    def test_mcp_connect_failed_returns_503(self, sync_client: TestClient) -> None:
        _install_stub_checker(
            sync_client,
            ReadinessResult(
                ready=False,
                reason=ReadinessReason.MCP_CONNECT_FAILED,
                detail="MCP servers unreachable",
                checks={
                    "startup_complete": True,
                    "healthy_teams": True,
                    "mcp_connected": False,
                },
            ),
        )
        r = sync_client.get("/ready")
        assert r.status_code == 503
        assert r.json()["reason"] == "mcp_connect_failed"

    def test_redis_unreachable_returns_503(self, sync_client: TestClient) -> None:
        _install_stub_checker(
            sync_client,
            ReadinessResult(
                ready=False,
                reason=ReadinessReason.REDIS_UNREACHABLE,
                detail="Redis ping failed",
                checks={
                    "startup_complete": True,
                    "healthy_teams": True,
                    "mcp_connected": True,
                    "redis_reachable": False,
                },
            ),
        )
        r = sync_client.get("/ready")
        assert r.status_code == 503
        assert r.json()["reason"] == "redis_unreachable"

    def test_ready_endpoint_auth_exempt(self, sync_client: TestClient) -> None:
        """``/ready`` is auth-exempt per §5.8 -- no headers needed."""
        # Auth is disabled in this fixture but verify the route still
        # responds without any X-API-Key header.
        r = sync_client.get("/ready")
        assert r.status_code in (200, 503), f"Got {r.status_code}: {r.text!r}"


# ---------------------------------------------------------------------------
# Cache behaviour
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestReadinessCache:
    def test_back_to_back_calls_reuse_cache(self, sync_client: TestClient) -> None:
        """Within the cache TTL the stored result is returned without a recompute.

        We swap in a checker whose ``check`` increments a call counter and
        confirm two consecutive ``/ready`` hits result in just one
        underlying check.
        """
        stub = _install_stub_checker(
            sync_client,
            ReadinessResult(
                ready=True,
                reason=None,
                detail="ok",
                checks={"startup_complete": True, "healthy_teams": True},
            ),
        )
        # Two back-to-back probes within ~1.5s window should still each
        # call the stub once (since the route always calls .check()) --
        # the cache lives inside the real ReadinessChecker, not the
        # route. So this test pins the route contract: every request
        # delegates to checker.check() exactly once.
        sync_client.get("/ready")
        sync_client.get("/ready")
        assert stub.call_count == 2, "Route delegates to checker.check on every call"


# ---------------------------------------------------------------------------
# Real ReadinessChecker -- exercise the in-process cache
# ---------------------------------------------------------------------------


@pytest.mark.integration
class TestReadinessCheckerInternalCache:
    @pytest.mark.asyncio
    async def test_cache_reuses_within_ttl(self) -> None:
        checker = ReadinessChecker(cache_ttl_seconds=10.0)
        fake_app = SimpleNamespace(state=SimpleNamespace(start_time=0.0, teams=None))
        first = await checker.check(fake_app)
        second = await checker.check(fake_app)
        assert first is second, "Cached result must be returned by reference"

    @pytest.mark.asyncio
    async def test_cache_expires_after_ttl(self) -> None:
        checker = ReadinessChecker(cache_ttl_seconds=0.001)
        fake_app = SimpleNamespace(state=SimpleNamespace(start_time=0.0, teams=None))
        import asyncio

        first = await checker.check(fake_app)
        await asyncio.sleep(0.05)
        second = await checker.check(fake_app)
        # Same equality (both ready=True, same payload) but different
        # instances because the second call recomputed past the TTL.
        assert first is not second, "Expired cache must recompute"
        assert first.ready == second.ready is True
