"""Tests for the _mcp_header_provider header-forwarding contract.

The artifact-service relies on X-Session-ID / X-Agent-ID / X-Team-ID
being forwarded by this function for ACL resolution and audit trailer
stamping. Regressions here would silently break audit on every commit.

We stub the `agno.tools.mcp` import (heavy / network-bound dep) before
loading `src.mcp_pool` so the test can run without the full agno
runtime — the header provider doesn't actually use agno.
"""

import sys
import types


def _ensure_agno_stub():
    if "agno" not in sys.modules:
        agno = types.ModuleType("agno")
        tools = types.ModuleType("agno.tools")
        mcp_mod = types.ModuleType("agno.tools.mcp")
        mcp_mod.MCPTools = object  # type: ignore[attr-defined]
        mcp_mod.StreamableHTTPClientParams = object  # type: ignore[attr-defined]
        sys.modules["agno"] = agno
        sys.modules["agno.tools"] = tools
        sys.modules["agno.tools.mcp"] = mcp_mod


_ensure_agno_stub()

from src.mcp_pool import _mcp_header_provider  # noqa: E402


class _FakeRunContext:
    def __init__(self, user_id=None, metadata=None, session_id=None):
        self.user_id = user_id
        self.metadata = metadata or {}
        if session_id is not None:
            self.session_id = session_id


class _FakeAgent:
    def __init__(self, id="agent-xyz"):
        self.id = id


class _FakeTeam:
    def __init__(self, id="team-1"):
        self.id = id


def test_returns_empty_when_no_run_context():
    assert _mcp_header_provider(None) == {}


def test_forwards_existing_identity_headers():
    rc = _FakeRunContext(
        user_id="user-1",
        metadata={"authorization": "Bearer abc", "project_id": "proj-1"},
    )
    headers = _mcp_header_provider(rc)
    assert headers["Authorization"] == "Bearer abc"
    assert headers["X-Project-ID"] == "proj-1"
    assert headers["X-User-ID"] == "user-1"


def test_forwards_session_id_from_run_context():
    rc = _FakeRunContext(user_id="u1", session_id="sess-42")
    headers = _mcp_header_provider(rc)
    assert headers["X-Session-ID"] == "sess-42"


def test_forwards_session_id_from_metadata_fallback():
    rc = _FakeRunContext(user_id="u1", metadata={"session_id": "sess-from-meta"})
    headers = _mcp_header_provider(rc)
    assert headers["X-Session-ID"] == "sess-from-meta"


def test_run_context_session_id_wins_over_metadata():
    rc = _FakeRunContext(
        user_id="u1",
        session_id="sess-real",
        metadata={"session_id": "sess-meta"},
    )
    headers = _mcp_header_provider(rc)
    assert headers["X-Session-ID"] == "sess-real"


def test_forwards_agent_id_when_agent_present():
    rc = _FakeRunContext(user_id="u1")
    headers = _mcp_header_provider(rc, agent=_FakeAgent(id="agt-abc"))
    assert headers["X-Agent-ID"] == "agt-abc"
    assert "X-Team-ID" not in headers


def test_forwards_team_id_when_team_present():
    rc = _FakeRunContext(user_id="u1")
    headers = _mcp_header_provider(rc, team=_FakeTeam(id="team-xyz"))
    assert headers["X-Team-ID"] == "team-xyz"


def test_omits_optional_headers_when_inputs_missing():
    rc = _FakeRunContext()
    headers = _mcp_header_provider(rc)
    # Only base headers should be considered, and even those skip when
    # their source is empty.
    assert "X-Session-ID" not in headers
    assert "X-Agent-ID" not in headers
    assert "X-Team-ID" not in headers
    assert "X-User-ID" not in headers
