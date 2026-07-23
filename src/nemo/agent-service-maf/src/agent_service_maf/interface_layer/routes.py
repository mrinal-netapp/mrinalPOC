"""REST, SSE, and WebSocket routes for agent invocation and discovery.

All resource routes are project-scoped. Two routers are exported:

- :data:`api_router` — included with prefix ``/api/v1``. Holds every
  project-scoped resource route.
- :data:`system_router` — included with no prefix. Holds ``/health`` so that
  Kubernetes liveness/readiness probes don't need to track the API version.

Project-scoped routes:

- ``GET    /api/v1/projects/{project_id}/agent-teams``
- ``GET    /api/v1/projects/{project_id}/agent-teams/{team_id}``
- ``POST   /api/v1/projects/{project_id}/agent-teams/{team_id}/invoke``
- ``POST   /api/v1/projects/{project_id}/agent-teams/{team_id}/invoke/async``
- ``POST   /api/v1/projects/{project_id}/agent-teams/{team_id}/invoke/stream``
- ``WS     /api/v1/projects/{project_id}/agent-teams/{team_id}/ws``
- ``GET    /api/v1/projects/{project_id}/agents``
- ``GET    /api/v1/projects/{project_id}/agents/{agent_id}/capabilities``
- ``POST   /api/v1/projects/{project_id}/agents/invoke``           (default team)
- ``POST   /api/v1/projects/{project_id}/agents/invoke/stream``    (default team)
- ``POST   /api/v1/projects/{project_id}/agents/{agent_id}/invoke``
- ``POST   /api/v1/projects/{project_id}/agents/{agent_id}/invoke/async``
- ``POST   /api/v1/projects/{project_id}/agents/{agent_id}/invoke/stream``
- ``WS     /api/v1/projects/{project_id}/agents/{agent_id}/ws``
- ``GET    /api/v1/projects/{project_id}/tasks/{task_id}``    (poll async task)
- ``DELETE /api/v1/projects/{project_id}/tasks/{task_id}``    (cancel async task)

System routes (un-prefixed):

- ``GET    /health``  (liveness)
- ``GET    /ready``   (readiness — §5.8 lock-in)

Error mapping:
    - Unknown ``project_id`` or ``team_id`` (or team in wrong project) → HTTP 404
    - Unhealthy team → HTTP 503
    - :class:`~agent_service_maf.core.exceptions.FrameworkNotFoundError` → HTTP 404
    - :class:`~agent_service_maf.core.exceptions.AgentFrameworkError` → HTTP 500
    - Any other exception → HTTP 500

See :mod:`agent_service_maf.interface_layer.api` for app creation and middleware
registration.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any

import structlog
from fastapi import (
    APIRouter,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from sse_starlette.sse import EventSourceResponse

from agent_service_maf.config._override_applier import (
    apply_per_agent_overrides,
    config_overrides_to_agent_request_dict,
    config_overrides_to_request_dict,
    validate_overrides_against_catalog,
)
from agent_service_maf.config.model_catalog import ModelCatalog, NoopModelCatalog
from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.exceptions import (
    AgentFrameworkError,
    AgentTimeoutError,
    FrameworkNotFoundError,
    GuardrailError,
)
from agent_service_maf.core.identity import (
    IdentityContext,
    get_current_identity,
    reset_current_identity,
    set_current_identity,
)
from agent_service_maf.core.interfaces import AgentRequest
from agent_service_maf.core.query_options import QueryOptions
from agent_service_maf.core.readiness import ReadinessChecker
from agent_service_maf.core.session import memory_degraded, reset_memory_degraded
from agent_service_maf.core.session_store import _strip_scope
from agent_service_maf.core.task_manager import TaskManager
from agent_service_maf.core.task_models import Task
from agent_service_maf.core.team_bundle import SessionScope, TeamBundle, TeamRegistry
from agent_service_maf.core.team_registry_lazy import LazyTeamRegistry
from agent_service_maf.interface_layer.error_formatter import SafeErrorFormatter
from agent_service_maf.interface_layer.models import (
    AgentListResponse,
    AssistantMessageMetadata,
    AsyncInvokeResponse,
    HealthResponse,
    InvokeRequest,
    InvokeResponse,
    ReadinessResponse,
    SessionDetailResponse,
    SessionListResponse,
    SessionRenameRequest,
    TaskStatusResponse,
)
from agent_service_maf.interface_layer.sse_handler import create_sse_generator
from agent_service_maf.interface_layer.ws_handler import handle_websocket_session

logger = structlog.get_logger(__name__)

# Resource routes — mounted under /api/v1 by api.py.
api_router = APIRouter()
# Probe / docs routes — mounted with no prefix.
system_router = APIRouter()


# WebSocket close code for authentication failures. WS application close
# codes 4000-4999 are reserved for application use; 4401 mirrors HTTP 401
# (matches the existing 4029 / HTTP-429 convention already used by
# ws_handler.py's per-IP-limit rejection).
_WS_AUTH_CLOSE_CODE: int = 4401


def _get_model_catalog(request: Request) -> ModelCatalog:
    """Return the process-wide model catalog used to validate overrides.

    The real config-service-backed catalog
    (:class:`~agent_service_maf.config.model_catalog.ConfigServiceModelCatalog`)
    is wired by setting ``app.state.model_catalog`` during
    ``lifespan_startup`` whenever the source is a
    :class:`RemoteConfigCache`. This helper falls back to a fresh
    :class:`NoopModelCatalog` when nothing has been wired — used in
    file/test mode.
    """
    catalog = getattr(request.app.state, "model_catalog", None)
    if catalog is None:
        catalog = NoopModelCatalog()
        request.app.state.model_catalog = catalog
    return catalog


# Starlette caps WebSocket close `reason` strings (RFC6455: 123 bytes after
# UTF-8 encoding). We use a conservative character-level cap so a verbose
# auth-failure detail doesn't trip Starlette's encoder.
_WS_REASON_MAX_CHARS: int = 100


async def _authenticate_websocket(websocket: WebSocket) -> bool:
    """Authenticate a WebSocket handshake using the app's auth provider.

    ``AgentAuthMiddleware`` is pure-ASGI HTTP middleware — it only handles
    HTTP scopes and passes WebSocket connections straight through. So this
    helper runs the *same* configured provider (stashed on
    ``app.state.auth_provider`` by :func:`create_app`) against the handshake
    headers before the handler calls ``websocket.accept()``.

    On success: stashes the returned claims on ``websocket.state.claims``
    and returns ``True``. The caller may then accept the connection.

    On failure: closes the socket with code :data:`_WS_AUTH_CLOSE_CODE`
    (4401) and a truncated reason derived from the auth provider's
    HTTPException, then returns ``False``. The caller must abort
    immediately and must NOT call ``websocket.accept()``.

    Args:
        websocket: The incoming WebSocket connection (not yet accepted).

    Returns:
        ``True`` if authentication passed (or auth is disabled — the
        ``NoopAuthMiddleware`` always returns ``{}``), ``False`` if the
        handshake was rejected. ``False`` always implies the socket has
        already been closed.
    """
    auth_provider = getattr(websocket.app.state, "auth_provider", None)
    if auth_provider is None:
        # No provider configured (shouldn't happen — create_app always sets
        # one — but be defensive so a partial init doesn't silently bypass
        # auth in production).
        logger.error("WebSocket auth: no auth_provider on app.state; closing connection")
        await websocket.close(
            code=_WS_AUTH_CLOSE_CODE,
            reason="Auth provider not configured",
        )
        return False

    try:
        claims = await auth_provider.authenticate(websocket)
    except HTTPException as exc:
        reason = str(exc.detail or "Authentication failed")[:_WS_REASON_MAX_CHARS]
        logger.warning(
            "WebSocket auth failed",
            status_code=exc.status_code,
            path=str(websocket.url.path),
        )
        await websocket.close(code=_WS_AUTH_CLOSE_CODE, reason=reason)
        return False
    except Exception as exc:
        logger.error(
            "WebSocket auth: unexpected provider error",
            error=str(exc),
            error_type=type(exc).__name__,
            path=str(websocket.url.path),
        )
        await websocket.close(
            code=_WS_AUTH_CLOSE_CODE,
            reason="Authentication error",
        )
        return False

    websocket.state.claims = claims
    return True


def _require_known_project(request: Request, project_id: str) -> TeamRegistry | LazyTeamRegistry:
    """Validate that the registry is loaded and the project is known.

    Used by the discovery routes (``list_teams``, ``list_agents``,
    ``get_capabilities``).

    Behaviour by registry kind:

    - **Eager** (legacy): preserves the previous semantics — 503 on
      missing/empty registry, 404 on unknown project, returns the
      registry on success. Used by tests that construct a plain
      ``TeamRegistry``.
    - **Lazy** (config-service migration): a project's *existence*
      cannot be determined without an async config-service round trip,
      and the lazy registry's flat ``teams`` is empty at startup by
      design. Skip the "known project" check entirely — the caller will
      either materialise a bundle (which 404s if the project / team /
      agent is unknown at the source) or list zero entries. Still
      returns 503 when no registry has been wired at all (programmer
      error).

    Returns:
        The registry (eager or lazy) on success.

    Raises:
        HTTPException: 503 on missing registry; 404 on unknown project
            (eager registries only).
    """
    registry = getattr(request.app.state, "teams", None)
    if registry is None:
        raise HTTPException(status_code=503, detail={"error": "No teams loaded"})
    if isinstance(registry, LazyTeamRegistry):
        # Lazy mode: project existence is determined by the source on
        # first fetch. Don't 503 just because nothing has been
        # materialised yet — that's the steady state at startup.
        # Exception: when the source is *synchronously known to be empty*
        # (legacy file mode with an empty teams dir), preserve the
        # pre-migration 503 contract so operational dashboards still
        # surface "no teams loaded" without waiting for a request to
        # discover it.
        if _source_is_synchronously_empty(registry):
            raise HTTPException(status_code=503, detail={"error": "No teams loaded"})
        # File source: project ids are known synchronously. Preserve the
        # pre-migration 404 for unknown projects (the remote source has
        # no equivalent — listing projects is not part of the contract).
        known = _sync_known_projects(registry)
        if known is not None and project_id not in known:
            raise HTTPException(
                status_code=404,
                detail={
                    "error": f"Unknown project_id '{project_id}'",
                    "available_projects": list(known),
                },
            )
        return registry
    if not registry.teams:
        raise HTTPException(status_code=503, detail={"error": "No teams loaded"})
    if not registry.has_project(project_id):
        raise HTTPException(
            status_code=404,
            detail={
                "error": f"Unknown project_id '{project_id}'",
                "available_projects": registry.project_ids(),
            },
        )
    return registry


async def _resolve_team(
    request: Request,
    project_id: str,
    team_id: str | None,
    *,
    scope: SessionScope = "team",
    agent_id: str | None = None,
    query_options: QueryOptions | None = None,
) -> TeamBundle:
    """Look up a :class:`~agent_service_maf.core.team_bundle.TeamBundle` scoped
    to ``project_id``.

    Migration-aware: when ``app.state.teams`` is a
    :class:`LazyTeamRegistry`, this triggers a config-service fetch +
    bundle build on first access. The ``scope`` + ``agent_id`` arguments
    let the agent-only routes target a synthetic single-agent bundle
    (built from an agent record) instead of the project's default team.
    For the legacy eager registry, both extra arguments are ignored —
    behaviour is identical to today.

    Args:
        request: FastAPI request carrying ``app.state.teams``.
        project_id: Project id from the path. Must match a project that
            has at least one team registered.
        team_id: Team id from the path. ``None`` selects the project's
            default team (used by ``/agents/*`` endpoints that don't
            carry a team_id), unless ``scope='agent'`` is supplied — in
            which case the agent record is fetched directly and wrapped
            in a synthetic single-agent bundle.
        scope: ``"team"`` (default) for team-orchestration routes,
            ``"agent"`` for routes whose semantics are a one-on-one with
            a named agent. Lazy registry only.
        agent_id: Required when ``scope='agent'``. The agent's id, used
            to materialise the synthetic single-agent bundle.

    Returns:
        The matching TeamBundle.

    Raises:
        HTTPException:
            - **503** when no team registry exists on app.state. This is
              an operational/startup misconfiguration, not a routing
              mistake.
            - **404** when the requested team / agent is unknown.
            - **503** when the resolved bundle exists but is marked
              unhealthy (e.g., its config failed schema validation).
    """
    registry = getattr(request.app.state, "teams", None)
    if registry is None:
        raise HTTPException(status_code=503, detail={"error": "No teams loaded"})

    # ----- Lazy registry branch (config-service migration) -----
    if isinstance(registry, LazyTeamRegistry):
        # Preserve the legacy 503-for-empty-registry contract on the
        # invoke surface when the source synchronously knows its
        # universe is empty (file mode, AGENT_TEAMS_DIR unset). Without
        # this the request falls through to a misleading 404 even
        # though the cause is operational (no teams configured) rather
        # than client-side (wrong team / agent id).
        if _source_is_synchronously_empty(registry):
            raise HTTPException(status_code=503, detail={"error": "No teams loaded"})
        bundle = await _resolve_via_lazy(
            registry,
            project_id=project_id,
            team_id=team_id,
            scope=scope,
            agent_id=agent_id,
            query_options=query_options,
        )
    else:
        bundle = _resolve_via_eager(registry, project_id=project_id, team_id=team_id)

    if not bundle.healthy:
        raise HTTPException(
            status_code=503,
            detail={
                "error": f"Team '{bundle.team_id}' is unhealthy",
                "startup_error": bundle.startup_error,
            },
        )
    return bundle


async def _resolve_via_lazy(
    registry: LazyTeamRegistry,
    *,
    project_id: str,
    team_id: str | None,
    scope: SessionScope,
    agent_id: str | None,
    query_options: QueryOptions | None = None,
) -> TeamBundle:
    """Lazy-registry resolution path with three branches:

    1. Explicit ``team_id`` — fetch the team blob, fan out to agents,
       compose. ``scope='agent'`` is ignored here; the team route is the
       source of truth for which agents exist (resolved downstream).
    2. ``scope='agent'`` with no team_id — fetch the standalone agent
       record and wrap in a synthetic single-agent bundle. This is the
       new path enabled by config-service: an agent invoke no longer
       requires a team blob to exist.
    3. No team_id, no agent_id — fall back to the project's *materialised*
       default team if any (preserves AGENT_DEFAULT_TEAM semantics for
       pre-warmed deployments).

    ``staging`` is threaded into every materialisation call so a
    ``playground`` invoke bypasses both cache layers (config TTL + bundle
    registry ``add()``) on whichever branch resolves it.
    """
    if team_id:
        bundle = await registry.get_or_load_team(project_id, team_id, query_options=query_options)
        if bundle is None:
            available = await _available_team_ids(registry, project_id)
            detail: dict[str, Any] = {
                "error": (f"Unknown team_id '{team_id}' for project '{project_id}'"),
            }
            if available:
                detail["available_teams"] = available
            raise HTTPException(status_code=404, detail=detail)
        return bundle

    if scope == "agent" and agent_id:
        # 1) Prefer the standalone agent record if config-service / the
        #    file source exposes one (the new agent-records-as-first-
        #    class-entity flow from the plan).
        bundle = await registry.get_or_load_agent(project_id, agent_id, query_options=query_options)
        if bundle is not None:
            return bundle
        # 2) Legacy fallback: invoke the named agent through the
        #    project's default team. Required by file-mode fixtures
        #    that only ship inlined team JSONs (no standalone agent
        #    files) and by deployments that have not yet migrated their
        #    standalone agent records to config-service.
        default = await _ensure_default_team_materialised(
            registry, project_id, query_options=query_options
        )
        if default is not None:
            return default
        raise HTTPException(
            status_code=404,
            detail={
                "error": (f"Unknown agent '{agent_id}' for project '{project_id}'"),
            },
        )

    # Project-default fallback. The lazy registry only knows about
    # materialised bundles for this — materialise the default on demand
    # by consulting the source listing if nothing has been warmed yet.
    bundle = await _ensure_default_team_materialised(
        registry, project_id, query_options=query_options
    )
    if bundle is None:
        raise HTTPException(
            status_code=404,
            detail={
                "error": (
                    f"Project '{project_id}' has no default team; "
                    "supply a team_id or pre-warm one via AGENT_WARM_TEAMS"
                ),
            },
        )
    return bundle


def _sync_known_projects(registry: LazyTeamRegistry) -> list[str] | None:
    """Return the project ids a lazy registry's source knows synchronously.

    Delegates to :meth:`LazyTeamRegistry.known_projects` so the route
    layer does not need to know which source backs the registry.
    """
    return registry.known_projects()


def _source_is_synchronously_empty(registry: LazyTeamRegistry) -> bool:
    """True when the lazy registry's source can confirm zero teams
    synchronously.

    Delegates to :meth:`LazyTeamRegistry.is_synchronously_empty` — the
    per-source semantics live there.
    """
    return registry.is_synchronously_empty()


async def _available_team_ids(registry: LazyTeamRegistry, project_id: str) -> list[str]:
    """Return the team ids known to the lazy registry's source for
    ``project_id``.

    Best-effort enrichment for 404 responses so the client sees the
    same hint shape the eager registry produced. Lazy registries can't
    know the universe of teams without consulting the source, so this
    issues a single (cheap, cache-aware) listing call via the registry's
    public listing helper. Failures are swallowed by
    :meth:`LazyTeamRegistry.list_team_summaries` — the 404 still
    surfaces, just without the hint.
    """
    summaries = await registry.list_team_summaries(project_id)
    ids: list[str] = []
    for s in summaries:
        tid = s.get("id") or s.get("team_id") or s.get("teamId")
        if tid:
            ids.append(str(tid))
    return ids


async def _ensure_default_team_materialised(
    registry: LazyTeamRegistry, project_id: str, *, query_options: QueryOptions | None = None
) -> TeamBundle | None:
    """Return the project's default ``TeamBundle``, materialising it on
    demand from the source listing when no team has been warmed yet.

    Lazy mode keeps the inner registry empty at startup, so
    ``default_for_project`` returns ``None`` until something is loaded.
    For legacy ``/projects/{pid}/agents/{aid}/invoke`` routes (whose
    file-mode contract is "use the project's default team"), pull the
    first id off the source listing and materialise it. Idempotent —
    repeated callers see the cached bundle.

    When ``staging=='playground'`` the already-materialised default fast
    path is skipped so the default team is re-fetched and rebuilt fresh,
    and the per-team build itself bypasses both cache layers (it returns
    a request-scoped bundle without an ``add()``).
    """
    if query_options is None or query_options.staging != "playground":
        default = registry.default_for_project(project_id)
        if default is not None:
            return default
    summaries = await registry.list_team_summaries(project_id)
    if not summaries:
        logger.warning(
            "default_team_listing_failed",
            project_id=project_id,
            error="empty or unavailable",
        )
        return None
    for summary in summaries:
        team_id = summary.get("id") or summary.get("team_id") or summary.get("teamId")
        if not team_id:
            continue
        bundle = await registry.get_or_load_team(
            project_id, str(team_id), query_options=query_options
        )
        if bundle is not None:
            return bundle
    return None


def _resolve_via_eager(
    registry: TeamRegistry,
    *,
    project_id: str,
    team_id: str | None,
) -> TeamBundle:
    """Legacy eager-registry path — preserved unchanged for callers that
    construct a plain :class:`TeamRegistry` (e.g. tests, the file-only
    pre-migration path).
    """
    if not registry.teams:
        raise HTTPException(status_code=503, detail={"error": "No teams loaded"})

    if not registry.has_project(project_id):
        raise HTTPException(
            status_code=404,
            detail={
                "error": f"Unknown project_id '{project_id}'",
                "available_projects": registry.project_ids(),
            },
        )

    if team_id is None:
        bundle = registry.default_for_project(project_id)
        if bundle is None:
            raise HTTPException(
                status_code=404,
                detail={"error": f"Project '{project_id}' has no teams"},
            )
    else:
        bundle = registry.get_in_project(project_id, team_id)
        if bundle is None:
            raise HTTPException(
                status_code=404,
                detail={
                    "error": (f"Unknown team_id '{team_id}' for project '{project_id}'"),
                    "available_teams": registry.team_ids_for_project(project_id),
                },
            )
    return bundle


async def _record_actual_token_usage(
    *,
    session_manager: Any | None,  # noqa: ANN401  # SessionManager imported lazily
    session_id: str | None,
    usage: Any | None,  # noqa: ANN401  # TokenUsage; loose to avoid framework import
    agent_response: Any,  # noqa: ANN401  # placeholder for future per-message annotations
) -> None:
    """Backfill ``tokens_actual`` on the last user/assistant messages.

    Phase 3 (MEM-3.1): the LLM gateway reports real prompt + completion
    token counts on every invocation. The route handler hands the
    gateway-reported numbers off to
    :meth:`SessionManager.record_token_usage`, which performs the
    backfill atomically (under the manager's own lock, via the normal
    save path so cap-enforcement and ``memory_degraded`` flagging both
    apply).

    Token accounting is best-effort -- a store failure flips
    ``memory_degraded`` on the request but never blocks the response.

    Args:
        session_manager: The team's session manager. ``None`` skips.
        session_id: The fully-scoped session id used for this turn.
            ``None`` skips (session-less invocation).
        usage: ``TokenUsage`` from the agent response. ``None`` skips.
        agent_response: The agent response (unused today; reserved for
            future per-message annotations).
    """
    _ = agent_response
    if session_manager is None or not session_id or usage is None:
        return
    prompt_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
    completion_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
    if prompt_tokens <= 0 and completion_tokens <= 0:
        return
    try:
        await session_manager.record_token_usage(
            session_id,
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
        )
    except Exception as exc:  # noqa: BLE001
        # ``record_token_usage`` already flips memory_degraded for every
        # store error it sees. This outer catch covers programmer-error
        # cases (e.g. someone monkey-patched a method that raises before
        # it can flag) so token accounting never breaks the response.
        logger.debug(
            "tokens_actual_route_dispatch_failed",
            session_id=session_id,
            error=str(exc),
        )


async def _persist_assistant_metadata(
    *,
    session_manager: Any | None,  # noqa: ANN401
    session_id: str | None,
    agent_response: Any,  # noqa: ANN401  # AgentResponse
    memory_degraded_flag: bool,
) -> None:
    """Upgrade the just-appended assistant message's metadata in-place
    (§B9 / §5.6.4).

    The framework adapter (SK / Echo / future) appends a bare
    assistant ``ConversationMessage`` inside its own session handling
    so the conversation transcript is self-contained even when the
    adapter is exercised outside an HTTP route. The route layer is the
    only place that has both the final
    :class:`~agent_service_maf.core.interfaces.AgentResponse` **and** the
    per-request ``memory_degraded`` flag, so this is where we enrich
    the persisted message with the full
    :class:`~agent_service_maf.interface_layer.models.AssistantMessageMetadata`
    block (citations, toolCalls, usage, durationMs, traceId,
    parsedOutput, memoryDegraded).

    Storage is best-effort: a failure flips ``memory_degraded`` via
    :meth:`SessionManager.update_last_assistant_metadata` but never
    raises -- the response has already been computed and the client
    should still see it.

    Args:
        session_manager: The team's session manager (``None`` skips).
        session_id: Scoped session id used for the turn. ``None`` skips
            (session-less invocation).
        agent_response: The adapter's
            :class:`~agent_service_maf.core.interfaces.AgentResponse`.
        memory_degraded_flag: Per-request ``memory_degraded`` captured
            after token-usage backfill so the stored block matches what
            the live response surfaced.
    """
    if session_manager is None or not session_id or agent_response is None:
        return

    tool_calls = None
    citations = getattr(agent_response, "citations", None)
    if citations is not None:
        steps = getattr(citations, "agent_trace", []) or []
        denormalized = [
            execution
            for step in steps
            for execution in (getattr(step, "tool_executions", []) or [])
        ]
        if denormalized:
            tool_calls = denormalized

    metadata = AssistantMessageMetadata(
        duration_ms=getattr(agent_response, "duration_ms", None),
        usage=getattr(agent_response, "usage", None),
        citations=citations,
        trace_id=getattr(agent_response, "trace_id", None),
        tool_calls=tool_calls,
        parsed_output=getattr(agent_response, "parsed_output", None),
        memory_degraded=memory_degraded_flag,
    )
    try:
        await session_manager.update_last_assistant_metadata(session_id, metadata)
    except Exception as exc:  # noqa: BLE001
        # update_last_assistant_metadata already flips memory_degraded on
        # store error; this outer catch covers programmer-error paths so
        # the response is never blocked by metadata persistence.
        logger.debug(
            "assistant_metadata_route_dispatch_failed",
            session_id=session_id,
            error=str(exc),
        )


def _resolve_user_id(request: Request) -> str:
    """Best-effort user-id resolution for session scoping.

    Priority:

    1. ``request.state.user_id`` -- populated by the auth middleware
       when JWT / OIDC integration is wired (future work).
    2. ``request.state.claims['sub']`` -- the API-key middleware AND
       the §B1 :class:`~agent_service_maf.interface_layer.auth.GatewayIdentityAuthMiddleware`
       both stash their resolved principal under ``"sub"``. With the
       gateway scheme this is the authoritative ``X-User-ID``.
    3. ``X-User-ID`` HTTP header -- **dev / no-auth fallback only**.
       When auth is enabled this path should never be hit because the
       middleware already promoted the header to ``claims['sub']``.
       Emits a warning so an auth-enabled production deployment that
       accidentally falls through here is visible in logs.
    4. Empty string -- dev fallback (single-user laptop, no auth).

    The resolved id is rejected if it contains ``':'``. The scoped
    session key is colon-delimited (``scope:project:anchor:user:sid``)
    and parsed with ``str.split(':', 4)``, so a colon in ``user_id``
    would shift segments and could collapse two users' partitions into
    a single key. We reject at the boundary instead of escaping so the
    rule is visible to clients and keys remain a 1:1 mapping with the
    auth principal.

    Returns:
        The resolved user id, or ``""`` when none can be determined.
        Callers pass this verbatim to
        :meth:`TeamBundle.scoped_session_id`, which itself decides how
        to handle the empty case.

    Raises:
        HTTPException: 400 when the resolved user id contains ``':'``.
    """
    state_user_id = getattr(request.state, "user_id", None)
    if state_user_id:
        return _validate_user_id(str(state_user_id))
    claims = getattr(request.state, "claims", None)
    if isinstance(claims, dict):
        sub = claims.get("sub") or claims.get("user_id")
        if sub:
            return _validate_user_id(str(sub))
    header = request.headers.get("x-user-id")
    if header:
        # §C4 — direct-header fallback. Acceptable in dev / no-auth
        # mode. If auth is enabled and we still landed here the
        # middleware never ran (mis-mounted) or wasn't the gateway
        # scheme; surface that as a warning so it's visible in prod
        # logs.
        scheme = (claims or {}).get("scheme") if isinstance(claims, dict) else None
        if scheme not in (None, "gateway_identity"):
            logger.warning(
                "_resolve_user_id falling back to X-User-ID header even though "
                "auth is enabled — gateway_identity middleware did not set claims['sub']",
                scheme=scheme,
                path=str(request.url.path),
            )
        return _validate_user_id(header.strip())
    return ""


# ---------------------------------------------------------------------------
# §C1 — Project access validator + identity binding
# ---------------------------------------------------------------------------


def validate_project_access(
    request: Request,
    url_project_id: str,
    resource_project_id: str | None = None,
) -> IdentityContext:
    """§3 / §C1 — Resolve identity, enforce URL ↔ header project parity, and
    optionally validate that the resolved resource belongs to the URL's project.

    Implements the three rules from §3 of the plan:

    1. When ``X-Project-ID`` is supplied via the gateway, it MUST match
       the URL path's ``url_project_id`` -- mismatch → 403.
    2. When ``X-Project-ID`` is empty, the URL path is the source of
       truth: the returned :class:`IdentityContext` is a frozen-copy
       with ``project_id=url_project_id`` and the bound copy is
       written back to ``request.state.claims["_identity"]`` so any
       later read sees the consistent value.
    3. When ``resource_project_id`` is supplied (e.g. a team / agent
       bundle's own ``project_id``), it must equal ``url_project_id``
       -- mismatch → 403. This generalizes the previous async-task
       cross-project check (`routes.py:1520`) to invokes / streams /
       sessions.

    When no identity is bound (NoopAuthMiddleware on local dev, or a
    test that bypasses the middleware), a synthetic
    :class:`IdentityContext` is built from
    ``user_id=_resolve_user_id(request)`` and the URL's
    ``project_id``. This preserves the dev-mode workflow: routes that
    used to read ``_resolve_user_id`` continue to work without an
    explicit auth provider.

    Args:
        request: FastAPI request whose ``request.state.claims`` was
            populated by the auth middleware.
        url_project_id: The ``{project_id}`` path parameter on this
            route.
        resource_project_id: Optional. The ``project_id`` recorded on
            the resolved resource (team / agent / task). When supplied
            and non-empty, must equal ``url_project_id``.

    Returns:
        The bound :class:`IdentityContext` (frozen). Caller should
        push it into the ContextVar via
        :func:`agent_service_maf.core.identity.set_current_identity`
        and attach it to :class:`AgentExecutionContext.identity`.

    Raises:
        HTTPException(403): on any of the three mismatches above.
    """
    claims = getattr(request.state, "claims", None) or {}
    identity = claims.get("_identity") if isinstance(claims, dict) else None

    # Synthesize an IdentityContext for dev / no-auth paths so the rest
    # of the request lifecycle has a uniform identity carrier. The
    # synthetic identity has no user_token / email / name -- only the
    # information the route legitimately knows from the URL + the
    # fallback ``X-User-ID`` header (via ``_resolve_user_id``).
    if not isinstance(identity, IdentityContext):
        fallback_user_id = _resolve_user_id(request)
        identity = IdentityContext(
            user_id=fallback_user_id or "",
            project_id=url_project_id,
        )

    # Rule 1 — header-supplied project must match the URL.
    if identity.project_id and identity.project_id != url_project_id:
        logger.warning(
            "validate_project_access_url_header_mismatch",
            url_project_id=url_project_id,
            header_project_id=identity.project_id,
            user_id=identity.user_id,
            correlation_id=identity.correlation_id,
        )
        raise HTTPException(
            status_code=403,
            detail={
                "error": "Project access denied",
                "detail": {
                    "urlProjectId": url_project_id,
                    "headerProjectId": identity.project_id,
                },
            },
        )

    # Rule 2 — fill empty project_id from the URL path.
    if not identity.project_id:
        identity = identity.model_copy(update={"project_id": url_project_id})
        if isinstance(claims, dict):
            claims["_identity"] = identity
            request.state.claims = claims

    # Rule 3 — resource must belong to the URL's project.
    if resource_project_id and resource_project_id != url_project_id:
        logger.warning(
            "validate_project_access_resource_mismatch",
            url_project_id=url_project_id,
            resource_project_id=resource_project_id,
            user_id=identity.user_id,
            correlation_id=identity.correlation_id,
        )
        raise HTTPException(
            status_code=403,
            detail={
                "error": "Resource does not belong to this project",
                "detail": {
                    "urlProjectId": url_project_id,
                    "resourceProjectId": resource_project_id,
                },
            },
        )

    # §H2 — bind audit breadcrumbs into the per-task structlog context
    # so every subsequent log line in this asyncio task carries the
    # identity envelope without each call site having to pass it
    # explicitly. We intentionally bind only ``user_id`` /
    # ``project_id`` / ``correlation_id`` -- never ``user_email`` /
    # ``user_name`` (PII) or ``user_token`` (secret; the §H1 redactor
    # would mask it anyway but pruning early is cheaper).
    # ``bind_contextvars`` overwrites the same keys for nested
    # requests; that's intentional since each request runs on its own
    # asyncio task and the binding is reset by the surrounding
    # ``reset_current_identity`` finally block.
    structlog.contextvars.bind_contextvars(
        user_id=identity.user_id,
        project_id=identity.project_id,
        correlation_id=identity.correlation_id,
    )

    return identity


def _validate_user_id(user_id: str) -> str:
    """Reject user ids containing the scoped-key delimiter.

    See :func:`_resolve_user_id` for the partition-collapse rationale.
    """
    if ":" in user_id:
        raise HTTPException(
            status_code=400,
            detail={"error": "user id may not contain ':'"},
        )
    return user_id


async def _build_context(
    request: Request,
    invoke_req: InvokeRequest,
    project_id: str,
    team_id: str | None = None,
    *,
    scope: SessionScope = "team",
    agent_id_for_scope: str | None = None,
    identity: IdentityContext | None = None,
    bundle: TeamBundle | None = None,
) -> AgentExecutionContext:
    """Build an :class:`~agent_service_maf.core.context.AgentExecutionContext`
    scoped to the resolved team.

    Resolves the 3-tier config merge (env → team JSON → request overrides)
    using the team's own ConfigLoader, and constructs the context with the
    team's gateway, MCP registry, guardrails, and session manager.

    The returned context's ``session_id`` is prefixed with the appropriate
    scope tuple by :meth:`TeamBundle.scoped_session_id` -- team-anchored
    when ``scope='team'`` (the default), agent-anchored when the route
    names a specific agent. The user_id partition comes from
    :func:`_resolve_user_id`.

    Args:
        request: The incoming FastAPI request. Used to access ``app.state.teams``.
        invoke_req: The parsed request body providing ``config_overrides``,
            ``metadata``, and ``session_id``.
        project_id: Project path parameter.
        team_id: Team path parameter, or ``None`` to use the project's default.
        scope: ``"team"`` (default) for team routes, ``"agent"`` for
            agent-specific routes.
        agent_id_for_scope: The agent id used as the scope anchor when
            ``scope='agent'``. Ignored for team scope.
        bundle: Optional pre-resolved :class:`TeamBundle`. When provided
            (the invoke / stream call sites already resolved it once to
            run :func:`validate_project_access`), it is reused verbatim so
            the bundle is **not** resolved a second time. This is required
            for the ``staging=playground`` path \u2014 a second resolution
            would trigger a redundant fresh fetch + MCP connect \u2014 and is a
            harmless micro-optimisation on the cached ``default`` path.
            When ``None`` the bundle is resolved here (back-compat for any
            caller that does not pre-resolve).

    Returns:
        A fully constructed :class:`~agent_service_maf.core.context.AgentExecutionContext`
        with a new auto-generated UUID4 ``correlation_id``.

    Raises:
        HTTPException: 404 if ``project_id`` or ``team_id`` is unknown; 503 if
            no teams loaded or the resolved team is unhealthy.
        ConfigurationError: If config merge fails validation.
    """
    if bundle is None:
        bundle = await _resolve_team(
            request,
            project_id,
            team_id,
            scope=scope,
            agent_id=agent_id_for_scope,
        )
    overrides = invoke_req.config_overrides
    request_overrides_dict = config_overrides_to_request_dict(overrides)
    base_config = bundle.config_loader.resolve(
        request_overrides=request_overrides_dict or None,
    )
    # Apply per-agent (and manager) overrides post-resolve since the
    # semantic_kernel.agents list cannot be deep-merged. See §5.1.4 of
    # the migration plan and `_override_applier` for the precedence
    # rules.
    config = apply_per_agent_overrides(
        base_config,
        overrides,
        is_team_invoke=(scope == "team"),
    )
    # Identity is authoritative for user-id partitioning when bound.
    # ``identity.user_id`` is required-truthy at the auth-middleware
    # boundary; fall back to ``_resolve_user_id`` only when no identity
    # was bound (NoopAuthMiddleware / dev path).
    if identity is None:
        identity = get_current_identity()
    user_id = identity.user_id if identity is not None else _resolve_user_id(request)
    # If the caller did not supply a session_id we mint one so the
    # response carries a stable handle the client can replay on
    # subsequent turns. The raw form (pre-scope) is what we hand back
    # in the API response; the scoped form is what goes into storage.
    raw_session_id = invoke_req.session_id or uuid.uuid4().hex
    scoped_id = bundle.scoped_session_id(
        raw_session_id,
        scope=scope,
        agent_id=agent_id_for_scope,
        user_id=user_id or None,
    )
    correlation_id = (
        identity.correlation_id
        if identity is not None and identity.correlation_id
        else str(uuid.uuid4())
    )
    return AgentExecutionContext(
        config=config,
        gateway=bundle.gateway,
        mcp_registry=bundle.mcp_manager,
        guardrails=bundle.guardrails,
        session_manager=bundle.session_manager,
        request_metadata=invoke_req.metadata,
        session_id=scoped_id,
        correlation_id=correlation_id,
        identity=identity,
    )


# ---------------------------------------------------------------------------
# Project / team discovery
# ---------------------------------------------------------------------------


@api_router.get(
    "/projects/{project_id}/agent-teams",
    summary="List teams in a project",
    description=(
        "Return all teams registered under the project at startup, with their "
        "health and orchestration metadata."
    ),
)
async def list_teams(project_id: str, request: Request) -> dict[str, Any]:
    """List all teams registered under ``project_id``.

    For the legacy eager registry, iterates the bundles that were loaded
    at startup. For the lazy registry (config-service migration), fetches
    the team listing from the source and materialises each entry — so
    the response shape stays the same whether teams were pre-warmed or
    not.

    Returns:
        Dict with ``teams`` (array of team summaries), ``total`` (count),
        ``project_id``, and ``default_team_id`` (the team used by
        ``/projects/{project_id}/agents/*`` routes that omit team_id).
    """
    registry = _require_known_project(request, project_id)
    if isinstance(registry, LazyTeamRegistry):
        bundles = await registry.list_teams_for_project(project_id)
    else:
        bundles = registry.teams_for_project(project_id)
    default_bundle = registry.default_for_project(project_id)
    return {
        "project_id": project_id,
        "teams": [b.to_public_dict() for b in bundles],
        "total": len(bundles),
        "default_team_id": default_bundle.team_id if default_bundle else "",
    }


@api_router.get(
    "/projects/{project_id}/agent-teams/{team_id}",
    summary="Get team detail",
    description=(
        "Return the team's non-sensitive metadata (agents, model, orchestration). "
        "404 if the team is not registered under this project."
    ),
)
async def get_team(
    project_id: str,
    team_id: str,
    request: Request,
) -> dict[str, Any]:
    """Return a single team's public metadata."""
    bundle = await _resolve_team(request, project_id, team_id)
    return bundle.to_public_dict()


# ---------------------------------------------------------------------------
# Team invocation
# ---------------------------------------------------------------------------


@api_router.post(
    "/projects/{project_id}/agent-teams/{team_id}/invoke",
    response_model=InvokeResponse,
    summary="Invoke a team",
    description="Invoke the orchestration pipeline of the team identified by team_id.",
)
async def invoke_team(
    project_id: str,
    team_id: str,
    body: InvokeRequest,
    request: Request,
) -> InvokeResponse:
    """Invoke a specific team's orchestration pipeline."""
    return await _invoke_impl(request, body, project_id=project_id, team_id=team_id)


@api_router.post(
    "/projects/{project_id}/agent-teams/{team_id}/invoke/stream",
    summary="Stream a team's orchestration via SSE",
    description="SSE streaming variant of /projects/{project_id}/agent-teams/{team_id}/invoke.",
)
async def stream_team(
    project_id: str,
    team_id: str,
    body: InvokeRequest,
    request: Request,
) -> EventSourceResponse:
    """Stream a specific team's orchestration via SSE."""
    return await _stream_impl(request, body, project_id=project_id, team_id=team_id)


@api_router.websocket("/projects/{project_id}/agent-teams/{team_id}/ws")
async def websocket_team(
    websocket: WebSocket,
    project_id: str,
    team_id: str,
) -> None:
    """Bidirectional WebSocket session for a specific team.

    Authenticates the handshake using the app's auth provider before
    accepting the socket. On auth failure the connection is closed with
    code 4401 by :func:`_authenticate_websocket` and we return early —
    do NOT call ``websocket.accept()`` in that path.
    """
    if not await _authenticate_websocket(websocket):
        return
    await websocket.accept()
    try:
        await handle_websocket_session(
            websocket=websocket,
            agent_id="orchestrator",
            app=websocket.app,
            project_id=project_id,
            team_id=team_id,
            scope="team",
        )
    except WebSocketDisconnect:
        logger.info("WebSocket disconnected", project_id=project_id, team_id=team_id)


# ---------------------------------------------------------------------------
# Shared invocation implementation
# ---------------------------------------------------------------------------


async def _invoke_impl(
    request: Request,
    body: InvokeRequest,
    *,
    project_id: str,
    team_id: str | None,
    agent_id: str = "orchestrator",
    scope: SessionScope = "team",
) -> InvokeResponse:
    """Shared synchronous invocation used by both ``/agent-teams/{team_id}/invoke``
    and the project-default ``/agents/...`` aliases.

    The only difference between call sites is whether ``team_id`` is supplied
    by the URL or resolved to the project's default, and which session scope
    the conversation belongs to. Agent-specific routes pass ``scope='agent'``
    so the session is partitioned by ``agent_id``.
    """
    start = time.monotonic()
    context: AgentExecutionContext | None = None
    # Reset the per-request memory_degraded flag so prior failures from
    # an earlier request that ran on this asyncio context don't leak.
    reset_memory_degraded()
    logger.info(
        "Invocation started",
        project_id=project_id,
        team_id=team_id or "<project-default>",
        agent_id=agent_id,
        scope=scope,
        session_id=body.session_id,
        input_chars=len(body.input or ""),
    )
    # §Task005 — parse the optional ``?staging=`` flag once. ``playground``
    # bypasses both config caches for this request; everything else is the
    # unchanged cached path.
    query_options = QueryOptions.from_query_params(request.query_params)
    # §C2 — resolve team early so we can pass the bundle's project_id
    # into :func:`validate_project_access` as the resource_project_id.
    # 404 / 503 propagate untouched.
    bundle = await _resolve_team(
        request,
        project_id,
        team_id,
        scope=scope,
        agent_id=agent_id if scope == "agent" else None,
        query_options=query_options,
    )
    identity = validate_project_access(
        request,
        url_project_id=project_id,
        resource_project_id=bundle.project_id,
    )
    # §C2 — bind ContextVar for the lifetime of the invocation so any
    # function tools, gateway calls, and MCP transport wrappers reached
    # through ``await agent.invoke(...)`` see this identity via
    # :func:`get_current_identity`.
    # Bind the raw (un-scoped) session id so the Phoenix span processor stamps session.id on spans.
    raw_session_id = body.session_id or uuid.uuid4().hex
    body = body.model_copy(update={"session_id": raw_session_id})
    identity_token = set_current_identity(
        identity.model_copy(update={"session_id": raw_session_id})
    )
    try:
        # Resolve every override model through the model catalog so the
        # downstream merge sees the Bifrost-routable id (e.g. the
        # catalog UUID is replaced by the model's gatewayModelId). With
        # the file-mode NoopModelCatalog this is observability-only;
        # with ConfigServiceModelCatalog it makes
        # ``configOverrides.model`` actually work for callers (eval-
        # worker, UI playground) that pass catalog UUIDs.
        body.config_overrides = await validate_overrides_against_catalog(
            body.config_overrides,
            _get_model_catalog(request),
            project_id,
        )
        context = await _build_context(
            request,
            body,
            project_id=project_id,
            team_id=team_id,
            scope=scope,
            agent_id_for_scope=agent_id if scope == "agent" else None,
            identity=identity,
            # Reuse the bundle resolved above so the playground bypass
            # does not re-fetch / re-build, and the cached path skips a
            # redundant registry lookup.
            bundle=bundle,
        )
        guardrails = context.guardrails
        guardrail_ctx: dict[str, str] = {"correlation_id": context.correlation_id}

        effective_input = body.input
        if guardrails is not None:
            effective_input = await guardrails.check_input(
                input_text=body.input,
                agent_id=agent_id,
                context=guardrail_ctx,
            )

        registry = request.app.state.framework_registry
        agent = registry.create(context.config.agent.framework, context.config)
        await agent.initialize(context)

        agent_request = AgentRequest(
            agent_id=agent_id,
            input=effective_input,
            context=body.context,
            config_overrides=config_overrides_to_agent_request_dict(body.config_overrides),
            session_id=context.session_id,  # already team-prefixed
            metadata=body.metadata,
        )
        response = await agent.invoke(agent_request, context)
        response.duration_ms = int((time.monotonic() - start) * 1000)

        if guardrails is not None:
            sanitized_output = await guardrails.check_output(
                output_text=response.output,
                agent_id=agent_id,
                original_input=body.input,
                context=guardrail_ctx,
            )
            response = response.model_copy(update={"output": sanitized_output})

        # Phase 3 (MEM-3.1): write gateway-reported token counts onto the
        # last user and assistant messages so memory accounting reflects
        # the real bill rather than estimates. Run this BEFORE capturing
        # ``memory_degraded`` so a failure during the token-usage save
        # (which flips the per-request degraded flag) is reflected in
        # the response and the completion log -- otherwise the client
        # sees ``memory_degraded=false`` even though the backfill
        # silently failed.
        await _record_actual_token_usage(
            session_manager=context.session_manager,
            session_id=context.session_id,
            usage=response.usage,
            agent_response=response,
        )

        degraded = memory_degraded()
        await _persist_assistant_metadata(
            session_manager=context.session_manager,
            session_id=context.session_id,
            agent_response=response,
            memory_degraded_flag=degraded,
        )
        logger.info(
            "Invocation completed",
            project_id=project_id,
            team_id=team_id or "<project-default>",
            agent_id=agent_id,
            orchestration_type=context.config.semantic_kernel.orchestration.type,
            duration_ms=response.duration_ms,
            correlation_id=context.correlation_id,
            memory_degraded=degraded,
        )
        # Return the raw (un-scoped) session id so the client can replay
        # it on the next turn without double-scoping. Falls back to the
        # response's own session_id (already raw) when context never had
        # one bound.
        echoed_session_id = (
            _strip_scope(context.session_id) if context.session_id else response.session_id
        )
        api_response = InvokeResponse.from_agent_response(
            response,
            session_id=echoed_session_id,
        )
        if degraded:
            api_response = api_response.model_copy(update={"memory_degraded": True})
        return api_response

    except HTTPException:
        # Let 404/503 from _resolve_team (and any other pre-wrapped HTTP errors)
        # propagate untouched — re-wrapping would turn them into 500s.
        raise
    except GuardrailError as exc:
        correlation_id = context.correlation_id if context else ""
        raise HTTPException(
            status_code=400,
            detail=SafeErrorFormatter.format_error(
                exc,
                is_dev=getattr(request.app, "debug", False),
                correlation_id=correlation_id,
            ),
        ) from exc
    except FrameworkNotFoundError as exc:
        correlation_id = context.correlation_id if context else ""
        raise HTTPException(
            status_code=404,
            detail=SafeErrorFormatter.format_error(
                exc,
                is_dev=getattr(request.app, "debug", False),
                correlation_id=correlation_id,
            ),
        ) from exc
    except AgentTimeoutError as exc:
        # Surface timeouts as HTTP 504 Gateway Timeout rather than 500.
        # ``AgentTimeoutError`` represents a downstream timeout (LLM /
        # MCP / tool call exceeding ``agent.timeout_seconds``) — clients,
        # retry/backoff logic, and monitoring depend on this distinction.
        # Must precede ``AgentFrameworkError`` since the latter is a
        # superclass.
        correlation_id = context.correlation_id if context else ""
        raise HTTPException(
            status_code=504,
            detail=SafeErrorFormatter.format_error(
                exc,
                is_dev=getattr(request.app, "debug", False),
                correlation_id=correlation_id,
            ),
        ) from exc
    except AgentFrameworkError as exc:
        correlation_id = context.correlation_id if context else ""
        raise HTTPException(
            status_code=500,
            detail=SafeErrorFormatter.format_error(
                exc,
                is_dev=getattr(request.app, "debug", False),
                correlation_id=correlation_id,
            ),
        ) from exc
    except Exception as exc:
        correlation_id = context.correlation_id if context else ""
        logger.error(
            "Unexpected error in _invoke_impl",
            project_id=project_id,
            team_id=team_id or "<project-default>",
            error_type=type(exc).__name__,
            correlation_id=correlation_id,
        )
        raise HTTPException(
            status_code=500,
            detail=SafeErrorFormatter.format_error(
                exc,
                is_dev=getattr(request.app, "debug", False),
                correlation_id=correlation_id,
            ),
        ) from exc
    finally:
        # §C2 — always restore the prior identity binding even on early
        # exits. The token is set before the try block so a raise from
        # ``validate_overrides_against_catalog`` or ``_build_context``
        # still hits this branch via the surrounding finally.
        reset_current_identity(identity_token)


async def _stream_impl(
    request: Request,
    body: InvokeRequest,
    *,
    project_id: str,
    team_id: str | None,
    agent_id: str = "orchestrator",
    scope: SessionScope = "team",
) -> EventSourceResponse:
    """Shared SSE streaming implementation used by ``/agent-teams/{team_id}/stream``
    and the project-default ``/agents/stream`` aliases.

    Made async so it can ``await`` :func:`_resolve_team`'s lazy
    materialisation path (the legacy eager registry is still served on
    the same call — the ``await`` is essentially free when the bundle is
    already cached).
    """
    # §C3 — validate project access + bind identity into the SSE
    # generator. The generator can outlive the route handler (sse-starlette
    # iterates it after this function returns), so we bind / reset the
    # ContextVar **inside** the generator wrapper rather than around the
    # ``EventSourceResponse`` constructor. Otherwise any tool / gateway
    # call made downstream by the adapter wouldn't see the identity.
    query_options = QueryOptions.from_query_params(request.query_params)
    bundle = await _resolve_team(
        request,
        project_id,
        team_id,
        scope=scope,
        agent_id=agent_id if scope == "agent" else None,
        query_options=query_options,
    )
    identity = validate_project_access(
        request,
        url_project_id=project_id,
        resource_project_id=bundle.project_id,
    )
    context = await _build_context(
        request,
        body,
        project_id=project_id,
        team_id=team_id,
        scope=scope,
        agent_id_for_scope=agent_id if scope == "agent" else None,
        identity=identity,
        # Reuse the bundle resolved above (playground-aware) so the SSE
        # path does not resolve / rebuild a second time.
        bundle=bundle,
    )
    logger.info(
        "Stream started",
        project_id=project_id,
        team_id=team_id or "<project-default>",
        agent_id=agent_id,
        scope=scope,
        session_id=context.session_id,
        orchestration_type=context.config.semantic_kernel.orchestration.type,
        input_chars=len(body.input or ""),
    )
    agent_request = AgentRequest(
        agent_id=agent_id,
        input=body.input,
        context=body.context,
        config_overrides=config_overrides_to_agent_request_dict(body.config_overrides),
        session_id=context.session_id,  # team-prefixed
        metadata=body.metadata,
    )
    inner_generator = create_sse_generator(
        registry=request.app.state.framework_registry,
        agent_request=agent_request,
        context=context,
    )

    # Playground invocations bypass the bundle registry/cache (see
    # ``_ensure_default_team_materialised``), so this bundle is request-scoped
    # and nothing else ever tears down its MCP connections. Release them when
    # the stream ends (normal completion OR client disconnect) so each
    # playground run reconnects fresh with the latest config and we don't leak
    # an owner task + endpoint connection per invocation.
    is_playground = query_options.staging == "playground"

    async def _generator_with_identity() -> Any:  # noqa: ANN401
        # ContextVar binding scoped to the lifetime of the generator.
        # The generator (sse-starlette consumer side) runs *after* this
        # outer function returns, so binding inside is the only way to
        # propagate identity to the adapter.stream / gateway / MCP
        # calls reached from within. See §C3 of the plan.
        # Stamp the raw (un-scoped) session id — the same id echoed to the
        # client — so spans carry ``session.id`` for session -> trace lookups.
        tok = set_current_identity(
            identity.model_copy(
                update={
                    "session_id": _strip_scope(context.session_id) if context.session_id else ""
                }
            )
        )
        try:
            async for chunk in inner_generator:
                yield chunk
        finally:
            reset_current_identity(tok)
            if is_playground and bundle.mcp_manager is not None:
                # Safe from this finalizer task: disconnect_all only *signals*
                # the MCP owner task, which exits the transport contexts in its
                # own task — no cross-task cancel-scope RuntimeError (the anyio
                # crash / 100% CPU spin). See MCPConnectionManager._owner_loop.
                try:
                    await bundle.mcp_manager.disconnect_all()
                except asyncio.CancelledError:
                    # Stream cancellation (client disconnect) must propagate,
                    # never be masked — re-raise explicitly. (On 3.11 this isn't
                    # caught by `except Exception`, but be explicit and robust.)
                    raise
                except Exception as exc:  # best effort; never mask stream outcome
                    logger.warning(
                        "playground MCP teardown failed",
                        project_id=project_id,
                        team_id=team_id,
                        error=str(exc),
                    )

    return EventSourceResponse(_generator_with_identity())


# ---------------------------------------------------------------------------
# Project-default agent endpoints (no team_id — use project's default team)
#
# NOTE: These must be defined BEFORE /agents/{agent_id}/* routes so that
# FastAPI does not match "invoke" or "stream" as an agent_id value.
# ---------------------------------------------------------------------------


@api_router.post(
    "/projects/{project_id}/agents/invoke",
    response_model=InvokeResponse,
    summary="Invoke the project's default team",
    description=(
        "Invoke the orchestration pipeline of the project's default team without "
        "specifying a team_id. Prefer /projects/{project_id}/agent-teams/{team_id}/invoke "
        "for explicit team selection."
    ),
)
async def invoke_orchestrated(
    project_id: str,
    body: InvokeRequest,
    request: Request,
) -> InvokeResponse:
    """Invoke the project's default team."""
    return await _invoke_impl(request, body, project_id=project_id, team_id=None)


@api_router.post(
    "/projects/{project_id}/agents/invoke/stream",
    summary="Stream the project's default team via SSE",
    description=(
        "SSE streaming variant routed to the project's default team. "
        "Prefer /projects/{project_id}/agent-teams/{team_id}/invoke/stream."
    ),
)
async def stream_orchestrated(
    project_id: str,
    body: InvokeRequest,
    request: Request,
) -> EventSourceResponse:
    """Stream the project's default team via SSE."""
    return await _stream_impl(request, body, project_id=project_id, team_id=None)


# ---------------------------------------------------------------------------
# Agent-specific endpoints (project-scoped)
#
# These remain default-team aliases (per project) for back-compat with
# clients that address an agent inside the implicit default team.
# ---------------------------------------------------------------------------


@api_router.post(
    "/projects/{project_id}/agents/{agent_id}/invoke",
    response_model=InvokeResponse,
    summary="Synchronous agent invocation (project default team)",
    description="Invoke an agent on the project's default team and wait for the complete response.",
)
async def invoke_agent(
    project_id: str,
    agent_id: str,
    body: InvokeRequest,
    request: Request,
) -> InvokeResponse:
    """Project-scoped agent invoke — uses the project's default team.

    The session is agent-scoped (``scope='agent'``) so the conversation is
    a private one-on-one thread with this specific agent rather than the
    default team's shared session.
    """
    return await _invoke_impl(
        request,
        body,
        project_id=project_id,
        team_id=None,
        agent_id=agent_id,
        scope="agent",
    )


@api_router.post(
    "/projects/{project_id}/agents/{agent_id}/invoke/stream",
    summary="SSE streaming agent invocation (project default team)",
    description="Invoke an agent on the project's default team via SSE.",
)
async def stream_agent(
    project_id: str,
    agent_id: str,
    body: InvokeRequest,
    request: Request,
) -> EventSourceResponse:
    """Project-scoped agent SSE — uses the project's default team."""
    return await _stream_impl(
        request,
        body,
        project_id=project_id,
        team_id=None,
        agent_id=agent_id,
        scope="agent",
    )


@api_router.websocket("/projects/{project_id}/agents/{agent_id}/ws")
async def websocket_agent(
    websocket: WebSocket,
    project_id: str,
    agent_id: str,
) -> None:
    """Handle a bidirectional WebSocket session for agent invocation against
    the project's default team.

    Authenticates the handshake using the app's auth provider (the
    ``X-API-Key`` header by default) before accepting the socket. On auth
    failure the connection is closed with code 4401 by
    :func:`_authenticate_websocket` and the handler returns early.

    After accept: loops receiving JSON ``InvokeRequest`` messages and
    streams agent events back as JSON text frames. Per-IP connection
    limits and idle timeouts are enforced by the handler.

    Args:
        websocket: The incoming WebSocket connection.
        project_id: Project identifier from the URL path.
        agent_id: Agent identifier from the URL path.
    """
    if not await _authenticate_websocket(websocket):
        return
    await websocket.accept()
    try:
        await handle_websocket_session(
            websocket=websocket,
            agent_id=agent_id,
            app=websocket.app,
            project_id=project_id,
            scope="agent",
        )
    except WebSocketDisconnect:
        logger.info("WebSocket disconnected", project_id=project_id, agent_id=agent_id)


@api_router.get(
    "/projects/{project_id}/agents",
    response_model=AgentListResponse,
    summary="List registered agent frameworks",
    description=(
        "Returns all registered framework adapters with their capabilities. "
        "Frameworks are global (not per-project), but the project_id in the path "
        "is validated against the team registry; unknown projects return 404."
    ),
)
async def list_agents(project_id: str, request: Request) -> AgentListResponse:
    """List all registered agent framework adapters.

    Returns capability descriptors for every adapter registered via
    :meth:`~agent_service_maf.framework.registry.FrameworkRegistry.register`.

    Args:
        project_id: Project identifier — validated against the team registry.
        request: FastAPI request for accessing ``app.state.framework_registry``.

    Returns:
        :class:`~agent_service_maf.interface_layer.models.AgentListResponse` with
        ``agents`` list and ``total`` count.
    """
    _require_known_project(request, project_id)
    framework_registry = request.app.state.framework_registry
    agents = framework_registry.list_capabilities()
    return AgentListResponse(agents=agents, total=len(agents))


@api_router.get(
    "/projects/{project_id}/agents/{agent_id}/capabilities",
    summary="Get agent capabilities",
    description="Returns the capabilities of a specific registered agent.",
)
async def get_capabilities(
    project_id: str,
    agent_id: str,
    request: Request,
) -> dict[str, Any]:
    """Get capabilities for a specific registered agent adapter.

    Args:
        project_id: Project identifier — validated against the team registry.
        agent_id: Framework name to query (e.g., ``"echo"``, ``"maf"``).
        request: FastAPI request for accessing ``app.state``.

    Returns:
        Dict representation of :class:`~agent_service_maf.core.interfaces.AgentCapabilities`.

    Raises:
        HTTPException: 404 if the project or framework is not registered.
    """
    registry = _require_known_project(request, project_id)
    # Capability introspection needs *some* AgentConfig instance; prefer the
    # project's default team so the introspected adapter sees realistic config.
    default_bundle = registry.default_for_project(project_id)
    config = (
        default_bundle.config
        if default_bundle is not None and default_bundle.config is not None
        else request.app.state.config
    )
    framework_registry = request.app.state.framework_registry
    try:
        agent = framework_registry.create(agent_id, config)
        # §A1 / §5.2: AgentCapabilities is a CamelCaseModel; emit camelCase
        # keys on the wire so consumers parse it identically to every other
        # response model in the service.
        caps_dict: dict[str, Any] = agent.get_capabilities().model_dump(by_alias=True)
        return caps_dict
    except FrameworkNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Async invoke (fire-and-forget) + task polling
# ---------------------------------------------------------------------------
#
# Pattern: client POSTs to /invoke/async, gets a task_id back immediately
# (HTTP 202), then polls GET /tasks/{task_id} until the status is terminal.
# The background work runs through the same invocation pipeline as the
# synchronous routes -- guardrails, agent.invoke, output sanitization -- via
# ``_run_invocation_for_task``. Errors are persisted on the task rather than
# returned to the submitting HTTP call.
# ---------------------------------------------------------------------------


async def _resolve_team_for_async(
    request: Request,
    project_id: str,
    team_id: str | None,
    *,
    scope: SessionScope = "team",
    agent_id: str | None = None,
) -> TeamBundle:
    """Resolve a team and verify async-invoke is enabled on it.

    Mirrors :func:`_resolve_team` but additionally rejects teams whose
    ``tasks.enabled`` is False with HTTP 404 -- the route effectively
    does not exist for that team. Returns the resolved bundle for
    callers that need to construct a :class:`Task` with the canonical
    ``team_id``.

    Raises:
        HTTPException: 404 / 503 from :func:`_resolve_team`, or 404 if
            the team has no task manager.
    """
    bundle = await _resolve_team(request, project_id, team_id, scope=scope, agent_id=agent_id)
    if bundle.task_manager is None:
        raise HTTPException(
            status_code=404,
            detail={
                "error": "Async invoke is not enabled for this team",
                "hint": "Set tasks.enabled=true in the team config.",
            },
        )
    return bundle


async def _run_invocation_for_task(
    request: Request,
    body: InvokeRequest,
    *,
    project_id: str,
    team_id: str | None,
    agent_id: str,
    task: Task,
    scope: SessionScope = "team",
) -> dict[str, Any]:
    """Run an invocation and return the result as a dict for task persistence.

    Functionally equivalent to the body of :func:`_invoke_impl` but:

    - Returns a dict (serialisable into :attr:`Task.result`) instead of an
      :class:`~agent_service_maf.interface_layer.models.InvokeResponse`.
    - Uses the task's ``correlation_id`` for tracing continuity, so all spans
      emitted during the background run carry the same id as the original
      submit response.
    - Does **not** wrap exceptions in HTTPException -- the task manager
      catches them and records ``failed`` state instead.

    Args:
        request: The original FastAPI request (used to access ``app.state``).
        body: The original invoke payload (input, context, overrides, ...).
        project_id: Project that owns the team.
        team_id: Resolved team_id, or ``None`` for the project's default.
        agent_id: Agent identifier to record on the response.
        task: The persisted :class:`Task`; its ``correlation_id`` is used.

    Returns:
        The :class:`InvokeResponse`-shaped dict to persist as
        :attr:`Task.result`.
    """
    start = time.monotonic()
    reset_memory_degraded()

    # Resolve every override model through the catalog so downstream
    # merges see the routable id (see _invoke_impl for the contract).
    body.config_overrides = await validate_overrides_against_catalog(
        body.config_overrides,
        _get_model_catalog(request),
        project_id,
    )

    # Re-build the context using the task's correlation_id so logs and
    # spans emitted by the runner stitch back to the submit response.
    bundle = await _resolve_team(
        request,
        project_id,
        team_id,
        scope=scope,
        agent_id=agent_id if scope == "agent" else None,
    )
    overrides = body.config_overrides
    request_overrides_dict = config_overrides_to_request_dict(overrides)
    base_config = bundle.config_loader.resolve(
        request_overrides=request_overrides_dict or None,
    )
    config = apply_per_agent_overrides(
        base_config,
        overrides,
        is_team_invoke=(scope == "team"),
    )
    # §D2 — identity comes from the persisted task (captured at submit
    # time, snapshotted *before* the asyncio.create_task boundary so
    # the runner reconstructs the same user). The runner already
    # re-bound the ContextVar at the top of TaskManager._run via the
    # wrapped runner; ``get_current_identity()`` therefore matches
    # ``task.identity``. Use the task's identity verbatim — never the
    # ambient request, which may have already finished by the time we
    # run on the background asyncio task.
    identity = task.identity or get_current_identity()
    user_id = identity.user_id if identity is not None else _resolve_user_id(request)
    scoped_id = bundle.scoped_session_id(
        body.session_id,
        scope=scope,
        agent_id=agent_id if scope == "agent" else None,
        user_id=user_id or None,
    )
    context = AgentExecutionContext(
        config=config,
        gateway=bundle.gateway,
        mcp_registry=bundle.mcp_manager,
        guardrails=bundle.guardrails,
        session_manager=bundle.session_manager,
        request_metadata=body.metadata,
        session_id=scoped_id,
        correlation_id=task.correlation_id,
        identity=identity,
    )

    guardrails = context.guardrails
    guardrail_ctx: dict[str, str] = {"correlation_id": context.correlation_id}

    effective_input = body.input
    if guardrails is not None:
        effective_input = await guardrails.check_input(
            input_text=body.input,
            agent_id=agent_id,
            context=guardrail_ctx,
        )

    framework_registry = request.app.state.framework_registry
    agent = framework_registry.create(context.config.agent.framework, context.config)
    await agent.initialize(context)

    agent_request = AgentRequest(
        agent_id=agent_id,
        input=effective_input,
        context=body.context,
        config_overrides=config_overrides_to_agent_request_dict(body.config_overrides),
        session_id=context.session_id,
        metadata=body.metadata,
    )
    response = await agent.invoke(agent_request, context)
    response.duration_ms = int((time.monotonic() - start) * 1000)

    if guardrails is not None:
        sanitized_output = await guardrails.check_output(
            output_text=response.output,
            agent_id=agent_id,
            original_input=body.input,
            context=guardrail_ctx,
        )
        response = response.model_copy(update={"output": sanitized_output})

    # Mirror the sync path's ordering: record token usage BEFORE capturing
    # ``memory_degraded`` so a failure in the backfill save is reflected
    # in both the completion log and the task result that polling
    # clients eventually read.
    await _record_actual_token_usage(
        session_manager=context.session_manager,
        session_id=context.session_id,
        usage=response.usage,
        agent_response=response,
    )

    degraded = memory_degraded()
    await _persist_assistant_metadata(
        session_manager=context.session_manager,
        session_id=context.session_id,
        agent_response=response,
        memory_degraded_flag=degraded,
    )
    logger.info(
        "Async invocation completed",
        task_id=task.task_id,
        project_id=project_id,
        team_id=team_id or "<project-default>",
        agent_id=agent_id,
        duration_ms=response.duration_ms,
        correlation_id=context.correlation_id,
        memory_degraded=degraded,
    )
    echoed_session_id = (
        _strip_scope(context.session_id) if context.session_id else response.session_id
    )
    api_response = InvokeResponse.from_agent_response(
        response,
        session_id=echoed_session_id,
    )
    if degraded:
        api_response = api_response.model_copy(update={"memory_degraded": True})
    return api_response.model_dump(mode="json")


@api_router.post(
    "/projects/{project_id}/agent-teams/{team_id}/invoke/async",
    response_model=AsyncInvokeResponse,
    status_code=202,
    summary="Submit a team invocation as a background task",
    description=(
        "Schedule the team's orchestration pipeline as a background task and "
        "return a task_id immediately. Poll GET /projects/{project_id}/tasks/"
        "{task_id} until status is terminal."
    ),
)
async def invoke_team_async(
    project_id: str,
    team_id: str,
    body: InvokeRequest,
    request: Request,
) -> AsyncInvokeResponse:
    """Submit a team invocation as a background task."""
    bundle = await _resolve_team_for_async(request, project_id, team_id)
    # §D1 — validate identity at submit time and capture it into the
    # Task. ``Task.identity`` is ``exclude=True`` so the wire response
    # never carries it, but the runner reads it on resume.
    identity = validate_project_access(
        request,
        url_project_id=project_id,
        resource_project_id=bundle.project_id,
    )
    task = Task(
        project_id=project_id,
        team_id=bundle.team_id,
        agent_id="orchestrator",
        correlation_id=identity.correlation_id or str(uuid.uuid4()),
        identity=identity,
    )

    async def runner(t: Task) -> dict[str, Any]:
        # §D2 — re-bind identity for the runner's asyncio task. The
        # outer request-scoped binding is gone by the time this
        # coroutine starts; re-establish it from the persisted task so
        # any function tool / MCP / Bifrost call inside sees the right
        # user. The TaskManager doesn't know about identity (kept
        # framework-agnostic); the route's runner wrapper owns this.
        tok = set_current_identity(t.identity) if t.identity is not None else None
        try:
            return await _run_invocation_for_task(
                request,
                body,
                project_id=project_id,
                team_id=team_id,
                agent_id="orchestrator",
                task=t,
            )
        finally:
            if tok is not None:
                reset_current_identity(tok)

    assert bundle.task_manager is not None  # narrowed by _resolve_team_for_async
    await bundle.task_manager.submit(task, runner)
    return AsyncInvokeResponse(task_id=task.task_id, status=task.status.value)


@api_router.post(
    "/projects/{project_id}/agents/{agent_id}/invoke/async",
    response_model=AsyncInvokeResponse,
    status_code=202,
    summary="Submit a single-agent invocation as a background task (default team)",
    description=(
        "Schedule the named agent on the project's default team as a "
        "background task. Use /projects/{project_id}/agent-teams/{team_id}/invoke/async "
        "to target a specific team."
    ),
)
async def invoke_agent_async_default_team(
    project_id: str,
    agent_id: str,
    body: InvokeRequest,
    request: Request,
) -> AsyncInvokeResponse:
    """Submit a single-agent invocation against the project's default team.

    Session is agent-scoped so the conversation is partitioned by ``agent_id``
    rather than the default team's id.
    """
    bundle = await _resolve_team_for_async(
        request, project_id, team_id=None, scope="agent", agent_id=agent_id
    )
    identity = validate_project_access(
        request,
        url_project_id=project_id,
        resource_project_id=bundle.project_id,
    )
    task = Task(
        project_id=project_id,
        team_id=bundle.team_id,
        agent_id=agent_id,
        correlation_id=identity.correlation_id or str(uuid.uuid4()),
        identity=identity,
    )

    async def runner(t: Task) -> dict[str, Any]:
        tok = set_current_identity(t.identity) if t.identity is not None else None
        try:
            return await _run_invocation_for_task(
                request,
                body,
                project_id=project_id,
                team_id=None,
                agent_id=agent_id,
                task=t,
                scope="agent",
            )
        finally:
            if tok is not None:
                reset_current_identity(tok)

    assert bundle.task_manager is not None
    await bundle.task_manager.submit(task, runner)
    return AsyncInvokeResponse(task_id=task.task_id, status=task.status.value)


async def _find_task_manager_for_project(
    request: Request,
    project_id: str,
    task_id: str,
) -> tuple[TaskManager, Task]:
    """Resolve the correct :class:`TaskManager` for a ``(project_id, task_id)``
    pair, returning the manager and the loaded :class:`Task` together.

    Multi-team projects can have several :class:`TaskManager` instances --
    one per team that enables async invokes. The previous version of this
    helper returned ``the first manager in the project``, which is wrong
    for two distinct reasons:

    1. **In-memory backend**: each team's manager has its own private
       dict. Polling task ``X`` against team B's manager when team A
       submitted it would 404 even though the task exists in A's store.
    2. **Cancel ownership**: even when teams share a backing Redis (so
       any manager can ``store.get(task_id)``), only the manager that
       actually scheduled the runner has the live ``asyncio.Task`` in
       its ``_inflight`` dict. Calling ``cancel`` through a non-owning
       manager would only persist ``CANCELLED`` -- the live coroutine on
       the owning manager keeps running and would stamp ``COMPLETED`` on
       top a moment later (the win-overwrites-loss race that
       :meth:`TaskManager._persist_unless_already_terminal` now guards,
       but routing through the right manager up-front is the cleaner
       fix).

    Resolution order:

    1. The manager that ``owns_inflight(task_id)`` -- guaranteed correct
       for the cancel path in the local-replica case.
    2. Any manager whose ``store.get(task_id)`` returns a non-``None``
       :class:`Task`. Handles the case where the runner has already
       finished (so no inflight), and the case where managers share a
       Redis backend.
    3. ``404 Task not found`` when no manager has a record of it.

    This still does not fully solve cross-replica cancellation: when
    the task's runner lives on a different process, the local manager
    here has no ``asyncio.Task`` to signal, so cancel only updates the
    persisted state. The runner replica's
    ``_persist_unless_already_terminal`` then prevents the COMPLETED
    overwrite. A true cross-replica cancel would need a cancel-intent
    flag on the Task model that runners poll between awaits -- flagged
    as future work; the present routing is correct for the
    single-replica multi-team case.

    Raises:
        HTTPException: 404 / 503 from :func:`_require_known_project`,
            404 if no team in the project has async-invoke enabled,
            or 404 if the task itself can't be located in any manager.
    """
    registry = _require_known_project(request, project_id)
    managers = [
        b.task_manager for b in registry.teams_for_project(project_id) if b.task_manager is not None
    ]
    if not managers:
        raise HTTPException(
            status_code=404,
            detail={
                "error": f"No async-invoke-enabled team in project '{project_id}'",
            },
        )

    # 1. Prefer the manager that owns the live runner — required for cancel.
    for manager in managers:
        if manager.owns_inflight(task_id):
            task = await manager.get(task_id)
            if task is not None:
                return manager, task
            # Ownership flag set but persistence gone (TTL eviction mid-flight?)
            # Fall through to the store-scan path.

    # 2. Otherwise, the first manager whose store contains the task wins.
    #    Concrete cases this covers:
    #      - runner already finished (no inflight; just need to read state),
    #      - shared-Redis backend (any manager can read any task).
    #
    #    Probe every manager concurrently. A sequential ``await manager.get``
    #    loop multiplies the per-call store timeout by the number of
    #    async-enabled teams in the project -- one slow / unreachable backend
    #    would otherwise make /tasks/{task_id} unresponsive for
    #    ``N * store_timeout`` seconds. Each individual ``get`` already
    #    carries its own per-op timeout (see
    #    :data:`~agent_service_maf.core.task_store._REDIS_OP_TIMEOUT` for
    #    Redis); ``gather`` collapses the total wall time to one such
    #    timeout regardless of N. We preserve the original positional
    #    tie-breaking (earlier manager wins on ties) by scanning the
    #    results list in registry order.
    results = await asyncio.gather(
        *(manager.get(task_id) for manager in managers),
        return_exceptions=True,
    )
    for manager, result in zip(managers, results, strict=True):
        if isinstance(result, BaseException):
            logger.warning(
                "task_manager_get_failed",
                project_id=project_id,
                task_id=task_id,
                error=str(result),
            )
            continue
        if result is not None:
            return manager, result

    raise HTTPException(
        status_code=404,
        detail={"error": "Task not found", "task_id": task_id},
    )


@api_router.get(
    "/projects/{project_id}/tasks/{task_id}",
    response_model=TaskStatusResponse,
    summary="Poll a previously submitted async task",
    description=(
        "Return the current status of an async-invoke task. ``result`` is "
        "populated when ``status == 'completed'``; ``error`` and "
        "``error_type`` are populated when ``status`` is ``'failed'`` or "
        "``'cancelled'``."
    ),
)
async def get_task(
    project_id: str,
    task_id: str,
    request: Request,
) -> TaskStatusResponse:
    """Poll an async task by id, scoped to the project."""
    _manager, task = await _find_task_manager_for_project(
        request,
        project_id,
        task_id,
    )
    # Defence in depth: even though the manager is scoped to this project,
    # a shared Redis backend could return a task submitted under a different
    # project. Reject cross-project lookups explicitly so clients can't
    # enumerate tasks across project boundaries.
    if task.project_id and task.project_id != project_id:
        raise HTTPException(
            status_code=404,
            detail={"error": "Task not found in this project", "task_id": task_id},
        )
    return TaskStatusResponse.from_task(task)


@api_router.delete(
    "/projects/{project_id}/tasks/{task_id}",
    response_model=TaskStatusResponse,
    summary="Cancel an in-flight async task",
    description=(
        "Cancel a running task. Cancellation is propagated to the background "
        "asyncio task so the runner stops promptly. Already-terminal tasks "
        "are returned unchanged."
    ),
)
async def cancel_task(
    project_id: str,
    task_id: str,
    request: Request,
) -> TaskStatusResponse:
    """Cancel a running async task by id, scoped to the project.

    Routes the cancel through the manager that **owns** the live runner
    (see :func:`_find_task_manager_for_project`) so the asyncio task on
    the right team's manager actually receives ``CancelledError`` --
    cancelling through a non-owning manager would only persist
    ``CANCELLED`` and let the runner stamp ``COMPLETED`` on top a moment
    later.
    """
    manager, located = await _find_task_manager_for_project(
        request,
        project_id,
        task_id,
    )
    if located.project_id and located.project_id != project_id:
        raise HTTPException(
            status_code=404,
            detail={"error": "Task not found in this project", "task_id": task_id},
        )
    task = await manager.cancel(task_id)
    if task is None:
        # Race between locate and cancel (TTL eviction etc.). Surface a
        # consistent 404 rather than leaking the partial state.
        raise HTTPException(
            status_code=404,
            detail={"error": "Task not found", "task_id": task_id},
        )
    return TaskStatusResponse.from_task(task)


# ---------------------------------------------------------------------------
# Session HTTP CRUD (Phase 2 -- MEM-2.4 / MEM-2.5)
# ---------------------------------------------------------------------------
#
# Two parallel route sets, one per scope. Both apply the per-user partition
# established by ``_resolve_user_id`` and the team's bundle. All session
# routes are fail-open: a degraded session store returns the appropriate
# default (empty list, default Session, etc.) and the response is stamped
# with ``memory_degraded: true`` so clients can surface the partial result
# to the user.
# ---------------------------------------------------------------------------


def _session_route_user_id(request: Request) -> str:
    """Resolve the user id for a session-CRUD route.

    Same priority as :func:`_resolve_user_id`. The session CRUD endpoints
    are part of the per-user UX surface, so an empty user_id falls back
    to the dev-mode partition (single-user laptop). In production the
    auth middleware always populates :attr:`request.state.user_id`.

    Prefers the bound :class:`IdentityContext.user_id` when present so
    the session partition lines up with the identity used for invoke /
    stream routes on the same request.
    """
    identity = get_current_identity()
    if identity is not None and identity.user_id:
        return _validate_user_id(identity.user_id)
    return _resolve_user_id(request)


def _require_session_manager(bundle: TeamBundle) -> Any:  # noqa: ANN401
    """Return the team's session manager or raise 404.

    Memory routes are only available on teams that enabled the memory
    subsystem in their config. Without it, the route doesn't exist for
    that team.
    """
    if bundle.session_manager is None:
        raise HTTPException(
            status_code=404,
            detail={
                "error": "Session memory is not enabled for this team",
                "hint": "Set memory.enabled=true in the team config.",
            },
        )
    return bundle.session_manager


async def _list_sessions_impl(
    request: Request,
    *,
    project_id: str,
    team_id: str | None,
    scope: SessionScope,
    anchor: str,
) -> SessionListResponse:
    """Shared list-sessions implementation for the team and agent scopes."""
    reset_memory_degraded()
    bundle = await _resolve_team(
        request, project_id, team_id, scope=scope, agent_id=anchor if scope == "agent" else None
    )
    # §C2 / §3 Rule 3 — enforce URL ↔ header ↔ resource project match.
    # Session reads must respect the same identity boundary as invokes.
    identity = validate_project_access(
        request,
        url_project_id=project_id,
        resource_project_id=bundle.project_id,
    )
    tok = set_current_identity(identity)
    try:
        sm = _require_session_manager(bundle)
        user_id = _session_route_user_id(request)
        summaries = await sm.list_for_user(
            scope=scope,
            project_id=project_id,
            anchor=anchor,
            user_id=user_id,
        )
        return SessionListResponse(
            scope=scope,
            project_id=project_id,
            anchor=anchor,
            user_id=user_id,
            sessions=summaries,
            total=len(summaries),
            memory_degraded=memory_degraded(),
        )
    finally:
        reset_current_identity(tok)


async def _get_session_impl(
    request: Request,
    *,
    project_id: str,
    team_id: str | None,
    scope: SessionScope,
    anchor: str,
    session_id: str,
) -> SessionDetailResponse:
    """Shared get-session-detail implementation for both scopes."""
    reset_memory_degraded()
    bundle = await _resolve_team(
        request, project_id, team_id, scope=scope, agent_id=anchor if scope == "agent" else None
    )
    identity = validate_project_access(
        request,
        url_project_id=project_id,
        resource_project_id=bundle.project_id,
    )
    tok = set_current_identity(identity)
    try:
        return await _get_session_impl_inner(
            request,
            bundle=bundle,
            project_id=project_id,
            scope=scope,
            anchor=anchor,
            session_id=session_id,
        )
    finally:
        reset_current_identity(tok)


async def _get_session_impl_inner(
    request: Request,
    *,
    bundle: TeamBundle,
    project_id: str,
    scope: SessionScope,
    anchor: str,
    session_id: str,
) -> SessionDetailResponse:
    """Inner of :func:`_get_session_impl` -- assumes identity is bound."""
    sm = _require_session_manager(bundle)
    user_id = _session_route_user_id(request)
    scoped_id = bundle.scoped_session_id(
        session_id,
        scope=scope,
        agent_id=anchor if scope == "agent" else None,
        user_id=user_id or None,
    )
    if scoped_id is None:
        raise HTTPException(status_code=400, detail={"error": "session_id is required"})
    session = await sm.get(scoped_id)
    if session is None:
        # ``SessionManager.get`` returns ``None`` for both a genuine
        # miss and a store outage (in the latter case it flips the
        # request-scoped ``memory_degraded`` flag). Honour the
        # documented fail-open contract: when the store failed, return
        # an empty default response stamped ``memory_degraded=true``
        # so the client can render "memory unavailable" instead of
        # mistaking an outage for a deleted session.
        if memory_degraded():
            return SessionDetailResponse(
                scope=scope,
                project_id=project_id,
                anchor=anchor,
                user_id=user_id,
                session_id=session_id,
                memory_degraded=True,
            )
        raise HTTPException(
            status_code=404,
            detail={"error": f"Session '{session_id}' not found", "scope": scope},
        )
    # Summary metadata (name / created_at / last_accessed) lives on the
    # store; the simplest reliable read is via list_for_user + filter,
    # but for a single id we can derive most fields from the Session
    # itself and only fall back to the store metadata for the name.
    name = session.metadata.get("name", "")
    summaries = await sm.list_for_user(
        scope=scope,
        project_id=project_id,
        anchor=anchor,
        user_id=user_id,
    )
    summary = next((s for s in summaries if s.session_id == session_id), None)
    if summary is not None:
        name = summary.name or name
        created_at = summary.created_at or session.created_at
        last_accessed = summary.last_accessed or session.last_accessed
    else:
        created_at = session.created_at
        last_accessed = session.last_accessed
    return SessionDetailResponse(
        scope=scope,
        project_id=project_id,
        anchor=anchor,
        user_id=user_id,
        session_id=session_id,
        name=name,
        created_at=created_at,
        last_accessed=last_accessed,
        token_count=session.token_count,
        messages=list(session.messages),
        memory_degraded=memory_degraded(),
    )


async def _rename_session_impl(
    request: Request,
    body: SessionRenameRequest,
    *,
    project_id: str,
    team_id: str | None,
    scope: SessionScope,
    anchor: str,
    session_id: str,
) -> SessionDetailResponse:
    reset_memory_degraded()
    new_name = body.name.strip()
    if not new_name:
        raise HTTPException(status_code=400, detail={"error": "name must be non-empty"})
    bundle = await _resolve_team(
        request, project_id, team_id, scope=scope, agent_id=anchor if scope == "agent" else None
    )
    identity = validate_project_access(
        request,
        url_project_id=project_id,
        resource_project_id=bundle.project_id,
    )
    tok = set_current_identity(identity)
    try:
        return await _rename_session_impl_inner(
            request,
            new_name=new_name,
            bundle=bundle,
            project_id=project_id,
            team_id=team_id,
            scope=scope,
            anchor=anchor,
            session_id=session_id,
        )
    finally:
        reset_current_identity(tok)


async def _rename_session_impl_inner(
    request: Request,
    *,
    new_name: str,
    bundle: TeamBundle,
    project_id: str,
    team_id: str | None,
    scope: SessionScope,
    anchor: str,
    session_id: str,
) -> SessionDetailResponse:
    sm = _require_session_manager(bundle)
    user_id = _session_route_user_id(request)
    scoped_id = bundle.scoped_session_id(
        session_id,
        scope=scope,
        agent_id=anchor if scope == "agent" else None,
        user_id=user_id or None,
    )
    if scoped_id is None:
        raise HTTPException(status_code=400, detail={"error": "session_id is required"})
    ok = await sm.rename_session(scoped_id, new_name)
    if not ok:
        # ``rename_session`` returns ``False`` for both an unknown
        # session and a store outage (the latter flips
        # ``memory_degraded``). Don't lie with a 404 when the store
        # failed -- the rename may have partially succeeded and the
        # session likely still exists. Surface a degraded response
        # carrying the requested name so the client can retry.
        if memory_degraded():
            return SessionDetailResponse(
                scope=scope,
                project_id=project_id,
                anchor=anchor,
                user_id=user_id,
                session_id=session_id,
                name=new_name,
                memory_degraded=True,
            )
        raise HTTPException(
            status_code=404,
            detail={"error": f"Session '{session_id}' not found", "scope": scope},
        )
    return await _get_session_impl(
        request,
        project_id=project_id,
        team_id=team_id,
        scope=scope,
        anchor=anchor,
        session_id=session_id,
    )


async def _delete_session_impl(
    request: Request,
    response: Response,
    *,
    project_id: str,
    team_id: str | None,
    scope: SessionScope,
    anchor: str,
    session_id: str,
) -> None:
    reset_memory_degraded()
    bundle = await _resolve_team(
        request, project_id, team_id, scope=scope, agent_id=anchor if scope == "agent" else None
    )
    identity = validate_project_access(
        request,
        url_project_id=project_id,
        resource_project_id=bundle.project_id,
    )
    tok = set_current_identity(identity)
    try:
        sm = _require_session_manager(bundle)
        user_id = _session_route_user_id(request)
        await _delete_session_impl_inner(
            response,
            sm=sm,
            bundle=bundle,
            user_id=user_id,
            scope=scope,
            anchor=anchor,
            session_id=session_id,
        )
    finally:
        reset_current_identity(tok)


async def _delete_session_impl_inner(
    response: Response,
    *,
    sm: Any,  # noqa: ANN401
    bundle: TeamBundle,
    user_id: str,
    scope: SessionScope,
    anchor: str,
    session_id: str,
) -> None:
    scoped_id = bundle.scoped_session_id(
        session_id,
        scope=scope,
        agent_id=anchor if scope == "agent" else None,
        user_id=user_id or None,
    )
    if scoped_id is None:
        raise HTTPException(status_code=400, detail={"error": "session_id is required"})
    ok = await sm.clear_session(scoped_id)
    if not ok:
        # ``clear_session`` returns ``False`` for both an unknown
        # session and a store outage (which flips ``memory_degraded``).
        # On a store outage treat the delete as fail-open at the HTTP
        # layer (return 204) but signal the condition with the
        # ``X-Memory-Degraded`` header so callers that care can react
        # without us mis-reporting an outage as a deleted session via
        # 404.
        if memory_degraded():
            response.headers["X-Memory-Degraded"] = "true"
            return
        raise HTTPException(
            status_code=404,
            detail={"error": f"Session '{session_id}' not found", "scope": scope},
        )


# --- Team-scoped session routes ----------------------------------------------


@api_router.get(
    "/projects/{project_id}/agent-teams/{team_id}/sessions",
    response_model=SessionListResponse,
    summary="List team-scoped sessions for the calling user",
)
async def list_team_sessions(
    project_id: str,
    team_id: str,
    request: Request,
) -> SessionListResponse:
    return await _list_sessions_impl(
        request,
        project_id=project_id,
        team_id=team_id,
        scope="team",
        anchor=team_id,
    )


@api_router.get(
    "/projects/{project_id}/agent-teams/{team_id}/sessions/{session_id}",
    response_model=SessionDetailResponse,
    summary="Get a team-scoped session transcript",
)
async def get_team_session(
    project_id: str,
    team_id: str,
    session_id: str,
    request: Request,
) -> SessionDetailResponse:
    return await _get_session_impl(
        request,
        project_id=project_id,
        team_id=team_id,
        scope="team",
        anchor=team_id,
        session_id=session_id,
    )


@api_router.patch(
    "/projects/{project_id}/agent-teams/{team_id}/sessions/{session_id}",
    response_model=SessionDetailResponse,
    summary="Rename a team-scoped session (PATCH per RFC 7396 / §5.9)",
    description=(
        "Rename a session by sending a partial update body. The previous "
        "``POST .../sessions/{sid}/rename`` form is gone (§5.9 lock-in -- "
        "rename is a partial resource update, not a custom verb)."
    ),
)
async def rename_team_session(
    project_id: str,
    team_id: str,
    session_id: str,
    body: SessionRenameRequest,
    request: Request,
) -> SessionDetailResponse:
    return await _rename_session_impl(
        request,
        body,
        project_id=project_id,
        team_id=team_id,
        scope="team",
        anchor=team_id,
        session_id=session_id,
    )


@api_router.delete(
    "/projects/{project_id}/agent-teams/{team_id}/sessions/{session_id}",
    status_code=204,
    summary="Delete a team-scoped session",
)
async def delete_team_session(
    project_id: str,
    team_id: str,
    session_id: str,
    request: Request,
    response: Response,
) -> None:
    await _delete_session_impl(
        request,
        response,
        project_id=project_id,
        team_id=team_id,
        scope="team",
        anchor=team_id,
        session_id=session_id,
    )


# --- Agent-scoped session routes (default team) ------------------------------


@api_router.get(
    "/projects/{project_id}/agents/{agent_id}/sessions",
    response_model=SessionListResponse,
    summary="List agent-scoped sessions for the calling user (default team)",
)
async def list_agent_sessions(
    project_id: str,
    agent_id: str,
    request: Request,
) -> SessionListResponse:
    return await _list_sessions_impl(
        request,
        project_id=project_id,
        team_id=None,
        scope="agent",
        anchor=agent_id,
    )


@api_router.get(
    "/projects/{project_id}/agents/{agent_id}/sessions/{session_id}",
    response_model=SessionDetailResponse,
    summary="Get an agent-scoped session transcript (default team)",
)
async def get_agent_session(
    project_id: str,
    agent_id: str,
    session_id: str,
    request: Request,
) -> SessionDetailResponse:
    return await _get_session_impl(
        request,
        project_id=project_id,
        team_id=None,
        scope="agent",
        anchor=agent_id,
        session_id=session_id,
    )


@api_router.patch(
    "/projects/{project_id}/agents/{agent_id}/sessions/{session_id}",
    response_model=SessionDetailResponse,
    summary="Rename an agent-scoped session (default team, PATCH per §5.9)",
    description=(
        "Rename a session by sending a partial update body. The previous "
        "``POST .../sessions/{sid}/rename`` form is gone (§5.9 lock-in -- "
        "rename is a partial resource update, not a custom verb)."
    ),
)
async def rename_agent_session(
    project_id: str,
    agent_id: str,
    session_id: str,
    body: SessionRenameRequest,
    request: Request,
) -> SessionDetailResponse:
    return await _rename_session_impl(
        request,
        body,
        project_id=project_id,
        team_id=None,
        scope="agent",
        anchor=agent_id,
        session_id=session_id,
    )


@api_router.delete(
    "/projects/{project_id}/agents/{agent_id}/sessions/{session_id}",
    status_code=204,
    summary="Delete an agent-scoped session (default team)",
)
async def delete_agent_session(
    project_id: str,
    agent_id: str,
    session_id: str,
    request: Request,
    response: Response,
) -> None:
    await _delete_session_impl(
        request,
        response,
        project_id=project_id,
        team_id=None,
        scope="agent",
        anchor=agent_id,
        session_id=session_id,
    )


# ---------------------------------------------------------------------------
# System routes (un-prefixed)
# ---------------------------------------------------------------------------


@system_router.get(
    "/health",
    response_model=HealthResponse,
    summary="Health check",
    description="Returns service status and uptime. Always exempt from authentication.",
)
async def health_check(request: Request) -> HealthResponse:
    """Service health check endpoint.

    Always returns 200 when the service is running. Used by Kubernetes liveness
    and readiness probes. Exempt from authentication middleware.

    Args:
        request: FastAPI request for accessing ``app.state.start_time``.

    Returns:
        :class:`~agent_service_maf.interface_layer.models.HealthResponse` with status,
        version, and uptime.
    """
    uptime = time.time() - getattr(request.app.state, "start_time", time.time())
    return HealthResponse(
        status="ok",
        version="0.1.0",
        uptime_seconds=round(uptime, 2),
    )


def _get_readiness_checker(request: Request) -> ReadinessChecker:
    """Return the process-wide :class:`ReadinessChecker` instance.

    Stashed on ``app.state.readiness_checker`` on first use so the
    in-process result cache outlives a single probe.
    """
    checker = getattr(request.app.state, "readiness_checker", None)
    if checker is None:
        checker = ReadinessChecker()
        request.app.state.readiness_checker = checker
    return checker


@system_router.get(
    "/ready",
    response_model=ReadinessResponse,
    summary="Readiness probe",
    description=(
        "Readiness probe per §5.8. Returns 200 once the service can serve "
        "invocations end-to-end (lifespan complete, at least one healthy "
        "team, MCP connected or lazy_connect, Redis reachable when "
        "configured). Returns 503 with a structured `reason` on first "
        "failing check. Auth-exempt; cache TTL ~1.5s to absorb probe storms."
    ),
)
async def readiness_check(request: Request, response: Response) -> ReadinessResponse:
    """Service readiness check endpoint (§5.8).

    Per §5.8.3, sets 503 with a structured ``reason`` enum when any
    check fails. 200 + ``status="ready"`` otherwise. Auth-exempt.

    Args:
        request: FastAPI request -- the readiness checker reads
            ``app.state.teams`` and ``app.state.start_time``.
        response: FastAPI response -- mutated to set status_code=503 on
            failure so the body still serializes via the response_model.

    Returns:
        :class:`~agent_service_maf.interface_layer.models.ReadinessResponse`.
        When ``status="not_ready"`` the route also sets HTTP 503.
    """
    checker = _get_readiness_checker(request)
    result = await checker.check(request.app)
    uptime = time.time() - getattr(request.app.state, "start_time", time.time())

    registry: TeamRegistry | None = getattr(request.app.state, "teams", None)
    team_ids: list[str] = []
    redis_status = "disabled"
    if registry is not None:
        team_ids = list(registry.healthy_ids())
        # Determine Redis exposure from any bundle that opted into a
        # Redis backend. "ok" iff the readiness sweep didn't surface a
        # redis_unreachable reason on this round.
        for bundle in registry.all_bundles():
            config = getattr(bundle, "config", None)
            if config is None:
                continue
            memory_uses_redis = (
                getattr(getattr(config, "memory", None), "storage_backend", "memory") == "redis"
            )
            tasks_uses_redis = (
                getattr(getattr(config, "tasks", None), "backend", "memory") == "redis"
            )
            if memory_uses_redis or tasks_uses_redis:
                redis_status = "ok" if result.checks.get("redis_reachable", True) else "unreachable"
                break

    if not result.ready:
        response.status_code = 503
        logger.warning(
            "readiness_check_failed",
            reason=result.reason.value if result.reason else "unknown",
            detail=result.detail,
            checks=result.checks,
        )
        return ReadinessResponse(
            status="not_ready",
            reason=result.reason.value if result.reason else "unknown",
            teams=team_ids,
            redis=redis_status,
            uptime=round(uptime, 2),
            details={"detail": result.detail, "checks": result.checks},
        )

    return ReadinessResponse(
        status="ready",
        reason="",
        teams=team_ids,
        redis=redis_status,
        uptime=round(uptime, 2),
        details={"checks": result.checks},
    )


# ---------------------------------------------------------------------------
# §6 — Config-service migration admin endpoints
# ---------------------------------------------------------------------------


@api_router.post(
    "/admin/config/invalidate",
    summary="Invalidate cached config-service payloads (lazy mode only)",
    description=(
        "Drop one or more cached agent / team payloads so the next request "
        "re-fetches from config-service. Auth-gated by "
        ":class:`AgentAuthMiddleware` (the ``/api/v1/admin`` prefix is in "
        "the protected-paths tuple). No-op when CONFIG_SOURCE=file."
    ),
)
async def invalidate_config(
    request: Request,
    project_id: str,
    team_id: str | None = None,
    agent_id: str | None = None,
) -> dict[str, Any]:
    """Forced invalidation hook for the config-service cache.

    Mirrors agent-service's two-cache invalidation: invalidating an
    agent cascades to every team that may embed it (the
    :class:`RemoteConfigCache` handles the cascade), and the lazy
    registry's matching bundles are evicted so the next request rebuilds
    against the fresh payload.

    When ``team_id`` is omitted the project's full team cache is dropped;
    when ``agent_id`` is omitted the project's full agent cache is dropped.
    Supplying both invalidates each independently. Supplying neither
    invalidates both for the project.
    """
    source = getattr(request.app.state, "config_loader_source", None)
    teams = getattr(request.app.state, "teams", None)
    if source is None:
        raise HTTPException(
            status_code=503,
            detail={"error": "Config source is not wired (app not fully started)"},
        )

    invalidated: dict[str, Any] = {
        "project_id": project_id,
        "team_id": team_id,
        "agent_id": agent_id,
    }

    # Agent invalidation (cascades to teams in RemoteConfigCache).
    if agent_id is not None:
        if hasattr(source, "invalidate_agent"):
            source.invalidate_agent(project_id, agent_id)
        if isinstance(teams, LazyTeamRegistry):
            teams.evict_agent(project_id, agent_id)

    # Team invalidation.
    if team_id is not None:
        if hasattr(source, "invalidate_team"):
            source.invalidate_team(project_id, team_id)
        if isinstance(teams, LazyTeamRegistry):
            teams.evict_team(project_id, team_id)

    # No-args invalidate: nuke everything for the project (both kinds).
    if team_id is None and agent_id is None:
        if hasattr(source, "invalidate_agent"):
            source.invalidate_agent(project_id, None)
        if hasattr(source, "invalidate_team"):
            source.invalidate_team(project_id, None)
        if isinstance(teams, LazyTeamRegistry):
            teams.evict_agent(project_id, None)
            teams.evict_team(project_id, None)

    # Per-project Bifrost VK cache: invalidate on ANY scope-flavoured
    # invalidate call so a config-service VK rotation propagates without
    # a service restart. The resolver caches per-project (not per-team
    # or per-agent), so we always drop the project's entry — irrespective
    # of whether a team or agent invalidation was requested.
    vk_resolver = getattr(request.app.state, "project_vk_resolver", None)
    if vk_resolver is not None:
        try:
            vk_resolver.invalidate(project_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "project_vk_resolver_invalidate_failed",
                project_id=project_id,
                error=str(exc),
            )

    return {"invalidated": invalidated}


@system_router.get(
    "/admin/config/status",
    summary="Snapshot of the remote-config cache (lazy mode only)",
    description=(
        "Return cache hit-rate counters, TTL, and current size. Returns an "
        "empty status object when CONFIG_SOURCE=file. Auth-gated by "
        ":class:`AgentAuthMiddleware` (the ``/admin`` prefix is in the "
        "protected-paths tuple) so the operational metrics are not "
        "exposed to unauthenticated callers."
    ),
)
async def config_status(request: Request) -> dict[str, Any]:
    """Operator-facing status snapshot for the config-service cache.

    Useful for the rollout checklist's >95 % hit-rate target and for
    triaging cold-start latency. Returns ``{"mode": "file"}`` when the
    file loader is wired so the route is safe to call in either mode.
    """
    source = getattr(request.app.state, "config_loader_source", None)
    # Surface the per-project VK cache alongside the config-source
    # snapshot — operators triage VK rotation issues from the same
    # endpoint.
    vk_resolver = getattr(request.app.state, "project_vk_resolver", None)
    vk_snap: dict[str, Any] | None = None
    if vk_resolver is not None and hasattr(vk_resolver, "status_snapshot"):
        try:
            vk_snap = vk_resolver.status_snapshot()
        except Exception:  # noqa: BLE001
            vk_snap = None
    if source is None:
        out: dict[str, Any] = {"mode": "unwired"}
        if vk_snap is not None:
            out["project_vk"] = vk_snap
        return out
    if hasattr(source, "status_snapshot"):
        snap: dict[str, Any] = source.status_snapshot()
        out = {"mode": "remote", **snap}
        if vk_snap is not None:
            out["project_vk"] = vk_snap
        return out
    file_out: dict[str, Any] = {"mode": "file"}
    if vk_snap is not None:
        file_out["project_vk"] = vk_snap
    return file_out
