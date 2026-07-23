"""Unit tests for :mod:`agent_service_maf.core.readiness`.

Pins the §5.8 readiness contract:

* Each failing check short-circuits to a distinct :class:`ReadinessReason`.
* The result cache reuses prior results within the TTL window so probe
  storms don't hammer Redis.
* MCP / Redis ping helpers degrade gracefully — missing ``ping`` is
  treated as healthy, layout mismatches return None and skip rather than
  crash.
* The bare ``/health`` is unaffected — this module is only consulted by
  ``/ready``.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import pytest

from agent_service_maf.core.readiness import (
    ReadinessChecker,
    ReadinessReason,
    ReadinessResult,
    _bundle_mcp_ok,
    _ping_object,
    _ping_redis_backends,
)

# ---------------------------------------------------------------------------
# Fixtures / stubs
# ---------------------------------------------------------------------------


def _app(state: dict[str, Any] | None = None) -> Any:
    """Build a minimal app stub. The readiness checker only reads
    ``app.state.<attr>``, so a namespace suffices."""
    return SimpleNamespace(state=SimpleNamespace(**(state or {})))


@dataclass
class _StubMcpConfig:
    lazy_connect: bool = False
    servers: list[Any] | None = None


@dataclass
class _StubMemoryConfig:
    storage_backend: str = "memory"


@dataclass
class _StubTasksConfig:
    backend: str = "memory"


@dataclass
class _StubBundleConfig:
    mcp: _StubMcpConfig | None = None
    memory: _StubMemoryConfig | None = None
    tasks: _StubTasksConfig | None = None


class _StubMcpManager:
    """Stub MCP manager — ``connected_servers`` returns the seed list or
    raises if seeded with an exception."""

    def __init__(self, connected: list[str] | Exception) -> None:
        self._connected = connected

    def connected_servers(self) -> list[str]:
        if isinstance(self._connected, Exception):
            raise self._connected
        return self._connected


class _StubStore:
    def __init__(self, ping_result: bool | Exception | None = True) -> None:
        self._result = ping_result
        self.ping_calls = 0

    async def ping(self) -> bool:  # noqa: D401 — simple ping
        self.ping_calls += 1
        if isinstance(self._result, Exception):
            raise self._result
        return bool(self._result)


@dataclass
class _StubBundle:
    team_id: str = "team-1"
    healthy: bool = True
    config: _StubBundleConfig | None = None
    mcp_manager: _StubMcpManager | None = None
    session_manager: Any | None = None
    task_manager: Any | None = None


class _StubRegistry:
    def __init__(self, bundles: list[_StubBundle]) -> None:
        self._bundles = bundles

    def all_bundles(self) -> list[_StubBundle]:
        return list(self._bundles)


# ---------------------------------------------------------------------------
# ReadinessChecker.check — end-to-end branches
# ---------------------------------------------------------------------------


class TestReadinessChecker:
    @pytest.mark.asyncio
    async def test_startup_not_complete(self) -> None:
        app = _app({})  # No start_time → STARTUP_IN_PROGRESS
        result = await ReadinessChecker().check(app)

        assert result.ready is False
        assert result.reason is ReadinessReason.STARTUP_IN_PROGRESS
        assert "lifespan" in result.detail.lower()
        assert result.checks == {"startup_complete": False}

    @pytest.mark.asyncio
    async def test_no_team_registry_is_acceptable(self) -> None:
        # An empty-config service (no teams attached) is still ready —
        # it can serve discovery / health endpoints. Per §5.8 doc:
        # "or the runtime intentionally has zero teams".
        app = _app({"start_time": time.time(), "teams": None})
        result = await ReadinessChecker().check(app)

        assert result.ready is True
        assert result.reason is None
        assert result.checks["startup_complete"] is True
        assert result.checks["teams_registered"] is True
        assert result.checks["healthy_teams"] is True
        assert result.checks["gateway_check"] is True

    @pytest.mark.asyncio
    async def test_all_teams_unhealthy(self) -> None:
        app = _app(
            {
                "start_time": time.time(),
                "teams": _StubRegistry(
                    [
                        _StubBundle(team_id="t1", healthy=False),
                        _StubBundle(team_id="t2", healthy=False),
                    ]
                ),
            }
        )
        result = await ReadinessChecker().check(app)

        assert result.ready is False
        assert result.reason is ReadinessReason.NO_HEALTHY_TEAMS
        assert "2" in result.detail  # registered count surfaces in detail
        assert result.checks["healthy_teams"] is False

    @pytest.mark.asyncio
    async def test_empty_registry_passes_healthy_team_check(self) -> None:
        # `registry.all_bundles()` returns [] → no bundles to check
        # against, but registry presence itself is acceptable.
        app = _app(
            {
                "start_time": time.time(),
                "teams": _StubRegistry([]),
            }
        )
        result = await ReadinessChecker().check(app)

        assert result.ready is True
        assert result.checks["healthy_teams"] is True

    @pytest.mark.asyncio
    async def test_mcp_disconnected_strict_fails(self) -> None:
        bundle = _StubBundle(
            mcp_manager=_StubMcpManager(connected=[]),
            config=_StubBundleConfig(
                mcp=_StubMcpConfig(lazy_connect=False, servers=["mcp-1"]),
            ),
        )
        app = _app(
            {
                "start_time": time.time(),
                "teams": _StubRegistry([bundle]),
            }
        )
        result = await ReadinessChecker().check(app)

        assert result.ready is False
        assert result.reason is ReadinessReason.MCP_CONNECT_FAILED
        assert result.checks["mcp_connected"] is False

    @pytest.mark.asyncio
    async def test_mcp_lazy_connect_passes_even_with_no_connections(self) -> None:
        # `lazy_connect=True` means on-demand connect is acceptable —
        # the readiness sweep must not require a live connection.
        bundle = _StubBundle(
            mcp_manager=_StubMcpManager(connected=[]),
            config=_StubBundleConfig(
                mcp=_StubMcpConfig(lazy_connect=True, servers=["mcp-1"]),
            ),
        )
        app = _app(
            {
                "start_time": time.time(),
                "teams": _StubRegistry([bundle]),
            }
        )
        result = await ReadinessChecker().check(app)

        assert result.ready is True
        assert result.checks["mcp_connected"] is True

    @pytest.mark.asyncio
    async def test_redis_unreachable_when_memory_uses_redis(self) -> None:
        store = _StubStore(ping_result=RuntimeError("connection refused"))
        bundle = _StubBundle(
            session_manager=SimpleNamespace(_store=store),
            config=_StubBundleConfig(
                mcp=_StubMcpConfig(servers=[]),  # no MCP servers
                memory=_StubMemoryConfig(storage_backend="redis"),
            ),
        )
        app = _app(
            {
                "start_time": time.time(),
                "teams": _StubRegistry([bundle]),
            }
        )
        result = await ReadinessChecker().check(app)

        assert result.ready is False
        assert result.reason is ReadinessReason.REDIS_UNREACHABLE
        assert "Memory Redis" in result.detail
        assert "team-1" in result.detail

    @pytest.mark.asyncio
    async def test_redis_unreachable_when_tasks_use_redis(self) -> None:
        store = _StubStore(ping_result=RuntimeError("timeout"))
        bundle = _StubBundle(
            task_manager=SimpleNamespace(_store=store),
            config=_StubBundleConfig(
                mcp=_StubMcpConfig(servers=[]),
                tasks=_StubTasksConfig(backend="redis"),
            ),
        )
        app = _app(
            {
                "start_time": time.time(),
                "teams": _StubRegistry([bundle]),
            }
        )
        result = await ReadinessChecker().check(app)

        assert result.ready is False
        assert result.reason is ReadinessReason.REDIS_UNREACHABLE
        assert "Tasks Redis" in result.detail

    @pytest.mark.asyncio
    async def test_redis_skipped_when_no_backend_uses_redis(self) -> None:
        # Memory backends → no ping → result is ready. Even if a stub
        # store is wired in, it must not be pinged.
        store = _StubStore(ping_result=True)
        bundle = _StubBundle(
            session_manager=SimpleNamespace(_store=store),
            config=_StubBundleConfig(
                mcp=_StubMcpConfig(servers=[]),
                memory=_StubMemoryConfig(storage_backend="memory"),
                tasks=_StubTasksConfig(backend="memory"),
            ),
        )
        app = _app(
            {
                "start_time": time.time(),
                "teams": _StubRegistry([bundle]),
            }
        )
        result = await ReadinessChecker().check(app)

        assert result.ready is True
        assert store.ping_calls == 0

    @pytest.mark.asyncio
    async def test_happy_path_all_checks_pass(self) -> None:
        bundle = _StubBundle(
            mcp_manager=_StubMcpManager(connected=["mcp-1", "mcp-2"]),
            config=_StubBundleConfig(
                mcp=_StubMcpConfig(servers=["mcp-1", "mcp-2"]),
                memory=_StubMemoryConfig(storage_backend="memory"),
            ),
        )
        app = _app(
            {
                "start_time": time.time(),
                "teams": _StubRegistry([bundle]),
            }
        )
        result = await ReadinessChecker().check(app)

        assert result.ready is True
        assert result.reason is None
        assert result.checks == {
            "startup_complete": True,
            "teams_registered": True,
            "healthy_teams": True,
            "mcp_connected": True,
            "redis_reachable": True,
            "gateway_check": True,
        }

    # --- Cache behavior ----------------------------------------------------

    @pytest.mark.asyncio
    async def test_cache_returns_same_object_within_ttl(self) -> None:
        # First call computes; second call within TTL must return the
        # SAME ReadinessResult instance (cache hit, no recomputation).
        app = _app({"start_time": time.time(), "teams": None})
        checker = ReadinessChecker(cache_ttl_seconds=60.0)
        r1 = await checker.check(app)
        r2 = await checker.check(app)
        assert r1 is r2

    @pytest.mark.asyncio
    async def test_cache_expires_after_ttl(self) -> None:
        app = _app({"start_time": time.time(), "teams": None})
        # Zero TTL → every call recomputes.
        checker = ReadinessChecker(cache_ttl_seconds=0.0)
        r1 = await checker.check(app)
        # Force a small sleep so monotonic clock advances past TTL window.
        await _sleep_tiny()
        r2 = await checker.check(app)
        assert r1 is not r2
        # Both still ready, just freshly computed.
        assert r1.ready is True and r2.ready is True


async def _sleep_tiny() -> None:
    import asyncio

    await asyncio.sleep(0.001)


# ---------------------------------------------------------------------------
# _bundle_mcp_ok helper
# ---------------------------------------------------------------------------


class TestBundleMcpOk:
    def test_no_manager_is_ok(self) -> None:
        bundle = _StubBundle(mcp_manager=None)
        assert _bundle_mcp_ok(bundle) is True

    def test_no_servers_configured_is_ok(self) -> None:
        bundle = _StubBundle(
            mcp_manager=_StubMcpManager(connected=[]),
            config=_StubBundleConfig(mcp=_StubMcpConfig(servers=[])),
        )
        assert _bundle_mcp_ok(bundle) is True

    def test_lazy_connect_is_ok_with_no_connections(self) -> None:
        bundle = _StubBundle(
            mcp_manager=_StubMcpManager(connected=[]),
            config=_StubBundleConfig(
                mcp=_StubMcpConfig(lazy_connect=True, servers=["mcp-1"]),
            ),
        )
        assert _bundle_mcp_ok(bundle) is True

    def test_strict_with_zero_connections_fails(self) -> None:
        bundle = _StubBundle(
            mcp_manager=_StubMcpManager(connected=[]),
            config=_StubBundleConfig(
                mcp=_StubMcpConfig(lazy_connect=False, servers=["mcp-1"]),
            ),
        )
        assert _bundle_mcp_ok(bundle) is False

    def test_connected_servers_pass(self) -> None:
        bundle = _StubBundle(
            mcp_manager=_StubMcpManager(connected=["mcp-1"]),
            config=_StubBundleConfig(
                mcp=_StubMcpConfig(lazy_connect=False, servers=["mcp-1"]),
            ),
        )
        assert _bundle_mcp_ok(bundle) is True

    def test_connected_servers_raising_returns_false(self) -> None:
        # If the manager throws when asked for its connection list,
        # we cannot prove readiness — treat as not ok.
        bundle = _StubBundle(
            mcp_manager=_StubMcpManager(connected=RuntimeError("kaboom")),
            config=_StubBundleConfig(
                mcp=_StubMcpConfig(lazy_connect=False, servers=["mcp-1"]),
            ),
        )
        assert _bundle_mcp_ok(bundle) is False


# ---------------------------------------------------------------------------
# _ping_object helper — graceful degradation across stores
# ---------------------------------------------------------------------------


class TestPingObject:
    @pytest.mark.asyncio
    async def test_none_object_is_ok(self) -> None:
        # Layout-mismatch case: the lookup helper couldn't find the
        # store handle. We can't prove anything either way, so don't
        # block readiness on it.
        assert await _ping_object(None) == (True, "")

    @pytest.mark.asyncio
    async def test_missing_ping_method_is_ok(self) -> None:
        # Memory backends have no ping() — that doesn't mean they're
        # broken, just that they don't support the probe.
        class _NoPing:
            pass

        assert await _ping_object(_NoPing()) == (True, "")

    @pytest.mark.asyncio
    async def test_sync_ping_returning_value_is_ok(self) -> None:
        class _SyncPing:
            def ping(self) -> bool:
                return True

        assert await _ping_object(_SyncPing()) == (True, "")

    @pytest.mark.asyncio
    async def test_async_ping_awaited(self) -> None:
        class _AsyncPing:
            def __init__(self) -> None:
                self.called = False

            async def ping(self) -> None:
                self.called = True

        target = _AsyncPing()
        result = await _ping_object(target)
        assert result == (True, "")
        assert target.called is True

    @pytest.mark.asyncio
    async def test_ping_exception_returns_error_message(self) -> None:
        class _BadPing:
            def ping(self) -> None:
                raise ConnectionError("redis unreachable")

        ok, detail = await _ping_object(_BadPing())
        assert ok is False
        assert "ConnectionError" in detail
        assert "redis unreachable" in detail

    @pytest.mark.asyncio
    async def test_async_ping_exception_returns_error_message(self) -> None:
        class _BadAsyncPing:
            async def ping(self) -> None:
                raise TimeoutError("deadline")

        ok, detail = await _ping_object(_BadAsyncPing())
        assert ok is False
        assert "TimeoutError" in detail


# ---------------------------------------------------------------------------
# _ping_redis_backends — multi-bundle iteration
# ---------------------------------------------------------------------------


class TestPingRedisBackends:
    @pytest.mark.asyncio
    async def test_skips_bundles_without_config(self) -> None:
        ok, detail = await _ping_redis_backends([_StubBundle(config=None)])
        assert (ok, detail) == (True, "")

    @pytest.mark.asyncio
    async def test_skips_bundles_with_memory_backends(self) -> None:
        bundle = _StubBundle(
            config=_StubBundleConfig(
                memory=_StubMemoryConfig(storage_backend="memory"),
                tasks=_StubTasksConfig(backend="memory"),
            ),
        )
        ok, detail = await _ping_redis_backends([bundle])
        assert (ok, detail) == (True, "")

    @pytest.mark.asyncio
    async def test_first_failing_bundle_short_circuits(self) -> None:
        bad = _StubBundle(
            team_id="bad",
            session_manager=SimpleNamespace(
                _store=_StubStore(ping_result=RuntimeError("nope")),
            ),
            config=_StubBundleConfig(
                memory=_StubMemoryConfig(storage_backend="redis"),
            ),
        )
        good_store = _StubStore(ping_result=True)
        good = _StubBundle(
            team_id="good",
            session_manager=SimpleNamespace(_store=good_store),
            config=_StubBundleConfig(
                memory=_StubMemoryConfig(storage_backend="redis"),
            ),
        )
        ok, detail = await _ping_redis_backends([bad, good])
        assert ok is False
        assert "bad" in detail
        # Second bundle was never pinged — short-circuit on first failure.
        assert good_store.ping_calls == 0


# ---------------------------------------------------------------------------
# ReadinessResult / ReadinessReason are simple data classes; pin shapes.
# ---------------------------------------------------------------------------


class TestReadinessResult:
    def test_reason_enum_values(self) -> None:
        # Wire format — must match the §5.8.3 spec.
        assert ReadinessReason.STARTUP_IN_PROGRESS.value == "startup_in_progress"
        assert ReadinessReason.NO_HEALTHY_TEAMS.value == "no_healthy_teams"
        assert ReadinessReason.MCP_CONNECT_FAILED.value == "mcp_connect_failed"
        assert ReadinessReason.REDIS_UNREACHABLE.value == "redis_unreachable"

    def test_result_is_frozen(self) -> None:
        r = ReadinessResult(ready=True, reason=None, detail="ok", checks={})
        with pytest.raises(Exception):
            r.ready = False  # type: ignore[misc]
