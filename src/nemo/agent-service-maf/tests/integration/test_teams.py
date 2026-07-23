"""Integration tests for multi-team loading and isolation.

These tests run the real FastAPI lifespan with an AGENT_TEAMS_DIR pointing at
a temp directory, exercise the project-scoped routes, and verify:

- Both teams are discoverable via GET /api/v1/projects/{pid}/agent-teams
- Per-team invocation hits only that team's configuration (model, agent name)
- Sessions are prefixed with team_id so cross-team leakage is impossible
- Unknown team_id → 404
- Project-default fallback works for /api/v1/projects/{pid}/agents/invoke
- One bad config does not kill the process; the other team still works
- Cross-project access is rejected (404) — a team in project A cannot be
  reached via project B's URL.

The test stubs Bifrost/MCP so these are fast and deterministic — we don't rely
on any external gateway or MCP server.
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from tests.conftest import TEST_PROJECT_ID, TEST_PROJECT_PREFIX

# A second project_id used to verify cross-project isolation.
SECOND_PROJECT_ID: str = "00000000-0000-0000-0000-000000000002"
SECOND_PROJECT_PREFIX: str = f"/api/v1/projects/{SECOND_PROJECT_ID}"


# --- Helpers ---------------------------------------------------------------


def _minimal_config(
    team_id: str,
    agent_name: str,
    model: str = "azure/gpt-4.1-mini",
    project_id: str = TEST_PROJECT_ID,
) -> dict:
    """A minimal v2.0.0 config that passes validation and uses the ``mock``
    framework registered by tests/conftest.py, so no real LLM is needed."""
    return {
        "_schema_version": "2.0.0",
        "project_id": project_id,
        "_team_id": team_id,
        "_team_name": team_id,
        "_description": f"Test team {team_id}",
        "agent": {
            "framework": "mock",
            "model": model,
            "temperature": 0.0,
            "max_tokens": 256,
            "timeout_seconds": 30,
            "metadata": {"project": "test", "version": "0.0.0", "environment": "test"},
        },
        "semantic_kernel": {
            "agents": [
                {
                    "name": agent_name,
                    "instructions": f"You are {agent_name}.",
                    "description": "test",
                    "model": model,
                    "temperature": 0.0,
                    "max_tokens": 256,
                    "tools": [],
                    "mcp_servers": [],
                    "function_choice_behavior": "auto",
                }
            ],
            "orchestration": {"type": "single"},
        },
        "interface": {
            "host": "0.0.0.0",
            "port": 8000,
            "cors_origins": ["*"],
            "request_timeout_seconds": 30,
            "max_concurrent_requests": 10,
            "auth": {"enabled": False},
        },
        "gateway": {
            "url": "http://localhost:0/v1",
            "default_model": model,
            "request_timeout_seconds": 10,
            "retry_on_timeout": False,
            "max_retries": 0,
        },
        "guardrails": {"enabled": False, "fail_open": True},
        "mcp": {
            "connection_timeout_seconds": 5,
            "lazy_connect": True,
            "tool_call_timeout_seconds": 5,
            "max_tool_retries": 0,
            "retry_on_timeout": False,
            "discovery_on_connect": False,
            "tool_name_format": "qualified",
            "max_concurrent_tool_calls": 1,
        },
        "mcp_servers": [],
        "memory": {
            "enabled": False,
            "storage_backend": "memory",
            "buffer_type": "sliding_window",
            "ttl_seconds": 60,
            "max_history_length": 10,
            "max_tokens_per_session": 0,
            "max_chars_per_session": 0,
        },
        "logging": {"level": "WARNING", "format": "json", "include_timestamp": True},
    }


@pytest.fixture
def teams_dir(tmp_path: Path) -> Iterator[Path]:
    """Create a temp teams directory: two valid configs in TEST_PROJECT_ID,
    one valid config in SECOND_PROJECT_ID (for cross-project isolation tests),
    and one broken config.
    """
    (tmp_path / "alpha.json").write_text(json.dumps(_minimal_config("alpha", "alpha_agent")))
    (tmp_path / "beta.json").write_text(
        json.dumps(_minimal_config("beta", "beta_agent", "azure/gpt-4.1"))
    )
    (tmp_path / "gamma.json").write_text(
        json.dumps(_minimal_config("gamma", "gamma_agent", project_id=SECOND_PROJECT_ID))
    )
    # broken config — unparseable JSON triggers a load failure; the team
    # should still be surfaced as unhealthy under the unknown project, not
    # crash startup.
    (tmp_path / "broken.json").write_text("{this is not valid json")
    yield tmp_path


@pytest.fixture
def client(teams_dir: Path) -> Iterator[object]:
    """Boot the FastAPI app with AGENT_TEAMS_DIR pointing at the fixture dir."""
    from fastapi.testclient import TestClient

    os.environ["AGENT_TEAMS_DIR"] = str(teams_dir)
    # Make sure single-file mode does not interfere
    os.environ.pop("AGENT_CONFIG_PATH", None)

    from agent_service_maf.interface_layer.api import create_app

    app = create_app()
    with TestClient(app) as c:
        yield c
    os.environ.pop("AGENT_TEAMS_DIR", None)


# --- Tests -----------------------------------------------------------------


def test_teams_listed(client: object) -> None:
    """GET /api/v1/projects/{pid}/agent-teams returns the project's healthy teams."""
    r = client.get(f"{TEST_PROJECT_PREFIX}/agent-teams")  # type: ignore[attr-defined]
    assert r.status_code == 200, r.text
    data = r.json()
    ids = [t["team_id"] for t in data["teams"]]
    assert "alpha" in ids
    assert "beta" in ids
    # gamma belongs to a different project — must NOT appear here.
    assert "gamma" not in ids
    # broken has no project_id, so it's bucketed under the unknown-project
    # sentinel, not under TEST_PROJECT_ID.
    assert "broken" not in ids

    by_id = {t["team_id"]: t for t in data["teams"]}
    assert by_id["alpha"]["healthy"] is True
    assert by_id["beta"]["healthy"] is True
    assert by_id["alpha"]["project_id"] == TEST_PROJECT_ID

    # Default team should be the alphabetically-first loaded team for this project.
    assert data["default_team_id"] == "alpha"
    assert data["project_id"] == TEST_PROJECT_ID


