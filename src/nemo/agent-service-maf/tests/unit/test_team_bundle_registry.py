"""Unit tests for :class:`agent_service_maf.core.team_bundle.TeamRegistry`
and :meth:`TeamBundle.to_public_dict` / ``scoped_session_id``.

These pin the multi-project bundle indexing contract:

* Adding two bundles with the SAME ``(project_id, team_id)`` marks the
  second unhealthy and refuses to re-index. The first-loaded slot wins.
* Adding the SAME ``team_id`` under DIFFERENT projects keeps both
  bundles isolated under ``_by_project``. The flat ``teams`` lookup is
  first-write-wins.
* The per-project default points at the first-loaded bundle and can be
  overridden via :meth:`set_project_default` (which returns False for
  unknown team ids).
* :meth:`to_public_dict` is safe on unhealthy / None-config bundles —
  it never raises, even when startup didn't get far enough to populate
  the AppConfig.
* :meth:`scoped_session_id` enforces the colon-safety invariant on
  ``user_id`` and produces the 5-segment fixed-width shape.
"""

from __future__ import annotations

from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import pytest

from agent_service_maf.core.team_bundle import TeamBundle, TeamRegistry

# ---------------------------------------------------------------------------
# Bundle factory — avoids constructing the real AppConfig / gateway / etc.
# ---------------------------------------------------------------------------


@dataclass
class _StubAgent:
    name: str = ""


@dataclass
class _StubOrchestration:
    type: str = "single"


@dataclass
class _StubSk:
    agents: list[_StubAgent]
    orchestration: _StubOrchestration | None


@dataclass
class _StubAppConfig:
    """Minimal stand-in mirroring the attributes ``to_public_dict`` reads."""

    semantic_kernel: _StubSk | None
    agent: SimpleNamespace


def _make_app_config(
    *,
    framework: str = "maf",
    model: str = "azure/gpt-4o-mini",
    agents: list[str] | None = None,
    orchestration_type: str | None = "single",
) -> _StubAppConfig:
    return _StubAppConfig(
        agent=SimpleNamespace(framework=framework, model=model),
        semantic_kernel=_StubSk(
            agents=[_StubAgent(name=n) for n in (agents or [])],
            orchestration=_StubOrchestration(type=orchestration_type)
            if orchestration_type
            else None,
        ),
    )


def _bundle(
    *,
    team_id: str,
    project_id: str = "proj-1",
    name: str | None = None,
    description: str = "",
    config_path: str = "/tmp/team.json",
    config: Any = None,
    healthy: bool = True,
    startup_error: str = "",
) -> TeamBundle:
    return TeamBundle(
        team_id=team_id,
        project_id=project_id,
        name=name if name is not None else team_id,
        description=description,
        config_path=config_path,
        config_loader=None,  # type: ignore[arg-type]
        config=config,  # type: ignore[arg-type]
        gateway=None,  # type: ignore[arg-type]
        mcp_manager=None,  # type: ignore[arg-type]
        healthy=healthy,
        startup_error=startup_error,
    )


# ---------------------------------------------------------------------------
# TeamRegistry.add — duplicate handling
# ---------------------------------------------------------------------------


class TestTeamRegistryAdd:
    def test_first_bundle_indexes_and_becomes_default(self) -> None:
        reg = TeamRegistry()
        b = _bundle(team_id="t1", project_id="proj-A")
        reg.add(b)

        assert reg.get("t1") is b
        assert reg.get_in_project("proj-A", "t1") is b
        assert reg.default() is b
        assert reg.default_for_project("proj-A") is b
        assert reg.has_project("proj-A") is True
        assert reg.project_ids() == ["proj-A"]
        assert reg.all_bundles() == [b]

    def test_same_project_duplicate_marks_second_unhealthy(self) -> None:
        # The second add under the same (project_id, team_id) must NOT
        # overwrite the first in _by_project; the first-loaded bundle is
        # the routing source of truth, and the duplicate is force-marked
        # unhealthy with a descriptive startup_error so ops can grep it.
        reg = TeamRegistry()
        first = _bundle(team_id="t1", project_id="proj-A", config_path="/configs/first.json")
        dup = _bundle(team_id="t1", project_id="proj-A", config_path="/configs/dup.json")
        reg.add(first)
        reg.add(dup)

        # _by_project still points at the first-loaded.
        assert reg.get_in_project("proj-A", "t1") is first
        # Duplicate is unhealthy with a clear message.
        assert dup.healthy is False
        assert "Duplicate team_id 't1'" in dup.startup_error
        assert "proj-A" in dup.startup_error
        assert "/configs/first.json" in dup.startup_error

    def test_cross_project_duplicate_team_id_is_allowed(self) -> None:
        # Two projects deliberately reusing the same team_id is a real
        # use case (per-project bundle isolation). _by_project must
        # keep them separate; the flat `teams` lookup is first-write-wins.
        reg = TeamRegistry()
        a = _bundle(team_id="shared", project_id="proj-A", config_path="/a.json")
        b = _bundle(team_id="shared", project_id="proj-B", config_path="/b.json")
        reg.add(a)
        reg.add(b)

        # Per-project isolation preserved.
        assert reg.get_in_project("proj-A", "shared") is a
        assert reg.get_in_project("proj-B", "shared") is b
        # Both projects show up in project_ids.
        assert sorted(reg.project_ids()) == ["proj-A", "proj-B"]
        # all_bundles() walks _by_project, so it sees BOTH (order is
        # project insertion → bundle insertion within each project).
        bundles = reg.all_bundles()
        assert len(bundles) == 2
        assert a in bundles and b in bundles
        # Flat lookup is first-write-wins.
        assert reg.get("shared") is a
        # Neither bundle is force-unhealthy — cross-project shared IDs are valid.
        assert a.healthy is True
        assert b.healthy is True
        assert a.startup_error == ""
        assert b.startup_error == ""

    def test_first_global_team_drives_default_team_id_only_once(self) -> None:
        reg = TeamRegistry()
        first = _bundle(team_id="alpha", project_id="proj-A")
        second = _bundle(team_id="beta", project_id="proj-B")
        reg.add(first)
        reg.add(second)

        # Global default is the FIRST loaded, not overwritten by later adds.
        assert reg.default_team_id == "alpha"
        assert reg.default() is first


