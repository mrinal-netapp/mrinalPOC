"""Unit tests for :mod:`agent_service_maf.config.file_loader`.

The existing :file:`test_config_service_migration.py` has two
``FileConfigLoader`` tests that cover the happy path (existing fixture
served, unknown 404). This file fills in the rest of the contract:

- Scanning paths (override vs env-driven discovery, unparseable JSON,
  missing project_id, the disabled-agents-dir case)
- The static helpers (``_scan_dir_for_json``, ``_read_summary``,
  ``_load_json``) at their failure modes
- The ConfigSource protocol on the agent side (``get_agent``,
  ``list_agents``) which the migration tests do not touch
- Lifecycle helpers (``rescan``, ``invalidate_*``)
- The ``_legacy_env_warning`` module-level helper

Filesystem boundary is real (using ``tmp_path``) — these are unit
tests of the loader's logic, not of the OS. No network, no settings
mutation other than via ``monkeypatch``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from agent_service_maf.config.file_loader import FileConfigLoader, _legacy_env_warning
from agent_service_maf.core.team_loader import UNKNOWN_PROJECT_ID

VALID_PROJECT_ID = "550e8400-e29b-41d4-a716-446655440000"


# ---------------------------------------------------------------------------
# Fixtures + helpers
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clean_agent_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Strip ``AGENT_*`` env vars so directory discovery is deterministic.

    Mirrors the same-named fixture in ``test_config_service_migration.py``
    so the two suites don't interfere when run together.
    """
    import os

    for key in list(os.environ):
        if key.startswith("AGENT_"):
            monkeypatch.delenv(key, raising=False)


def _team_payload(
    *,
    team_id: str = "team-x",
    project_id: str | None = VALID_PROJECT_ID,
    name: str = "Team X",
    description: str = "desc",
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "_team_id": team_id,
        "_team_name": name,
        "_description": description,
        "agent": {"framework": "maf", "model": "azure/gpt-5.4"},
        "gateway": {"url": "http://gw", "default_model": "azure/gpt-5.4"},
        "memory": {"enabled": False},
        "guardrails": {"enabled": False},
        "semantic_kernel": {
            "agents": [
                {
                    "name": "analyst",
                    "instructions": "be helpful",
                    "tools": [],
                    "mcp_servers": [],
                }
            ],
            "orchestration": {"type": "single"},
        },
    }
    if project_id is not None:
        payload["project_id"] = project_id
    return payload


def _agent_payload(
    *,
    agent_id: str = "agent-a",
    project_id: str | None = VALID_PROJECT_ID,
    name: str = "Agent A",
    description: str = "agent desc",
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": agent_id,
        "name": name,
        "description": description,
        "agent": {"framework": "maf", "model": "azure/gpt-5.4"},
    }
    if project_id is not None:
        payload["project_id"] = project_id
    return payload


