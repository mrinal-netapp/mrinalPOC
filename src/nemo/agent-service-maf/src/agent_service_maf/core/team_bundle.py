"""TeamBundle — per-team runtime bundle for multi-team deployments.

A TeamBundle holds all the runtime resources a single "team" (one agent-config
file's worth of agents + orchestration) needs to answer requests:

- Resolved :class:`~agent_service_maf.config.validators.AppConfig`
- Dedicated :class:`~agent_service_maf.config.config_loader.ConfigLoader` so per-request
  overrides still work and are scoped to this team's base config
- :class:`~agent_service_maf.gateway.llm_gateway.LLMGateway` (LLM routing)
- :class:`~agent_service_maf.mcp.mcp_manager.MCPManager` (tool connections)
- Guardrail pipeline (input/output/tool checks) — optional
- Session manager — optional, shared if memory is disabled

A process hosts a :class:`TeamRegistry` holding one TeamBundle per loaded team,
indexed by ``team_id`` and grouped by ``project_id``. Route handlers resolve
the bundle using the ``/api/v1/projects/{project_id}/agent-teams/{team_id}/...``
path parameters.

No MCP connection pooling is done at MVP time — each team's MCPManager owns
its own connections even if two teams reference the same server URL.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from agent_service_maf.config.config_loader import ConfigLoader
    from agent_service_maf.config.validators import AppConfig
    from agent_service_maf.core.session import SessionManager
    from agent_service_maf.core.task_manager import TaskManager
    from agent_service_maf.gateway.llm_gateway import LLMGateway
    from agent_service_maf.guardrails.pipeline import GuardrailPipeline
    from agent_service_maf.mcp.mcp_manager import MCPManager

#: Two scopes are recognised. ``"team"`` denotes a team-orchestration
#: conversation; ``"agent"`` denotes a one-on-one chat with a specific
#: agent (even when the agent is a member of a team).
SessionScope = Literal["team", "agent"]


@dataclass
class TeamBundle:
    """Runtime resources for a single team.

    Attributes:
        team_id: Stable identifier used in routes (e.g. the filename stem).
        project_id: UUID of the project this team belongs to (from the team
            JSON's top-level ``project_id`` field). Used by route handlers to
            scope ``/api/v1/projects/{project_id}/...`` requests.
        name: Human-readable name — from ``agent.metadata.name`` or ``team_id``.
        description: Optional description from ``_description`` in the config.
        config_path: Absolute path of the source JSON config file (for logs).
        config_loader: Team-scoped loader. Honors per-request overrides.
        config: Initial resolved AppConfig for this team.
        gateway: LLMGateway for this team's model routing.
        mcp_manager: MCPManager owning this team's tool connections.
        guardrails: Pipeline for input/output/tool checks, or None if disabled.
        session_manager: Session/memory manager, or None if memory disabled.
        task_manager: Async-invoke task manager, or None if ``tasks.enabled``
            is False. Owns the team's task store and in-flight asyncio tasks.
        healthy: Whether startup succeeded. Unhealthy teams still surface in
            ``GET /api/v1/projects/{project_id}/agent-teams`` so operators can see
            what failed.
        startup_error: Short error message if ``healthy`` is False.
    """

    team_id: str
    project_id: str
    name: str
    description: str
    config_path: str
    config_loader: ConfigLoader
    config: AppConfig
    gateway: LLMGateway
    mcp_manager: MCPManager
    guardrails: GuardrailPipeline | None = None
    session_manager: SessionManager | None = None
    task_manager: TaskManager | None = None
    healthy: bool = True
    startup_error: str = ""

    def scoped_session_id(
        self,
        session_id: str | None,
        *,
        scope: SessionScope = "team",
        agent_id: str | None = None,
        user_id: str | None = None,
    ) -> str | None:
        """Prefix a caller-supplied ``session_id`` with the right scope tuple.

        After Phase 2 the key encodes four orthogonal isolation axes:

        - **Scope discriminator** (``team`` / ``agent``) — which URL
          hierarchy created the session. A user's team chat and their
          one-on-one with a member agent are distinct threads.
        - **project_id** — multi-tenant boundary. MAF allows duplicate
          ``team_id`` across projects (see ``TeamRegistry.add``), so
          including the project id here keeps cross-project siblings
          isolated even when they share a backing Redis.
        - **Anchor** — ``team_id`` for the team scope, ``agent_id`` for
          the agent scope.
        - **user_id** — per-user partition. Two users sharing a raw
          ``session_id`` never share storage.

        Returns ``None`` for a falsy ``session_id`` so session-less
        requests stay session-less.

        Args:
            session_id: The raw session id from the request payload.
            scope: ``"team"`` (default) for team-orchestration paths;
                ``"agent"`` for paths that name a specific agent.
            agent_id: Required when ``scope='agent'`` — the agent's id.
            user_id: The authenticated caller's id. ``None`` drops to
                the dev-mode shape with no user partition.

        Returns:
            Always 5 colon-separated segments:
            ``"{scope}:{project_id}:{anchor}:{user_id}:{session_id}"``.
            In dev mode without auth ``user_id`` is the empty string,
            producing a literal ``::`` between ``anchor`` and
            ``session_id`` -- this is intentional so the parser can
            always treat the first four segments as fixed-width and
            re-join everything from the fifth onward as the raw
            ``session_id`` (which may itself contain ``:``).

            Returns ``None`` for a falsy ``session_id``.

        Raises:
            ValueError: When ``scope='agent'`` and ``agent_id`` is missing,
                or when ``user_id`` contains ``':'`` (which would shift
                the fixed-width segments and risk collapsing two users'
                partitions onto the same key). ``session_id`` itself may
                contain ``':'`` because it is the trailing segment.
        """
        if not session_id:
            return None

        if scope == "agent":
            if not agent_id:
                raise ValueError("agent_id is required when scope='agent'")
            anchor = agent_id
        else:
            anchor = self.team_id

        # ``:`` in ``user_id`` would let ``_split_scoped`` mis-attribute
        # segments and merge two users' storage. Validate here so every
        # entry point (HTTP, WebSocket, future protocols) gets the same
        # invariant for free instead of relying on each transport to
        # remember to call its own validator before reaching this
        # chokepoint. The HTTP layer still maps this to an explicit 400.
        if user_id is not None and ":" in user_id:
            raise ValueError("user_id may not contain ':'")

        project_id = self.project_id or "_unscoped_"
        # Always emit the 5-segment shape. Previously the dev-mode shape
        # collapsed the empty user_id and produced a 4-segment id; the
        # parser then ambiguously read "{scope}:{project}:{anchor}:{a:b}"
        # (raw session_id containing a colon) as if "a" were a user_id.
        # The fixed-width form is colon-safe regardless of what the caller
        # passed as ``session_id``.
        safe_user_id = user_id or ""
        return f"{scope}:{project_id}:{anchor}:{safe_user_id}:{session_id}"

    def to_public_dict(self) -> dict[str, Any]:
        """Return a non-sensitive summary for ``GET /agent-teams``.

        Safe to call on unhealthy bundles — config may be None for teams whose
        load failed; we still surface team_id/name/description/startup_error.

        ``startup_error`` is echoed whenever it is non-empty, even on
        ``healthy=True`` bundles. The Option-B output-schema validator
        (plan §3 #9 / §4 C4) uses a soft-fail pattern: a malformed
        agent ``output_schema`` does not block team load but surfaces
        as a startup-warning here so operators see it on
        ``GET /agent-teams`` without having to scrape WARNING logs.

        Returns:
            Dict with team_id, name, description, health, agent count,
            orchestration type, and configured model — no secrets.
        """
        summary: dict[str, Any] = {
            "team_id": self.team_id,
            "project_id": self.project_id,
            "name": self.name,
            "description": self.description,
            "healthy": self.healthy,
            "startup_error": self.startup_error,
        }
        if self.config is None:
            summary.update(
                {
                    "framework": None,
                    "model": None,
                    "orchestration_type": None,
                    "agent_count": 0,
                    "agent_names": [],
                }
            )
            return summary

        sk = getattr(self.config, "semantic_kernel", None)
        agents = list(getattr(sk, "agents", []) or []) if sk else []
        orch = getattr(sk, "orchestration", None) if sk else None
        summary.update(
            {
                "framework": self.config.agent.framework,
                "model": self.config.agent.model,
                "orchestration_type": getattr(orch, "type", None) if orch else None,
                "agent_count": len(agents),
                "agent_names": [getattr(a, "name", "") for a in agents],
            }
        )
        return summary


@dataclass
class TeamRegistry:
    """Container for all teams loaded into one process.

    Stored on ``app.state.teams``. Routes call :meth:`get_in_project` to
    resolve a team by ``(project_id, team_id)`` (returns None for unknown
    combinations → 404). The per-project default team is used by
    ``/api/v1/projects/{project_id}/agents/*`` endpoints that don't carry a
    team_id.

    Source of truth is :attr:`_by_project`, a nested
    ``{project_id: {team_id: TeamBundle}}`` map. The flat :attr:`teams`
    dict is retained as a back-compat lookup for code that still keys by
    ``team_id`` alone (e.g., the ``AGENT_DEFAULT_TEAM`` env override and the
    ``app.state.config`` lifespan shim) — it is **first-write-wins** on
    cross-project ``team_id`` collisions and therefore unreliable when two
    projects intentionally reuse the same id. Iteration over every loaded
    bundle (e.g., MCP connect/disconnect at lifespan boundaries) must go
    through :meth:`all_bundles`, not :attr:`teams`.
    """

    teams: dict[str, TeamBundle] = field(default_factory=dict)
    default_team_id: str = ""
    _by_project: dict[str, dict[str, TeamBundle]] = field(default_factory=dict)
    _default_by_project: dict[str, TeamBundle] = field(default_factory=dict)

    def add(self, bundle: TeamBundle) -> None:
        """Register a team.

        Behavior on duplicates:

        - **Same ``(project_id, team_id)`` already present**: the new bundle
          is a real conflict. It is force-marked unhealthy with a
          ``startup_error`` describing the collision and **is not added** to
          the per-project index (the first-loaded bundle keeps the slot).
          The collision is also surfaced in :attr:`teams` only if the slot
          was empty (first-write-wins, same as cross-project case below).
        - **Same ``team_id`` in a *different* project**: legitimate use case.
          Each project keeps its own bundle under :attr:`_by_project`. The
          flat :attr:`teams` lookup gets the first-loaded bundle; subsequent
          cross-project siblings are intentionally not re-indexed there to
          keep ``teams[team_id]`` deterministic across restarts.

        The first team registered for a given project becomes that project's
        default (overridable via :meth:`set_project_default`).
        """
        pid = bundle.project_id

        # Same-project conflict: mark unhealthy and refuse to index.
        if pid and bundle.team_id in self._by_project.get(pid, {}):
            existing = self._by_project[pid][bundle.team_id]
            bundle.healthy = False
            bundle.startup_error = (
                f"Duplicate team_id '{bundle.team_id}' within project '{pid}' "
                f"(first loaded from {existing.config_path}); "
                "team_ids must be unique within a project."
            )
            # Surface via flat lookup only if no entry exists yet (extremely
            # rare — would mean the first instance never made it into
            # ``teams``). Don't touch ``_by_project`` — the first-loaded
            # bundle keeps the slot so routing is deterministic.
            self.teams.setdefault(bundle.team_id, bundle)
            return

        # Index in the nested map. This is the routing source of truth.
        if pid:
            self._by_project.setdefault(pid, {})[bundle.team_id] = bundle
            self._default_by_project.setdefault(pid, bundle)

        # Flat lookup: first-write-wins. We intentionally do NOT overwrite,
        # so consumers that key by team_id alone get stable, deterministic
        # behavior across cross-project duplicates.
        self.teams.setdefault(bundle.team_id, bundle)
        if not self.default_team_id:
            self.default_team_id = bundle.team_id

    def get(self, team_id: str) -> TeamBundle | None:
        """Look up a team by id (back-compat, first-write-wins on duplicates).

        Prefer :meth:`get_in_project` when ``project_id`` is known.
        """
        return self.teams.get(team_id)

    def default(self) -> TeamBundle | None:
        """Return the global default team (first loaded, or env override)."""
        return self.teams.get(self.default_team_id) if self.default_team_id else None

    def all_ids(self) -> list[str]:
        """Return team ids present in the flat lookup, in insertion order.

        Note: with cross-project duplicate team_ids this list contains each
        id only once. Use :meth:`all_bundles` when you need every bundle.
        """
        return list(self.teams.keys())

    def healthy_ids(self) -> list[str]:
        """Return only the ids of teams whose startup succeeded (flat view)."""
        return [tid for tid, t in self.teams.items() if t.healthy]

    def all_bundles(self) -> list[TeamBundle]:
        """Return every registered bundle across every project.

        Use this for lifecycle iteration (MCP connect/disconnect, session
        manager start/stop) — :attr:`teams` deduplicates by team_id and
        therefore misses cross-project siblings.
        """
        return [b for project_map in self._by_project.values() for b in project_map.values()]

    # --- project-scoped lookups -------------------------------------------

    def has_project(self, project_id: str) -> bool:
        """Return True if any team is registered under this project."""
        return project_id in self._by_project and bool(self._by_project[project_id])

    def teams_for_project(self, project_id: str) -> list[TeamBundle]:
        """Return all teams registered under a project, in load order.

        Empty list if the project is unknown.
        """
        return list(self._by_project.get(project_id, {}).values())

    def team_ids_for_project(self, project_id: str) -> list[str]:
        """Return all team ids registered under a project, in load order."""
        return list(self._by_project.get(project_id, {}).keys())

    def get_in_project(self, project_id: str, team_id: str) -> TeamBundle | None:
        """Look up a team by id within a project.

        Returns the bundle registered for this exact ``(project_id, team_id)``
        pair, or ``None``. Cross-project bundles sharing the same team_id
        are never returned — isolation is guaranteed by the nested index.
        """
        return self._by_project.get(project_id, {}).get(team_id)

    def default_for_project(self, project_id: str) -> TeamBundle | None:
        """Return the default team for a project, or ``None`` if the project
        has no teams.
        """
        return self._default_by_project.get(project_id)

    def set_project_default(self, project_id: str, team_id: str) -> bool:
        """Override the default team for a project.

        Returns True if applied, False if the team is not registered under
        that project (in which case the existing default is preserved).
        """
        bundle = self._by_project.get(project_id, {}).get(team_id)
        if bundle is None:
            return False
        self._default_by_project[project_id] = bundle
        return True

    def project_ids(self) -> list[str]:
        """Return all project ids that have at least one team, in load order."""
        return list(self._by_project.keys())