# ---------------------------------------------------------------------------
# TeamRegistry — project-scoped helpers
# ---------------------------------------------------------------------------


class TestTeamRegistryLookups:
    def test_default_for_project_returns_first_loaded_team(self) -> None:
        reg = TeamRegistry()
        a = _bundle(team_id="a", project_id="proj-X")
        b = _bundle(team_id="b", project_id="proj-X")
        reg.add(a)
        reg.add(b)
        assert reg.default_for_project("proj-X") is a

    def test_set_project_default_swaps_to_known_team(self) -> None:
        reg = TeamRegistry()
        a = _bundle(team_id="a", project_id="proj-X")
        b = _bundle(team_id="b", project_id="proj-X")
        reg.add(a)
        reg.add(b)
        assert reg.set_project_default("proj-X", "b") is True
        assert reg.default_for_project("proj-X") is b

    def test_set_project_default_unknown_team_is_no_op(self) -> None:
        reg = TeamRegistry()
        a = _bundle(team_id="a", project_id="proj-X")
        reg.add(a)
        assert reg.set_project_default("proj-X", "nonexistent") is False
        # Existing default still in place.
        assert reg.default_for_project("proj-X") is a

    def test_set_project_default_unknown_project_is_no_op(self) -> None:
        reg = TeamRegistry()
        a = _bundle(team_id="a", project_id="proj-X")
        reg.add(a)
        assert reg.set_project_default("proj-Y", "a") is False

    def test_teams_for_project_lists_in_load_order(self) -> None:
        reg = TeamRegistry()
        a = _bundle(team_id="alpha", project_id="p")
        b = _bundle(team_id="beta", project_id="p")
        c = _bundle(team_id="gamma", project_id="p")
        for bundle in (a, b, c):
            reg.add(bundle)
        assert reg.teams_for_project("p") == [a, b, c]
        assert reg.team_ids_for_project("p") == ["alpha", "beta", "gamma"]

    def test_teams_for_unknown_project_is_empty(self) -> None:
        reg = TeamRegistry()
        assert reg.teams_for_project("unknown") == []
        assert reg.team_ids_for_project("unknown") == []
        assert reg.has_project("unknown") is False

    def test_get_in_project_unknown_pair_returns_none(self) -> None:
        reg = TeamRegistry()
        reg.add(_bundle(team_id="t1", project_id="proj-A"))
        assert reg.get_in_project("proj-A", "nonexistent") is None
        assert reg.get_in_project("proj-OTHER", "t1") is None

    def test_healthy_ids_filters_to_healthy_teams(self) -> None:
        reg = TeamRegistry()
        healthy = _bundle(team_id="ok", project_id="p")
        sick = _bundle(team_id="bad", project_id="p", healthy=False, startup_error="boom")
        reg.add(healthy)
        reg.add(sick)
        assert reg.healthy_ids() == ["ok"]
        # all_ids includes both — order is insertion order.
        assert reg.all_ids() == ["ok", "bad"]


# ---------------------------------------------------------------------------
# TeamBundle.to_public_dict — safe on unhealthy / None-config bundles
# ---------------------------------------------------------------------------


