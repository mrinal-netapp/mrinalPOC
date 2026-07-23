"""MCP connection pool routing through the Bifrost LLM gateway."""

import asyncio
import hashlib
import json
import time
from datetime import timedelta
from enum import Enum

from agno.tools.mcp import MCPTools, StreamableHTTPClientParams
from observability_client_runtime import get_logger

from .config import settings
from .llmproxy_gateway_settings import mcp_auth_headers, mcp_url_for_server

logger = get_logger()


def _mcp_header_provider(run_context, agent=None, team=None):
    """Inject per-run identity headers into MCP tool calls.

    Called by Agno with the RunContext of the current arun().
    During connect() (no active run), run_context is None -- return empty.

    Forwarded headers:
      Authorization, X-Project-ID, X-User-ID  -- pre-existing.
      X-Session-ID  -- session id from RunContext; used by the artifact
        store to resolve the 'SESSION' ref sentinel and to stamp the
        X-Session-Id audit trailer on every commit.
      X-Agent-ID    -- agent id when an agent (or team member) is running.
      X-Team-ID     -- team id when a team is running.

    The artifact-service relies on these headers for ACL resolution and
    non-bypassable audit trailers; without them, audit and ACL are blind.
    """
    if run_context is None:
        return {}
    headers: dict[str, str] = {}
    meta = run_context.metadata or {}
    if meta.get("authorization"):
        headers["Authorization"] = meta["authorization"]
    if meta.get("project_id"):
        headers["X-Project-ID"] = meta["project_id"]
    if run_context.user_id:
        headers["X-User-ID"] = run_context.user_id

    session_id = getattr(run_context, "session_id", None) or meta.get("session_id")
    if session_id:
        headers["X-Session-ID"] = str(session_id)

    if agent is not None:
        agent_id = getattr(agent, "id", None) or getattr(agent, "agent_id", None)
        if agent_id:
            headers["X-Agent-ID"] = str(agent_id)

    if team is not None:
        team_id = getattr(team, "id", None) or getattr(team, "team_id", None)
        if team_id:
            headers["X-Team-ID"] = str(team_id)

    return headers


class _ConnHealth(str, Enum):
    HEALTHY = "healthy"
    INIT_FAILED = "init_failed"
    UNHEALTHY = "unhealthy"


class _ConnEntry:
    """Wrapper around an MCPTools connection with health metadata."""

    __slots__ = (
        "conn", "config_hash", "server_name", "created_at",
        "last_used", "access_count", "health", "last_error",
        "consecutive_failures",
    )

    def __init__(
        self, conn: MCPTools, config_hash: str, server_name: str,
    ) -> None:
        now = time.monotonic()
        self.conn = conn
        self.config_hash = config_hash
        self.server_name = server_name
        self.created_at = now
        self.last_used = now
        self.access_count = 0
        self.health: _ConnHealth = _ConnHealth.HEALTHY
        self.last_error: str | None = None
        self.consecutive_failures = 0


