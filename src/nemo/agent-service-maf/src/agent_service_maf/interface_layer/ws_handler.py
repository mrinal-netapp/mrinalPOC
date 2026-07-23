"""WebSocket bidirectional handler for agent invocation.

Handles a WebSocket session lifecycle:

1. Authenticate on connection handshake (first message or connection).
2. Accept incoming JSON messages matching InvokeRequest schema.
3. Build execution context and stream agent events back as JSON text frames.
4. Enforce per-IP connection limits and idle timeouts.
5. Handle graceful disconnects.

WebSocket limits (per engineering-standards.md §1.5):

- ``max_connections_per_ip``: Maximum concurrent WebSocket connections from a single
  IP address. Default: 5. Connections exceeding this limit are rejected immediately
  with a close frame.
- ``idle_timeout_seconds``: Maximum seconds to wait for the next message from a
  connected client. Default: 60. Idle connections are closed with a log message.

Connection tracking is done via a module-level dict keyed by client IP. This is
suitable for single-process deployments. For multi-process deployments, use a shared
Redis store (not in scope for Phase 1).
"""

from __future__ import annotations

import asyncio
import collections
import contextlib
import json
import uuid
from typing import TYPE_CHECKING

import structlog
from fastapi import WebSocket, WebSocketDisconnect

from agent_service_maf.config._override_applier import (
    apply_per_agent_overrides,
    config_overrides_to_agent_request_dict,
    config_overrides_to_request_dict,
)
from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.identity import (
    IdentityContext,
    reset_current_identity,
    set_current_identity,
)
from agent_service_maf.core.interfaces import AgentRequest, EventType
from agent_service_maf.interface_layer.models import InvokeRequest

if TYPE_CHECKING:
    from fastapi import FastAPI

logger = structlog.get_logger(__name__)

# Default WebSocket limits — override via ``interface`` config section.
DEFAULT_MAX_CONNECTIONS_PER_IP: int = 5
DEFAULT_IDLE_TIMEOUT_SECONDS: int = 60

# Module-level connection tracking: IP address → count of active connections.
# Note: This is per-process only. For multi-process deployments, use a shared store.
_active_connections: dict[str, int] = collections.defaultdict(int)


def _get_client_ip(websocket: WebSocket) -> str:
    """Extract the client IP address from a WebSocket connection.

    Prefers ``X-Forwarded-For`` when present (for reverse-proxy deployments).
    Falls back to the raw client host.

    Args:
        websocket: The active WebSocket connection.

    Returns:
        Client IP address string, or ``"unknown"`` if not determinable.
    """
    forwarded_for = websocket.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    if websocket.client:
        return websocket.client.host
    return "unknown"