class TestToPublicDict:
    def test_safe_when_config_is_none(self) -> None:
        # Unhealthy bundle that never finished loading — config is None.
        # The method must still return a usable summary instead of raising.
        b = _bundle(
            team_id="t-bad",
            project_id="proj-A",
            config=None,
            healthy=False,
            startup_error="config load failed",
        )
        summary = b.to_public_dict()
        assert summary["team_id"] == "t-bad"
        assert summary["healthy"] is False
        assert summary["startup_error"] == "config load failed"
        # Stubs for missing-config fields — not raises.
        assert summary["framework"] is None
        assert summary["model"] is None
        assert summary["orchestration_type"] is None
        assert summary["agent_count"] == 0
        assert summary["agent_names"] == []

    def test_populated_summary_with_full_config(self) -> None:
        cfg = _make_app_config(
            framework="maf",
            model="azure/gpt-4o-mini",
            agents=["alpha", "beta"],
            orchestration_type="magentic",
        )
        b = _bundle(team_id="ok", project_id="p", config=cfg, description="my team")
        summary = b.to_public_dict()
        assert summary["framework"] == "maf"
        assert summary["model"] == "azure/gpt-4o-mini"
        assert summary["orchestration_type"] == "magentic"
        assert summary["agent_count"] == 2
        assert summary["agent_names"] == ["alpha", "beta"]
        assert summary["description"] == "my team"
        assert summary["healthy"] is True
        assert summary["startup_error"] == ""

    def test_orchestration_omitted_when_sk_missing(self) -> None:
        # semantic_kernel section can legitimately be None on a no-orchestration
        # team (rare, but the method should not assume it).
        cfg = _StubAppConfig(
            agent=SimpleNamespace(framework="maf", model="m"),
            semantic_kernel=None,
        )
        b = _bundle(team_id="ok", project_id="p", config=cfg)
        summary = b.to_public_dict()
        assert summary["framework"] == "maf"
        assert summary["model"] == "m"
        assert summary["agent_count"] == 0
        assert summary["agent_names"] == []
        assert summary["orchestration_type"] is None


# ---------------------------------------------------------------------------
# TeamBundle.scoped_session_id — fixed-width 5-segment key
# ---------------------------------------------------------------------------


class TestScopedSessionId:
    def test_empty_session_id_returns_none(self) -> None:
        b = _bundle(team_id="t1", project_id="proj-A")
        assert b.scoped_session_id(None) is None
        assert b.scoped_session_id("") is None

    def test_team_scope_default(self) -> None:
        b = _bundle(team_id="t1", project_id="proj-A")
        assert b.scoped_session_id("sess-1", user_id="user-7") == "team:proj-A:t1:user-7:sess-1"

    def test_agent_scope_uses_agent_id_as_anchor(self) -> None:
        b = _bundle(team_id="t1", project_id="proj-A")
        assert (
            b.scoped_session_id("sess-1", scope="agent", agent_id="ag-5", user_id="user-7")
            == "agent:proj-A:ag-5:user-7:sess-1"
        )

    def test_agent_scope_requires_agent_id(self) -> None:
        b = _bundle(team_id="t1", project_id="proj-A")
        with pytest.raises(ValueError, match="agent_id is required"):
            b.scoped_session_id("sess-1", scope="agent")

    def test_user_id_with_colon_is_rejected(self) -> None:
        # ":" in user_id would let _split_scoped mis-attribute segments
        # and collapse two users' partitions. The bundle layer enforces
        # the colon-safety invariant on every entry point.
        b = _bundle(team_id="t1", project_id="proj-A")
        with pytest.raises(ValueError, match="user_id may not contain ':'"):
            b.scoped_session_id("sess", user_id="bad:user")

    def test_session_id_may_contain_colon(self) -> None:
        # The trailing segment is the session_id — it's the LAST piece
        # of the fixed-width shape, so colons inside it are unambiguous
        # to the parser. Pin that contract here.
        b = _bundle(team_id="t1", project_id="proj-A")
        result = b.scoped_session_id("sess:with:colons", user_id="u")
        assert result == "team:proj-A:t1:u:sess:with:colons"

    def test_empty_user_id_renders_empty_segment(self) -> None:
        # 5-segment shape is always emitted — empty user_id becomes an
        # explicit empty segment. This is what makes the parser
        # colon-safe even when session_id itself contains colons.
        b = _bundle(team_id="t1", project_id="proj-A")
        assert b.scoped_session_id("sess-1") == "team:proj-A:t1::sess-1"

    def test_empty_project_id_uses_unscoped_marker(self) -> None:
        # File-mode / dev-mode teams may have an empty project_id;
        # don't emit "team::t1::sess" (4 segments) — use a synthetic
        # "_unscoped_" marker so the shape stays 5-segment.
        b = _bundle(team_id="t1", project_id="")
        assert b.scoped_session_id("sess-1", user_id="u") == "team:_unscoped_:t1:u:sess-1"