class MCPConnectionPool:
    """Maintains long-lived MCP connections through the LLM gateway proxy.
    Evicts and recreates connections when server config changes.
    Closes idle connections after MCP_IDLE_TTL seconds.
    Tracks connection health and refuses to hand out broken connections.

    Naming note: the field ``llmproxyGatewayServerName`` (read from the
    ``server_config`` dict returned by config-service) is the MCP client
    name registered with the **LLM proxy gateway** (Bifrost) — it is
    NOT the AgentStudio api-gateway / apigateway-service. The
    unambiguous ``llmproxyGateway*`` naming is used end-to-end (DB
    column, OpenAPI, Go workflow-engine, GUI, Python). Historical
    chain for context: ``litellmServerName`` → ``gatewayServerName`` →
    ``llmproxyGatewayServerName``.
    """

    MAX_CONSECUTIVE_FAILURES = 3

    def __init__(self, idle_ttl: int = 0) -> None:
        self._entries: dict[str, _ConnEntry] = {}
        self._lock = asyncio.Lock()
        self._idle_ttl = idle_ttl

    def _hash_config(self, server_config: dict) -> str:
        # `llmproxyGatewayServerName` = the MCP client name at the LLM
        # proxy gateway (Bifrost); see class docstring.
        keys = ("llmproxyGatewayServerName", "timeout")
        canonical = json.dumps(
            {k: server_config[k] for k in sorted(server_config) if k in keys},
            sort_keys=True,
        )
        return hashlib.sha256(canonical.encode()).hexdigest()

    async def get_tools(self, server_id: str, server_config: dict) -> MCPTools:
        """Return an initialized MCPTools connection, creating one if needed.

        Raises RuntimeError if the server is unhealthy and cannot be recovered.
        """
        config_hash = self._hash_config(server_config)
        now = time.monotonic()
        async with self._lock:
            entry = self._entries.get(server_id)

            if entry and entry.config_hash != config_hash:
                logger.info(
                    ">>> MCP POOL RECYCLE | server=%s (%s) | reason=config_changed",
                    server_id, entry.server_name,
                )
                await self._close_entry(server_id, entry)
                entry = None

            if entry and entry.health == _ConnHealth.INIT_FAILED:
                age = now - entry.created_at
                if age < 60:
                    raise RuntimeError(
                        f"MCP server {server_id} ({entry.server_name}) failed to "
                        f"initialize {entry.consecutive_failures} time(s), last "
                        f"error: {entry.last_error}. Will retry after cooldown."
                    )
                logger.info(
                    ">>> MCP POOL RETRY   | server=%s (%s) | age=%.0fs "
                    "| retrying after init failure cooldown",
                    server_id, entry.server_name, age,
                )
                await self._close_entry(server_id, entry)
                entry = None

            if entry and entry.health == _ConnHealth.UNHEALTHY:
                if entry.consecutive_failures >= self.MAX_CONSECUTIVE_FAILURES:
                    age = now - entry.last_used
                    if age < 120:
                        raise RuntimeError(
                            f"MCP server {server_id} ({entry.server_name}) marked "
                            f"unhealthy after {entry.consecutive_failures} consecutive "
                            f"failures, last error: {entry.last_error}. "
                            f"Cooling down for {120 - age:.0f}s."
                        )
                logger.info(
                    ">>> MCP POOL REHAB   | server=%s (%s) | "
                    "re-initializing unhealthy connection",
                    server_id, entry.server_name,
                )
                await self._close_entry(server_id, entry)
                entry = None

            if entry is None:
                entry = await self._create_entry(server_id, server_config, config_hash)
                self._entries[server_id] = entry

            entry.last_used = now
            entry.access_count += 1
            return entry.conn

    async def _create_entry(
        self, server_id: str, server_config: dict, config_hash: str,
    ) -> _ConnEntry:
        """Create a new MCP connection entry with timeout-guarded initialization."""
        # `llmproxyGatewayServerName` is the MCP client name at the LLM
        # proxy gateway (Bifrost), NOT the AgentStudio api-gateway.
        server_name = server_config.get("llmproxyGatewayServerName")
        if not server_name:
            raise ValueError(
                f"MCP server {server_id} has no llmproxyGatewayServerName "
                "(MCP client name at the LLM proxy gateway / Bifrost)"
            )

        llmproxy_gateway_mcp_url = mcp_url_for_server(server_name)
        headers: dict[str, str] = dict(mcp_auth_headers())
        logger.info(
            ">>> MCP POOL BIFROST | server=%s (%s) | aggregated /mcp endpoint",
            server_id, server_name,
        )

        timeout_ms = server_config.get("timeout", 600000)
        server_params = StreamableHTTPClientParams(
            url=llmproxy_gateway_mcp_url,
            headers=headers,
            timeout=timedelta(milliseconds=timeout_ms),
        )
        mcp = MCPTools(
            server_params=server_params,
            transport="streamable-http",
            timeout_seconds=settings.MCP_TOOL_TIMEOUT,
            header_provider=_mcp_header_provider,
        )
        logger.info(
            ">>> MCP POOL CREATE  | server=%s (%s) | url=%s | timeout=%dms | tool_timeout=%ds",
            server_id, server_name, llmproxy_gateway_mcp_url, timeout_ms, settings.MCP_TOOL_TIMEOUT,
        )

        entry = _ConnEntry(mcp, config_hash, server_name or server_id)

        try:
            await asyncio.wait_for(
                mcp.connect(),
                timeout=settings.MCP_INIT_TIMEOUT,
            )
            entry.health = _ConnHealth.HEALTHY
            logger.info(
                ">>> MCP POOL READY   | server=%s (%s) | health=HEALTHY | pool_size=%d",
                server_id, server_name, len(self._entries) + 1,
            )
        except asyncio.TimeoutError:
            entry.health = _ConnHealth.INIT_FAILED
            entry.last_error = (
                f"connect() timed out after {settings.MCP_INIT_TIMEOUT}s"
            )
            entry.consecutive_failures += 1
            logger.error(
                ">>> MCP POOL INIT TIMEOUT | server=%s (%s) | timeout=%ds "
                "| This server will NOT be attached to agents.",
                server_id, server_name, settings.MCP_INIT_TIMEOUT,
            )
            raise RuntimeError(
                f"MCP server {server_id} ({server_name}) connection timed out "
                f"after {settings.MCP_INIT_TIMEOUT}s. Server will not be used."
            )
        except Exception as init_exc:
            entry.health = _ConnHealth.INIT_FAILED
            entry.last_error = str(init_exc)
            entry.consecutive_failures += 1
            logger.error(
                ">>> MCP POOL INIT FAILED  | server=%s (%s) | error=%s "
                "| This server will NOT be attached to agents.",
                server_id, server_name, init_exc,
            )
            self._entries[server_id] = entry
            raise RuntimeError(
                f"MCP server {server_id} ({server_name}) failed to connect: "
                f"{init_exc}. Server will not be used."
            )

        return entry

    def mark_unhealthy(self, server_id: str, error: str) -> None:
        """Called by agent invocation code when an MCP tool call fails at runtime."""
        entry = self._entries.get(server_id)
        if entry:
            entry.health = _ConnHealth.UNHEALTHY
            entry.last_error = error
            entry.consecutive_failures += 1
            logger.warning(
                ">>> MCP POOL MARK UNHEALTHY | server=%s (%s) | "
                "consecutive_failures=%d | error=%s",
                server_id, entry.server_name,
                entry.consecutive_failures, error,
            )

    def mark_healthy(self, server_id: str) -> None:
        """Called after a successful agent run that used this server's tools."""
        entry = self._entries.get(server_id)
        if entry:
            entry.health = _ConnHealth.HEALTHY
            entry.consecutive_failures = 0
            entry.last_error = None

    async def _close_entry(self, server_id: str, entry: _ConnEntry) -> None:
        try:
            await asyncio.wait_for(entry.conn.close(), timeout=5)
        except Exception:
            pass
        self._entries.pop(server_id, None)

    async def evict_idle(self) -> list[str]:
        """Close connections idle longer than idle_ttl or stuck in INIT_FAILED.
        Returns IDs of evicted servers."""
        now = time.monotonic()
        evicted: list[str] = []
        async with self._lock:
            for server_id in list(self._entries):
                entry = self._entries[server_id]
                idle_secs = now - entry.last_used
                should_evict = False
                reason = ""

                if self._idle_ttl > 0 and idle_secs > self._idle_ttl:
                    should_evict = True
                    reason = f"idle={idle_secs:.0f}s > ttl={self._idle_ttl}s"

                if entry.health == _ConnHealth.INIT_FAILED:
                    age = now - entry.created_at
                    if age > 120:
                        should_evict = True
                        reason = f"init_failed, age={age:.0f}s"

                if (
                    entry.health == _ConnHealth.UNHEALTHY
                    and entry.consecutive_failures >= self.MAX_CONSECUTIVE_FAILURES
                ):
                    should_evict = True
                    reason = (
                        f"unhealthy, failures={entry.consecutive_failures}, "
                        f"last_error={entry.last_error}"
                    )

                if should_evict:
                    logger.info(
                        ">>> MCP POOL EVICT   | server=%s (%s) | reason=%s",
                        server_id, entry.server_name, reason,
                    )
                    await self._close_entry(server_id, entry)
                    evicted.append(f"{server_id} ({entry.server_name})")
        return evicted

    def status_snapshot(self) -> dict:
        """Return a snapshot of pool state for the periodic status report."""
        now = time.monotonic()
        connections = []
        for server_id, entry in self._entries.items():
            connections.append({
                "server_id": server_id,
                "name": entry.server_name,
                "health": entry.health.value,
                "accesses": entry.access_count,
                "consecutive_failures": entry.consecutive_failures,
                "last_error": entry.last_error,
                "idle_seconds": round(now - entry.last_used, 1),
                "age_seconds": round(now - entry.created_at, 1),
            })
        return {
            "pool_size": len(self._entries),
            "idle_ttl": self._idle_ttl,
            "connections": connections,
        }

    async def close_all(self) -> None:
        for server_id in list(self._entries):
            entry = self._entries.pop(server_id)
            try:
                await asyncio.wait_for(entry.conn.close(), timeout=5)
                logger.info("MCP connection closed for server %s", server_id)
            except Exception as e:
                logger.warning(
                    "Error closing MCP connection for %s: %s", server_id, e,
                )
        self._entries.clear()