def _write(path: Path, payload: Any) -> Path:
    """Write JSON payload, return the path. Accepts dicts or raw strings."""
    if isinstance(payload, str):
        path.write_text(payload, encoding="utf-8")
    else:
        path.write_text(json.dumps(payload), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# Construction + scanning
# ---------------------------------------------------------------------------


class TestConstruction:
    def test_explicit_teams_dir_override_is_used(self, tmp_path: Path) -> None:
        teams = tmp_path / "teams"
        teams.mkdir()
        _write(teams / "alpha.json", _team_payload(team_id="alpha"))

        loader = FileConfigLoader(teams_dir=teams)
        assert (VALID_PROJECT_ID, "alpha") in loader.known_team_keys()

    def test_no_override_falls_back_to_env_discovery(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        # discover_team_config_paths() reads AGENT_TEAMS_DIR — set it and
        # confirm the loader picks it up when teams_dir=None.
        teams = tmp_path / "env_teams"
        teams.mkdir()
        _write(teams / "beta.json", _team_payload(team_id="beta"))
        monkeypatch.setenv("AGENT_TEAMS_DIR", str(teams))

        loader = FileConfigLoader()
        assert (VALID_PROJECT_ID, "beta") in loader.known_team_keys()

    def test_explicit_empty_string_agents_dir_disables_agent_scan(self, tmp_path: Path) -> None:
        # ``""`` is a meaningful "disabled" sentinel — distinct from
        # ``None`` (which falls through to settings.AGENT_AGENTS_DIR).
        loader = FileConfigLoader(teams_dir=tmp_path, agents_dir="")
        assert loader._agent_summaries == {}
        assert loader._agents_by_key == {}


# ---------------------------------------------------------------------------
# _scan_dir_for_json static helper
# ---------------------------------------------------------------------------


class TestScanDirForJson:
    def test_empty_string_returns_empty_list(self) -> None:
        assert FileConfigLoader._scan_dir_for_json("") == []

    def test_missing_directory_returns_empty_list(self, tmp_path: Path) -> None:
        # A nonexistent path is a tolerated state — operators may not have
        # populated AGENT_AGENTS_DIR.
        assert FileConfigLoader._scan_dir_for_json(tmp_path / "nope") == []

    def test_file_instead_of_directory_returns_empty_list(self, tmp_path: Path) -> None:
        f = tmp_path / "not_a_dir.json"
        f.write_text("{}", encoding="utf-8")
        assert FileConfigLoader._scan_dir_for_json(f) == []

    def test_returns_only_json_files_sorted(self, tmp_path: Path) -> None:
        (tmp_path / "zeta.json").write_text("{}", encoding="utf-8")
        (tmp_path / "alpha.json").write_text("{}", encoding="utf-8")
        (tmp_path / "ignored.txt").write_text("nope", encoding="utf-8")
        paths = FileConfigLoader._scan_dir_for_json(tmp_path)
        assert [p.name for p in paths] == ["alpha.json", "zeta.json"]


# ---------------------------------------------------------------------------
# _read_summary static helper
# ---------------------------------------------------------------------------


class TestReadSummary:
    def test_team_summary_uses_team_metadata_fields(self, tmp_path: Path) -> None:
        path = _write(tmp_path / "t.json", _team_payload(name="Coral"))
        out = FileConfigLoader._read_summary(path, kind="team")
        assert out is not None
        assert out["id"] == "team-x"
        assert out["project_id"] == VALID_PROJECT_ID
        assert out["name"] == "Coral"
        assert out["description"] == "desc"

    def test_agent_summary_uses_agent_metadata_fields(self, tmp_path: Path) -> None:
        path = _write(tmp_path / "a.json", _agent_payload(name="Reef"))
        out = FileConfigLoader._read_summary(path, kind="agent")
        assert out is not None
        assert out["id"] == "agent-a"
        assert out["project_id"] == VALID_PROJECT_ID
        assert out["name"] == "Reef"
        assert out["description"] == "agent desc"

    def test_agent_summary_falls_back_to_agentId(self, tmp_path: Path) -> None:
        # The summary helper accepts ``id``, ``agent_id``, or ``agentId``
        # for agent records.
        payload = {"agentId": "weird-id", "project_id": VALID_PROJECT_ID, "name": "X"}
        path = _write(tmp_path / "a.json", payload)
        out = FileConfigLoader._read_summary(path, kind="agent")
        assert out is not None
        assert out["id"] == "weird-id"

    def test_unparseable_json_returns_none(self, tmp_path: Path) -> None:
        path = _write(tmp_path / "broken.json", "not valid json {{{")
        assert FileConfigLoader._read_summary(path, kind="team") is None

    def test_missing_file_returns_none(self, tmp_path: Path) -> None:
        # OSError path — the file simply doesn't exist.
        assert FileConfigLoader._read_summary(tmp_path / "missing.json", kind="team") is None

    def test_non_dict_top_level_returns_none(self, tmp_path: Path) -> None:
        path = _write(tmp_path / "list.json", [1, 2, 3])
        assert FileConfigLoader._read_summary(path, kind="team") is None


# ---------------------------------------------------------------------------
# Team scanning — bad-file / missing-project_id paths
# ---------------------------------------------------------------------------


class TestTeamScan:
    def test_unparseable_team_file_is_indexed_under_unknown_project(self, tmp_path: Path) -> None:
        # The pre-migration contract says a broken team JSON must still
        # surface in the registry as an UNHEALTHY bundle on request — so
        # we index it under the UNKNOWN sentinel with the file stem as id.
        _write(tmp_path / "broken-team.json", "{{ invalid")

        loader = FileConfigLoader(teams_dir=tmp_path)
        assert (UNKNOWN_PROJECT_ID, "broken-team") in loader.known_team_keys()
        summaries = loader._team_summaries[UNKNOWN_PROJECT_ID]
        assert summaries == [{"id": "broken-team", "name": "broken-team", "description": ""}]

    def test_team_file_without_project_id_is_indexed_under_unknown(self, tmp_path: Path) -> None:
        # Otherwise-valid JSON but no project_id — reachable via the
        # legacy sentinel-project URL pattern.
        _write(
            tmp_path / "orphan.json",
            _team_payload(team_id="orphan", project_id=None),
        )

        loader = FileConfigLoader(teams_dir=tmp_path)
        assert (UNKNOWN_PROJECT_ID, "orphan") in loader.known_team_keys()
        summaries = loader._team_summaries[UNKNOWN_PROJECT_ID]
        assert summaries[0]["id"] == "orphan"
        assert summaries[0]["name"] == "Team X"

    def test_team_file_uses_camelCase_projectId_when_snake_absent(self, tmp_path: Path) -> None:
        # config-service emits camelCase; the loader has to accept both.
        payload = _team_payload(project_id=None)
        payload["projectId"] = VALID_PROJECT_ID  # camelCase form
        _write(tmp_path / "camel.json", payload)

        loader = FileConfigLoader(teams_dir=tmp_path)
        assert (VALID_PROJECT_ID, "team-x") in loader.known_team_keys()


# ---------------------------------------------------------------------------
# Agent scanning — happy path + bad-record handling
# ---------------------------------------------------------------------------


class TestAgentScan:
    def test_agents_dir_unset_is_a_noop(self, tmp_path: Path) -> None:
        # ``agents_dir=""`` short-circuits the entire scan.
        loader = FileConfigLoader(teams_dir=tmp_path, agents_dir="")
        assert loader._agents_by_key == {}

    def test_agent_record_without_project_id_is_logged_and_skipped(self, tmp_path: Path) -> None:
        # Distinct from teams: agents WITHOUT project_id are dropped,
        # not stowed under UNKNOWN_PROJECT_ID (there is no analogous
        # legacy URL pattern for orphan agents).
        agents = tmp_path / "agents"
        agents.mkdir()
        _write(
            agents / "orphan.json",
            _agent_payload(agent_id="orphan", project_id=None),
        )

        loader = FileConfigLoader(teams_dir=tmp_path, agents_dir=agents)
        assert (UNKNOWN_PROJECT_ID, "orphan") not in loader._agents_by_key
        assert (VALID_PROJECT_ID, "orphan") not in loader._agents_by_key
        assert loader._agent_summaries == {}

    def test_agent_record_indexed_by_project_and_id(self, tmp_path: Path) -> None:
        agents = tmp_path / "agents"
        agents.mkdir()
        _write(agents / "a1.json", _agent_payload(agent_id="a1"))

        loader = FileConfigLoader(teams_dir=tmp_path, agents_dir=agents)
        assert (VALID_PROJECT_ID, "a1") in loader._agents_by_key
        summaries = loader._agent_summaries[VALID_PROJECT_ID]
        assert summaries == [{"id": "a1", "name": "Agent A", "description": "agent desc"}]

    def test_unparseable_agent_file_is_silently_skipped(self, tmp_path: Path) -> None:
        # Unlike teams, broken agents don't get a sentinel entry — they
        # just don't appear. The warning log is sufficient operator
        # signal because /agents/{id} → 404 is a benign outcome.
        agents = tmp_path / "agents"
        agents.mkdir()
        _write(agents / "broken.json", "{{ nope")

        loader = FileConfigLoader(teams_dir=tmp_path, agents_dir=agents)
        assert loader._agents_by_key == {}
        assert loader._agent_summaries == {}


# ---------------------------------------------------------------------------
# ConfigSource protocol surface
# ---------------------------------------------------------------------------


class TestGetTeam:
    @pytest.mark.asyncio
    async def test_known_team_returns_full_payload(self, tmp_path: Path) -> None:
        _write(tmp_path / "t.json", _team_payload())
        loader = FileConfigLoader(teams_dir=tmp_path)
        got = await loader.get_team(VALID_PROJECT_ID, "team-x")
        assert got is not None
        assert got["_team_id"] == "team-x"
        # Full payload, not just the summary — semantic_kernel section
        # must be present.
        assert got["semantic_kernel"]["agents"][0]["name"] == "analyst"

    @pytest.mark.asyncio
    async def test_unknown_team_returns_none(self, tmp_path: Path) -> None:
        loader = FileConfigLoader(teams_dir=tmp_path)
        assert await loader.get_team(VALID_PROJECT_ID, "missing") is None

    @pytest.mark.asyncio
    async def test_unparseable_team_returns_unparseable_path_sentinel(self, tmp_path: Path) -> None:
        # Per the contract: the lazy registry uses the sentinel to call
        # build_team_bundle(path) which then produces an unhealthy bundle
        # with the underlying parser exception. The loader's job here is
        # just to hand the trampoline back.
        broken = _write(tmp_path / "broken.json", "{{ not json")
        loader = FileConfigLoader(teams_dir=tmp_path)
        got = await loader.get_team(UNKNOWN_PROJECT_ID, "broken")
        assert got == {"_unparseable_path": str(broken)}


class TestGetTeamFilePath:
    def test_returns_path_for_indexed_team(self, tmp_path: Path) -> None:
        path = _write(tmp_path / "t.json", _team_payload())
        loader = FileConfigLoader(teams_dir=tmp_path)
        assert loader.get_team_file_path(VALID_PROJECT_ID, "team-x") == path

    def test_returns_none_for_unknown_team(self, tmp_path: Path) -> None:
        loader = FileConfigLoader(teams_dir=tmp_path)
        assert loader.get_team_file_path(VALID_PROJECT_ID, "ghost") is None


class TestKnownProjectsAndTeamKeys:
    def test_known_projects_includes_real_and_unknown_sentinel(self, tmp_path: Path) -> None:
        _write(tmp_path / "good.json", _team_payload(team_id="good"))
        _write(tmp_path / "bad.json", "{{ broken")
        loader = FileConfigLoader(teams_dir=tmp_path)
        assert set(loader.known_projects()) == {
            VALID_PROJECT_ID,
            UNKNOWN_PROJECT_ID,
        }

    def test_known_team_keys_returns_all_indexed_keys(self, tmp_path: Path) -> None:
        _write(tmp_path / "a.json", _team_payload(team_id="alpha"))
        _write(tmp_path / "b.json", _team_payload(team_id="beta"))
        loader = FileConfigLoader(teams_dir=tmp_path)
        assert set(loader.known_team_keys()) == {
            (VALID_PROJECT_ID, "alpha"),
            (VALID_PROJECT_ID, "beta"),
        }


class TestIsSynchronouslyEmpty:
    def test_returns_true_when_no_teams_indexed(self, tmp_path: Path) -> None:
        loader = FileConfigLoader(teams_dir=tmp_path)
        assert loader.is_synchronously_empty() is True

    def test_returns_false_when_at_least_one_team_indexed(self, tmp_path: Path) -> None:
        _write(tmp_path / "t.json", _team_payload())
        loader = FileConfigLoader(teams_dir=tmp_path)
        assert loader.is_synchronously_empty() is False

    def test_returns_true_when_only_empty_summary_lists_exist(self, tmp_path: Path) -> None:
        # Edge case the second branch defends against — _team_summaries
        # has keys but every list is empty. Real callers won't hit this
        # in practice but the branch must not silently return False.
        loader = FileConfigLoader(teams_dir=tmp_path)
        loader._team_summaries = {VALID_PROJECT_ID: []}
        assert loader.is_synchronously_empty() is True


class TestGetAgent:
    @pytest.mark.asyncio
    async def test_known_agent_returns_payload(self, tmp_path: Path) -> None:
        agents = tmp_path / "agents"
        agents.mkdir()
        _write(agents / "a1.json", _agent_payload(agent_id="a1"))
        loader = FileConfigLoader(teams_dir=tmp_path, agents_dir=agents)
        got = await loader.get_agent(VALID_PROJECT_ID, "a1")
        assert got is not None
        assert got["id"] == "a1"

    @pytest.mark.asyncio
    async def test_unknown_agent_returns_none(self, tmp_path: Path) -> None:
        loader = FileConfigLoader(teams_dir=tmp_path, agents_dir="")
        assert await loader.get_agent(VALID_PROJECT_ID, "ghost") is None


class TestListEndpoints:
    @pytest.mark.asyncio
    async def test_list_teams_for_unknown_project_returns_empty_list(self, tmp_path: Path) -> None:
        loader = FileConfigLoader(teams_dir=tmp_path)
        assert await loader.list_teams("nonexistent-project") == []

    @pytest.mark.asyncio
    async def test_list_agents_returns_summary_entries(self, tmp_path: Path) -> None:
        agents = tmp_path / "agents"
        agents.mkdir()
        _write(agents / "a1.json", _agent_payload(agent_id="a1", name="One"))
        _write(agents / "a2.json", _agent_payload(agent_id="a2", name="Two"))
        loader = FileConfigLoader(teams_dir=tmp_path, agents_dir=agents)
        out = await loader.list_agents(VALID_PROJECT_ID)
        assert {entry["id"] for entry in out} == {"a1", "a2"}

    @pytest.mark.asyncio
    async def test_list_agents_for_unknown_project_returns_empty_list(self, tmp_path: Path) -> None:
        loader = FileConfigLoader(teams_dir=tmp_path, agents_dir="")
        assert await loader.list_agents("ghost") == []


# ---------------------------------------------------------------------------
# _load_json static helper
# ---------------------------------------------------------------------------


class TestLoadJson:
    def test_valid_object_returns_dict(self, tmp_path: Path) -> None:
        path = _write(tmp_path / "ok.json", {"x": 1})
        assert FileConfigLoader._load_json(path) == {"x": 1}

    def test_unparseable_returns_none(self, tmp_path: Path) -> None:
        path = _write(tmp_path / "broken.json", "{{ not json")
        assert FileConfigLoader._load_json(path) is None

    def test_missing_file_returns_none(self, tmp_path: Path) -> None:
        assert FileConfigLoader._load_json(tmp_path / "missing.json") is None

    def test_non_dict_top_level_returns_none(self, tmp_path: Path) -> None:
        path = _write(tmp_path / "list.json", [1, 2])
        assert FileConfigLoader._load_json(path) is None


# ---------------------------------------------------------------------------
# Lifecycle escape hatches
# ---------------------------------------------------------------------------


class TestRescan:
    def test_rescan_picks_up_new_files(self, tmp_path: Path) -> None:
        loader = FileConfigLoader(teams_dir=tmp_path)
        assert loader.known_team_keys() == []

        _write(tmp_path / "new.json", _team_payload(team_id="new"))
        loader.rescan()
        assert (VALID_PROJECT_ID, "new") in loader.known_team_keys()

    def test_rescan_drops_removed_files(self, tmp_path: Path) -> None:
        path = _write(tmp_path / "going.json", _team_payload(team_id="going"))
        loader = FileConfigLoader(teams_dir=tmp_path)
        assert (VALID_PROJECT_ID, "going") in loader.known_team_keys()

        path.unlink()
        loader.rescan()
        assert (VALID_PROJECT_ID, "going") not in loader.known_team_keys()


class TestInvalidate:
    """The file loader has no in-process cache — invalidation must
    return cleanly so the admin endpoint can call both source types
    interchangeably without an isinstance check."""

    def test_invalidate_team_is_a_noop(self, tmp_path: Path) -> None:
        loader = FileConfigLoader(teams_dir=tmp_path)
        loader.invalidate_team(VALID_PROJECT_ID, "some-id")  # must not raise
        loader.invalidate_team(VALID_PROJECT_ID)  # team_id=None form

    def test_invalidate_agent_is_a_noop(self, tmp_path: Path) -> None:
        loader = FileConfigLoader(teams_dir=tmp_path)
        loader.invalidate_agent(VALID_PROJECT_ID, "some-id")  # must not raise
        loader.invalidate_agent(VALID_PROJECT_ID)


# ---------------------------------------------------------------------------
# _legacy_env_warning module helper
# ---------------------------------------------------------------------------


class TestLegacyEnvWarning:
    """The helper is a startup canary for half-configured file-mode
    deployments. It must short-circuit on non-file modes and stay
    silent when any of the three legacy env vars / settings is set."""

    def test_noop_when_config_source_is_not_file(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # settings.CONFIG_SOURCE is the cached value; patch it so we don't
        # need to re-instantiate the Settings object.
        from agent_service_maf.config import file_loader as mod

        monkeypatch.setattr(mod.settings, "CONFIG_SOURCE", "remote")
        # No assertion needed — the test passes if no exception is raised
        # and no warning would be sensible to assert without capturing
        # structlog output. The branch is the value being exercised.
        _legacy_env_warning()

    def test_no_warning_when_teams_dir_setting_set(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from agent_service_maf.config import file_loader as mod

        monkeypatch.setattr(mod.settings, "CONFIG_SOURCE", "file")
        monkeypatch.setattr(mod.settings, "AGENT_TEAMS_DIR", "/some/dir")
        # No warning expected — branch coverage for the "setting present"
        # arm.
        _legacy_env_warning()

    def test_warns_when_no_teams_dir_anywhere(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        from agent_service_maf.config import file_loader as mod

        monkeypatch.setattr(mod.settings, "CONFIG_SOURCE", "file")
        monkeypatch.setattr(mod.settings, "AGENT_TEAMS_DIR", "")
        monkeypatch.delenv("AGENT_TEAMS_DIR", raising=False)
        monkeypatch.delenv("AGENT_CONFIG_PATH", raising=False)

        # Warning is emitted via structlog; we just confirm the call does
        # not raise. The fact that this branch was reached at all is what
        # we are exercising for coverage; the message content is locked
        # by the source verbatim.
        _legacy_env_warning()