def test_unknown_project_returns_404(client: object) -> None:
    r = client.get(f"/api/v1/projects/{SECOND_PROJECT_ID[:-1]}9/agent-teams")  # type: ignore[attr-defined]
    assert r.status_code == 404
    detail = r.json()["detail"]
    assert "Unknown project_id" in detail["error"]
    assert "available_projects" in detail


def test_team_detail(client: object) -> None:
    r = client.get(f"{TEST_PROJECT_PREFIX}/agent-teams/alpha")  # type: ignore[attr-defined]
    assert r.status_code == 200
    body = r.json()
    assert body["team_id"] == "alpha"
    assert body["project_id"] == TEST_PROJECT_ID
    assert body["agent_names"] == ["alpha_agent"]
    assert body["model"] == "azure/gpt-4.1-mini"


def test_unknown_team_returns_404(client: object) -> None:
    r = client.post(  # type: ignore[attr-defined]
        f"{TEST_PROJECT_PREFIX}/agent-teams/does_not_exist/invoke",
        json={
            "input": "hi",
            "context": {},
            "config_overrides": {},
            "session_id": "x",
            "metadata": {},
        },
    )
    assert r.status_code == 404
    detail = r.json()["detail"]
    assert "does_not_exist" in detail["error"]
    assert "available_teams" in detail


def test_team_in_wrong_project_returns_404(client: object) -> None:
    """A team that lives in project A cannot be reached via project B's URL."""
    # gamma belongs to SECOND_PROJECT_ID; addressing it via TEST_PROJECT_ID must 404.
    r = client.post(  # type: ignore[attr-defined]
        f"{TEST_PROJECT_PREFIX}/agent-teams/gamma/invoke",
        json={
            "input": "hi",
            "context": {},
            "config_overrides": {},
            "session_id": "x",
            "metadata": {},
        },
    )
    assert r.status_code == 404
    detail = r.json()["detail"]
    assert "gamma" in detail["error"]
    assert TEST_PROJECT_ID in detail["error"]


