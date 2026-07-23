"""Integration test — WebSocket message lifecycle beyond the handshake.

The integration audit (H8) flagged the WS surface as covered only at
the auth-handshake layer (`TestWebSocketAuth` in test_api_endpoints).
Everything after the 4401-or-200 handshake — actually sending a turn,
receiving the event stream, ordering of frames, sending multiple
sequential messages on one connection, malformed-payload recovery —
was untested.

This file pins the per-message contract using the existing
`MockAgent` (registered globally by tests/conftest.py and yielding
`THINKING → TOKEN` events) so the test exercises real ws_handler.py
code paths, not a hand-rolled fake.

Properties pinned:

  1. A valid InvokeRequest yields the documented event frame
     sequence: `started → thinking → token → completed`.
  2. Each frame has the documented shape: `{event, data, metadata,
     timestamp}`.
  3. Malformed JSON yields an `error` frame with `error_type:
     json_decode_error` but **does NOT close the connection** — the
     loop continues so the client can recover.
  4. After a malformed frame, sending a valid InvokeRequest on the
     same connection still works (loop genuinely continues).
  5. Multiple sequential valid InvokeRequests on one connection each
     produce a full event sequence — no state bleeds between turns.
  6. The same `session_id` across sequential turns shares the
     SessionManager scope (real session continuity wiring).
"""

from __future__ import annotations

import contextlib
import json
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from tests.conftest import TEST_PROJECT_ID, TEST_PROJECT_PREFIX


# Match the existing TestWebSocketAuth pattern so this test stays
# isolated from suite-wide AGENT_INTERFACE__AUTH__* env vars.
@contextlib.contextmanager
def _boot_app(tmp_path: Any, auth_enabled: bool = False) -> Iterator[TestClient]:
    """Boot a fresh TestClient with the MockAgent framework loaded."""
    from agent_service_maf.config.config_loader import ConfigLoader as RealConfigLoader
    from agent_service_maf.interface_layer.api import create_app

    teams_dir = tmp_path / "teams"
    teams_dir.mkdir(parents=True, exist_ok=True)
    (teams_dir / "default.json").write_text(
        json.dumps(
            {
                "_team_id": "default",
                "project_id": TEST_PROJECT_ID,
                "agent": {"framework": "mock"},
            }
        )
    )
    env = {
        "AGENT_AGENT__FRAMEWORK": "mock",
        "AGENT_TEAMS_DIR": str(teams_dir),
        "AGENT_INTERFACE__AUTH__ENABLED": "false" if not auth_enabled else "true",
    }
    with (
        patch.dict("os.environ", env),
        patch(
            "agent_service_maf.core.team_loader.ConfigLoader",
            return_value=RealConfigLoader(json_config_path=None),
        ),
    ):
        app = create_app()
        with TestClient(app) as client:
            yield client


def _make_invoke_message(text: str, session_id: str | None = None) -> str:
    payload: dict[str, Any] = {"input": text}
    if session_id is not None:
        payload["session_id"] = session_id
    return json.dumps(payload)


# ---------------------------------------------------------------------------
# (1) Event sequence — valid turn yields started → thinking → token → completed
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_ws_valid_turn_emits_full_event_sequence(tmp_path: Any) -> None:
    """A single InvokeRequest must produce the documented frame
    sequence. Order locked: `started` always first, `completed`
    always last."""
    with (
        _boot_app(tmp_path) as client,
        client.websocket_connect(f"{TEST_PROJECT_PREFIX}/agent-teams/default/ws") as ws,
    ):
        ws.send_text(_make_invoke_message("hello"))

        events: list[dict[str, Any]] = []
        for _ in range(10):  # bounded read; protect against test hang
            frame = ws.receive_json()
            events.append(frame)
            if frame.get("event") == "completed":
                break

        event_types = [e["event"] for e in events]
        assert event_types[0] == "started", f"first frame must be 'started', got: {event_types[0]}"
        assert event_types[-1] == "completed", (
            f"last frame must be 'completed', got: {event_types[-1]}"
        )
        assert "thinking" in event_types, (
            f"MockAgent emits a thinking event, expected in: {event_types}"
        )
        assert "token" in event_types, (
            f"MockAgent emits a token event with the response, expected in: {event_types}"
        )

        # Token data must include the agent's mock response shape.
        token_frame = next(e for e in events if e["event"] == "token")
        assert "hello" in token_frame["data"], (
            f"MockAgent should echo the input in its token data: {token_frame['data']}"
        )


