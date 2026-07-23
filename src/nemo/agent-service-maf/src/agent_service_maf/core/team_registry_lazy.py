"""Lazy ``TeamRegistry`` — materialises ``TeamBundle``s on first access.

Drop-in replacement for the eager ``TeamRegistry`` from ``team_bundle.py``,
plus two new async methods (``get_or_load_team`` / ``get_or_load_agent``)
that fetch from a pluggable :class:`ConfigSource` and run the post-build
lifecycle (MCP connect, task manager start) before returning the bundle.

The source is plugged in by ``api.py::lifespan`` based on ``CONFIG_SOURCE``:

- ``CONFIG_SOURCE=remote`` → :class:`~agent_service_maf.config.remote_loader.RemoteConfigCache`
- ``CONFIG_SOURCE=file``   → :class:`~agent_service_maf.config.file_loader.FileConfigLoader`

Both implement the same four-method protocol so the registry is source-
agnostic — every Execution-Behavior Invariant from the migration plan is
preserved across both modes.

Concurrency model
-----------------

- Per-(project_id, team_id) and per-(project_id, agent_id) ``asyncio.Lock``
  prevents stampedes: two concurrent first-request invocations of the same
  team will *not* fire two config-service fetches; the second waits.
- After the first successful build, subsequent calls take a synchronous
  fast path through the inner ``TeamRegistry`` (no lock acquisition) so
  steady-state latency is unaffected.
- ``all_bundles()`` delegates to the inner registry so lifespan shutdown
  + ``app.state.*`` back-compat shims only see *materialised* bundles —
  un-warmed teams contribute nothing to the teardown sequence.
"""

from __future__ import annotations

import asyncio
import functools
from typing import TYPE_CHECKING, Any, Protocol, runtime_checkable

import httpx
import structlog

from agent_service_maf.config.settings import settings
from agent_service_maf.core.query_options import QueryOptions
from agent_service_maf.core.team_bundle import TeamBundle, TeamRegistry
from agent_service_maf.core.team_loader import (
    build_team_bundle,
    build_team_bundle_from_agent,
    build_team_bundle_from_team_blob,
)

if TYPE_CHECKING:  # pragma: no cover - typing only
    from collections.abc import Awaitable, Callable

    PostBuildHookType = Callable[[TeamBundle], Awaitable[None]]
else:
    PostBuildHookType = object

logger = structlog.get_logger(__name__)


@runtime_checkable
class ConfigSource(Protocol):
    """Source-agnostic interface plugged into :class:`LazyTeamRegistry`.

    Two implementations exist:
    :class:`~agent_service_maf.config.remote_loader.RemoteConfigCache` for
    config-service HTTP, and
    :class:`~agent_service_maf.config.file_loader.FileConfigLoader` for the
    local ``configs/team/*.json`` testing escape hatch. Both honour the
    same four-method contract so a single registry handles either.
    """

    async def get_team(
        self, project_id: str, team_id: str, *, skip_cache: bool = False
    ) -> dict[str, Any] | None: ...
    async def get_agent(
        self, project_id: str, agent_id: str, *, skip_cache: bool = False
    ) -> dict[str, Any] | None: ...
    async def list_teams(self, project_id: str) -> list[dict[str, Any]]: ...
    async def list_agents(self, project_id: str) -> list[dict[str, Any]]: ...


# Hook called after a bundle is materialised but before it's added to the
# inner registry. ``api.py::lifespan`` wires this to run MCP connect + task
# manager start so any team produced through the lazy path comes out of
# the registry already wired up. The default no-op keeps tests and direct
# callers (which don't need lifecycle) ergonomic.
PostBuildHook = "Callable[[TeamBundle], Awaitable[None]] | None"


