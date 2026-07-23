"""Integration tests for Phase 2 session HTTP CRUD endpoints.

Boots a real FastAPI app with a single team that has memory enabled,
populates conversation history via the invoke route, and exercises the
new session list / get / rename / delete endpoints in both the team
and agent scope.

Also verifies the per-user partition: an ``X-User-ID`` header on one
request must not leak conversation history to a request that carries a
different user id.
"""

from __future__ import annotations

import json
import os
from collections.abc import Awaitable, Callable, Iterator
from functools import partial
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tests.conftest import TEST_PROJECT_ID, TEST_PROJECT_PREFIX

# Names reused across the tests so failures surface obvious diff context.
TEAM_ID = "memory_team"
AGENT_ID = "mock"


def _team_config_with_memory() -> dict[str, Any]:
    """A minimal v2.0.0 config with ``memory.enabled=True``.

    Uses the ``mock`` framework registered by ``tests/conftest.py`` so no
    network or real LLM is involved.
    """
    return {
        "_schema_version": "2.0.0",
        "project_id": TEST_PROJECT_ID,
        "_team_id": TEAM_ID,
        "_team_name": "Memory Team",
        "_description": "Memory CRUD integration test",
        "agent": {
            "framework": "mock",
            "model": "azure/gpt-4.1-mini",
            "temperature": 0.0,
            "max_tokens": 64,
            "timeout_seconds": 30,
            "metadata": {
                "project": "test",
                "version": "0.0.0",
                "environment": "test",
            },
        },
        "semantic_kernel": {
            "agents": [
                {
                    "name": AGENT_ID,
                    "instructions": "Be brief.",
                    "description": "test",
                    "model": "azure/gpt-4.1-mini",
                    "temperature": 0.0,
                    "max_tokens": 64,
                    "tools": [],
                    "mcp_servers": [],
                    "function_choice_behavior": "auto",
                },
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
            "default_model": "azure/gpt-4.1-mini",
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
            "enabled": True,
            "storage_backend": "memory",
            "buffer_type": "sliding_window",
            "ttl_seconds": 3600,
            "max_history_length": 100,
            "max_tokens_per_session": 0,
            "max_chars_per_session": 0,
        },
        "logging": {
            "level": "WARNING",
            "format": "json",
            "include_timestamp": True,
        },
    }


@pytest.fixture
def memory_client(tmp_path: Path) -> Iterator[TestClient]:
    """Boot FastAPI with one team that has memory enabled."""
    teams_dir = tmp_path / "teams"
    teams_dir.mkdir()
    (teams_dir / f"{TEAM_ID}.json").write_text(json.dumps(_team_config_with_memory()))

    os.environ["AGENT_TEAMS_DIR"] = str(teams_dir)
    os.environ.pop("AGENT_CONFIG_PATH", None)

    from agent_service_maf.interface_layer.api import create_app

    app = create_app()
    with TestClient(app) as c:
        yield c
    os.environ.pop("AGENT_TEAMS_DIR", None)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
#
# The MockAgent registered in conftest.py is a pure stub and does NOT call
# session_manager.append_message itself (that's the SK / production adapter
# wiring, not the unit-test stub). So instead of going through /invoke and
# expecting persistence as a side effect, the tests below seed sessions
# directly into the team's bundle.session_manager. This keeps the routes
# under test (list/get/rename/delete) independent of which framework
# actually writes the session.


def _bundle(client: TestClient) -> Any:
    """Return the registered TeamBundle for ``TEAM_ID`` under ``TEST_PROJECT_ID``."""
    registry = client.app.state.teams
    bundle = registry.get_in_project(TEST_PROJECT_ID, TEAM_ID)
    assert bundle is not None, "memory_team bundle was not registered"
    assert bundle.session_manager is not None, "memory_team must have memory enabled"
    return bundle


async def _seed_session(
    bundle: Any,
    *,
    session_id: str,
    user_id: str,
    scope: str,
    anchor: str,
    input_text: str = "ping",
) -> None:
    """Write a user+assistant message pair to the team's session store."""
    from agent_service_maf.core.session import ConversationMessage

    scoped_id = bundle.scoped_session_id(
        session_id,
        scope=scope,
        agent_id=anchor if scope == "agent" else None,
        user_id=user_id or None,
    )
    assert scoped_id is not None
    await bundle.session_manager.append_message(
        scoped_id,
        ConversationMessage(role="user", content=input_text),
    )
    await bundle.session_manager.append_message(
        scoped_id,
        ConversationMessage(role="assistant", content=f"echo: {input_text}"),
    )


def _run_on_app_loop(
    client: TestClient,
    coro_fn: Callable[[], Awaitable[None]],
) -> None:
    """Run an async callable on the TestClient's app event loop.

    The lifespan-owned :class:`~agent_service_maf.core.session.SessionManager`
    creates its ``asyncio.Lock`` on the portal thread's loop; awaiting
    ``append_message`` from a fresh loop on the test thread raises
    "attached to a different loop". Routing the seed call through
    ``client.portal.call`` shares the loop and the lock works as
    intended. ``portal.call`` blocks until the coroutine completes, so
    callers stay sync.
    """
    portal = client.portal
    assert portal is not None, (
        "TestClient must be entered as a context manager so its portal exists"
    )
    portal.call(coro_fn)


def _seed_team(
    client: TestClient,
    *,
    session_id: str,
    user_id: str,
    input_text: str = "ping",
) -> None:
    bundle = _bundle(client)
    _run_on_app_loop(
        client,
        partial(
            _seed_session,
            bundle,
            session_id=session_id,
            user_id=user_id,
            scope="team",
            anchor=TEAM_ID,
            input_text=input_text,
        ),
    )


def _seed_agent(
    client: TestClient,
    *,
    session_id: str,
    user_id: str,
    input_text: str = "ping",
) -> None:
    bundle = _bundle(client)
    _run_on_app_loop(
        client,
        partial(
            _seed_session,
            bundle,
            session_id=session_id,
            user_id=user_id,
            scope="agent",
            anchor=AGENT_ID,
            input_text=input_text,
        ),
    )


# ---------------------------------------------------------------------------
# Team-scoped CRUD
# ---------------------------------------------------------------------------


class TestTeamScopedCrud:
    def test_list_after_seed(self, memory_client: TestClient) -> None:
        _seed_team(memory_client, session_id="s1", user_id="alice")
        r = memory_client.get(
            f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/sessions",
            headers={"X-User-ID": "alice"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["scope"] == "team"
        assert body["anchor"] == TEAM_ID
        assert body["userId"] == "alice"
        assert body["total"] == 1
        assert body["sessions"][0]["sessionId"] == "s1"
        assert body["memoryDegraded"] is False

    def test_get_returns_messages(self, memory_client: TestClient) -> None:
        _seed_team(
            memory_client,
            session_id="s1",
            user_id="alice",
            input_text="What is the capital of France?",
        )
        r = memory_client.get(
            f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/sessions/s1",
            headers={"X-User-ID": "alice"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["sessionId"] == "s1"
        assert body["scope"] == "team"
        assert body["userId"] == "alice"
        roles = [m["role"] for m in body["messages"]]
        assert "user" in roles
        assert "assistant" in roles
        assert body["name"].startswith("Session ")

    def test_get_unknown_session_returns_404(self, memory_client: TestClient) -> None:
        r = memory_client.get(
            f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/sessions/does-not-exist",
            headers={"X-User-ID": "alice"},
        )
        assert r.status_code == 404
        assert "does-not-exist" in r.json()["detail"]["error"]

    def test_rename_updates_name(self, memory_client: TestClient) -> None:
        _seed_team(memory_client, session_id="s1", user_id="alice")
        r = memory_client.patch(
            f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/sessions/s1",
            headers={"X-User-ID": "alice"},
            json={"name": "Trip planning"},
        )
        assert r.status_code == 200, r.text
        assert r.json()["name"] == "Trip planning"

    def test_rename_rejects_empty_name(self, memory_client: TestClient) -> None:
        _seed_team(memory_client, session_id="s1", user_id="alice")
        r = memory_client.patch(
            f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/sessions/s1",
            headers={"X-User-ID": "alice"},
            json={"name": "   "},
        )
        assert r.status_code == 400

    def test_delete_then_list_is_empty(self, memory_client: TestClient) -> None:
        _seed_team(memory_client, session_id="s1", user_id="alice")
        r = memory_client.delete(
            f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/sessions/s1",
            headers={"X-User-ID": "alice"},
        )
        assert r.status_code == 204, r.text
        listing = memory_client.get(
            f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/sessions",
            headers={"X-User-ID": "alice"},
        ).json()
        assert listing["total"] == 0

    def test_invoke_without_session_id_auto_generates_one(
        self,
        memory_client: TestClient,
    ) -> None:
        """POST /invoke with no sessionId should mint a UUID-style raw
        session id and echo it back in the response — never the scoped
        storage key (which clients can't safely replay)."""
        r = memory_client.post(
            f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/invoke",
            headers={"X-User-ID": "alice"},
            json={"input": "hello"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        echoed = body.get("sessionId")
        assert echoed, "expected a generated sessionId in the response"
        # Must be the raw form, not the team:proj:tid:uid:sid scoped key.
        assert ":" not in echoed, f"sessionId echoed to client must be the raw form, got {echoed!r}"
        # uuid4().hex is 32 lower-case hex chars.
        assert len(echoed) == 32 and all(c in "0123456789abcdef" for c in echoed), (
            f"expected uuid4().hex format, got {echoed!r}"
        )

    def test_invoke_with_session_id_echoes_caller_form(
        self,
        memory_client: TestClient,
    ) -> None:
        """When the caller supplies a session id we echo their raw form
        back unchanged — not the team-prefixed storage key."""
        r = memory_client.post(
            f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/invoke",
            headers={"X-User-ID": "alice"},
            json={"input": "hello", "sessionId": "sess-abc-123"},
        )
        assert r.status_code == 200, r.text
        assert r.json()["sessionId"] == "sess-abc-123"

    def test_delete_unknown_returns_404(self, memory_client: TestClient) -> None:
        r = memory_client.delete(
            f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/sessions/does-not-exist",
            headers={"X-User-ID": "alice"},
        )
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# Cross-user isolation (the privacy guarantee of Phase 2)
# ---------------------------------------------------------------------------


class TestCrossUserIsolation:
    def test_alice_and_bob_see_separate_lists(
        self,
        memory_client: TestClient,
    ) -> None:
        _seed_team(memory_client, session_id="s1", user_id="alice", input_text="alice's thread")
        _seed_team(memory_client, session_id="s1", user_id="bob", input_text="bob's thread")

        alice = memory_client.get(
            f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/sessions",
            headers={"X-User-ID": "alice"},
        ).json()
        bob = memory_client.get(
            f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/sessions",
            headers={"X-User-ID": "bob"},
        ).json()

        # Each user sees exactly their own session.
        assert {s["sessionId"] for s in alice["sessions"]} == {"s1"}
        assert {s["sessionId"] for s in bob["sessions"]} == {"s1"}
        assert {s["userId"] for s in alice["sessions"]} == {"alice"}
        assert {s["userId"] for s in bob["sessions"]} == {"bob"}

    def test_alice_cannot_read_bobs_transcript(
        self,
        memory_client: TestClient,
    ) -> None:
        _seed_team(memory_client, session_id="s1", user_id="alice", input_text="alice secret")
        _seed_team(memory_client, session_id="s1", user_id="bob", input_text="bob secret")

        alice_detail = memory_client.get(
            f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/sessions/s1",
            headers={"X-User-ID": "alice"},
        ).json()
        bob_detail = memory_client.get(
            f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/sessions/s1",
            headers={"X-User-ID": "bob"},
        ).json()

        alice_text = json.dumps(alice_detail["messages"])
        bob_text = json.dumps(bob_detail["messages"])
        assert "alice secret" in alice_text
        assert "bob secret" not in alice_text
        assert "bob secret" in bob_text
        assert "alice secret" not in bob_text

    def test_alice_delete_does_not_touch_bob(
        self,
        memory_client: TestClient,
    ) -> None:
        _seed_team(memory_client, session_id="s1", user_id="alice")
        _seed_team(memory_client, session_id="s1", user_id="bob")

        # Alice deletes her copy.
        r = memory_client.delete(
            f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/sessions/s1",
            headers={"X-User-ID": "alice"},
        )
        assert r.status_code == 204, r.text

        # Bob's list is unchanged.
        bob = memory_client.get(
            f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/sessions",
            headers={"X-User-ID": "bob"},
        ).json()
        assert {s["sessionId"] for s in bob["sessions"]} == {"s1"}


# ---------------------------------------------------------------------------
# Scope isolation: team-scoped vs agent-scoped sessions diverge
# ---------------------------------------------------------------------------


class TestScopeIsolation:
    def test_team_and_agent_scope_lists_diverge(
        self,
        memory_client: TestClient,
    ) -> None:
        _seed_team(memory_client, session_id="s1", user_id="alice", input_text="team-side hello")
        _seed_agent(memory_client, session_id="s1", user_id="alice", input_text="agent-side hello")

        team_list = memory_client.get(
            f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/sessions",
            headers={"X-User-ID": "alice"},
        ).json()
        agent_list = memory_client.get(
            f"{TEST_PROJECT_PREFIX}/agents/{AGENT_ID}/sessions",
            headers={"X-User-ID": "alice"},
        ).json()

        assert {s["scope"] for s in team_list["sessions"]} == {"team"}
        assert {s["scope"] for s in agent_list["sessions"]} == {"agent"}
        assert team_list["anchor"] == TEAM_ID
        assert agent_list["anchor"] == AGENT_ID

    def test_agent_get_returns_agent_anchor(
        self,
        memory_client: TestClient,
    ) -> None:
        _seed_agent(memory_client, session_id="s1", user_id="alice")
        r = memory_client.get(
            f"{TEST_PROJECT_PREFIX}/agents/{AGENT_ID}/sessions/s1",
            headers={"X-User-ID": "alice"},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["scope"] == "agent"
        assert body["anchor"] == AGENT_ID
        assert body["sessionId"] == "s1"


# ---------------------------------------------------------------------------
# Memory disabled → 404 (not 500)
# ---------------------------------------------------------------------------


class TestMemoryDisabled:
    """When the team has memory.enabled=false the routes return 404."""

    def test_routes_404_when_memory_disabled(self, tmp_path: Path) -> None:
        # Same team config as `memory_client` but with memory disabled.
        cfg = _team_config_with_memory()
        cfg["memory"]["enabled"] = False
        teams_dir = tmp_path / "teams"
        teams_dir.mkdir()
        (teams_dir / f"{TEAM_ID}.json").write_text(json.dumps(cfg))

        os.environ["AGENT_TEAMS_DIR"] = str(teams_dir)
        from agent_service_maf.interface_layer.api import create_app

        app = create_app()
        try:
            with TestClient(app) as client:
                r = client.get(
                    f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/sessions",
                    headers={"X-User-ID": "alice"},
                )
                assert r.status_code == 404
                assert "memory" in r.json()["detail"]["error"].lower()
        finally:
            os.environ.pop("AGENT_TEAMS_DIR", None)
