"""File-backed implementation of the :class:`ConfigSource` protocol.

Selected by ``CONFIG_SOURCE=file`` in :mod:`agent_service_maf.config.settings`.
The runtime behaviour (lazy materialisation, locked-field check, secret
check, env merge, Pydantic validation) is identical to the remote source;
only the payload origin differs.

Two directories are scanned:

- ``AGENT_TEAMS_DIR`` — team JSON files (today's ``configs/team/*.json``).
  Each file's stem (or ``_team_id`` field) is the team id. The team blob
  may have agents inlined under ``semantic_kernel.agents[]`` (matches
  every existing MAF fixture) or reference agent IDs via ``members[]`` —
  the team loader handles both shapes.
- ``AGENT_AGENTS_DIR`` — standalone agent records (new, optional). Each
  file's stem (or ``id``/``agent_id`` field) is the agent id. Used by
  ``/projects/{pid}/agents/{aid}/invoke`` test coverage without
  requiring a running config-service.

When ``AGENT_AGENTS_DIR`` is empty, agent-level routes still work for
agents inlined in a team — the team loader's back-compat path returns
the team payload's ``semantic_kernel.agents[]`` verbatim. Agent records
on disk are only required when tests exercise the synthetic
single-agent bundle path directly (or when an agent should be loadable
without a parent team).

Listings are derived once at construction time (lightweight read of every
file). The actual content is read on each ``get_*`` so a developer can
edit a fixture and re-invoke without restarting the process.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import structlog

from agent_service_maf.config.settings import settings
from agent_service_maf.core.team_loader import (
    UNKNOWN_PROJECT_ID,
    discover_team_config_paths,
)

logger = structlog.get_logger(__name__)


class FileConfigLoader:
    """Lazy file-backed :class:`ConfigSource`.

    Implements ``get_team`` / ``get_agent`` / ``list_teams`` / ``list_agents``
    so :class:`LazyTeamRegistry` can plug it in interchangeably with
    :class:`~agent_service_maf.config.remote_loader.RemoteConfigCache`.

    Args:
        teams_dir: Override the directory containing team JSONs. When
            ``None`` (default) the env vars consulted by
            :func:`discover_team_config_paths` apply.
        agents_dir: Override the directory containing standalone agent
            JSONs. When ``None`` (default) ``settings.AGENT_AGENTS_DIR``
            is used; empty string means "no agent dir".
    """

    def __init__(
        self,
        *,
        teams_dir: str | Path | None = None,
        agents_dir: str | Path | None = None,
    ) -> None:
        self._teams_by_key: dict[tuple[str, str], Path] = {}
        self._agents_by_key: dict[tuple[str, str], Path] = {}
        self._team_summaries: dict[str, list[dict[str, Any]]] = {}
        self._agent_summaries: dict[str, list[dict[str, Any]]] = {}

        self._teams_dir_override: str | Path | None = teams_dir
        # ``""`` is a meaningful "disabled" value here — distinct from
        # ``None`` which falls through to settings.AGENT_AGENTS_DIR.
        self._agents_dir: str | Path = (
            agents_dir if agents_dir is not None else settings.AGENT_AGENTS_DIR
        )
        self._scan()

    # ------------------------------------------------------------------
    # Scanning
    # ------------------------------------------------------------------

    def _scan(self) -> None:
        """Walk both directories and pre-build the (pid, id) → path indexes.

        Scanning is best-effort — unreadable / malformed JSONs are logged
        as warnings and skipped so a single broken fixture cannot prevent
        every other team from loading. The team loader still flags the
        bad file at first invocation with an unhealthy bundle (the route
        layer surfaces it on ``GET /agent-teams``).
        """
        self._scan_teams()
        self._scan_agents()

    def _scan_teams(self) -> None:
        if self._teams_dir_override is not None:
            paths = self._scan_dir_for_json(self._teams_dir_override)
        else:
            # Reuse the canonical team discovery so single-file fallback
            # (AGENT_CONFIG_PATH) keeps working in file mode.
            paths = discover_team_config_paths()

        for path in paths:
            summary = self._read_summary(path, kind="team")
            if summary is None:
                # Unparseable team file. Index under the sentinel project
                # ``_unknown_`` so the lazy registry can still surface an
                # unhealthy bundle on request (matches the pre-migration
                # contract where ``build_team_bundle`` produced an
                # unhealthy bundle with the parser exception).
                tid = path.stem
                self._teams_by_key[(UNKNOWN_PROJECT_ID, tid)] = path
                self._team_summaries.setdefault(UNKNOWN_PROJECT_ID, []).append(
                    {"id": tid, "name": tid, "description": ""}
                )
                continue
            tid = str(summary.get("id") or path.stem)
            pid = str(summary.get("project_id") or summary.get("projectId") or "")
            if not pid:
                # Otherwise-valid JSON but no project_id — also index
                # under ``_unknown_`` so the team is still reachable via
                # the legacy sentinel-project URL pattern.
                self._teams_by_key[(UNKNOWN_PROJECT_ID, tid)] = path
                self._team_summaries.setdefault(UNKNOWN_PROJECT_ID, []).append(
                    {
                        "id": tid,
                        "name": summary.get("name") or tid,
                        "description": summary.get("description", ""),
                    }
                )
                continue
            self._teams_by_key[(pid, tid)] = path
            self._team_summaries.setdefault(pid, []).append(
                {
                    "id": tid,
                    "name": summary.get("name") or tid,
                    "description": summary.get("description", ""),
                }
            )

    def _scan_agents(self) -> None:
        if not self._agents_dir:
            return
        paths = self._scan_dir_for_json(self._agents_dir)
        for path in paths:
            summary = self._read_summary(path, kind="agent")
            if summary is None:
                continue
            aid = str(summary.get("id") or path.stem)
            pid = str(summary.get("project_id") or summary.get("projectId") or "")
            if not pid:
                logger.warning(
                    "file_loader_agent_missing_project_id",
                    path=str(path),
                    agent_id=aid,
                )
                continue
            self._agents_by_key[(pid, aid)] = path
            self._agent_summaries.setdefault(pid, []).append(
                {
                    "id": aid,
                    "name": summary.get("name") or aid,
                    "description": summary.get("description", ""),
                }
            )

    @staticmethod
    def _scan_dir_for_json(dir_path: str | Path) -> list[Path]:
        """Return every ``*.json`` under ``dir_path``, sorted.

        Empty / missing directories return an empty list — no warning.
        Operators may not have populated ``AGENT_AGENTS_DIR`` if they
        don't need standalone-agent test coverage.
        """
        if not dir_path:
            return []
        d = Path(dir_path)
        if not d.is_dir():
            return []
        return sorted(d.glob("*.json"))

    @staticmethod
    def _read_summary(path: Path, *, kind: str) -> dict[str, Any] | None:
        """Read just enough of a JSON file to populate the listing entry.

        Returns ``None`` (and logs a warning) if the file is not valid
        JSON or its top level isn't an object. The actual content is
        re-read on each ``get_*`` so file edits propagate without a
        restart.
        """
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            logger.warning(
                "file_loader_summary_read_failed",
                kind=kind,
                path=str(path),
                error_type=type(exc).__name__,
                error=str(exc),
            )
            return None
        if not isinstance(raw, dict):
            logger.warning(
                "file_loader_summary_not_object",
                kind=kind,
                path=str(path),
                top_level_type=type(raw).__name__,
            )
            return None
        # The "summary" view is uniform regardless of kind so the lazy
        # registry's listing handler doesn't need to special-case it.
        return {
            "id": (
                raw.get("_team_id")
                if kind == "team"
                else raw.get("id") or raw.get("agent_id") or raw.get("agentId")
            )
            or raw.get("id"),
            "project_id": raw.get("project_id") or raw.get("projectId"),
            "name": raw.get("_team_name") if kind == "team" else raw.get("name"),
            "description": (raw.get("_description") if kind == "team" else raw.get("description"))
            or "",
        }

    # ------------------------------------------------------------------
    # ConfigSource protocol
    # ------------------------------------------------------------------

    async def get_team(
        self, project_id: str, team_id: str, *, skip_cache: bool = False
    ) -> dict[str, Any] | None:
        """Return the team blob for ``(project_id, team_id)`` or ``None``.

        ``skip_cache`` is accepted for protocol parity with the remote cache
        but is always ignored in file mode (D6).

        For unparseable files (indexed under ``UNKNOWN_PROJECT_ID``) this
        returns a sentinel dict with ``_unparseable_path`` so the lazy
        registry can route to the file-based builder and surface the
        underlying parser exception as the bundle's ``startup_error``.
        """
        path = self._teams_by_key.get((project_id, team_id))
        if path is None:
            return None
        payload = self._load_json(path)
        if payload is None:
            # Indexed file failed to load (e.g. unparseable JSON). Hand
            # the caller a trampoline so ``build_team_bundle(path)`` can
            # produce an unhealthy bundle with the exact parser error.
            return {"_unparseable_path": str(path)}
        return payload

    def get_team_file_path(self, project_id: str, team_id: str) -> Path | None:
        """Return the on-disk path for an indexed team, or ``None``.

        Used by :class:`~agent_service_maf.core.team_registry_lazy.LazyTeamRegistry`
        to short-circuit composition for the file source — it always
        delegates to :func:`agent_service_maf.core.team_loader.build_team_bundle`
        so the file-mode runtime semantics are bit-identical to the
        pre-migration eager path.
        """
        return self._teams_by_key.get((project_id, team_id))

    def known_projects(self) -> list[str]:
        """Return every project id discovered during the directory scan.

        Includes :data:`UNKNOWN_PROJECT_ID` when any team JSON failed to
        produce a usable ``project_id`` so the route layer's "unknown
        project" 404 stays consistent with the eager path's behaviour.
        """
        return list(self._team_summaries.keys())

    def known_team_keys(self) -> list[tuple[str, str]]:
        """Return every ``(project_id, team_id)`` indexed during the scan.

        Used by the lifespan to pre-warm the lazy registry in file mode
        — the directory scan already paid the cost of reading every
        team's header, so eagerly materialising every team preserves
        the pre-migration "all teams in registry at startup" contract
        for integration tests that inspect ``app.state.teams``
        directly. Remote sources have no equivalent (project / team
        enumeration is not part of the contract).
        """
        return list(self._teams_by_key.keys())

    def is_synchronously_empty(self) -> bool:
        """``True`` when the file loader has indexed zero teams.

        The directory scan runs synchronously at construction so we can
        answer "is the configured universe empty?" without an async
        call. The route layer uses this to short-circuit discovery
        responses with the same "no teams" semantics the eager
        pre-migration registry used to provide.

        Public counterpart to the private ``_teams_by_key`` /
        ``_team_summaries`` attribute reads the route helpers used to
        do — keeps the implementation a single, audited method on the
        loader instead of cross-module attribute access.
        """
        if self._teams_by_key:
            return False
        return not any(bool(v) for v in self._team_summaries.values())

    async def get_agent(
        self, project_id: str, agent_id: str, *, skip_cache: bool = False
    ) -> dict[str, Any] | None:
        """Return the standalone agent record or ``None``.

        ``skip_cache`` is ignored — file mode has no config TTL cache (D6).

        Standalone records live in ``AGENT_AGENTS_DIR`` (when configured).
        When that dir is empty, agent fetches always 404 — the team
        loader still composes inlined team agents because it goes through
        ``get_team`` instead.
        """
        path = self._agents_by_key.get((project_id, agent_id))
        if path is None:
            return None
        return self._load_json(path)

    async def list_teams(self, project_id: str) -> list[dict[str, Any]]:
        return list(self._team_summaries.get(project_id, []))

    async def list_agents(self, project_id: str) -> list[dict[str, Any]]:
        return list(self._agent_summaries.get(project_id, []))

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _load_json(path: Path) -> dict[str, Any] | None:
        """Read + parse a JSON file. ``None`` on read/parse failure so the
        lazy registry surfaces a 404 rather than crashing the request.
        """
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            logger.warning(
                "file_loader_payload_read_failed",
                path=str(path),
                error_type=type(exc).__name__,
                error=str(exc),
            )
            return None
        if not isinstance(raw, dict):
            return None
        return raw

    # ------------------------------------------------------------------
    # Test / admin escape hatch
    # ------------------------------------------------------------------

    def rescan(self) -> None:
        """Drop the indexes and re-scan both directories.

        Useful when a test adds / removes a fixture file at runtime.
        """
        self._teams_by_key.clear()
        self._agents_by_key.clear()
        self._team_summaries.clear()
        self._agent_summaries.clear()
        self._scan()

    def invalidate_team(
        self,
        project_id: str,
        team_id: str | None = None,  # noqa: ARG002
    ) -> None:
        """Cache invalidation is a no-op for the file loader.

        Each ``get_team`` re-reads from disk so there is no in-process
        cache to clear. Provided so the admin endpoint can call the same
        method on both source implementations without an isinstance check.
        """

    def invalidate_agent(
        self,
        project_id: str,
        agent_id: str | None = None,  # noqa: ARG002
    ) -> None:
        """Cache invalidation is a no-op for the file loader (see
        :meth:`invalidate_team`)."""


def _legacy_env_warning() -> None:
    """Surface a one-line warning when ``AGENT_TEAMS_DIR`` is missing while
    ``CONFIG_SOURCE=file``. Helps operators spot half-configured deployments.
    """
    if settings.CONFIG_SOURCE != "file":
        return
    if not (
        settings.AGENT_TEAMS_DIR
        or os.environ.get("AGENT_TEAMS_DIR")
        or os.environ.get("AGENT_CONFIG_PATH")
    ):
        logger.warning(
            "file_config_source_no_teams_dir",
            hint=(
                "CONFIG_SOURCE=file is set but neither AGENT_TEAMS_DIR nor "
                "AGENT_CONFIG_PATH is configured — the registry will be empty."
            ),
        )


__all__ = ["FileConfigLoader"]