class LazyTeamRegistry:
    """Builds ``TeamBundle``s on first access from a pluggable source.

    Public API surface mirrors :class:`TeamRegistry` for the read-side so
    existing routes can use either via :meth:`get_in_project`,
    :meth:`default_for_project`, :meth:`teams_for_project`, etc. Mutating
    methods (``add``, ``set_project_default``) are forwarded to ``_inner``
    so the legacy code paths keep working when an explicit pre-warm or
    AGENT_DEFAULT_TEAM override is supplied.

    Args:
        source: A :class:`ConfigSource` implementation. Required.
        post_build_hook: Optional async callback invoked once per
            newly-materialised bundle. Used by the lifespan to connect
            MCP servers and start the task manager before the bundle is
            handed to the route layer.
    """

    def __init__(
        self,
        *,
        source: ConfigSource,
        post_build_hook: PostBuildHookType | None = None,
        vk_resolver: Any | None = None,  # noqa: ANN401  # ProjectVKResolver — typed loose to avoid import cycle
    ) -> None:
        self._inner: TeamRegistry = TeamRegistry()
        self._source = source
        self._post_build_hook = post_build_hook
        # Per-project Bifrost VK resolver. When wired, every bundle
        # build (file-mode or remote-mode) gets its gateway.api_key
        # overridden with the project's VK from config-service.
        self._vk_resolver = vk_resolver
        # Coalesce concurrent first-fetches per (kind, project, id).
        self._locks: dict[str, asyncio.Lock] = {}
        # Single registry-wide lock guarding the lock dictionary itself
        # (lookup-or-create is racy without it).
        self._locks_guard = asyncio.Lock()
        # ``AGENT_DEFAULT_TEAM`` may name a team that hasn't been
        # materialised at startup. Remember the operator's choice so each
        # subsequent ``add`` re-applies the override the moment a
        # matching bundle appears.
        self._explicit_default_team_id: str = ""

    def set_explicit_default_team_id(self, team_id: str) -> None:
        """Record an operator's ``AGENT_DEFAULT_TEAM`` choice for late
        application.

        The lazy registry can't honour the override at startup because the
        named team may not be materialised yet. Storing the id here lets
        every subsequent successful ``add()`` (whether triggered by
        warm-up, an explicit request, or a listing fan-out) promote the
        matching bundle to the default — preserving the legacy
        ``AGENT_DEFAULT_TEAM`` contract exercised by integration tests.
        """
        self._explicit_default_team_id = team_id.strip()

    # ------------------------------------------------------------------
    # Lazy materialisation
    # ------------------------------------------------------------------

    async def get_or_load_team(
        self, project_id: str, team_id: str, *, query_options: QueryOptions | None = None
    ) -> TeamBundle | None:
        """Resolve a team by id, fetching + composing on first access.

        Fast path: when the bundle is already materialised and healthy,
        returns the cached bundle without taking any lock — the
        synchronous lookup is the steady-state path.

        Slow path: serialise concurrent misses under a per-team lock so a
        thundering herd of first requests issues a single config-service
        fetch + a single MCP connect.

        Args:
            project_id: Owning project id.
            team_id: Team record id.
            staging: ``"playground"`` bypasses **both** cache layers for
                this call (config-service ``skip_cache=True`` + no
                ``add()`` into the registry), building a request-scoped
                bundle only — see the module's staging contract. Any other
                value (``"default"`` etc.) is the unchanged cached path.
                The bypass only engages when the source supports it
                (config-service / remote mode); file mode ignores it (D6).
                Passed via ``query_options``.

        Returns:
            The bundle on success, ``None`` if the source reports 404
            (no such team in this project).
        """
        apply_playground = self._apply_playground(query_options)

        if not apply_playground:
            existing = self._inner.get_in_project(project_id, team_id)
            if existing is not None and existing.healthy:
                return existing

        async with await self._get_lock(self._team_lock_key(project_id, team_id)):
            # Re-check inside the lock — another coroutine may have built
            # the bundle while we were waiting. Skipped for playground,
            # which must always rebuild fresh.
            if not apply_playground:
                existing = self._inner.get_in_project(project_id, team_id)
                if existing is not None and existing.healthy:
                    return existing

            # File source short-circuit. When the loader can hand us the
            # team's on-disk path, delegate to ``build_team_bundle(path)``
            # so the file-mode runtime semantics are bit-identical to the
            # pre-migration eager path (including the unhealthy-bundle +
            # parser-error breadcrumb for malformed JSON).
            path_fetcher = getattr(self._source, "get_team_file_path", None)
            if callable(path_fetcher):
                team_path = path_fetcher(project_id, team_id)
                if team_path is not None:
                    bundle = await build_team_bundle(team_path, vk_resolver=self._vk_resolver)
                    await self._post_build_lifecycle(bundle)
                    self.add(bundle)
                    return bundle
                # Path-based source but no path indexed — treat as 404.
                return None

            team_payload = await self._safe_fetch(
                self._source.get_team,
                project_id,
                team_id,
                kind="team",
                skip_cache=apply_playground,
            )
            if team_payload is None:
                return None

            mcp_get = getattr(self._source, "get_mcp_server", None)
            kb_get = getattr(self._source, "get_knowledge_base", None)
            bundle = await build_team_bundle_from_team_blob(
                team_id=team_id,
                project_id=project_id,
                name=str(team_payload.get("_team_name") or team_payload.get("name") or team_id),
                description=str(
                    team_payload.get("_description") or team_payload.get("description") or ""
                ),
                team_payload=team_payload,
                agent_resolver=(
                    functools.partial(self._source.get_agent, skip_cache=True)
                    if apply_playground
                    else self._source.get_agent
                ),
                mcp_server_resolver=mcp_get,
                kb_resolver=kb_get,
                source_ref=self._source_ref("team", project_id, team_id),
                vk_resolver=self._vk_resolver,
            )
            await self._post_build_lifecycle(bundle)
            # Playground bundles are request-scoped only — never written to
            # the in-process registry so they cannot pollute or be served
            # to subsequent ``default`` requests (D1).
            if not apply_playground:
                self.add(bundle)
            return bundle

    async def get_or_load_agent(
        self, project_id: str, agent_id: str, *, query_options: QueryOptions | None = None
    ) -> TeamBundle | None:
        """Resolve a standalone agent invocation.

        Materialises a synthetic single-agent ``TeamBundle`` keyed under
        ``team_id = f"_agent_{agent_id}_"`` so all downstream code
        (routes, session manager, MCP, executor) stays unchanged.

        Args:
            project_id: Owning project id.
            agent_id: Agent record id.
            staging: ``"playground"`` bypasses both cache layers for this
                call (config-service ``skip_cache=True`` + no ``add()``),
                returning a request-scoped bundle only. Any other value is
                the unchanged cached path. The bypass engages only in
                config-service / remote mode (D6). Passed via ``query_options``.
        """
        apply_playground = self._apply_playground(query_options)
        synthetic_team_id = f"_agent_{agent_id}_"

        if not apply_playground:
            existing = self._inner.get_in_project(project_id, synthetic_team_id)
            if existing is not None and existing.healthy:
                return existing

        async with await self._get_lock(self._agent_lock_key(project_id, agent_id)):
            if not apply_playground:
                existing = self._inner.get_in_project(project_id, synthetic_team_id)
                if existing is not None and existing.healthy:
                    return existing

            agent_payload = await self._safe_fetch(
                self._source.get_agent,
                project_id,
                agent_id,
                kind="agent",
                skip_cache=apply_playground,
            )
            if agent_payload is None:
                return None

            # The agent record may not carry project_id (e.g. the
            # config-service returns a flat shape). Inject the URL's
            # project_id so the synthetic team's project tag matches.
            if not agent_payload.get("project_id") and not agent_payload.get("projectId"):
                agent_payload = {**agent_payload, "project_id": project_id}

            mcp_get = getattr(self._source, "get_mcp_server", None)
            kb_get = getattr(self._source, "get_knowledge_base", None)
            bundle = await build_team_bundle_from_agent(
                project_id=project_id,
                agent_id=agent_id,
                agent_payload=agent_payload,
                source_ref=self._source_ref("agent", project_id, agent_id),
                mcp_server_resolver=mcp_get,
                kb_resolver=kb_get,
                vk_resolver=self._vk_resolver,
            )
            await self._post_build_lifecycle(bundle)
            # Request-scoped only on the playground path (D1).
            if not apply_playground:
                self.add(bundle)
            return bundle

    # ------------------------------------------------------------------
    # Bulk listing
    # ------------------------------------------------------------------

    async def list_teams_for_project(self, project_id: str) -> list[TeamBundle]:
        """Fetch the team listing for a project and materialise each.

        Bundles that were already loaded reuse the cached entry; only
        previously-unseen teams trigger a fresh fetch + build. Returns
        only successfully-loaded bundles — 404s are silently dropped.
        """
        summaries = await self._safe_listing(self._source.list_teams, project_id, kind="teams")
        out: list[TeamBundle] = []
        for s in summaries:
            tid = self._summary_id(s)
            if not tid:
                continue
            bundle = await self.get_or_load_team(project_id, tid)
            if bundle is not None:
                out.append(bundle)
        return out

    async def list_agents_for_project(self, project_id: str) -> list[TeamBundle]:
        """Fetch the agent listing for a project and materialise each
        as a synthetic single-agent bundle."""
        summaries = await self._safe_listing(self._source.list_agents, project_id, kind="agents")
        out: list[TeamBundle] = []
        for s in summaries:
            aid = self._summary_id(s)
            if not aid:
                continue
            bundle = await self.get_or_load_agent(project_id, aid)
            if bundle is not None:
                out.append(bundle)
        return out

    # ------------------------------------------------------------------
    # Eviction
    # ------------------------------------------------------------------

    def evict_team(self, project_id: str, team_id: str | None = None) -> None:
        """Drop one or every team bundle from the registry.

        The next ``get_or_load_team`` will re-fetch from the source.
        Used by the admin invalidation endpoint when config-service
        signals a change.
        """
        if team_id:
            self._evict_one(project_id, team_id)
        else:
            for tid in list(self._inner.team_ids_for_project(project_id)):
                if not tid.startswith("_agent_"):
                    self._evict_one(project_id, tid)

    def evict_agent(self, project_id: str, agent_id: str | None = None) -> None:
        """Drop a synthetic single-agent bundle (or every one for the
        project). Mirrors :meth:`evict_team`.
        """
        if agent_id:
            self._evict_one(project_id, f"_agent_{agent_id}_")
        else:
            for tid in list(self._inner.team_ids_for_project(project_id)):
                if tid.startswith("_agent_"):
                    self._evict_one(project_id, tid)

    def _evict_one(self, project_id: str, team_id: str) -> None:
        """Best-effort removal of one bundle from both indices."""
        project_map = self._inner._by_project.get(project_id, {})
        bundle = project_map.pop(team_id, None)
        if bundle is None:
            return
        # Maintain the per-project default if we dropped it.
        default = self._inner._default_by_project.get(project_id)
        if default is bundle:
            # Pick the next surviving bundle, or remove the project entry
            # entirely if empty.
            remaining = next(iter(project_map.values()), None)
            if remaining is None:
                self._inner._default_by_project.pop(project_id, None)
            else:
                self._inner._default_by_project[project_id] = remaining
        if not project_map:
            self._inner._by_project.pop(project_id, None)
        # Flat ``teams`` is first-write-wins; only drop the entry if it
        # points at the bundle we just evicted (otherwise a cross-project
        # sibling would lose its slot).
        flat_entry = self._inner.teams.get(team_id)
        if flat_entry is bundle:
            self._inner.teams.pop(team_id, None)
            if self._inner.default_team_id == team_id:
                # Pick any surviving team_id (deterministic by insertion order).
                self._inner.default_team_id = next(iter(self._inner.teams), "")

    # ------------------------------------------------------------------
    # TeamRegistry-shaped delegation surface (read-side mirrors)
    # ------------------------------------------------------------------

    @property
    def teams(self) -> dict[str, TeamBundle]:
        """Flat lookup — back-compat with code that keys by team_id alone.

        Exposes only materialised bundles. The legacy ``AGENT_DEFAULT_TEAM``
        env override + ``app.state`` shims read this attribute so they
        keep working in lazy mode.
        """
        return self._inner.teams

    @property
    def default_team_id(self) -> str:
        return self._inner.default_team_id

    @default_team_id.setter
    def default_team_id(self, value: str) -> None:
        self._inner.default_team_id = value

    def default(self) -> TeamBundle | None:
        return self._inner.default()

    def get(self, team_id: str) -> TeamBundle | None:
        return self._inner.get(team_id)

    def get_in_project(self, project_id: str, team_id: str) -> TeamBundle | None:
        return self._inner.get_in_project(project_id, team_id)

    def has_project(self, project_id: str) -> bool:
        return self._inner.has_project(project_id)

    def teams_for_project(self, project_id: str) -> list[TeamBundle]:
        return self._inner.teams_for_project(project_id)

    def team_ids_for_project(self, project_id: str) -> list[str]:
        return self._inner.team_ids_for_project(project_id)

    def default_for_project(self, project_id: str) -> TeamBundle | None:
        return self._inner.default_for_project(project_id)

    def set_project_default(self, project_id: str, team_id: str) -> bool:
        return self._inner.set_project_default(project_id, team_id)

    def project_ids(self) -> list[str]:
        return self._inner.project_ids()

    def all_bundles(self) -> list[TeamBundle]:
        return self._inner.all_bundles()

    def all_ids(self) -> list[str]:
        return self._inner.all_ids()

    def healthy_ids(self) -> list[str]:
        return self._inner.healthy_ids()

    # ------------------------------------------------------------------
    # Source introspection — public API used by the route layer
    # ------------------------------------------------------------------
    # These three methods expose the synchronously-knowable bits of the
    # underlying :class:`ConfigSource` without forcing the route layer
    # to reach into ``_source`` (and its source-specific private state).
    # All three return safe defaults on missing methods or source-side
    # exceptions so a discovery-tier 404/503 path is never broken by a
    # source bug.

    def known_projects(self) -> list[str] | None:
        """Return the project ids the source knows synchronously, or
        ``None`` when the source can't answer without an async call
        (e.g. the remote cache).

        Used by ``_require_known_project`` to preserve the legacy 404
        for unknown projects in file mode while skipping the check
        entirely in remote mode.
        """
        fetcher = getattr(self._source, "known_projects", None)
        if not callable(fetcher):
            return None
        try:
            return list(fetcher())
        except Exception:  # noqa: BLE001  - defensive: never break discovery
            return None

    def is_synchronously_empty(self) -> bool:
        """Return ``True`` when the source can confirm zero teams
        synchronously, ``False`` otherwise (including for sources that
        don't implement the probe). See
        :meth:`agent_service_maf.config.file_loader.FileConfigLoader.is_synchronously_empty`
        and the matching remote-mode method for the per-source contract.
        """
        fn = getattr(self._source, "is_synchronously_empty", None)
        if not callable(fn):
            return False
        try:
            return bool(fn())
        except Exception:  # noqa: BLE001  - defensive
            return False

    async def list_team_summaries(self, project_id: str) -> list[dict[str, Any]]:
        """Return the raw team-summary listing for ``project_id``.

        Distinct from :meth:`list_teams_for_project`, which materialises
        each bundle. The route layer just needs the summary dicts (for
        404 hints, default-team materialisation). Failures are
        swallowed — the caller still gets ``[]`` so the 404 surfaces.
        """
        try:
            return list(await self._source.list_teams(project_id))
        except Exception as exc:  # noqa: BLE001
            logger.debug(
                "list_team_summaries_failed",
                project_id=project_id,
                error=str(exc),
            )
            return []

    def add(self, bundle: TeamBundle) -> None:
        """Insert a bundle into the inner registry (used by pre-warm).

        Also re-applies the operator's ``AGENT_DEFAULT_TEAM`` override
        whenever the newly-added bundle matches the recorded
        :attr:`_explicit_default_team_id`. The override survives lazy
        materialisation order because it is captured *before* any team
        is built — see :meth:`set_explicit_default_team_id`.
        """
        self._inner.add(bundle)
        if self._explicit_default_team_id and bundle.team_id == self._explicit_default_team_id:
            self._inner.default_team_id = bundle.team_id
            if bundle.project_id:
                self._inner.set_project_default(bundle.project_id, bundle.team_id)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _apply_playground(self, query_options: QueryOptions | None) -> bool:
        """Return ``True`` when the ``staging=playground`` bypass should engage.

        Playground cache bypass is **remote mode only** (D6). In file mode
        ``?staging=playground`` is ignored with a warning — never a 400.
        ``None`` query_options is treated as the default cached path.
        """
        if query_options is None or query_options.staging != "playground":
            return False
        if settings.CONFIG_SOURCE != "remote":
            logger.warning(
                "staging_playground_ignored_non_remote",
                config_source=settings.CONFIG_SOURCE,
            )
            return False
        return True

    async def _get_lock(self, key: str) -> asyncio.Lock:
        """Return (or create) the asyncio.Lock for ``key``.

        Lock creation itself is async because ``dict.setdefault`` is
        sufficient for atomicity here, but the outer guard keeps the
        creation observable in tests that need to assert on lock count.
        """
        # ``setdefault`` is atomic in CPython; the outer guard ensures no
        # spurious key churn under heavy contention.
        async with self._locks_guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = asyncio.Lock()
                self._locks[key] = lock
            return lock

    @staticmethod
    def _team_lock_key(project_id: str, team_id: str) -> str:
        return f"team:{project_id}:{team_id}"

    @staticmethod
    def _agent_lock_key(project_id: str, agent_id: str) -> str:
        return f"agent:{project_id}:{agent_id}"

    def _source_ref(self, kind: str, project_id: str, entity_id: str) -> str:
        """Build a human-readable source label for ``TeamBundle.config_path``.

        Tags the bundle with the active source mode (``remote`` / ``file``)
        so logs and unhealthy-team responses make the data origin obvious.
        Reads from :data:`settings` rather than passing in a constructor
        argument so a single registry can be reused across the test
        escape hatch without reconstruction.
        """
        return f"{settings.CONFIG_SOURCE}:{kind}/{project_id}/{entity_id}"

    @staticmethod
    def _summary_id(summary: dict[str, Any]) -> str:
        """Pull the entity id from a listing entry.

        Tolerates both ``id`` (config-service standard) and ``team_id`` /
        ``agent_id`` (legacy / file source) so the same registry can
        consume either shape unchanged.
        """
        for key in ("id", "team_id", "teamId", "agent_id", "agentId"):
            value = summary.get(key)
            if value:
                return str(value)
        return ""

    @staticmethod
    async def _safe_fetch(
        fn: Any,  # noqa: ANN401  # bound source method, signature varies
        project_id: str,
        entity_id: str,
        *,
        kind: str,
        skip_cache: bool = False,
    ) -> dict[str, Any] | None:
        """Wrap a source fetch so 404s come back as ``None``.

        Other HTTPStatusErrors propagate so the registry doesn't mask a
        misconfigured config-service as "no such team". Network-level
        failures fall through to the source's own stale-while-error
        handling.
        """
        try:
            result: dict[str, Any] | None = await fn(project_id, entity_id, skip_cache=skip_cache)
            return result
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                return None
            logger.warning(
                "config_source_fetch_http_error",
                kind=kind,
                project_id=project_id,
                entity_id=entity_id,
                status=exc.response.status_code,
            )
            raise

    @staticmethod
    async def _safe_listing(
        fn: Any,  # noqa: ANN401  # bound source method, signature varies
        project_id: str,
        *,
        kind: str,
    ) -> list[dict[str, Any]]:
        """Wrap a source listing so 404 returns an empty list rather than
        propagating. Other errors bubble.
        """
        try:
            result: list[dict[str, Any]] = await fn(project_id)
            return result
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                return []
            logger.warning(
                "config_source_listing_http_error",
                kind=kind,
                project_id=project_id,
                status=exc.response.status_code,
            )
            raise

    async def _post_build_lifecycle(self, bundle: TeamBundle) -> None:
        """Hand the freshly-built bundle to the registered post-build hook.

        Used by ``api.py::lifespan`` to connect MCP servers + start the
        task manager so the bundle is fully wired by the time the request
        handler receives it.

        Errors from the hook flip the bundle to unhealthy with the hook's
        error message; the registry still indexes the unhealthy bundle so
        operators see it on ``GET /agent-teams``.
        """
        if self._post_build_hook is None:
            return
        try:
            await self._post_build_hook(bundle)
        except Exception as exc:
            logger.error(
                "post_build_hook_failed",
                project_id=bundle.project_id,
                team_id=bundle.team_id,
                error_type=type(exc).__name__,
                error=str(exc),
            )
            bundle.healthy = False
            existing = bundle.startup_error.strip()
            bundle.startup_error = (
                f"{existing} | post-build hook failed: {exc}".strip(" |")
                if existing
                else f"post-build hook failed: {exc}"
            )


__all__ = ["ConfigSource", "LazyTeamRegistry"]
