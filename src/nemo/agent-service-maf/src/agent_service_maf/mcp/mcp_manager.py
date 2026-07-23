"""MCPManager — facade composing connection lifecycle, tool invocation, discovery, and health.

Implements SRP by splitting responsibilities across four focused classes:

* :class:`MCPConnectionManager` — server connection lifecycle
* :class:`MCPDiscovery` — tool discovery from connected servers
* :class:`MCPToolInvoker` — tool call execution
* :class:`MCPHealthCheck` — per-server health status

:class:`MCPManager` is the facade that composes all four and is the primary
entry point for callers.

This module is framework-agnostic and does NOT import any agent framework
libraries (Microsoft Agent Framework, etc.).
"""

from __future__ import annotations

import asyncio
import contextlib
import re
import time
from collections.abc import Awaitable, Callable
from contextlib import AsyncExitStack
from typing import Any

import structlog
from jsonschema import ValidationError as JsonSchemaValidationError
from jsonschema import validate as jsonschema_validate
from mcp import ClientSession, ClientSessionGroup, McpError
from mcp.client.session_group import ServerParameters
from mcp.types import CallToolResult

from agent_service_maf.config.validators import MCPSection
from agent_service_maf.core.exceptions import MCPConnectionError, MCPToolError
from agent_service_maf.core.identity import get_current_identity
from agent_service_maf.mcp._identity_transport import (
    HDR_AUTHORIZATION,
    build_identity_meta,
)
from agent_service_maf.mcp.config_loader import MCPServerConfig
from agent_service_maf.mcp.tool_registry import ToolRegistry, ToolResult, ToolSchema
from agent_service_maf.mcp.transport_factory import TransportFactory

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Secret redaction helpers
# ---------------------------------------------------------------------------

# Patterns that identify secret-like values (applied to log field *values*).
_SECRET_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"(sk-[A-Za-z0-9\-_]{10,})", re.IGNORECASE),
    re.compile(r"(sk-ant-[A-Za-z0-9\-_]{10,})", re.IGNORECASE),
    re.compile(r"(AKIA[A-Z0-9]{16})"),
    re.compile(r"(ghp_[A-Za-z0-9]{36})"),
    re.compile(r"(Bearer\s+[A-Za-z0-9\-_\.~\+\/]{10,})", re.IGNORECASE),
    re.compile(r"(eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_\.~\+\/]+)"),  # JWT
]

# Header / env-var names considered sensitive.
_SENSITIVE_FIELD_NAMES: frozenset[str] = frozenset(
    {
        "authorization",
        "api_key",
        "api-key",
        "x-api-key",
        "secret",
        "password",
        "token",
        "private_key",
    }
)

_REDACTED = "[REDACTED]"


def _redact_value(value: str) -> str:
    """Redact known secret patterns from a string value.

    Args:
        value: Raw string that may contain secrets.

    Returns:
        String with secrets replaced by ``[REDACTED]``.
    """
    for pattern in _SECRET_PATTERNS:
        value = pattern.sub(_REDACTED, value)
    return value


def _redact_dict(d: dict[str, str]) -> dict[str, str]:
    """Redact sensitive keys and values from a string dict.

    Fields whose *name* appears in :data:`_SENSITIVE_FIELD_NAMES` are
    replaced wholesale.  Other fields have their values pattern-matched.

    Args:
        d: Dictionary whose entries may be sensitive (e.g. HTTP headers, env vars).

    Returns:
        New dict safe for logging.
    """
    result: dict[str, str] = {}
    for k, v in d.items():
        if k.lower() in _SENSITIVE_FIELD_NAMES:
            result[k] = _REDACTED
        else:
            result[k] = _redact_value(v)
    return result


# ---------------------------------------------------------------------------
# Protocol / abstraction for DIP
# ---------------------------------------------------------------------------


class MCPClientProtocol:
    """Abstract interface for MCP client operations.

    Provides the abstraction layer required by the Dependency Inversion
    Principle so that :class:`MCPManager` can be unit-tested with a mock
    implementation that does not open real network connections.

    Subclass this and pass it to :class:`MCPManager` via
    ``client_factory`` when testing.
    """

    async def connect(self, params: ServerParameters, exit_stack: AsyncExitStack) -> ClientSession:
        """Open a connection to an MCP server and return a live session.

        Args:
            params: Transport-specific connection parameters.
            exit_stack: Async exit stack that manages the session lifetime.

        Returns:
            Active :class:`~mcp.ClientSession`.

        Raises:
            :class:`~agent_service_maf.core.exceptions.MCPConnectionError`:
                On any connection failure.
        """
        raise NotImplementedError

    async def list_tools(self, session: ClientSession) -> list[Any]:
        """List tools available from a connected server session.

        Args:
            session: Active client session.

        Returns:
            List of MCP ``Tool`` objects.
        """
        raise NotImplementedError

    async def call_tool(
        self, group: ClientSessionGroup, tool_name: str, arguments: dict[str, Any]
    ) -> CallToolResult:
        """Call a tool via the session group.

        Args:
            group: Active :class:`~mcp.ClientSessionGroup`.
            tool_name: Qualified or bare tool name registered in the group.
            arguments: Tool call arguments.

        Returns:
            ``CallToolResult`` from the MCP server.
        """
        raise NotImplementedError

    async def ping(self, session: ClientSession) -> None:
        """Send a ping to verify the session is alive.

        Args:
            session: Active client session.

        Raises:
            :class:`~agent_service_maf.core.exceptions.MCPConnectionError`:
                If the ping fails.
        """
        raise NotImplementedError


