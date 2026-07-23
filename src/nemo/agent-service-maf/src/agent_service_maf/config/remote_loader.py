"""TTL-cached HTTP fetcher for agent + team configs from config-service.

Mirrors ``agent-service/src/config_cache.py``'s two-cache split: one cache
for standalone agent records (keyed by ``(project_id, agent_id)``) and one
for team blobs (keyed by ``(project_id, team_id)``). Both share auth, HTTP
client, and metrics.

The cache returns **raw dict payloads** — NOT TeamBundles, NOT AgentConfigs.
The caller (lazy registry → ``team_loader._build_bundle_common``) is
responsible for running each payload through :class:`ConfigLoader.resolve`
so locked-field enforcement, secret rejection, env merging, and Pydantic
validation all run on the remote dict exactly the way they do today on a
file-loaded dict.

Cascading invalidation: a team blob references agent IDs, and team
composition fans out to fetch each member agent. When an agent is
invalidated, every team that may embed it is also dropped so the next
team load re-composes against fresh agent data.
"""

from __future__ import annotations

from typing import Any, cast

import httpx
import structlog
from cachetools import TTLCache

from agent_service_maf.config.service_auth import ServiceAccountClient
from agent_service_maf.config.settings import settings

logger = structlog.get_logger(__name__)


class RemoteConfigCache:
    """TTL-cached fetcher for MAF agent + team configs from config-service.

    Args:
        auth: Service-account client used to mint ``Authorization`` headers
            for every outbound request. A single client is shared so the
            cached bearer is reused across all fetches.
        ttl: Cache time-to-live, in seconds. Same TTL applies to both the
            agent and team caches — they share the same staleness contract.
        max_size: Maximum number of entries per cache. Either cache filling
            evicts least-recently-used entries (cachetools default).
        base_url: Optional override for the config-service URL. Defaults to
            ``settings.CONFIG_SERVICE_URL`` so production code paths read
            from the canonical env variable, while tests can plug in a
            different host without touching the env.
        timeout: HTTP request timeout. Defaults to
            ``settings.CONFIG_HTTP_TIMEOUT``.
    """

    def __init__(
        self,
        *,
        auth: ServiceAccountClient,
        ttl: int,
        max_size: int,
        base_url: str | None = None,
        timeout: float | None = None,
    ) -> None:
        self._auth = auth
        # Two parallel caches matching agent-service's pattern of an agent
        # cache (config_cache.py:24) and a team cache (line 34) living side
        # by side. The listing cache holds ``list_*`` results so the
        # /agent-teams listing page is also served from memory between TTL
        # bumps.
        self._agent_cache: TTLCache[str, dict[str, Any]] = TTLCache(maxsize=max_size, ttl=ttl)
        self._team_cache: TTLCache[str, dict[str, Any]] = TTLCache(maxsize=max_size, ttl=ttl)
        # MCP-server records are fetched on every team load when agents
        # reference them by ID — same TTL/size envelope as agents.
        self._mcp_cache: TTLCache[str, dict[str, Any]] = TTLCache(maxsize=max_size, ttl=ttl)
        # Knowledge-base records — same fetch pattern as MCP servers.
        # Agents reference KBs via ``knowledgeBaseIds[]``; the loader
        # synthesises ``kb_retrieve`` function bindings from these.
        self._kb_cache: TTLCache[str, dict[str, Any]] = TTLCache(maxsize=max_size, ttl=ttl)
        # Model records — used by the model catalog to resolve per-request
        # ``configOverrides.model`` UUIDs into the routable gatewayModelId.
        self._model_cache: TTLCache[str, dict[str, Any]] = TTLCache(maxsize=max_size, ttl=ttl)
        self._listing_cache: TTLCache[str, list[dict[str, Any]]] = TTLCache(
            maxsize=max_size, ttl=ttl
        )
        # Last-known-good payloads — kept past TTL for stale-while-error
        # mode (settings.CONFIG_STALE_WHILE_ERROR). When config-service is
        # unreachable we serve the most recently seen payload rather than
        # 503-ing every request. Cleared on explicit invalidate().
        self._lkg_agents: dict[str, dict[str, Any]] = {}
        self._lkg_teams: dict[str, dict[str, Any]] = {}
        self._lkg_mcp: dict[str, dict[str, Any]] = {}
        self._lkg_kb: dict[str, dict[str, Any]] = {}
        self._lkg_models: dict[str, dict[str, Any]] = {}
        self._lkg_listings: dict[str, list[dict[str, Any]]] = {}

        self._url = (base_url or settings.CONFIG_SERVICE_URL).rstrip("/")
        self._timeout = timeout if timeout is not None else settings.CONFIG_HTTP_TIMEOUT
        self._hits = 0
        self._misses = 0
        self._stale_serves = 0
        # Long-lived HTTP client so cache misses reuse pooled connections
        # / keepalives across requests. Creating a fresh AsyncClient per
        # fetch defeats pooling and can exhaust ephemeral ports under
        # sustained load (one TCP handshake + DNS lookup per resource per
        # cache miss). Closed by ``aclose()`` from the app's shutdown
        # path. AsyncClient construction itself is synchronous and makes
        # no network calls, so building it here is safe even outside an
        # event loop.
        self._http_client: httpx.AsyncClient = httpx.AsyncClient(timeout=self._timeout)

    # ------------------------------------------------------------------
    # Agent records
    # ------------------------------------------------------------------

    async def get_agent(
        self, project_id: str, agent_id: str, *, skip_cache: bool = False
    ) -> dict[str, Any] | None:
        """Fetch a standalone agent record.

        Used directly by ``/projects/{pid}/agents/{aid}/invoke`` and
        recursively by :meth:`get_team` to resolve member agents.

        Args:
            project_id: Owning project id.
            agent_id: Agent record id.
            skip_cache: When ``True`` (the ``staging=playground`` path),
                bypass the TTL cache entirely — no read, no write, and no
                last-known-good write/stale-serve. Always issues a fresh
                HTTP fetch so a playground invoke never reads or pollutes
                the shared cache used by ``default`` requests.

        Returns:
            The agent record dict on success, or ``None`` if the
            config-service responds with 404. All other HTTP errors
            propagate.
        """
        key = self._agent_key(project_id, agent_id)
        if not skip_cache and key in self._agent_cache:
            self._hits += 1
            return self._agent_cache[key]
        self._misses += 1
        url = f"{self._url}/api/v1/projects/{project_id}/agents/{agent_id}"
        payload = await self._fetch_json_or_none(
            url, lkg_key=key, lkg_store=self._lkg_agents, skip_cache=skip_cache
        )
        if payload is None:
            return None
        if not isinstance(payload, dict):
            raise self._shape_error(url, payload, expected="object")
        if not skip_cache:
            self._agent_cache[key] = payload
            self._lkg_agents[key] = payload
        return payload

    async def list_agents(self, project_id: str) -> list[dict[str, Any]]:
        """List agent summaries for a project.

        Returns:
            A list of dicts (each at minimum carrying ``id``, ``name``,
            ``description``). Empty list on 404 — listings semantically
            "exist" even when no agents are registered.
        """
        cache_key = self._listing_key("agents", project_id)
        if cache_key in self._listing_cache:
            self._hits += 1
            return self._listing_cache[cache_key]
        self._misses += 1
        url = f"{self._url}/api/v1/projects/{project_id}/agents"
        data = await self._fetch_json_or_none(url, lkg_key=cache_key, lkg_store=self._lkg_listings)
        if data is None:
            return []
        normalized = self._normalize_listing(url, data)
        self._listing_cache[cache_key] = normalized
        self._lkg_listings[cache_key] = normalized
        return normalized

    # ------------------------------------------------------------------
    # Team records
    # ------------------------------------------------------------------

    async def get_team(
        self, project_id: str, team_id: str, *, skip_cache: bool = False
    ) -> dict[str, Any] | None:
        """Fetch a team record.

        The returned dict's ``members[]`` holds agent IDs only —
        composition is done in :func:`build_team_bundle_from_team_blob`
        which fans out to :meth:`get_agent` for each member.

        Args:
            project_id: Owning project id.
            team_id: Team record id.
            skip_cache: When ``True`` (``staging=playground``), bypass the
                TTL cache for read and write (incl. last-known-good) and
                always HTTP-fetch. See :meth:`get_agent`.

        Returns:
            The team record dict on success, or ``None`` on 404.
        """
        key = self._team_key(project_id, team_id)
        if not skip_cache and key in self._team_cache:
            self._hits += 1
            return self._team_cache[key]
        self._misses += 1
        url = f"{self._url}/api/v1/projects/{project_id}/agent-teams/{team_id}"
        payload = await self._fetch_json_or_none(
            url, lkg_key=key, lkg_store=self._lkg_teams, skip_cache=skip_cache
        )
        if payload is None:
            return None
        if not isinstance(payload, dict):
            raise self._shape_error(url, payload, expected="object")
        if not skip_cache:
            self._team_cache[key] = payload
            self._lkg_teams[key] = payload
        return payload

    async def list_teams(self, project_id: str) -> list[dict[str, Any]]:
        """List team summaries for a project."""
        cache_key = self._listing_key("teams", project_id)
        if cache_key in self._listing_cache:
            self._hits += 1
            return self._listing_cache[cache_key]
        self._misses += 1
        url = f"{self._url}/api/v1/projects/{project_id}/agent-teams"
        data = await self._fetch_json_or_none(url, lkg_key=cache_key, lkg_store=self._lkg_listings)
        if data is None:
            return []
        normalized = self._normalize_listing(url, data)
        self._listing_cache[cache_key] = normalized
        self._lkg_listings[cache_key] = normalized
        return normalized

    # ------------------------------------------------------------------
    # MCP-server records
    # ------------------------------------------------------------------

    async def get_mcp_server(self, project_id: str, server_id: str) -> dict[str, Any] | None:
        """Fetch one MCP-server record.

        Used by :func:`build_team_bundle_from_team_blob` to turn an
        agent's ``mcpServerIds`` into MAF's inline ``mcp_servers[]``
        config (name + transport + URL). The URL on the record is
        already routed through the Bifrost gateway — MCP traffic is
        not allowed to go direct to the upstream server — and is
        therefore inlined verbatim.

        Args:
            project_id: Owning project id.
            server_id: MCP-server record id.

        Returns:
            The MCP-server record dict on success, or ``None`` on 404.
        """
        key = self._mcp_key(project_id, server_id)
        if key in self._mcp_cache:
            self._hits += 1
            return self._mcp_cache[key]
        self._misses += 1
        url = f"{self._url}/api/v1/projects/{project_id}/mcp-servers/{server_id}"
        payload = await self._fetch_json_or_none(url, lkg_key=key, lkg_store=self._lkg_mcp)
        if payload is None:
            return None
        if not isinstance(payload, dict):
            raise self._shape_error(url, payload, expected="object")
        self._mcp_cache[key] = payload
        self._lkg_mcp[key] = payload
        return payload

    # ------------------------------------------------------------------
    # Knowledge-base records
    # ------------------------------------------------------------------

    async def get_model(self, project_id: str, model_id: str) -> dict[str, Any] | None:
        """Fetch one model record (carries the Bifrost-routable ``gatewayModelId``).

        Used by :class:`~agent_service_maf.config.model_catalog.ConfigServiceModelCatalog`
        to resolve catalog UUIDs supplied as per-request ``configOverrides.model``
        into the ``provider/model-name`` string that Bifrost requires. Agent
        records embed an already-resolved model dict; this endpoint is only
        hit for the per-request override path where callers (UI playground,
        eval-worker) send the raw catalog UUID.
        """
        key = self._model_key(project_id, model_id)
        if key in self._model_cache:
            self._hits += 1
            return self._model_cache[key]
        self._misses += 1
        url = f"{self._url}/api/v1/projects/{project_id}/models/{model_id}"
        payload = await self._fetch_json_or_none(url, lkg_key=key, lkg_store=self._lkg_models)
        if payload is None:
            return None
        if not isinstance(payload, dict):
            raise self._shape_error(url, payload, expected="object")
        self._model_cache[key] = payload
        self._lkg_models[key] = payload
        return payload

    async def get_knowledge_base(self, project_id: str, kb_id: str) -> dict[str, Any] | None:
        """Fetch one knowledge-base record.

        Used by :func:`build_team_bundle_from_team_blob` to turn each
        ``knowledgeBaseIds`` entry on an agent record into a synthetic
        ``kb_retrieve`` :class:`FunctionBinding`. ``kb_retrieve`` is a
        Python-registered tool function (no direct HTTP from MAF →
        external KB endpoints; it goes through the in-process function
        that itself talks to the configured KB backend).

        Args:
            project_id: Owning project id.
            kb_id: Knowledge-base record id.

        Returns:
            The KB record dict on success, or ``None`` on 404.
        """
        key = self._kb_key(project_id, kb_id)
        if key in self._kb_cache:
            self._hits += 1
            return self._kb_cache[key]
        self._misses += 1
        url = f"{self._url}/api/v1/projects/{project_id}/knowledgebases/{kb_id}"
        payload = await self._fetch_json_or_none(url, lkg_key=key, lkg_store=self._lkg_kb)
        if payload is None:
            return None
        if not isinstance(payload, dict):
            raise self._shape_error(url, payload, expected="object")
        self._kb_cache[key] = payload
        self._lkg_kb[key] = payload
        return payload

    # ------------------------------------------------------------------
    # Invalidation
    # ------------------------------------------------------------------

    def invalidate_agent(self, project_id: str, agent_id: str | None = None) -> None:
        """Drop one agent's cache entry, or every agent for the project.

        Team blobs embed agent IDs and the composed bundle pulls each
        member through :meth:`get_agent`. Invalidating an agent therefore
        cascades to every team blob in the same project so the next team
        load re-composes against fresh agent data — matches
        agent-service's invariant in ``config_cache.py``.
        """
        if agent_id:
            key = self._agent_key(project_id, agent_id)
            self._agent_cache.pop(key, None)
            self._lkg_agents.pop(key, None)
        else:
            prefix = f"agent:{project_id}:"
            for k in [k for k in self._agent_cache if k.startswith(prefix)]:
                self._agent_cache.pop(k, None)
            for k in [k for k in self._lkg_agents if k.startswith(prefix)]:
                self._lkg_agents.pop(k, None)
            self._listing_cache.pop(self._listing_key("agents", project_id), None)
            self._lkg_listings.pop(self._listing_key("agents", project_id), None)
        # Cascade — teams may embed this agent.
        self.invalidate_team(project_id)

    def invalidate_team(self, project_id: str, team_id: str | None = None) -> None:
        """Drop one team's cache entry, or every team for the project."""
        if team_id:
            key = self._team_key(project_id, team_id)
            self._team_cache.pop(key, None)
            self._lkg_teams.pop(key, None)
        else:
            prefix = f"team:{project_id}:"
            for k in [k for k in self._team_cache if k.startswith(prefix)]:
                self._team_cache.pop(k, None)
            for k in [k for k in self._lkg_teams if k.startswith(prefix)]:
                self._lkg_teams.pop(k, None)
            self._listing_cache.pop(self._listing_key("teams", project_id), None)
            self._lkg_listings.pop(self._listing_key("teams", project_id), None)

    def invalidate_knowledge_base(self, project_id: str, kb_id: str | None = None) -> None:
        """Drop one KB entry (or every KB for the project).

        Team bundles embed synthesized ``kb_retrieve`` bindings that
        reference KB records; KB changes must re-flow into the bundles,
        so this cascade-invalidates teams in the same project.
        """
        if kb_id:
            key = self._kb_key(project_id, kb_id)
            self._kb_cache.pop(key, None)
            self._lkg_kb.pop(key, None)
        else:
            prefix = f"kb:{project_id}:"
            for k in [k for k in self._kb_cache if k.startswith(prefix)]:
                self._kb_cache.pop(k, None)
            for k in [k for k in self._lkg_kb if k.startswith(prefix)]:
                self._lkg_kb.pop(k, None)
        # Cascade — teams embed synthesised bindings referencing this KB.
        self.invalidate_team(project_id)

    def invalidate_mcp_server(self, project_id: str, server_id: str | None = None) -> None:
        """Drop one MCP-server entry (or every server for the project).

        Team bundles embed inline MCP configs derived from these records;
        changes to a server (URL, transport, headers) should re-flow into
        the bundles, so this cascade-invalidates teams in the same
        project just like :meth:`invalidate_agent`.
        """
        if server_id:
            key = self._mcp_key(project_id, server_id)
            self._mcp_cache.pop(key, None)
            self._lkg_mcp.pop(key, None)
        else:
            prefix = f"mcp:{project_id}:"
            for k in [k for k in self._mcp_cache if k.startswith(prefix)]:
                self._mcp_cache.pop(k, None)
            for k in [k for k in self._lkg_mcp if k.startswith(prefix)]:
                self._lkg_mcp.pop(k, None)
        # Cascade — teams embed resolved server configs.
        self.invalidate_team(project_id)

    # ------------------------------------------------------------------
    # Status / introspection
    # ------------------------------------------------------------------

    def is_synchronously_empty(self) -> bool:
        """``False`` — emptiness is not knowable without an async call.

        The remote source can't enumerate projects / teams without a
        round trip. The route helpers therefore must NOT assume the
        registry is empty just because the local cache is cold; the
        lazy-load contract is "an empty registry at startup is normal".

        Public counterpart to :meth:`FileConfigLoader.is_synchronously_empty`
        — both methods satisfy the same protocol so the route layer
        can call them uniformly without inspecting source internals.
        """
        return False

    async def aclose(self) -> None:
        """Release the pooled HTTP client.

        Idempotent — safe to call multiple times (httpx ``AsyncClient.aclose``
        on an already-closed client is a no-op). The lifespan's shutdown
        path invokes this so any keep-alive connections are returned to
        the OS instead of lingering until process exit.
        """
        await self._http_client.aclose()

    def status_snapshot(self) -> dict[str, Any]:
        """Return a non-sensitive summary of cache state.

        Surfaced by the future ``/health`` / status reporter and consumed
        by the rollout checklist (>95% hit rate target at steady state).
        """
        total = self._hits + self._misses
        return {
            "agents": len(self._agent_cache),
            "teams": len(self._team_cache),
            "listings": len(self._listing_cache),
            "max_size": self._agent_cache.maxsize,
            "ttl_seconds": int(self._agent_cache.ttl),
            "hits": self._hits,
            "misses": self._misses,
            "stale_serves": self._stale_serves,
            "hit_rate_pct": round((self._hits / total * 100) if total else 0.0, 1),
        }

    # ------------------------------------------------------------------
    # Shared HTTP helpers
    # ------------------------------------------------------------------

    async def _fetch_json_or_none(
        self,
        url: str,
        *,
        lkg_key: str,
        lkg_store: dict[str, Any],
        skip_cache: bool = False,
    ) -> Any:  # noqa: ANN401  # config-service shape varies by endpoint
        """GET ``url`` with auth headers. Return parsed JSON, ``None`` on 404,
        or the last-known-good payload when the network is unreachable and
        stale-while-error is enabled.

        Args:
            url: Fully-qualified target URL.
            lkg_key: Key into ``lkg_store`` used for stale-while-error
                fallback. The cache miss path stores the fresh payload
                under this key; this method only reads.
            lkg_store: One of ``_lkg_agents`` / ``_lkg_teams`` /
                ``_lkg_listings``. Stale-while-error returns the
                previously stored value for ``lkg_key`` when set.
            skip_cache: When ``True`` (``staging=playground``), the
                stale-while-error last-known-good *read* is also skipped \u2014
                a playground fetch must never serve a cached payload, even
                during a config-service outage. The error propagates
                instead, surfacing as a 503 to the caller.

        Raises:
            httpx.HTTPStatusError: For any non-2xx, non-404 response.
            ConfigurationError: When auth headers cannot be acquired (the
                underlying ``ServiceAccountClient`` already raises this).
        """
        headers = await self._auth.auth_headers()
        try:
            resp = await self._http_client.get(url, headers=headers)
        except httpx.HTTPError as exc:
            # Network-level failure (DNS, connect, read). Fall back to
            # last-known-good if available; otherwise re-raise. The
            # playground bypass (skip_cache) declines the stale read so
            # the fetch is always fresh-or-fail.
            if settings.CONFIG_STALE_WHILE_ERROR and not skip_cache and lkg_key in lkg_store:
                self._stale_serves += 1
                logger.warning(
                    "remote_config_stale_serve",
                    url=url,
                    error_type=type(exc).__name__,
                    error=str(exc),
                )
                return lkg_store[lkg_key]
            logger.error(
                "remote_config_fetch_failed",
                url=url,
                error_type=type(exc).__name__,
                error=str(exc),
            )
            raise

        if resp.status_code == 404:
            return None
        if resp.status_code >= 400:
            # Try stale-while-error before bubbling (skipped on the
            # playground bypass for the same fresh-or-fail reason).
            if settings.CONFIG_STALE_WHILE_ERROR and not skip_cache and lkg_key in lkg_store:
                self._stale_serves += 1
                logger.warning(
                    "remote_config_stale_serve_on_status",
                    url=url,
                    status=resp.status_code,
                )
                return lkg_store[lkg_key]
            resp.raise_for_status()
        try:
            return resp.json()
        except ValueError as exc:
            raise self._shape_error(url, resp.text, expected="json") from exc

    @staticmethod
    def _agent_key(project_id: str, agent_id: str) -> str:
        return f"agent:{project_id}:{agent_id}"

    @staticmethod
    def _team_key(project_id: str, team_id: str) -> str:
        return f"team:{project_id}:{team_id}"

    @staticmethod
    def _mcp_key(project_id: str, server_id: str) -> str:
        return f"mcp:{project_id}:{server_id}"

    @staticmethod
    def _kb_key(project_id: str, kb_id: str) -> str:
        return f"kb:{project_id}:{kb_id}"

    @staticmethod
    def _model_key(project_id: str, model_id: str) -> str:
        return f"model:{project_id}:{model_id}"

    @staticmethod
    def _listing_key(kind: str, project_id: str) -> str:
        return f"{kind}:{project_id}"

    @staticmethod
    def _normalize_listing(
        url: str,
        data: Any,  # noqa: ANN401  # parsed JSON; shape validated below
    ) -> list[dict[str, Any]]:
        """Listing endpoints can return either a bare ``[...]`` array or a
        wrapped ``{"items": [...]}`` envelope. Tolerate both so a
        config-service shape tweak does not require a MAF redeploy.
        """
        if isinstance(data, list):
            return [item for item in data if isinstance(item, dict)]
        if isinstance(data, dict):
            items = data.get("items") or data.get("data") or []
            if isinstance(items, list):
                return [item for item in items if isinstance(item, dict)]
        raise RemoteConfigCache._shape_error(url, data, expected="array or {items:[]}")

    @staticmethod
    def _shape_error(
        url: str,
        payload: Any,  # noqa: ANN401  # raw parsed JSON for diagnostic preview
        *,
        expected: str,
    ) -> ValueError:
        body_preview = repr(payload)
        if len(body_preview) > 200:
            body_preview = body_preview[:200] + "..."
        return ValueError(
            f"Unexpected response shape from config-service "
            f"(url={url}, expected={expected}, got={body_preview})"
        )


__all__ = ["RemoteConfigCache"]


# Re-exported as a runtime cast helper so callers expecting ``dict[str, Any]``
# from the cache do not need to repeat the narrow at every call site.
def _typed_dict(
    payload: Any,  # noqa: ANN401  # cast helper accepts any runtime value
) -> dict[str, Any]:  # pragma: no cover - typing aid
    return cast(dict[str, Any], payload)