def test_unhealthy_team_returns_503(client: object) -> None:
    # broken loads under the "_unknown_" project sentinel because its JSON
    # cannot be parsed for project_id. Address it via that sentinel project so
    # we exercise the 503-unhealthy branch (rather than the 404 path).
    r = client.post(  # type: ignore[attr-defined]
        "/api/v1/projects/_unknown_/agent-teams/broken/invoke",
        json={
            "input": "hi",
            "context": {},
            "config_overrides": {},
            "session_id": "x",
            "metadata": {},
        },
    )
    assert r.status_code == 503
    assert "unhealthy" in r.json()["detail"]["error"].lower()


def test_team_isolation_invokes_hit_correct_team(client: object) -> None:
    """Each {team_id}/invoke must resolve to a distinct, reachable team.

    MockAgent doesn't populate citations, so we verify reachability via HTTP
    200 + input echoed, and rely on ``test_team_detail`` to prove models
    differ between the two teams' configs.
    """
    r_a = client.post(  # type: ignore[attr-defined]
        f"{TEST_PROJECT_PREFIX}/agent-teams/alpha/invoke",
        json={
            "input": "hi-alpha",
            "context": {},
            "config_overrides": {},
            "session_id": "s",
            "metadata": {},
        },
    )
    assert r_a.status_code == 200, r_a.text
    assert "hi-alpha" in r_a.json()["output"]

    r_b = client.post(  # type: ignore[attr-defined]
        f"{TEST_PROJECT_PREFIX}/agent-teams/beta/invoke",
        json={
            "input": "hi-beta",
            "context": {},
            "config_overrides": {},
            "session_id": "s",
            "metadata": {},
        },
    )
    assert r_b.status_code == 200, r_b.text
    assert "hi-beta" in r_b.json()["output"]


def test_project_default_agents_invoke(client: object) -> None:
    """POST /api/v1/projects/{pid}/agents/invoke (no team_id) should route to
    the project's default team and succeed.
    """
    r = client.post(  # type: ignore[attr-defined]
        f"{TEST_PROJECT_PREFIX}/agents/invoke",
        json={
            "input": "legacy-ping",
            "context": {},
            "config_overrides": {},
            "session_id": "s",
            "metadata": {},
        },
    )
    assert r.status_code == 200, r.text
    assert "legacy-ping" in r.json()["output"]