class _DefaultMCPClient(MCPClientProtocol):
    """Default :class:`MCPClientProtocol` implementation using the real MCP SDK."""

    async def connect(
        self, params: ServerParameters, exit_stack: AsyncExitStack
    ) -> ClientSession:  # pragma: no cover — needs live MCP server
        """Establish connection using the real MCP SDK.

        Args:
            params: Transport parameters (stdio / SSE / streamable-HTTP).
            exit_stack: Context-manager stack for lifecycle management.

        Returns:
            A connected :class:`~mcp.ClientSession`.
        """
        group = await exit_stack.enter_async_context(ClientSessionGroup())
        return await group.connect_to_server(params)

    async def list_tools(self, session: ClientSession) -> list[Any]:  # pragma: no cover
        """List tools from the session via MCP protocol.

        Args:
            session: Active MCP session.

        Returns:
            List of ``mcp.types.Tool`` objects.
        """
        result = await session.list_tools()
        return result.tools

    async def call_tool(
        self,
        group: ClientSessionGroup,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> CallToolResult:  # pragma: no cover
        """Call a tool via the session group.

        Args:
            group: Active session group.
            tool_name: Tool name (qualified, as registered in the group).
            arguments: Validated call arguments.

        Returns:
            ``CallToolResult`` from the MCP server.
        """
        return await group.call_tool(tool_name, arguments)

    async def ping(self, session: ClientSession) -> None:  # pragma: no cover
        """Send a ping to verify liveness.

        Args:
            session: Active client session.

        Raises:
            Exception: On any SDK-level error.
        """
        await session.send_ping()


# ---------------------------------------------------------------------------
# SRP component 1: Connection lifecycle
# ---------------------------------------------------------------------------


class MCPConnectionManager:
    """Manages the lifecycle of MCP server connections.

    Responsibilities: connect, disconnect, reconnect individual servers
    and all servers in bulk.

    Args:
        config: MCP integration settings from
            :class:`~agent_service_maf.config.validators.MCPSection`.
        server_configs: Pre-loaded server config list. If ``None`` it is loaded
            from the inline ``mcp_servers`` array in the agent config.
        transport_factory: Factory for building server parameters. Defaults to
            :meth:`TransportFactory.default`.
        client: MCP client protocol implementation. Defaults to the real SDK client.
        inline_servers: Raw inline ``mcp_servers`` array from agent config (v2.0.0 format).
    """

    def __init__(
        self,
        config: MCPSection,
        server_configs: list[MCPServerConfig] | None = None,
        transport_factory: TransportFactory | None = None,
        client: MCPClientProtocol | None = None,
        inline_servers: list[dict[str, Any]] | None = None,
        idle_ttl_seconds: float | None = None,
    ) -> None:
        self._config = config
        self._server_configs: list[MCPServerConfig] | None = server_configs
        self._inline_servers = inline_servers
        self._transport_factory = transport_factory or TransportFactory.default()
        self._client = client or _DefaultMCPClient()

        self._group: ClientSessionGroup | None = None
        self._server_sessions: dict[str, ClientSession] = {}
        # Maps a *physical* endpoint identity (transport|url|headers) to the
        # one live session serving it. Lets multiple configured servers that
        # point at the same aggregated Bifrost ``/mcp`` proxy share a single
        # connection instead of each trying (and failing) to re-register the
        # identical tool list. See :meth:`_endpoint_key` / :meth:`_connect_one`.
        self._endpoint_sessions: dict[str, ClientSession] = {}
        self._exit_stack: AsyncExitStack = AsyncExitStack()
        self._configs_loaded: bool = server_configs is not None

        # --- Owner-task ownership of transport contexts --------------------
        # Every MCP transport context (streamable_http_client / ClientSession
        # via ClientSessionGroup) is entered AND exited inside a single
        # long-lived "owner" task. anyio binds a cancel scope to the task that
        # enters it and raises "Attempted to exit cancel scope in a different
        # task" if it is exited elsewhere — exactly what happened when an
        # abandoned SSE response generator was finalized by the event-loop
        # GC/finalizer task, wedging the worker at 100% CPU forever. Funnelling
        # all enter/exit through one task makes that structurally impossible: a
        # task's own cancellation runs its ``finally`` in that same task.
        self._owner_task: asyncio.Task[None] | None = None
        self._owner_ready: asyncio.Future[None] | None = None
        self._stop_event: asyncio.Event | None = None
        self._cmd_queue: (
            asyncio.Queue[tuple[list[MCPServerConfig], asyncio.Future[list[str]], bool]] | None
        ) = None
        # Set while the owner task is winding down (stop-event, idle-TTL, or
        # cancellation). A stopping owner is NOT reusable: ``_ensure_owner``
        # waits it out and starts a fresh one, so a concurrent connect can never
        # enqueue onto a queue the owner has already drained (which would leave
        # that caller's ``await result`` unresolved forever).
        self._stopping: bool = False
        # Optional idle-TTL safety net (belt-and-suspenders for the rare case
        # where an abandoned request never signals disconnect_all): the owner
        # task self-tears-down after this many seconds with no connect/use
        # activity. ``None`` disables it (default) — the owner then blocks
        # indefinitely, preserving long-lived deployed-bundle connections.
        # Only safe to enable for EPHEMERAL (e.g. playground) managers; a
        # deployed bundle would lose its connection with no reconnect-on-borrow.
        self._idle_ttl_seconds: float | None = idle_ttl_seconds
        self._last_activity: float = time.monotonic()

    async def _ensure_server_configs(self) -> list[MCPServerConfig]:
        """Load server configs from the inline array on the team config.

        MCP servers are defined inline in each team config (v2.0.0 schema);
        there is no external file fallback.

        Returns:
            List of :class:`~agent_service_maf.mcp.config_loader.MCPServerConfig`.
        """
        if not self._configs_loaded or self._server_configs is None:
            if self._inline_servers:
                from agent_service_maf.mcp.config_loader import load_mcp_configs_from_list

                self._server_configs = load_mcp_configs_from_list(self._inline_servers)
            else:
                self._server_configs = []
            self._configs_loaded = True
        return self._server_configs

    def get_default_arguments(self, server_name: str) -> dict[str, Any]:
        """Return the ``default_arguments`` configured for a given MCP server.

        Used by tool executors to merge per-server fixed/binding parameters
        (tenant ids, snapshot versions, etc.) into every tool call. Returns an
        empty dict when the server is unknown or has no defaults configured.
        Reads from already-loaded server configs without async I/O.

        Args:
            server_name: Server identifier as registered in ``mcp_servers``.

        Returns:
            Copy of the server's ``default_arguments`` dict, or ``{}`` if none.
        """
        if not self._server_configs:
            return {}
        for cfg in self._server_configs:
            if cfg.name == server_name:
                return dict(getattr(cfg, "default_arguments", {}) or {})
        return {}

    async def _ensure_group(self) -> ClientSessionGroup:
        """Ensure the :class:`~mcp.ClientSessionGroup` is initialised.

        Returns:
            The active ``ClientSessionGroup``.
        """
        if self._group is None:
            self._group = await self._exit_stack.enter_async_context(ClientSessionGroup())
        return self._group

    @staticmethod
    def _endpoint_key(server_cfg: MCPServerConfig) -> str | None:
        """Stable identity for a server's *physical* upstream connection.

        Network servers sharing the same ``(transport, url, headers)`` open the
        SAME upstream connection — the Bifrost multiplexing case, where many
        configured servers point at one aggregated ``/mcp`` proxy and differ
        only by ``gateway_server_name`` (the tool-name prefix). The MCP SDK's
        ``ClientSessionGroup`` registers tools by name and rejects a second
        connect to such an endpoint with "already exist in group tools", so we
        dedupe on this key and alias the rest to the first live session.

        Returns ``None`` for stdio (every subprocess is its own distinct
        server — never shared).
        """
        if server_cfg.transport not in {"sse", "streamable-http"}:
            return None
        url = (server_cfg.url or "").rstrip("/")
        headers = server_cfg.headers or {}
        header_sig = "&".join(f"{k.lower()}={v}" for k, v in sorted(headers.items()))
        return f"{server_cfg.transport}|{url}|{header_sig}"

    def get_config(self, server_name: str) -> MCPServerConfig | None:
        """Return the :class:`MCPServerConfig` for *server_name*, or ``None``.

        Lets the discovery + invoker components read fields like
        ``gateway_server_name`` (the Bifrost client-name prefix) without
        keeping their own copies of the config list.
        """
        configs = self._server_configs
        if not configs:
            return None
        return next((c for c in configs if c.name == server_name), None)

    def get_session(self, server_name: str) -> ClientSession | None:
        """Return the live session for *server_name*, or ``None`` if not connected.

        Args:
            server_name: MCP server identifier.

        Returns:
            Active :class:`~mcp.ClientSession` or ``None``.
        """
        # Fetched once per tool call by the invoker — treat as activity so the
        # idle-TTL never tears a connection down mid-stream (no-op when TTL off).
        self._last_activity = time.monotonic()
        return self._server_sessions.get(server_name)

    def get_group(self) -> ClientSessionGroup | None:
        """Return the underlying ``ClientSessionGroup``.

        Returns:
            The ``ClientSessionGroup`` or ``None`` if not yet initialised.
        """
        return self._group

    def connected_servers(self) -> list[str]:
        """Return identifiers of all currently connected servers.

        Returns:
            List of server name strings.
        """
        return list(self._server_sessions)

    async def connect_server(self, server_name: str) -> None:
        """Connect to a single MCP server by name.

        Looks up the server in the configured server list, builds transport
        parameters, and establishes a session via the ``ClientSessionGroup``.

        Args:
            server_name: Server identifier from the team config's ``mcp_servers`` array.

        Raises:
            :class:`~agent_service_maf.core.exceptions.MCPConnectionError`:
                If the server is not in the config or connection fails.
        """
        configs = await self._ensure_server_configs()
        server_cfg = next((s for s in configs if s.name == server_name), None)
        if server_cfg is None:
            raise MCPConnectionError(
                f"MCP server '{server_name}' is not configured. "
                f"Add it to the 'mcp_servers' array in the agent config."
            )
        # Route through the owner task so the transport context is entered in
        # the same task that will later exit it (see §_owner_loop).
        # raise_on_error=True preserves this method's contract: a failed connect
        # propagates instead of being swallowed like connect_all's skip-list.
        await self._run_in_owner([server_cfg], raise_on_error=True)

    async def _connect_one(self, server_cfg: MCPServerConfig) -> None:
        """Internal: connect to one server and register the session.

        Args:
            server_cfg: Validated server configuration.

        Raises:
            :class:`~agent_service_maf.core.exceptions.MCPConnectionError`:
                On any transport or SDK error.
        """
        # §E1/§E2 — inject the per-deployment MCP service-account
        # token into the static connect-time headers for HTTP/SSE
        # transports. The MCP SDK bakes headers into the underlying
        # httpx client at connect time, so this is the only practical
        # place to set ``Authorization`` per the two-token model when
        # using ``ClientSessionGroup``. Per-call user JWT propagation
        # rides via the MCP ``_meta`` field (set in
        # :meth:`MCPToolInvoker.call_tool`) which is transport-
        # agnostic. The service token never leaves config; the
        # contract is enforced once here.
        if server_cfg.transport in {"sse", "streamable-http"}:
            service_token = (self._config.service_token or "").strip()
            if service_token:
                # Don't blow away an operator-supplied Authorization
                # header in server_cfg.headers; respect explicit
                # overrides. HTTP header names are case-insensitive on
                # the wire, but a Python dict is case-sensitive, so an
                # exact ``HDR_AUTHORIZATION in cfg_headers`` check would
                # miss ``authorization`` / ``AUTHORIZATION`` and let
                # both keys ride to httpx, producing duplicate
                # ``Authorization`` headers (RFC 9110 §5.2 forbids
                # combining auth headers, so some servers will reject).
                cfg_headers = dict(server_cfg.headers or {})
                has_auth = any(k.lower() == "authorization" for k in cfg_headers)
                if not has_auth:
                    cfg_headers[HDR_AUTHORIZATION] = f"Bearer {service_token}"
                    # ``server_cfg`` is frozen / Pydantic-immutable; build
                    # a fresh copy with the augmented headers so the
                    # transport_factory sees the service token.
                    server_cfg = server_cfg.model_copy(update={"headers": cfg_headers})

        group = await self._ensure_group()

        # Bifrost multiplexing: if another configured server already opened the
        # identical physical endpoint (same transport/url/headers), reuse that
        # session instead of reconnecting. A second connect to the aggregated
        # ``/mcp`` proxy returns the same tool list and the MCP SDK rejects it
        # ("already exist in group tools"), which previously dropped every
        # server after the first and silently stripped the agent's tools.
        # The shared session's group already holds all servers' tools; per-
        # server discovery slices them out by ``gateway_server_name`` prefix.
        endpoint_key = self._endpoint_key(server_cfg)
        if endpoint_key is not None:
            shared = self._endpoint_sessions.get(endpoint_key)
            if shared is not None:
                self._server_sessions[server_cfg.name] = shared
                logger.info(
                    "Reusing shared MCP endpoint session",
                    name=server_cfg.name,
                    transport=server_cfg.transport,
                    url=server_cfg.url,
                    gateway_server_name=server_cfg.gateway_server_name,
                )
                return

        params = self._transport_factory.build(server_cfg)

        # Redact secrets from log fields before logging.
        log_headers = _redact_dict(server_cfg.headers) if server_cfg.headers else {}
        log_env = _redact_dict(server_cfg.env) if server_cfg.env else {}
        logger.info(
            "Connecting to MCP server",
            name=server_cfg.name,
            transport=server_cfg.transport,
            url=server_cfg.url,
            gateway_server_name=server_cfg.gateway_server_name,
            headers=log_headers,
            env=log_env,
        )

        try:
            async with asyncio.timeout(self._config.connection_timeout_seconds):
                session = await group.connect_to_server(params)
        except TimeoutError as exc:
            raise MCPConnectionError(
                f"MCP server '{server_cfg.name}' connection timed out after "
                f"{self._config.connection_timeout_seconds}s. "
                f"Increase mcp.connection_timeout_seconds or check server availability."
            ) from exc
        except Exception as exc:
            raise MCPConnectionError(
                f"Failed to connect to MCP server '{server_cfg.name}': {exc}. "
                f"Verify the server is running and the MCP server config is correct."
            ) from exc

        self._server_sessions[server_cfg.name] = session
        if endpoint_key is not None:
            self._endpoint_sessions[endpoint_key] = session
        logger.info(
            "Connected to MCP server",
            name=server_cfg.name,
            tool_count=len(getattr(group, "tools", {}) or {}),
        )

    async def connect_all(self) -> list[str]:
        """Connect to all enabled MCP servers from the config file.

        Servers that fail to connect are logged as warnings and skipped.

        Returns:
            List of server names that connected successfully.
        """
        configs = await self._ensure_server_configs()
        # All connects happen inside the single owner task (see §_owner_loop),
        # so the transport cancel scopes are entered and exited in one task.
        return await self._run_in_owner(configs)

    # ------------------------------------------------------------------
    # Owner task — sole entrant/exitor of transport contexts
    # ------------------------------------------------------------------

    async def _ensure_owner(self) -> None:
        """Start the long-lived owner task if not already running.

        A *stopping* owner (winding down via stop-event / idle-TTL /
        cancellation) is treated as not reusable: we wait it out and start a
        fresh one. The reuse fast-path below is await-free, and enqueue in
        :meth:`_run_in_owner` is likewise await-free (``put_nowait`` on an
        unbounded queue), so in single-threaded asyncio a caller that reuses the
        owner cannot be interleaved by the owner transitioning to stopping
        between the check and the enqueue — the command is guaranteed to be
        processed or failed, never orphaned.
        """
        if self._owner_task is not None and not self._owner_task.done() and not self._stopping:
            return
        # A stopping-but-not-done owner must fully wind down before we replace
        # it, so its transport-context exit stays in its own task. ``asyncio.
        # wait`` waits without cancelling it, while still propagating THIS
        # caller's own cancellation (unlike ``suppress(BaseException)``, which
        # would swallow it).
        if self._owner_task is not None and not self._owner_task.done():
            prev = self._owner_task
            await asyncio.wait({prev})
            # Retrieve the previous owner's outcome so that replacing it below
            # doesn't leave its exception unconsumed — which would surface as a
            # spurious "Task exception was never retrieved" warning when the old
            # task is GC'd. A cancelled owner (abandoned bundle) is expected.
            with contextlib.suppress(asyncio.CancelledError):
                prev.exception()
        self._stopping = False
        loop = asyncio.get_running_loop()
        self._owner_ready = loop.create_future()
        self._owner_task = loop.create_task(self._owner_loop(), name="mcp-conn-owner")
        # Wait until the owner has created its queue + stop event and entered
        # its loop, so a connect submitted immediately after is never dropped.
        await self._owner_ready

    async def _run_in_owner(
        self, configs: list[MCPServerConfig], *, raise_on_error: bool = False
    ) -> list[str]:
        """Connect ``configs`` inside the owner task; return connected names.

        The caller may be any task (a request handler, an SSE generator); the
        actual context enter still happens in the owner task.

        Args:
            configs: Servers to connect.
            raise_on_error: When ``True`` (single-server ``connect_server``), a
                connect failure is re-raised to the caller. When ``False``
                (``connect_all``), failures are skipped and only the connected
                names are returned.
        """
        if not configs:
            return []
        await self._ensure_owner()
        cmd_queue = self._cmd_queue
        if cmd_queue is None:  # pragma: no cover - owner exited concurrently
            raise MCPConnectionError("MCP connection owner task is not running")
        loop = asyncio.get_running_loop()
        result: asyncio.Future[list[str]] = loop.create_future()
        # Await-free enqueue (queue is unbounded): the owner cannot mark itself
        # stopping / drain between the checks above and this put — see
        # _ensure_owner's atomicity note — so this command is never orphaned.
        cmd_queue.put_nowait((configs, result, raise_on_error))
        return await result

    @staticmethod
    async def _drain_cancelled_future(fut: asyncio.Future[Any]) -> asyncio.CancelledError | None:
        """Await ``fut`` (which the caller just cancelled), swallowing *its own*
        ``CancelledError`` so owner-task teardown can continue — but WITHOUT
        consuming this owner task's own cancellation.

        Returns the ``CancelledError`` when the current (owner) task is itself
        under cancellation, so the caller can re-raise it after cleanup finishes;
        returns ``None`` otherwise. Non-``CancelledError`` ``BaseException``
        (``KeyboardInterrupt`` / ``SystemExit``) is never swallowed.
        """
        try:
            await fut
        except asyncio.CancelledError as exc:
            current = asyncio.current_task()
            if current is not None and current.cancelling() > 0:
                return exc
        return None

    async def _owner_loop(self) -> None:
        """Own every MCP transport context on ``_exit_stack`` for its lifetime.

        Connect batches arrive on ``_cmd_queue`` and are executed **here**, so
        ``ClientSessionGroup.connect_to_server`` enters cancel scopes in this
        task. The contexts are held open until :meth:`disconnect_all` sets
        ``_stop_event`` (or the task is cancelled, e.g. GC of an abandoned
        bundle). The ``finally`` closes ``_exit_stack`` in this same task, so
        the anyio cross-task cancel-scope RuntimeError (→ 100% CPU spin) can
        never occur.
        """
        self._stop_event = asyncio.Event()
        self._cmd_queue = asyncio.Queue()
        cmd_queue = self._cmd_queue
        stop_event = self._stop_event
        if self._owner_ready is not None and not self._owner_ready.done():
            self._owner_ready.set_result(None)

        self._last_activity = time.monotonic()
        stop_wait = asyncio.ensure_future(stop_event.wait())
        get_cmd: asyncio.Future[Any] | None = None
        try:
            while True:
                get_cmd = asyncio.ensure_future(cmd_queue.get())
                # ``timeout=None`` (idle-TTL disabled) blocks until a command
                # or stop — the original, connection-preserving behavior.
                done, _pending = await asyncio.wait(
                    {get_cmd, stop_wait},
                    timeout=self._idle_ttl_seconds,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if stop_wait in done:
                    # Winding down. Mark stopping BEFORE the await below so a
                    # concurrent _run_in_owner starts a fresh owner instead of
                    # enqueuing onto this queue. Fail a command this iteration
                    # already dequeued so its caller doesn't hang; still-queued
                    # commands are failed in the ``finally`` drain.
                    self._stopping = True
                    if get_cmd in done:
                        _cfgs, dequeued, _roe = get_cmd.result()
                        if not dequeued.done():
                            dequeued.set_exception(
                                MCPConnectionError("MCP connection owner is stopping")
                            )
                    else:
                        get_cmd.cancel()
                        drained = await self._drain_cancelled_future(get_cmd)
                        if drained is not None:
                            raise drained  # owner cancelled — let it propagate
                    break
                if get_cmd not in done:
                    # Idle-TTL tick: no command and no stop within the window.
                    get_cmd.cancel()
                    drained = await self._drain_cancelled_future(get_cmd)
                    if drained is not None:
                        raise drained  # owner cancelled — let it propagate
                    if (
                        self._idle_ttl_seconds is not None
                        and (time.monotonic() - self._last_activity) >= self._idle_ttl_seconds
                    ):
                        self._stopping = True
                        logger.info(
                            "MCP connection owner idle — releasing connections",
                            idle_ttl_seconds=self._idle_ttl_seconds,
                        )
                        break
                    continue
                self._last_activity = time.monotonic()
                configs, result, raise_on_error = get_cmd.result()
                try:
                    connected: list[str] = []
                    failure: MCPConnectionError | None = None
                    for server_cfg in configs:
                        try:
                            await self._connect_one(server_cfg)
                            connected.append(server_cfg.name)
                        except MCPConnectionError as exc:
                            # connect_all skips-and-continues; connect_server
                            # (raise_on_error) propagates so a caller never
                            # believes a failed server is connected.
                            if raise_on_error:
                                failure = exc
                                break
                            logger.warning(
                                "Failed to connect MCP server — skipping",
                                name=server_cfg.name,
                                error=str(exc),
                            )
                    if not result.done():
                        if failure is not None:
                            result.set_exception(failure)
                        else:
                            result.set_result(connected)
                except BaseException as exc:  # ensure the caller never hangs
                    if not result.done():
                        result.set_exception(exc)
                    raise
        finally:
            # Cover every exit path (stop, idle, cancellation, unexpected
            # error): mark stopping so concurrent callers don't reuse this owner
            # during the awaits below, then fail any still-queued commands so
            # their callers never hang. Both steps are await-free, so no command
            # can slip in between marking and draining.
            self._stopping = True
            while True:
                try:
                    _cfgs, pending, _roe = cmd_queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
                if not pending.done():
                    pending.set_exception(MCPConnectionError("MCP connection owner is stopping"))
            # Settle the two helper futures we cancelled. The drain helper
            # swallows each future's OWN cancellation but preserves this owner
            # task's cancellation (returning it) so it still propagates after
            # teardown — and never swallows KeyboardInterrupt/SystemExit.
            cancelled: asyncio.CancelledError | None = None
            stop_wait.cancel()
            cancelled = await self._drain_cancelled_future(stop_wait) or cancelled
            # Cancel the in-flight cmd_queue.get() so it isn't orphaned when the
            # owner exits while blocked in asyncio.wait() (cancellation / error).
            # The stop and idle branches already cancel it; this covers the
            # cancellation-mid-wait path. If it had already dequeued a command
            # that never got processed, fail that command's future too so its
            # caller never hangs (the queue drain above can't see it — it's no
            # longer on the queue).
            if get_cmd is not None:
                if not get_cmd.done():
                    get_cmd.cancel()
                    cancelled = await self._drain_cancelled_future(get_cmd) or cancelled
                elif not get_cmd.cancelled() and get_cmd.exception() is None:
                    _cfgs, pending, _roe = get_cmd.result()
                    if not pending.done():
                        pending.set_exception(
                            MCPConnectionError("MCP connection owner is stopping")
                        )
            # SAME task that entered every transport context, so the exit is
            # always in-task — never the anyio cross-task RuntimeError, even
            # when this task is *cancelled* (abandoned bundle) rather than
            # stopped via disconnect_all. The close MUST be awaited directly in
            # this task: shielding it onto a separate task would run each
            # __aexit__ off-task and reintroduce the cross-task cancel-scope exit
            # this whole design exists to prevent. A single cancellation reaching
            # here is already consumed (it propagated us into this finally), so
            # aclose() runs to completion. Guard only the pathological re-cancel:
            # swallow it, then re-raise after the state reset so cancellation
            # still propagates. contextlib.AsyncExitStack.aclose() pops-and-
            # continues past a raising __aexit__ (bare except), so it empties the
            # stack in a single pass — the loop is belt-and-suspenders and
            # terminates in one extra (no-op) iteration at most.
            #
            # On CancelledError, clear this task's pending cancellation
            # (uncancel) before continuing so the cancel count stays balanced —
            # anyio 4 and structured concurrency track Task.cancelling(), and an
            # unbalanced count could confuse a re-driven aclose or an outer
            # scope. We re-raise below, so the task still ends cancelled.
            current = asyncio.current_task()
            while True:
                try:
                    await self._exit_stack.aclose()
                    break
                except asyncio.CancelledError as exc:
                    cancelled = exc
                    if current is not None and current.cancelling() > 0:
                        current.uncancel()
                        continue
                    # No pending task-cancellation left to clear — don't spin.
                    break
                except Exception as exc:  # pragma: no cover - best-effort teardown
                    logger.warning(
                        "MCP exit stack close failed during owner teardown",
                        error=str(exc),
                    )
                    break
            self._exit_stack = AsyncExitStack()
            self._group = None
            self._server_sessions.clear()
            self._endpoint_sessions.clear()
            self._cmd_queue = None
            self._stop_event = None
            if cancelled is not None:
                raise cancelled

    async def disconnect_all(self) -> None:
        """Gracefully disconnect all MCP servers and release resources.

        Signals the owner task to stop; the owner closes the transport
        contexts **in its own task**. Safe to call from any task (including an
        SSE generator's finalizer) — this method only signals, it never exits
        a transport cancel scope itself.
        """
        task = self._owner_task
        if task is None:
            # No owner task (nothing was connected / already torn down) — best
            # effort close of anything left on the stack, in the caller task.
            server_names = list(self._server_sessions)
            self._server_sessions.clear()
            self._endpoint_sessions.clear()
            with contextlib.suppress(Exception):
                await self._exit_stack.aclose()
            self._exit_stack = AsyncExitStack()
            self._group = None
            logger.info("Disconnected all MCP servers", count=len(server_names))
            return
        # Mark stopping and KEEP _owner_task set until the owner has fully torn
        # down. A concurrent _ensure_owner then waits this owner out (via
        # _stopping) instead of starting a fresh owner that would race the
        # shared _exit_stack teardown — which is exactly the cross-task context
        # exit this design prevents.
        self._stopping = True
        count = len(self._server_sessions)
        if self._stop_event is not None:
            self._stop_event.set()
        # Await the owner via asyncio.wait (NOT ``await task``): a bare await sets
        # the owner as this caller's _fut_waiter, so if THIS caller (request /
        # SSE) is cancelled the cancellation propagates into the owner and tears
        # it down prematurely — the very cross-task race this design prevents.
        # asyncio.wait waits without cancelling the owner, while still
        # propagating the caller's own cancellation (so we re-raise and leave
        # _owner_task set for the still-running owner to finish in its own task).
        await asyncio.wait({task})
        # Owner finished on its own. Retrieve its outcome (best-effort: it exits
        # transport contexts in its own finally, so an error here must not abort
        # the shutdown / __aexit__ path) — and so a failed owner doesn't trigger
        # a spurious "Task exception was never retrieved" warning on GC.
        if not task.cancelled() and task.exception() is not None:
            logger.warning(
                "MCP owner task ended with error during disconnect",
                error=str(task.exception()),
            )
        # Clear only after teardown, and only if a fresh owner hasn't replaced
        # this one in the meantime.
        if self._owner_task is task:
            self._owner_task = None
        logger.info("Disconnected all MCP servers", count=count)


# ---------------------------------------------------------------------------
# SRP component 2: Tool discovery
# ---------------------------------------------------------------------------


class MCPDiscovery:
    """Discovers and registers tools from connected MCP servers.

    Reads tool definitions from each live ``ClientSession`` and registers
    them in the shared :class:`~agent_service_maf.mcp.tool_registry.ToolRegistry`.

    Args:
        tool_registry: Registry to populate with discovered tools.
    """

    def __init__(self, tool_registry: ToolRegistry) -> None:
        self._registry = tool_registry

    async def discover_server(
        self,
        server_name: str,
        group: ClientSessionGroup,
        session: ClientSession | None = None,
        gateway_server_name: str | None = None,
    ) -> list[ToolSchema]:
        """Discover tools from a specific connected server.

        Two attribution modes — only one applies per call:

        * **Bifrost-multiplexed** (``gateway_server_name`` set): the
          server is reached through Bifrost's aggregated ``/mcp``
          endpoint, where every registered upstream's tools live behind
          a single session and are name-prefixed with the Bifrost client
          name (e.g. ``projXY_weather-get_forecast``). Discovery filters
          ``group.tools`` to entries whose name starts with
          ``f"{gateway_server_name}-"`` and strips the prefix so the
          registry holds clean, LLM-facing names (``get_forecast``).
          Session-based attribution is intentionally skipped here — N
          sessions to the same Bifrost endpoint all see the same tool
          list, so ``_tool_to_session`` would mis-attribute.

        * **Direct-session** (``gateway_server_name`` is ``None``):
          legacy / file-source path. When ``session`` is provided,
          discovery is restricted to the tools contributed by that
          session — read from the group's ``_tool_to_session`` reverse
          index. Without it, every tool in the group is registered
          under ``server_name``, which mis-attributes tools whenever
          the group holds multiple servers.

        Args:
            server_name: Friendly server identifier (the agent's
                ``mcp_servers[]`` reference). Tags every registered
                schema and becomes the SK plugin name.
            group: Active ``ClientSessionGroup`` with the server connected.
            session: The :class:`~mcp.ClientSession` for ``server_name``
                (direct-session mode only).
            gateway_server_name: Bifrost client-name prefix (Bifrost-
                multiplexed mode). When set, ``session`` is ignored.

        Returns:
            List of :class:`~agent_service_maf.mcp.tool_registry.ToolSchema`
            objects discovered (also registered in the registry).
        """
        tool_to_session: dict[str, ClientSession] = getattr(group, "_tool_to_session", {})

        schemas: list[ToolSchema] = []
        if gateway_server_name:
            prefix = f"{gateway_server_name}-"
            for _qname, mcp_tool in group.tools.items():
                tool_name_raw = mcp_tool.name
                if not tool_name_raw.startswith(prefix):
                    continue
                stripped = tool_name_raw[len(prefix) :]
                schema = ToolSchema(
                    name=stripped,
                    description=mcp_tool.description or "",
                    input_schema=mcp_tool.inputSchema,
                    output_schema=mcp_tool.outputSchema,
                    server_name=server_name,
                    annotations=(
                        mcp_tool.annotations.model_dump() if mcp_tool.annotations else None
                    ),
                )
                schemas.append(schema)
            if not schemas:
                # The agent referenced this server but Bifrost's aggregated
                # tool list has nothing under its prefix — the usual cause of a
                # silently tool-less agent. Surface the available prefixes so
                # an operator can spot a gatewayServerName mismatch fast.
                available_prefixes = sorted(
                    {
                        name.split("-", 1)[0]
                        for name in (t.name for t in group.tools.values())
                        if "-" in name
                    }
                )
                logger.warning(
                    "No MCP tools matched gateway prefix; agent missing this server's tools",
                    server=server_name,
                    gateway_server_name=gateway_server_name,
                    group_tool_count=len(group.tools),
                    available_prefixes=available_prefixes,
                )
        else:
            for qname, mcp_tool in group.tools.items():
                if session is not None and tool_to_session.get(qname) is not session:
                    # Tool belongs to a different server's session — skip.
                    continue
                schema = ToolSchema(
                    name=mcp_tool.name,
                    description=mcp_tool.description or "",
                    input_schema=mcp_tool.inputSchema,
                    output_schema=mcp_tool.outputSchema,
                    server_name=server_name,
                    annotations=(
                        mcp_tool.annotations.model_dump() if mcp_tool.annotations else None
                    ),
                )
                schemas.append(schema)

        await self._registry.register_batch(schemas)
        logger.info(
            "Discovered tools from MCP server",
            server=server_name,
            count=len(schemas),
            gateway_server_name=gateway_server_name,
        )
        return schemas

    async def discover_all(
        self,
        server_names: list[str],
        group: ClientSessionGroup,
        sessions: dict[str, ClientSession] | None = None,
        gateway_server_names: dict[str, str | None] | None = None,
    ) -> dict[str, list[ToolSchema]]:
        """Discover tools from all connected servers.

        Args:
            server_names: Ordered list of server names to process.
            group: Active ``ClientSessionGroup`` with all servers connected.
            sessions: Optional mapping of ``server_name`` to its
                :class:`~mcp.ClientSession`. When provided, each server's
                discovery is restricted to its own session's tools so they
                are attributed correctly (direct-session mode).
            gateway_server_names: Optional mapping of ``server_name`` to
                its Bifrost client-name prefix. When set for a given
                server, switches that server's discovery to Bifrost-
                multiplexed mode (prefix filter + strip). Missing /
                ``None`` entries fall back to direct-session mode.

        Returns:
            Mapping of server_name → list of discovered :class:`ToolSchema`.
        """
        sessions = sessions or {}
        gateways = gateway_server_names or {}
        results: dict[str, list[ToolSchema]] = {}
        for server_name in server_names:
            schemas = await self.discover_server(
                server_name,
                group,
                sessions.get(server_name),
                gateway_server_name=gateways.get(server_name),
            )
            results[server_name] = schemas
        return results


# ---------------------------------------------------------------------------
# SRP component 3: Tool invocation
# ---------------------------------------------------------------------------


class MCPToolInvoker:
    """Executes MCP tool calls with argument validation, size limits, and hooks.

    Args:
        config: MCP settings (timeout, size limit, etc.).
        tool_registry: Used to resolve tool schemas for JSON Schema validation.
        on_tool_call_start: Optional async hook called before each tool call with
            ``(server_name, tool_name, arguments)``.
        on_tool_call_end: Optional async hook called after each tool call with
            ``(server_name, tool_name, result)``.
    """

    # Default result size limit: 10 MiB.
    DEFAULT_MAX_RESULT_BYTES = 10 * 1024 * 1024

    def __init__(
        self,
        config: MCPSection,
        tool_registry: ToolRegistry,
        on_tool_call_start: Callable[[str, str, dict[str, Any]], Awaitable[None]] | None = None,
        on_tool_call_end: Callable[[str, str, ToolResult], Awaitable[None]] | None = None,
    ) -> None:
        self._config = config
        self._registry = tool_registry
        self._on_tool_call_start = on_tool_call_start
        self._on_tool_call_end = on_tool_call_end

    def _validate_arguments(
        self, server_name: str, tool_name: str, arguments: dict[str, Any]
    ) -> None:
        """Validate tool arguments against the tool's JSON Schema.

        Args:
            server_name: MCP server identifier.
            tool_name: Bare or qualified tool name.
            arguments: Arguments to validate.

        Raises:
            :class:`~agent_service_maf.core.exceptions.MCPToolError`:
                If the arguments do not satisfy the tool's input schema.
        """
        # Try qualified name first, then fall back to searching by bare name.
        qualified = f"{server_name}.{tool_name}"
        schema_def = self._registry.get(qualified)
        if schema_def is None:
            matches = self._registry.get_by_name(tool_name)
            schema_def = next((t for t in matches if t.server_name == server_name), None)
        if schema_def is None:
            # No schema available — skip validation rather than blocking.
            logger.debug(
                "No tool schema found for validation — skipping",
                server=server_name,
                tool=tool_name,
            )
            return

        try:
            jsonschema_validate(instance=arguments, schema=schema_def.input_schema)
        except JsonSchemaValidationError as exc:
            raise MCPToolError(
                f"Invalid arguments for tool '{tool_name}' on server '{server_name}': "
                f"{exc.message}. "
                f"Expected schema: {schema_def.input_schema}.",
                server_name=server_name,
                tool_name=tool_name,
            ) from exc

    def _check_result_size(
        self, server_name: str, tool_name: str, content: str | dict[str, Any]
    ) -> None:
        """Enforce the maximum result size limit.

        Args:
            server_name: MCP server identifier (for error messages).
            tool_name: Tool name (for error messages).
            content: Extracted tool result content.

        Raises:
            :class:`~agent_service_maf.core.exceptions.MCPToolError`:
                If the serialised result exceeds the limit.
        """
        text = content if isinstance(content, str) else str(content)
        size = len(text.encode("utf-8", errors="replace"))
        limit = self.DEFAULT_MAX_RESULT_BYTES
        if size > limit:
            raise MCPToolError(
                f"Tool '{tool_name}' on server '{server_name}' returned a result of "
                f"{size:,} bytes which exceeds the limit of {limit:,} bytes "
                f"(mcp.max_result_size_bytes). "
                f"Configure the MCP server to return smaller results or increase the limit.",
                server_name=server_name,
                tool_name=tool_name,
            )

    @staticmethod
    def _extract_content(result: CallToolResult) -> str | dict[str, Any]:
        """Convert a ``CallToolResult`` into a plain string or structured dict.

        Handles ``TextContent``, ``ImageContent``, ``EmbeddedResource``, and
        any other content block type by falling back to ``str()``.

        Args:
            result: ``mcp.types.CallToolResult`` from the SDK.

        Returns:
            String (for text results) or dict (for structured / image results).
        """
        # Use structuredContent when available.
        if result.structuredContent is not None:
            return result.structuredContent

        parts: list[str] = []
        for block in result.content:
            block_type = getattr(block, "type", None)
            if block_type == "text":
                parts.append(getattr(block, "text", str(block)))
            elif block_type == "image":
                mime = getattr(block, "mimeType", "unknown")
                parts.append(f"[image/{mime}: base64 data omitted]")
            elif block_type == "resource":
                uri = getattr(getattr(block, "resource", None), "uri", "unknown")
                parts.append(f"[resource: {uri}]")
            else:
                parts.append(str(block))
        return "\n".join(parts)

    async def call_tool(
        self,
        server_name: str,
        tool_name: str,
        arguments: dict[str, Any],
        group: ClientSessionGroup,
        gateway_server_name: str | None = None,
    ) -> ToolResult:
        """Invoke a tool on an MCP server via the session group.

        Steps:

        1. Validate *arguments* against the tool's JSON Schema.
        2. Fire :attr:`on_tool_call_start` hook.
        3. Call the tool via the ``ClientSessionGroup`` with a timeout.
        4. Check result size.
        5. Fire :attr:`on_tool_call_end` hook.
        6. Return a :class:`~agent_service_maf.mcp.tool_registry.ToolResult`.

        When ``gateway_server_name`` is set, this is a Bifrost-
        multiplexed server: tools are stored in the group under their
        full ``f"{gateway_server_name}-{tool_name}"`` name (because
        Bifrost name-prefixes the aggregated tool list). The dispatch
        re-prefixes before invoking the group so Bifrost can route the
        call to the right upstream client. Hooks and validation continue
        to use the bare ``tool_name`` so they remain LLM-facing.

        Args:
            server_name: MCP server that owns the tool.
            tool_name: Bare tool name (LLM-facing — already stripped of
                any Bifrost prefix at discovery time).
            arguments: Tool call arguments (validated against JSON Schema).
            group: Active ``ClientSessionGroup`` with the server connected.
            gateway_server_name: Bifrost client-name prefix; when set,
                the bare ``tool_name`` is re-prefixed before dispatch.

        Returns:
            Normalised :class:`~agent_service_maf.mcp.tool_registry.ToolResult`.

        Raises:
            :class:`~agent_service_maf.core.exceptions.MCPToolError`:
                On argument validation failure, result size limit exceeded, or
                MCP SDK ``McpError``.
        """
        # 1. Validate arguments.
        self._validate_arguments(server_name, tool_name, arguments)

        # 2. Fire start hook.
        if self._on_tool_call_start is not None:
            await self._on_tool_call_start(server_name, tool_name, arguments)

        # §E3 / §3 — propagate user-on-behalf-of identity via the MCP
        # ``_meta`` field. This is transport-agnostic (works for
        # stdio, SSE, streamable-HTTP) and intentionally excludes the
        # user JWT + service tokens (MCP transport frames may be
        # logged). For HTTP/SSE transports, the service-token
        # ``Authorization`` header is applied once at connect time in
        # :meth:`MCPConnectionManager._connect_one`.
        identity = get_current_identity()
        identity_meta = build_identity_meta(identity)

        # Re-prefix the tool name for Bifrost-multiplexed servers. The
        # group's tool index is keyed by the full prefixed name (that's
        # what `tools/list` returned), so an un-prefixed call would 404
        # at the group level before ever reaching Bifrost.
        dispatch_name = f"{gateway_server_name}-{tool_name}" if gateway_server_name else tool_name

        try:
            async with asyncio.timeout(self._config.tool_call_timeout_seconds):
                raw = await group.call_tool(dispatch_name, arguments, meta=identity_meta)
        except TimeoutError as exc:
            raise MCPToolError(
                f"Tool '{tool_name}' on server '{server_name}' timed out after "
                f"{self._config.tool_call_timeout_seconds}s. "
                f"Increase mcp.tool_call_timeout_seconds or check server performance.",
                server_name=server_name,
                tool_name=tool_name,
            ) from exc
        except McpError as exc:
            raise MCPToolError(
                f"Tool '{tool_name}' failed on server '{server_name}': {exc}. "
                f"Check the MCP server logs for details.",
                server_name=server_name,
                tool_name=tool_name,
            ) from exc
        except KeyError as exc:
            raise MCPToolError(
                f"Tool '{tool_name}' is not registered in the session group for server "
                f"'{server_name}'. "
                f"Available tools: {list(group.tools)}. "
                f"Reconnect or rediscover tools.",
                server_name=server_name,
                tool_name=tool_name,
            ) from exc

        content = self._extract_content(raw)

        # 4. Enforce size limit.
        self._check_result_size(server_name, tool_name, content)

        result = ToolResult(
            content=content,
            is_error=raw.isError,
            raw=raw,
        )

        # 5. Fire end hook.
        if self._on_tool_call_end is not None:
            await self._on_tool_call_end(server_name, tool_name, result)

        return result


# ---------------------------------------------------------------------------
# SRP component 4: Health checks
# ---------------------------------------------------------------------------


class MCPHealthCheck:
    """Checks per-server health by sending MCP ping requests.

    Args:
        config: MCP settings (connection timeout used as ping timeout).
    """

    def __init__(self, config: MCPSection) -> None:
        self._config = config

    async def check(
        self,
        server_name: str,
        session: ClientSession,
    ) -> dict[str, Any]:
        """Ping a specific MCP server and report health status.

        Args:
            server_name: Server identifier (used in the returned dict).
            session: Active :class:`~mcp.ClientSession` for that server.

        Returns:
            Dict with keys ``healthy`` (bool), ``server`` (str), and
            ``latency_ms`` (float).  On failure ``healthy`` is ``False`` and
            an ``error`` key is included.

        Example:
            >>> status = await health_check.check("web", session)
            >>> status
            {"healthy": True, "server": "web", "latency_ms": 12.3}
        """
        start = time.monotonic()
        try:
            async with asyncio.timeout(self._config.connection_timeout_seconds):
                await session.send_ping()
            latency = (time.monotonic() - start) * 1000
            return {
                "healthy": True,
                "server": server_name,
                "latency_ms": round(latency, 2),
            }
        except Exception as exc:
            latency = (time.monotonic() - start) * 1000
            logger.warning(
                "MCP server health check failed",
                server=server_name,
                error=str(exc),
            )
            return {
                "healthy": False,
                "server": server_name,
                "latency_ms": round(latency, 2),
                "error": str(exc),
            }


# ---------------------------------------------------------------------------
# Facade: MCPManager
# ---------------------------------------------------------------------------


class MCPManager:
    """Facade composing connection management, discovery, invocation, and health.

    This is the primary entry point for callers (LLMGateway, app lifecycle
    hooks, etc.).  It delegates to:

    * :class:`MCPConnectionManager` — connection lifecycle
    * :class:`MCPDiscovery` — tool discovery
    * :class:`MCPToolInvoker` — tool call execution
    * :class:`MCPHealthCheck` — per-server health

    Supports ``async with`` context manager for automatic lifecycle management.

    Args:
        config: MCP integration settings.
        tool_registry: Optional pre-existing registry. A new one is created
            when not provided.
        transport_factory: Optional custom transport factory. Defaults to
            :meth:`TransportFactory.default`.
        client: Optional :class:`MCPClientProtocol` implementation for DIP /
            testing.  Defaults to the real MCP SDK client.
        on_tool_call_start: Optional async hook ``(server, tool, args) -> None``
            called before each tool invocation.
        on_tool_call_end: Optional async hook ``(server, tool, result) -> None``
            called after each tool invocation.

    Example:
        >>> async with MCPManager(config) as manager:
        ...     await manager.connect_all()
        ...     result = await manager.call_tool("web", "search", {"query": "hello"})
        ...     print(result.content)
    """

    def __init__(
        self,
        config: MCPSection,
        tool_registry: ToolRegistry | None = None,
        transport_factory: TransportFactory | None = None,
        client: MCPClientProtocol | None = None,
        on_tool_call_start: Callable[[str, str, dict[str, Any]], Awaitable[None]] | None = None,
        on_tool_call_end: Callable[[str, str, ToolResult], Awaitable[None]] | None = None,
        inline_servers: list[dict[str, Any]] | None = None,
    ) -> None:
        self._config = config
        self.tool_registry = tool_registry or ToolRegistry()

        tf = transport_factory or TransportFactory.default()
        self._connection_manager = MCPConnectionManager(
            config=config,
            transport_factory=tf,
            client=client,
            inline_servers=inline_servers,
        )
        self._discovery = MCPDiscovery(self.tool_registry)
        self._invoker = MCPToolInvoker(
            config=config,
            tool_registry=self.tool_registry,
            on_tool_call_start=on_tool_call_start,
            on_tool_call_end=on_tool_call_end,
        )
        self._health = MCPHealthCheck(config=config)

    # ------------------------------------------------------------------
    # Async context manager
    # ------------------------------------------------------------------

    async def __aenter__(self) -> MCPManager:
        """Enter the async context — returns self.

        Returns:
            This :class:`MCPManager` instance.
        """
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: object,
    ) -> None:
        """Exit the async context — disconnects all servers.

        Args:
            exc_type: Exception type if an exception is being propagated.
            exc_val: Exception value.
            exc_tb: Traceback.
        """
        await self.disconnect_all()

    # ------------------------------------------------------------------
    # Connection API
    # ------------------------------------------------------------------

    async def connect(self, server_name: str) -> None:
        """Connect to a single MCP server by name.

        If ``config.discovery_on_connect`` is ``True``, tools are discovered
        immediately after connecting.

        Args:
            server_name: Server identifier from the team config's ``mcp_servers`` array.

        Raises:
            :class:`~agent_service_maf.core.exceptions.MCPConnectionError`:
                If the server is unknown or connection fails.
        """
        await self._connection_manager.connect_server(server_name)
        if self._config.discovery_on_connect:
            group = self._connection_manager.get_group()
            if group is not None:
                session = self._connection_manager.get_session(server_name)
                server_cfg = self._connection_manager.get_config(server_name)
                gateway = server_cfg.gateway_server_name if server_cfg is not None else None
                await self._discovery.discover_server(
                    server_name,
                    group,
                    session,
                    gateway_server_name=gateway,
                )

    async def connect_all(self) -> list[str]:
        """Connect to all configured MCP servers.

        Failures are logged as warnings; the method returns after attempting
        all servers regardless of individual failures.

        Returns:
            List of server names that connected successfully.
        """
        connected = await self._connection_manager.connect_all()
        if self._config.discovery_on_connect and connected:
            group = self._connection_manager.get_group()
            if group is not None:
                sessions = {
                    name: s
                    for name in connected
                    if (s := self._connection_manager.get_session(name)) is not None
                }
                gateway_names: dict[str, str | None] = {}
                for name in connected:
                    cfg = self._connection_manager.get_config(name)
                    gateway_names[name] = cfg.gateway_server_name if cfg else None
                await self._discovery.discover_all(
                    connected,
                    group,
                    sessions,
                    gateway_server_names=gateway_names,
                )
        return connected

    async def disconnect_all(self) -> None:
        """Disconnect all MCP servers and release resources."""
        await self._connection_manager.disconnect_all()

    def connected_servers(self) -> list[str]:
        """Return names of currently connected servers.

        Returns:
            List of server name strings.
        """
        return self._connection_manager.connected_servers()

    def get_default_arguments(self, server_name: str) -> dict[str, Any]:
        """Per-server default arguments configured via ``mcp_servers[].default_arguments``.

        Delegates to :class:`MCPConnectionManager.get_default_arguments`. Used
        by tool executors to merge deployment-fixed parameters into every
        tool call without the LLM needing to know about them.

        Args:
            server_name: Server identifier from the team config.

        Returns:
            Copy of the configured ``default_arguments`` dict, or ``{}`` if
            none configured / the server is unknown.
        """
        return self._connection_manager.get_default_arguments(server_name)

    # ------------------------------------------------------------------
    # Tool invocation API
    # ------------------------------------------------------------------

    async def call_tool(
        self,
        server_name: str,
        tool_name: str,
        arguments: dict[str, Any],
    ) -> ToolResult:
        """Call a tool on a specific MCP server.

        If the server is not connected and ``config.lazy_connect`` is
        ``True``, it is connected on-demand.

        Args:
            server_name: MCP server identifier.
            tool_name: Bare tool name (not qualified).
            arguments: Tool call arguments. Validated against the tool's
                JSON Schema before the call is dispatched.

        Returns:
            Normalised :class:`~agent_service_maf.mcp.tool_registry.ToolResult`.

        Raises:
            :class:`~agent_service_maf.core.exceptions.MCPConnectionError`:
                If the server is not connected and lazy connect is disabled.
            :class:`~agent_service_maf.core.exceptions.MCPToolError`:
                On argument validation failure, result size limit exceeded, or
                MCP protocol error.
        """
        session = self._connection_manager.get_session(server_name)
        if session is None:
            if self._config.lazy_connect:
                await self.connect(server_name)
            else:
                raise MCPConnectionError(
                    f"Not connected to MCP server '{server_name}'. "
                    f"Either enable mcp.lazy_connect or call connect_all() at startup."
                )

        group = self._connection_manager.get_group()
        if group is None:
            raise MCPConnectionError(
                f"ClientSessionGroup is not initialised for server '{server_name}'. "
                f"Call connect() or connect_all() first."
            )

        server_cfg = self._connection_manager.get_config(server_name)
        gateway = server_cfg.gateway_server_name if server_cfg is not None else None
        return await self._invoker.call_tool(
            server_name=server_name,
            tool_name=tool_name,
            arguments=arguments,
            group=group,
            gateway_server_name=gateway,
        )

    # ------------------------------------------------------------------
    # Discovery API
    # ------------------------------------------------------------------

    async def list_tools(self, server_name: str | None = None) -> list[ToolSchema]:
        """Return known tools, optionally filtered by server.

        Args:
            server_name: When given, only return tools from this server.
                When ``None``, return all tools.

        Returns:
            List of :class:`~agent_service_maf.mcp.tool_registry.ToolSchema`.
        """
        if server_name is not None:
            return self.tool_registry.get_tools_for_server(server_name)
        return self.tool_registry.get_all_tools()

    # ------------------------------------------------------------------
    # Health API
    # ------------------------------------------------------------------

    async def check_health(self, server_name: str) -> dict[str, Any]:
        """Check the health of a specific MCP server via a ping.

        Args:
            server_name: Server identifier.

        Returns:
            Dict with ``healthy`` (bool), ``server`` (str), ``latency_ms``
            (float), and optionally ``error`` (str) on failure.

        Raises:
            :class:`~agent_service_maf.core.exceptions.MCPConnectionError`:
                If there is no active session for the server.
        """
        session = self._connection_manager.get_session(server_name)
        if session is None:
            raise MCPConnectionError(
                f"Cannot health-check MCP server '{server_name}' — not connected. "
                f"Call connect('{server_name}') first."
            )
        return await self._health.check(server_name, session)

    async def check_all_health(self) -> list[dict[str, Any]]:
        """Check health of all connected MCP servers.

        Returns:
            List of health status dicts (one per connected server).
        """
        results: list[dict[str, Any]] = []
        for name in self._connection_manager.connected_servers():
            status = await self.check_health(name)
            results.append(status)
        return results