async def handle_websocket_session(
    websocket: WebSocket,
    agent_id: str,
    app: FastAPI,
    *,
    project_id: str,
    team_id: str | None = None,
    scope: str = "team",
    max_connections_per_ip: int = DEFAULT_MAX_CONNECTIONS_PER_IP,
    idle_timeout_seconds: int = DEFAULT_IDLE_TIMEOUT_SECONDS,
) -> None:
    """Handle a full WebSocket session for agent invocation.

    Manages the complete lifecycle of a WebSocket connection:
    - Checks per-IP connection limit and rejects if exceeded.
    - Loops receiving JSON InvokeRequest messages from the client.
    - For each message, builds context, streams agent events, and sends them as JSON.
    - Enforces idle timeout between messages.
    - Handles clean disconnects and unexpected errors.

    WebSocket message protocol (client → server):
        JSON matching :class:`~agent_service_maf.interface_layer.models.InvokeRequest`.

    WebSocket event protocol (server → client):
        JSON with keys: ``event``, ``data``, ``metadata``, ``timestamp``.

    Per-IP limit: If the client's IP already has ``max_connections_per_ip`` active
    connections, the new connection is rejected with a 4029 close code.

    Idle timeout: If no message arrives within ``idle_timeout_seconds``, the
    connection is closed with a 4008 code and an eviction log.

    Args:
        websocket: The accepted WebSocket connection.
        agent_id: The agent ID from the URL path (``/agents/{agent_id}/ws``)
            or ``"orchestrator"`` when the connection is on the team route
            ``/agent-teams/{team_id}/ws``.
        app: The FastAPI application instance (used to access ``app.state``).
        project_id: Project ID from the URL path. Required: all WebSocket
            routes are mounted under
            ``/api/v1/projects/{project_id}/...`` and the registered bundle
            is resolved per ``(project_id, team_id)``. Cross-project siblings
            sharing the same ``team_id`` are not reachable through this
            connection.
        team_id: Team ID from the URL path. ``None`` selects the project's
            default team — used by ``/api/v1/projects/{project_id}/agents/
            {agent_id}/ws`` connections that don't carry an explicit team_id.
        max_connections_per_ip: Maximum concurrent connections per client IP.
        idle_timeout_seconds: Maximum idle time (seconds) between client messages.

    Example:
        >>> # Called from a project-scoped /agent-teams/{team_id}/ws route:
        >>> await handle_websocket_session(
        ...     websocket,
        ...     agent_id="orchestrator",
        ...     app=websocket.app,
        ...     project_id="550e8400-e29b-41d4-a716-446655440000",
        ...     team_id="alpha",
        ... )
        >>>
        >>> # Or from a project-scoped /agents/{agent_id}/ws route
        >>> # (resolves to the project's default team):
        >>> await handle_websocket_session(
        ...     websocket,
        ...     agent_id="echo",
        ...     app=websocket.app,
        ...     project_id="550e8400-e29b-41d4-a716-446655440000",
        ... )
    """
    client_ip = _get_client_ip(websocket)

    # Check per-IP connection limit.
    if _active_connections[client_ip] >= max_connections_per_ip:
        logger.warning(
            "WebSocket connection rejected: per-IP limit exceeded",
            client_ip=client_ip,
            active_connections=_active_connections[client_ip],
            max_connections_per_ip=max_connections_per_ip,
        )
        await websocket.close(code=4029, reason="Too many connections from this IP address")
        return

    _active_connections[client_ip] += 1
    logger.info(
        "WebSocket session started",
        agent_id=agent_id,
        client_ip=client_ip,
        active_connections=_active_connections[client_ip],
    )

    # §B4 / §C2 — bind identity from the WS handshake claims (set by
    # ``_authenticate_websocket``) so any per-message tool calls
    # spawned by the adapter see the right user. We bind once per
    # connection rather than once per message because each WebSocket
    # session is a single asyncio task; nested per-message rebinds
    # would only add overhead.
    ws_claims = getattr(websocket, "state", None)
    claims_dict = getattr(ws_claims, "claims", None) if ws_claims is not None else None
    ws_identity = claims_dict.get("_identity") if isinstance(claims_dict, dict) else None
    identity_token = (
        set_current_identity(ws_identity) if isinstance(ws_identity, IdentityContext) else None
    )

    try:
        while True:
            # Wait for a message with idle timeout.
            try:
                raw = await asyncio.wait_for(
                    websocket.receive_text(),
                    timeout=idle_timeout_seconds,
                )
            except TimeoutError:
                logger.info(
                    "WebSocket idle timeout — closing connection",
                    agent_id=agent_id,
                    client_ip=client_ip,
                    idle_timeout_seconds=idle_timeout_seconds,
                )
                await websocket.send_json(
                    {
                        "event": EventType.ERROR.value,
                        "data": (
                            f"Connection closed: idle for more than {idle_timeout_seconds}s. "
                            "Increase interface.ws_idle_timeout_seconds in config."
                        ),
                        "metadata": {"reason": "idle_timeout"},
                        "timestamp": "",
                    }
                )
                await websocket.close(code=4008, reason="Idle timeout")
                return

            # Parse the request.
            try:
                data = json.loads(raw)
                invoke_req = InvokeRequest(**data)
            except json.JSONDecodeError as exc:
                await websocket.send_json(
                    {
                        "event": EventType.ERROR.value,
                        "data": (
                            f"Invalid JSON: {exc}. "
                            "Send a valid JSON object matching the InvokeRequest schema."
                        ),
                        "metadata": {"error_type": "json_decode_error"},
                        "timestamp": "",
                    }
                )
                continue
            except Exception as exc:
                await websocket.send_json(
                    {
                        "event": EventType.ERROR.value,
                        "data": (
                            f"Invalid request: {exc}. "
                            "Check the InvokeRequest schema in the API documentation."
                        ),
                        "metadata": {"error_type": type(exc).__name__},
                        "timestamp": "",
                    }
                )
                continue

            # Build execution context — scoped to the requested project + team
            # (or the project's default team if this is a /projects/{pid}/agents/
            # {id}/ws connection without an explicit team_id).
            try:
                registry = getattr(app.state, "teams", None)
                if registry is None:
                    raise RuntimeError("No teams loaded on this server")
                if not registry.has_project(project_id):
                    raise RuntimeError(
                        f"Unknown project_id '{project_id}'; available: {registry.project_ids()}"
                    )
                bundle = (
                    registry.get_in_project(project_id, team_id)
                    if team_id
                    else registry.default_for_project(project_id)
                )
                if bundle is None:
                    raise RuntimeError(
                        f"Unknown team_id '{team_id}' for project '{project_id}'; "
                        f"available: {registry.team_ids_for_project(project_id)}"
                    )
                if not bundle.healthy:
                    raise RuntimeError(
                        f"Team '{bundle.team_id}' is unhealthy: {bundle.startup_error}"
                    )
                ws_overrides = invoke_req.config_overrides
                ws_overrides_dict = config_overrides_to_request_dict(ws_overrides)
                base_config = bundle.config_loader.resolve(
                    request_overrides=ws_overrides_dict or None,
                )
                config = apply_per_agent_overrides(
                    base_config,
                    ws_overrides,
                    is_team_invoke=(scope != "agent"),
                )
                # WS user_id resolution mirrors the HTTP path: prefer
                # the bound identity (set above by the handshake
                # claims), fall back to legacy header readers when no
                # identity is bound (NoopAuthMiddleware / tests).
                if isinstance(ws_identity, IdentityContext):
                    ws_user_id = ws_identity.user_id
                else:
                    ws_user_id = (
                        str(getattr(websocket, "scope", {}).get("user_id") or "")  # type: ignore[union-attr]
                        or websocket.headers.get("x-user-id", "")
                    ).strip()
                # Mint a session id if the caller did not supply one so
                # WS streams behave the same as the HTTP invoke route —
                # downstream events emit the raw form (see
                # response_builder.py) and clients can replay it on the
                # next message.
                raw_session_id = invoke_req.session_id or uuid.uuid4().hex
                scoped_id = bundle.scoped_session_id(
                    raw_session_id,
                    scope="agent" if scope == "agent" else "team",  # type: ignore[arg-type]
                    agent_id=agent_id if scope == "agent" else None,
                    user_id=ws_user_id or None,
                )
                ws_correlation_id = (
                    ws_identity.correlation_id
                    if isinstance(ws_identity, IdentityContext) and ws_identity.correlation_id
                    else str(uuid.uuid4())
                )
                context = AgentExecutionContext(
                    config=config,
                    gateway=bundle.gateway,
                    mcp_registry=bundle.mcp_manager,
                    guardrails=bundle.guardrails,
                    session_manager=bundle.session_manager,
                    request_metadata=invoke_req.metadata,
                    session_id=scoped_id,
                    correlation_id=ws_correlation_id,
                    identity=ws_identity if isinstance(ws_identity, IdentityContext) else None,
                )
            except Exception as exc:
                logger.error(
                    "WebSocket context build failed",
                    agent_id=agent_id,
                    error=str(exc),
                )
                await websocket.send_json(
                    {
                        "event": EventType.ERROR.value,
                        "data": "Failed to build execution context. Check server logs.",
                        "metadata": {"error_type": type(exc).__name__},
                        "timestamp": "",
                    }
                )
                continue

            # Build agent request. Use context.session_id (team-prefixed) so
            # session continuity matches the SessionManager scope established
            # when the context was built.
            agent_request = AgentRequest(
                agent_id=agent_id,
                input=invoke_req.input,
                context=invoke_req.context,
                config_overrides=config_overrides_to_agent_request_dict(
                    invoke_req.config_overrides
                ),
                session_id=context.session_id,
                metadata=invoke_req.metadata,
            )

            # Stream agent events to the client.
            await _stream_agent_events(websocket, agent_request, context, app)

    except WebSocketDisconnect:
        logger.info(
            "WebSocket client disconnected",
            agent_id=agent_id,
            client_ip=client_ip,
        )

    except Exception as exc:
        logger.error(
            "WebSocket session error",
            agent_id=agent_id,
            client_ip=client_ip,
            error_type=type(exc).__name__,
        )
        with contextlib.suppress(Exception):
            await websocket.send_json(
                {
                    "event": EventType.ERROR.value,
                    "data": "An unexpected error occurred. The connection will be closed.",
                    "metadata": {"error_type": type(exc).__name__},
                    "timestamp": "",
                }
            )

    finally:
        # Always decrement the connection counter.
        _active_connections[client_ip] = max(0, _active_connections[client_ip] - 1)
        if identity_token is not None:
            reset_current_identity(identity_token)
        logger.info(
            "WebSocket session ended",
            agent_id=agent_id,
            client_ip=client_ip,
            remaining_connections=_active_connections[client_ip],
        )