def test_session_ids_are_scoped_by_project_and_team() -> None:
    """``TeamBundle.scoped_session_id`` namespaces session keys with the
    Phase 2 4-axis tuple (scope, project_id, anchor, user_id) so:

    1. Two teams in the same project sharing a raw ``session_id`` don't collide.
    2. Two projects with the *same* ``team_id`` sharing a raw ``session_id``
       don't collide — critical now that ``TeamRegistry.add`` allows
       cross-project ``team_id`` duplicates.
    3. Team-scoped and agent-scoped sessions are distinct threads even when
       the same id is used by the same user.
    4. Per-user partitioning: two users with the same session_id are isolated.
    5. ``None`` / ``""`` inputs stay falsy.
    6. Legacy bundles (empty project_id) get the ``_unscoped_`` placeholder.
    """
    from agent_service_maf.core.team_bundle import TeamBundle

    SECOND_PROJECT_ID = "00000000-0000-0000-0000-000000000002"  # noqa: N806

    def _bundle(team_id: str, project_id: str) -> TeamBundle:
        return TeamBundle(
            team_id=team_id,
            project_id=project_id,
            name=team_id,
            description="",
            config_path="",
            config_loader=None,  # type: ignore[arg-type]
            config=None,  # type: ignore[arg-type]
            gateway=None,  # type: ignore[arg-type]
            mcp_manager=None,  # type: ignore[arg-type]
        )

    # --- 1. Same project, different teams ---------------------------------
    alpha_p1 = _bundle("alpha", TEST_PROJECT_ID)
    beta_p1 = _bundle("beta", TEST_PROJECT_ID)
    s_alpha = alpha_p1.scoped_session_id("s1", user_id="u1")
    s_beta = beta_p1.scoped_session_id("s1", user_id="u1")
    assert s_alpha == f"team:{TEST_PROJECT_ID}:alpha:u1:s1"
    assert s_beta == f"team:{TEST_PROJECT_ID}:beta:u1:s1"
    assert s_alpha != s_beta, "Same project, different teams must yield distinct keys"

    # --- 2. Different projects, SAME team_id ------------------------------
    alpha_p2 = _bundle("alpha", SECOND_PROJECT_ID)
    s_alpha_p2 = alpha_p2.scoped_session_id("s1", user_id="u1")
    assert s_alpha != s_alpha_p2
    assert s_alpha_p2 == f"team:{SECOND_PROJECT_ID}:alpha:u1:s1"

    # --- 3. Team vs agent scope distinct ----------------------------------
    s_team = alpha_p1.scoped_session_id("s1", scope="team", user_id="u1")
    s_agent = alpha_p1.scoped_session_id(
        "s1",
        scope="agent",
        agent_id="alpha",
        user_id="u1",
    )
    assert s_team != s_agent
    assert s_agent.startswith("agent:")

    # --- 4. Per-user partition --------------------------------------------
    s_alice = alpha_p1.scoped_session_id("s1", user_id="alice")
    s_bob = alpha_p1.scoped_session_id("s1", user_id="bob")
    assert s_alice != s_bob

    # --- 5. Falsy inputs are passed through as None -----------------------
    assert alpha_p1.scoped_session_id(None) is None
    assert alpha_p1.scoped_session_id("") is None

    # --- 6. Dev shape (no user_id) carries an explicit empty segment ------
    # Previously the dev fallback produced a 4-segment id without a
    # user_id slot; that collapsed with session_ids that themselves
    # contained ':'. The current shape is always 5 segments with an
    # empty user_id between anchor and session_id (literal '::').
    dev = alpha_p1.scoped_session_id("s1")
    assert dev == f"team:{TEST_PROJECT_ID}:alpha::s1"

    # Regression: a session_id with internal colons round-trips cleanly
    # through scoped_session_id + _split_scoped because the 5-segment
    # shape is unambiguous.
    from agent_service_maf.core.session_store import _split_scoped

    dev_with_colons = alpha_p1.scoped_session_id("chat:42:retry")
    assert dev_with_colons == f"team:{TEST_PROJECT_ID}:alpha::chat:42:retry"
    assert _split_scoped(dev_with_colons)[4] == "chat:42:retry"

    # --- 7. Empty project_id -> _unscoped_ placeholder --------------------
    legacy = _bundle("legacy_team", project_id="")
    assert legacy.scoped_session_id("s1") == "team:_unscoped_:legacy_team::s1"

    # --- 8. agent scope without agent_id raises ---------------------------
    import pytest

    with pytest.raises(ValueError):
        alpha_p1.scoped_session_id("s1", scope="agent", user_id="u1")


def test_default_team_override_via_env(teams_dir: Path) -> None:
    """AGENT_DEFAULT_TEAM env var should override the project's default."""
    from fastapi.testclient import TestClient

    os.environ["AGENT_TEAMS_DIR"] = str(teams_dir)
    os.environ["AGENT_DEFAULT_TEAM"] = "beta"
    os.environ.pop("AGENT_CONFIG_PATH", None)
    try:
        from agent_service_maf.interface_layer.api import create_app

        app = create_app()
        with TestClient(app) as c:
            r = c.get(f"{TEST_PROJECT_PREFIX}/agent-teams")
            assert r.json()["default_team_id"] == "beta"
            r = c.post(
                f"{TEST_PROJECT_PREFIX}/agents/invoke",
                json={
                    "input": "hi-override",
                    "context": {},
                    "config_overrides": {},
                    "session_id": "s",
                    "metadata": {},
                },
            )
            assert r.status_code == 200
            assert "hi-override" in r.json()["output"]
    finally:
        os.environ.pop("AGENT_DEFAULT_TEAM", None)
        os.environ.pop("AGENT_TEAMS_DIR", None)