# ---------------------------------------------------------------------------
# (2) Frame shape
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_ws_frames_have_documented_shape(tmp_path: Any) -> None:
    """Every WS frame carries `{event, data, metadata, timestamp}`.
    Locked so a frame-shape change forces an explicit doc update."""
    with (
        _boot_app(tmp_path) as client,
        client.websocket_connect(f"{TEST_PROJECT_PREFIX}/agent-teams/default/ws") as ws,
    ):
        ws.send_text(_make_invoke_message("hello"))
        for _ in range(10):
            frame = ws.receive_json()
            assert set(frame.keys()) >= {
                "event",
                "data",
                "metadata",
                "timestamp",
            }, f"frame missing required keys: {frame}"
            if frame.get("event") == "completed":
                break


# ---------------------------------------------------------------------------
# (3) Malformed JSON yields error but does NOT close connection
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_ws_malformed_json_yields_error_without_closing(tmp_path: Any) -> None:
    """The loop must keep the connection alive after a malformed
    payload. Closing would prevent retry from a poorly-formed client
    and force a full reconnect / re-auth."""
    with (
        _boot_app(tmp_path) as client,
        client.websocket_connect(f"{TEST_PROJECT_PREFIX}/agent-teams/default/ws") as ws,
    ):
        ws.send_text("not json at all")
        err = ws.receive_json()
        assert err["event"] == "error"
        assert err["metadata"].get("error_type") == "json_decode_error"

        # The connection is still alive — send a valid message and get
        # the full sequence.
        ws.send_text(_make_invoke_message("after-malformed"))
        recovery: list[str] = []
        for _ in range(10):
            f = ws.receive_json()
            recovery.append(f["event"])
            if f["event"] == "completed":
                break
        assert "completed" in recovery, (
            f"After a malformed frame, valid follow-up must still work; events: {recovery}"
        )


# ---------------------------------------------------------------------------
# (4) Invalid InvokeRequest shape — error frame, loop continues
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_ws_invalid_request_shape_yields_error_and_continues(tmp_path: Any) -> None:
    """JSON parses but doesn't match InvokeRequest schema (missing
    `input`) → error frame, loop continues. Documented behaviour at
    `ws_handler.py:237-249`."""
    with (
        _boot_app(tmp_path) as client,
        client.websocket_connect(f"{TEST_PROJECT_PREFIX}/agent-teams/default/ws") as ws,
    ):
        ws.send_text(json.dumps({"not_a_field": "value"}))
        err = ws.receive_json()
        assert err["event"] == "error"

        # Loop continues — next valid message processed normally.
        ws.send_text(_make_invoke_message("recover"))
        for _ in range(10):
            f = ws.receive_json()
            if f["event"] == "completed":
                break
        else:
            pytest.fail("Loop did not deliver completed event after invalid request")


# ---------------------------------------------------------------------------
# (5) Multiple sequential turns on one connection
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_ws_multiple_sequential_turns_each_get_full_sequence(tmp_path: Any) -> None:
    """Two InvokeRequests in a row on the same connection must each
    produce a complete started→completed sequence — no state leakage
    between turns at the WS handler level."""
    with (
        _boot_app(tmp_path) as client,
        client.websocket_connect(f"{TEST_PROJECT_PREFIX}/agent-teams/default/ws") as ws,
    ):
        for turn_text in ("first turn", "second turn"):
            ws.send_text(_make_invoke_message(turn_text))
            events: list[dict[str, Any]] = []
            for _ in range(10):
                f = ws.receive_json()
                events.append(f)
                if f["event"] == "completed":
                    break
            event_types = [e["event"] for e in events]
            assert event_types[0] == "started"
            assert event_types[-1] == "completed"
            token = next(e for e in events if e["event"] == "token")
            assert turn_text in token["data"], (
                f"Turn {turn_text!r} must echo in its own token frame, got: {token['data']}"
            )


# ---------------------------------------------------------------------------
# (6) Same session_id across turns
# ---------------------------------------------------------------------------


@pytest.mark.integration
def test_ws_same_session_id_across_turns_does_not_error(tmp_path: Any) -> None:
    """Two turns on the same WS with the same session_id must succeed
    cleanly. The SessionManager scope is real (per ws_handler.py's
    scoped_session_id call) — this test asserts the wiring doesn't
    fail under reuse."""
    with (
        _boot_app(tmp_path) as client,
        client.websocket_connect(f"{TEST_PROJECT_PREFIX}/agent-teams/default/ws") as ws,
    ):
        sid = "lifecycle-sess-1"
        ws.send_text(_make_invoke_message("turn one", session_id=sid))
        for _ in range(10):
            f = ws.receive_json()
            if f["event"] == "completed":
                break

        ws.send_text(_make_invoke_message("turn two", session_id=sid))
        for _ in range(10):
            f = ws.receive_json()
            if f["event"] == "completed":
                break
        else:
            pytest.fail("Second turn on same session_id did not complete")