async def _stream_agent_events(
    websocket: WebSocket,
    agent_request: AgentRequest,
    context: AgentExecutionContext,
    app: FastAPI,
) -> None:
    """Stream agent events over a WebSocket connection for a single request.

    Creates the adapter, initializes it, streams events, and sends each as a
    JSON text frame. Handles adapter errors by sending an ERROR event.

    Args:
        websocket: The active WebSocket connection.
        agent_request: The parsed agent invocation request.
        context: The built execution context.
        app: FastAPI app instance for accessing the framework registry.
    """
    try:
        registry = app.state.framework_registry
        framework = context.config.agent.framework
        agent = registry.create(framework, context.config)
        await agent.initialize(context)

        # Send STARTED sentinel.
        await websocket.send_json(
            {
                "event": EventType.STARTED.value,
                "data": "",
                "metadata": {},
                "timestamp": "",
            }
        )

        # Stream adapter events.
        async for event in agent.stream(agent_request, context):
            await websocket.send_json(
                {
                    "event": event.event_type.value,
                    "data": event.data,
                    "metadata": event.metadata,
                    "timestamp": event.timestamp.isoformat(),
                }
            )

        # Send COMPLETED sentinel.
        await websocket.send_json(
            {
                "event": EventType.COMPLETED.value,
                "data": "",
                "metadata": {},
                "timestamp": "",
            }
        )

    except WebSocketDisconnect:
        raise  # Re-raise so the session handler can clean up.

    except Exception as exc:
        logger.error(
            "WebSocket agent stream error",
            agent_id=agent_request.agent_id,
            error_type=type(exc).__name__,
            correlation_id=context.correlation_id,
        )
        with contextlib.suppress(Exception):
            await websocket.send_json(
                {
                    "event": EventType.ERROR.value,
                    "data": "An error occurred during agent execution. Check server logs.",
                    "metadata": {
                        "error_type": type(exc).__name__,
                        "correlation_id": context.correlation_id,
                    },
                    "timestamp": "",
                }
            )


def reset_connection_tracking() -> None:
    """Reset the per-IP connection counter. For testing only.

    Clears the module-level ``_active_connections`` dict to prevent test
    isolation issues.

    Example:
        >>> reset_connection_tracking()
        >>> _active_connections
        defaultdict(<class 'int'>, {})
    """
    _active_connections.clear()