# Smoke: direct unit test of the loader to ensure build_team_bundle never raises
# for a malformed config — it must return an unhealthy bundle instead.
def test_build_team_bundle_isolates_failure(tmp_path: Path) -> None:
    from agent_service_maf.core.team_loader import build_team_bundle

    bad = tmp_path / "bad.json"
    bad.write_text("{not valid json at all")
    # ``asyncio.run`` creates AND closes the loop, avoiding the
    # ResourceWarning that ``asyncio.new_event_loop().run_until_complete``
    # produces when the loop is never closed.
    bundle = asyncio.run(build_team_bundle(bad))
    assert bundle.healthy is False
    assert bundle.team_id == "bad"
    assert bundle.startup_error, "startup_error populated on failure"


# ---------------------------------------------------------------------------
# startup_error discrimination: invalid JSON vs missing project_id vs healthy
# ---------------------------------------------------------------------------
#
# Both failure modes used to map to the same generic "missing project_id"
# message because the pre-parse short-circuited build_team_bundle before
# ConfigLoader had a chance to surface the real exception. These tests pin
# the corrected behavior: ConfigLoader runs first, so its exception is
# preserved when present; the project_id-missing message only fires when the
# JSON is otherwise valid.


def _run(coro: Any) -> Any:
    """Run an async test coroutine and tear the loop down cleanly.

    Uses :func:`asyncio.run`, which creates the loop, runs the coroutine,
    and **closes** the loop in a ``finally`` block. The previous
    ``asyncio.new_event_loop().run_until_complete(...)`` form never closed
    the loop, leaking resources and triggering ``ResourceWarning`` /
    ``unclosed event loop`` warnings across the suite when many of these
    helpers ran back-to-back.
    """
    return asyncio.run(coro)


class TestBuildTeamBundleStartupErrorIsAccurate:
    def test_invalid_json_surfaces_parser_exception(self, tmp_path: Path) -> None:
        """A syntactically broken JSON file → startup_error includes the
        underlying parser error type (e.g., ``JSONDecodeError``), not the
        misleading "missing project_id" message.
        """
        from agent_service_maf.core.team_loader import build_team_bundle

        bad = tmp_path / "broken.json"
        bad.write_text("{this is not valid json")
        bundle = _run(build_team_bundle(bad))

        assert bundle.healthy is False
        assert bundle.team_id == "broken"
        # The real cause must surface — not the generic project_id message.
        assert "project_id" not in bundle.startup_error.lower(), (
            f"Generic project_id message must not mask the real parse error. "
            f"Got: {bundle.startup_error!r}"
        )
        # ConfigLoader's exception type should be present so the operator can
        # search for it. The repo's ConfigLoader currently raises a
        # ConfigurationError-derived exception for parse failures; either way,
        # the substring "json" or a recognisable class name should appear.
        err = bundle.startup_error
        assert "JSON" in err or "json" in err or "Error" in err, (
            f"Expected the parser exception details in startup_error, got: {err!r}"
        )

    def test_valid_json_missing_project_id_surfaces_specific_message(self, tmp_path: Path) -> None:
        """Otherwise-valid config that omits ``project_id`` → the dedicated
        "missing/invalid project_id" message (which is correct here).
        """
        from agent_service_maf.core.team_loader import build_team_bundle

        cfg = _minimal_config("nopid", "a")
        cfg.pop("project_id", None)
        path = tmp_path / "nopid.json"
        path.write_text(json.dumps(cfg))

        bundle = _run(build_team_bundle(path))
        assert bundle.healthy is False
        assert bundle.project_id == "_unknown_"
        assert "project_id" in bundle.startup_error
        assert "UUID" in bundle.startup_error

    def test_valid_json_invalid_project_id_surfaces_specific_message(self, tmp_path: Path) -> None:
        """``project_id`` present but not a UUID → same missing-/-invalid
        project_id outcome (since ``_coerce_project_id`` maps both to the
        unknown sentinel).
        """
        from agent_service_maf.core.team_loader import build_team_bundle

        cfg = _minimal_config("badpid", "a")
        cfg["project_id"] = "not-a-uuid"
        path = tmp_path / "badpid.json"
        path.write_text(json.dumps(cfg))

        bundle = _run(build_team_bundle(path))
        assert bundle.healthy is False
        assert bundle.project_id == "_unknown_"
        assert "project_id" in bundle.startup_error

    def test_valid_json_valid_project_id_is_healthy(self, tmp_path: Path) -> None:
        """Sanity baseline: a fully valid config still yields a healthy
        bundle. Asserts the new control flow didn't regress the happy path.
        """
        from agent_service_maf.core.team_loader import build_team_bundle

        path = tmp_path / "good.json"
        path.write_text(json.dumps(_minimal_config("good", "agent")))

        bundle = _run(build_team_bundle(path))
        assert bundle.healthy is True
        assert bundle.team_id == "good"
        assert bundle.project_id == TEST_PROJECT_ID
        assert bundle.startup_error == ""

    def test_pre_parse_logs_underlying_exception(
        self, tmp_path: Path, capsys: pytest.CaptureFixture[str]
    ) -> None:
        """The pre-parse logger surfaces the underlying exception so the
        real parse error is visible in startup logs even before
        ``build_team_bundle`` constructs the bundle.

        structlog (as configured in this service) writes directly to stdout,
        so we read via ``capsys`` rather than ``caplog``.
        """
        from agent_service_maf.core.team_loader import _read_team_id

        bad = tmp_path / "broken.json"
        bad.write_text("{still not json")

        # Clear any prior captured output so we only see this call's logs.
        capsys.readouterr()
        team_id, _, _, project_id = _read_team_id(bad)
        captured = capsys.readouterr().out

        assert team_id == "broken"
        assert project_id == "_unknown_"
        assert "pre-parse failed" in captured, (
            f"Expected pre-parse failure to be logged, got: {captured!r}"
        )
        assert "JSONDecodeError" in captured, (
            f"Expected underlying exception type in log, got: {captured!r}"
        )


