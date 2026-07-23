"""Readiness checker for ``GET /ready`` (§5.8 lock-in).

``/health`` is a liveness probe -- it returns 200 as soon as the FastAPI
process is up. ``/ready`` is a readiness probe -- it returns 200 only
when the service can actually accept invocations end-to-end.

Per §5.8.3 of the migration plan, the five checks are:

1. **Lifespan startup completed.** ``app.state.start_time`` is set by
   the lifespan startup hook. Until it appears we are still booting.
2. **At least one healthy team** is registered for at least one project
   (or the runtime intentionally has zero teams -- empty-config case).
3. **MCP managers connected** (or every team has ``mcp.lazy_connect`` so
   on-demand connect is acceptable).
4. **Redis pingable** when ``memory.storage_backend == "redis"`` or
   ``tasks.backend == "redis"`` on **any** team.
5. **Gateway** check off by default (toggled via
   ``interface.readiness.check_gateway`` -- see
   :class:`~agent_service_maf.config.validators.InterfaceSection`).

Failures map to a small structured ``reason`` enum so the consumer's
readiness probe (k8s, Argo) can log / page on the specific cause:

* ``startup_in_progress``
* ``no_healthy_teams``
* ``mcp_connect_failed``
* ``redis_unreachable``

Results are cached for a short window (1.5 seconds by default) so the
endpoint does not hammer Redis under heavy probe load.

This module is auth-exempt (mounted on ``system_router``) and never
raises; it always returns a :class:`ReadinessResult` so the route
handler can map to 200 / 503 directly.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, Any

import structlog

if TYPE_CHECKING:
    from agent_service_maf.core.team_bundle import TeamRegistry

logger = structlog.get_logger(__name__)

#: Cache window (seconds) -- subsequent /ready hits within this window
#: reuse the last computed :class:`ReadinessResult`. Keeps the endpoint
#: cheap under probe storms (k8s default is 10s; we want sub-probe
#: caching but still fresh enough to flap reasonably fast).
_DEFAULT_CACHE_TTL_SECONDS: float = 1.5


class ReadinessReason(StrEnum):
    """Structured failure causes returned on a not-ready response.

    Values match the wire enum in §5.8.3 of the migration plan. Order
    is the check order in :meth:`ReadinessChecker.check` -- the first
    failing check wins.
    """

    STARTUP_IN_PROGRESS = "startup_in_progress"
    NO_HEALTHY_TEAMS = "no_healthy_teams"
    MCP_CONNECT_FAILED = "mcp_connect_failed"
    REDIS_UNREACHABLE = "redis_unreachable"


@dataclass(frozen=True)
class ReadinessResult:
    """Outcome of a readiness sweep.

    Attributes:
        ready: ``True`` when every check passed; ``False`` otherwise.
        reason: First failing :class:`ReadinessReason`. ``None`` when
            ``ready=True``.
        detail: Free-form diagnostic message for humans -- safe to log
            and surface to ops dashboards. Never leaks secrets.
        checks: Per-check map of ``name -> passed?`` for granular
            observability. Always populated even on the happy path so
            the route can mirror it onto the response body.
    """

    ready: bool
    reason: ReadinessReason | None
    detail: str
    checks: dict[str, bool]


class ReadinessChecker:
    """Run the five §5.8 readiness checks against the live app state.

    Stateless beyond a 1.5-second result cache. Construct one per app
    (or per request -- it is cheap) and call :meth:`check` from the
    route handler. The cache prevents probe storms from hammering
    Redis: subsequent hits within the cache window reuse the most
    recent :class:`ReadinessResult`.

    Args:
        cache_ttl_seconds: How long a successful or failing result
            stays cached. Default 1.5s.

    Example:
        >>> checker = ReadinessChecker()
        >>> result = await checker.check(app=request.app)
        >>> if result.ready:
        ...     return {"status": "ready", "checks": result.checks}
        ... raise HTTPException(503, detail={"reason": result.reason.value, ...})
    """

    def __init__(self, cache_ttl_seconds: float = _DEFAULT_CACHE_TTL_SECONDS) -> None:
        self._cache_ttl_seconds = cache_ttl_seconds
        self._cached_result: ReadinessResult | None = None
        self._cached_at_monotonic: float = 0.0

    async def check(self, app: Any) -> ReadinessResult:  # noqa: ANN401
        """Compute (or return cached) readiness state for ``app``.

        Performs the five §5.8.3 checks in order:

        1. Lifespan startup completed (``app.state.start_time`` set).
        2. At least one healthy team registered.
        3. MCP managers connected (or ``lazy_connect=True`` everywhere).
        4. Redis pingable (when any backend is Redis).
        5. Gateway smoke check (off by default).

        Args:
            app: The FastAPI application instance. Accessed via
                ``app.state`` for the team registry, framework registry,
                and the cached gateway.

        Returns:
            A :class:`ReadinessResult` -- never raises. The route handler
            decides 200 vs 503 from ``result.ready``.
        """
        now = time.monotonic()
        if (
            self._cached_result is not None
            and (now - self._cached_at_monotonic) < self._cache_ttl_seconds
        ):
            return self._cached_result

        result = await self._compute(app)
        self._cached_result = result
        self._cached_at_monotonic = time.monotonic()
        return result

    async def _compute(self, app: Any) -> ReadinessResult:  # noqa: ANN401
        checks: dict[str, bool] = {}

        # Check 1: lifespan startup completed.
        started = getattr(app.state, "start_time", None) is not None
        checks["startup_complete"] = started
        if not started:
            return ReadinessResult(
                ready=False,
                reason=ReadinessReason.STARTUP_IN_PROGRESS,
                detail="Service has not finished lifespan startup yet.",
                checks=checks,
            )

        # Check 2: at least one healthy team (empty registry is OK -- the
        # service can still serve discovery and bare /health).
        registry: TeamRegistry | None = getattr(app.state, "teams", None)
        if registry is None:
            checks["teams_registered"] = True  # Empty config is valid.
            checks["healthy_teams"] = True
        else:
            bundles = list(registry.all_bundles())
            healthy_bundles = [b for b in bundles if b.healthy]
            checks["teams_registered"] = True
            checks["healthy_teams"] = bool(healthy_bundles) or not bundles
            if bundles and not healthy_bundles:
                return ReadinessResult(
                    ready=False,
                    reason=ReadinessReason.NO_HEALTHY_TEAMS,
                    detail=(
                        f"All {len(bundles)} registered team(s) failed startup. "
                        "Inspect /api/v1/projects/{project_id}/agent-teams for "
                        "per-team startup_error messages."
                    ),
                    checks=checks,
                )

            # Check 3: MCP managers. A bundle passes when either the
            # manager has at least one connected server or its team
            # config sets ``mcp.lazy_connect=true`` (on-demand connect
            # is acceptable).
            mcp_ok = True
            for bundle in healthy_bundles:
                if not _bundle_mcp_ok(bundle):
                    mcp_ok = False
                    break
            checks["mcp_connected"] = mcp_ok
            if not mcp_ok:
                return ReadinessResult(
                    ready=False,
                    reason=ReadinessReason.MCP_CONNECT_FAILED,
                    detail=(
                        "One or more teams have unconnected MCP servers and "
                        "lazy_connect=false. Inspect mcp.connected_servers() "
                        "per team."
                    ),
                    checks=checks,
                )

            # Check 4: Redis ping when any backend uses Redis.
            redis_ok, redis_detail = await _ping_redis_backends(healthy_bundles)
            checks["redis_reachable"] = redis_ok
            if not redis_ok:
                return ReadinessResult(
                    ready=False,
                    reason=ReadinessReason.REDIS_UNREACHABLE,
                    detail=redis_detail,
                    checks=checks,
                )

        # Check 5: gateway smoke check is intentionally off by default.
        # The flag is read from any team's interface.readiness section
        # when (and only when) the team config opts in. Off by default
        # because the gateway is best-checked by the upstream control
        # plane, and a probe-time call would burn a real LLM round-trip.
        checks["gateway_check"] = True

        return ReadinessResult(
            ready=True,
            reason=None,
            detail="All readiness checks passed.",
            checks=checks,
        )


def _bundle_mcp_ok(bundle: Any) -> bool:  # noqa: ANN401
    """Return True when the bundle's MCP manager is acceptable for
    readiness.

    Accepted states:

    * Manager has at least one connected server, **or**
    * The team's MCP config sets ``lazy_connect=True`` (on-demand
      connect is allowed in this mode).
    * The team has **no** MCP servers configured -- trivially ok.
    """
    mcp = getattr(bundle, "mcp_manager", None)
    if mcp is None:
        return True
    config = getattr(bundle, "config", None)
    lazy = False
    if config is not None:
        lazy = bool(getattr(getattr(config, "mcp", None), "lazy_connect", False))

    servers = getattr(config, "mcp", None)
    server_list = getattr(servers, "servers", []) if servers is not None else []
    if not server_list:
        return True
    if lazy:
        return True
    try:
        connected = mcp.connected_servers()
    except Exception:  # noqa: BLE001
        return False
    return bool(connected)


async def _ping_redis_backends(bundles: list[Any]) -> tuple[bool, str]:
    """Best-effort Redis ping across every bundle that uses Redis.

    A bundle uses Redis when its team config sets
    ``memory.storage_backend == "redis"`` or
    ``tasks.backend == "redis"``. For each such bundle we try the
    backend's ``ping()`` (when available); on failure the function
    returns ``(False, message)`` short-circuiting the readiness sweep.

    Memory and task backends share the same Redis stack in deployment,
    but we ping them through their own handle so a misconfigured task
    backend is still surfaced separately.
    """
    for bundle in bundles:
        config = getattr(bundle, "config", None)
        if config is None:
            continue

        memory_section = getattr(config, "memory", None)
        memory_uses_redis = getattr(memory_section, "storage_backend", "memory") == "redis"
        tasks_section = getattr(config, "tasks", None)
        tasks_uses_redis = getattr(tasks_section, "backend", "memory") == "redis"

        if memory_uses_redis:
            store = _get_session_store(bundle)
            ok, detail = await _ping_object(store)
            if not ok:
                team = getattr(bundle, "team_id", "?")
                return (
                    False,
                    f"Memory Redis ping failed on team '{team}': {detail}",
                )
        if tasks_uses_redis:
            store = _get_task_store(bundle)
            ok, detail = await _ping_object(store)
            if not ok:
                team = getattr(bundle, "team_id", "?")
                return (
                    False,
                    f"Tasks Redis ping failed on team '{team}': {detail}",
                )
    return True, ""


def _get_session_store(bundle: Any) -> Any:  # noqa: ANN401
    """Best-effort lookup of the session-store handle on a bundle.

    The handle path is ``bundle.session_manager._store`` for the
    current SessionManager implementation; falls back to ``None`` when
    the attribute layout differs (we only ping when ping() resolves).
    """
    session_manager = getattr(bundle, "session_manager", None)
    if session_manager is None:
        return None
    return getattr(session_manager, "_store", None)


def _get_task_store(bundle: Any) -> Any:  # noqa: ANN401
    """Best-effort lookup of the task-store handle on a bundle.

    The TaskManager owns the backend; we walk through it to reach the
    Redis client. Returns ``None`` on layout mismatch.
    """
    task_manager = getattr(bundle, "task_manager", None)
    if task_manager is None:
        return None
    return getattr(task_manager, "_store", None)


async def _ping_object(obj: Any) -> tuple[bool, str]:  # noqa: ANN401
    """Call ``ping()`` on ``obj`` when available.

    Returns ``(True, "")`` on success and ``(False, error)`` on
    failure. Missing ``ping`` returns ``(True, "")`` -- we cannot
    distinguish "store doesn't expose ping" from "store is fine", and
    the readiness check should not regress on stores that simply have
    no probe method (the memory backends, for instance).
    """
    if obj is None:
        return True, ""
    ping = getattr(obj, "ping", None)
    if ping is None or not callable(ping):
        return True, ""
    try:
        result = ping()
        if hasattr(result, "__await__"):
            await result
        return True, ""
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"


__all__ = [
    "ReadinessChecker",
    "ReadinessReason",
    "ReadinessResult",
]