# ---------------------------------------------------------------------------
# Duplicate team_id handling (cross-project legitimate, same-project rejected)
# ---------------------------------------------------------------------------


def _stub_bundle(team_id: str, project_id: str, config_path: str = "") -> Any:
    """Build a minimal TeamBundle suitable for TeamRegistry tests."""
    from agent_service_maf.core.team_bundle import TeamBundle

    return TeamBundle(
        team_id=team_id,
        project_id=project_id,
        name=team_id,
        description="",
        config_path=config_path or f"/fake/{project_id}/{team_id}.json",
        config_loader=None,  # type: ignore[arg-type]
        config=None,  # type: ignore[arg-type]
        gateway=None,  # type: ignore[arg-type]
        mcp_manager=None,  # type: ignore[arg-type]
    )


class TestTeamRegistryDuplicateHandling:
    """The registry was previously keyed by ``team_id`` alone, so a later
    bundle with the same id would silently overwrite an earlier one and
    ``get_in_project`` would return the wrong bundle for the original
    project. These tests pin the corrected behavior.
    """

    def test_cross_project_same_team_id_keeps_both_bundles_isolated(self) -> None:
        from agent_service_maf.core.team_bundle import TeamRegistry

        registry = TeamRegistry()
        b_a = _stub_bundle("alpha", TEST_PROJECT_ID, "/p1/alpha.json")
        b_b = _stub_bundle("alpha", SECOND_PROJECT_ID, "/p2/alpha.json")
        registry.add(b_a)
        registry.add(b_b)

        # Both projects can resolve their own "alpha" bundle.
        assert registry.get_in_project(TEST_PROJECT_ID, "alpha") is b_a
        assert registry.get_in_project(SECOND_PROJECT_ID, "alpha") is b_b

        # Both bundles remain healthy — cross-project is a legitimate case.
        assert b_a.healthy is True
        assert b_b.healthy is True

        # Both are surfaced via all_bundles for lifecycle work.
        all_bundles = registry.all_bundles()
        assert b_a in all_bundles
        assert b_b in all_bundles

    def test_same_project_same_team_id_marks_second_unhealthy(self) -> None:
        from agent_service_maf.core.team_bundle import TeamRegistry

        registry = TeamRegistry()
        first = _stub_bundle("alpha", TEST_PROJECT_ID, "/p1/alpha-v1.json")
        duplicate = _stub_bundle("alpha", TEST_PROJECT_ID, "/p1/alpha-v2.json")
        registry.add(first)
        registry.add(duplicate)

        # The first bundle keeps the project slot.
        assert registry.get_in_project(TEST_PROJECT_ID, "alpha") is first
        assert first.healthy is True

        # The duplicate is force-marked unhealthy with a descriptive error.
        assert duplicate.healthy is False
        assert "Duplicate team_id 'alpha'" in duplicate.startup_error
        assert "/p1/alpha-v1.json" in duplicate.startup_error

        # Only the first bundle appears in the project index — collisions
        # don't pollute the routing table.
        assert registry.teams_for_project(TEST_PROJECT_ID) == [first]

    def test_flat_teams_lookup_is_first_write_wins(self) -> None:
        """``teams[team_id]`` keeps the first-loaded bundle on cross-project
        duplicates so back-compat consumers (``AGENT_DEFAULT_TEAM`` env
        override, ``app.state.config`` shim) see deterministic state.
        """
        from agent_service_maf.core.team_bundle import TeamRegistry

        registry = TeamRegistry()
        first = _stub_bundle("alpha", TEST_PROJECT_ID, "/p1/alpha.json")
        sibling = _stub_bundle("alpha", SECOND_PROJECT_ID, "/p2/alpha.json")
        registry.add(first)
        registry.add(sibling)

        assert registry.get("alpha") is first
        assert registry.default() is first
        # all_ids stays a flat (deduped) list — still one entry for "alpha".
        assert registry.all_ids() == ["alpha"]
        # But the full bundle set is visible via all_bundles.
        assert len(registry.all_bundles()) == 2

    def test_per_project_default_tracks_correct_bundle(self) -> None:
        from agent_service_maf.core.team_bundle import TeamRegistry

        registry = TeamRegistry()
        b_a = _stub_bundle("alpha", TEST_PROJECT_ID)
        b_b = _stub_bundle("alpha", SECOND_PROJECT_ID)
        registry.add(b_a)
        registry.add(b_b)

        assert registry.default_for_project(TEST_PROJECT_ID) is b_a
        assert registry.default_for_project(SECOND_PROJECT_ID) is b_b

    def test_cross_project_isolation_at_http_layer(self, tmp_path: Path) -> None:
        """End-to-end: two projects each have a team called "alpha"; invoking
        ``/api/v1/projects/{pid}/agent-teams/alpha/invoke`` reaches the project-
        scoped bundle (not the cross-project sibling).
        """
        from fastapi.testclient import TestClient

        # Same team_id in two projects.
        (tmp_path / "alpha_p1.json").write_text(
            json.dumps({**_minimal_config("alpha", "agent_p1"), "_team_id": "alpha"})
        )
        (tmp_path / "alpha_p2.json").write_text(
            json.dumps(
                {
                    **_minimal_config("alpha", "agent_p2", project_id=SECOND_PROJECT_ID),
                    "_team_id": "alpha",
                }
            )
        )

        os.environ["AGENT_TEAMS_DIR"] = str(tmp_path)
        os.environ.pop("AGENT_CONFIG_PATH", None)
        try:
            from agent_service_maf.interface_layer.api import create_app

            app = create_app()
            with TestClient(app) as c:
                # Project 1's "alpha" lists agent_p1.
                r1 = c.get(f"{TEST_PROJECT_PREFIX}/agent-teams/alpha")
                assert r1.status_code == 200, r1.text
                assert r1.json()["agent_names"] == ["agent_p1"], (
                    f"Project 1 must resolve its own alpha bundle, got {r1.json()}"
                )

                # Project 2's "alpha" lists agent_p2 — proving isolation.
                r2 = c.get(f"{SECOND_PROJECT_PREFIX}/agent-teams/alpha")
                assert r2.status_code == 200, r2.text
                assert r2.json()["agent_names"] == ["agent_p2"], (
                    f"Project 2 must resolve its own alpha bundle, got {r2.json()}"
                )
        finally:
            os.environ.pop("AGENT_TEAMS_DIR", None)
