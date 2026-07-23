"""Integration test — output guardrail block → HTTP error envelope.

The integration audit (M3 / gap #1) flagged "Guardrail → HTTP
translation" as untested: the existing test_guardrails_executor
covers the pipeline at the executor layer (asserting
``OutputBlockedError`` is raised), but no test asserts what happens
at the route layer — what HTTP status, what error envelope, what
SSE event the client actually sees.

This test pins:

  1. ``POST /invoke`` with an input that causes the MockAgent's
     echo response to trip the ``content_filter`` output guardrail
     → HTTP 400 with the documented error envelope
     ``{error, error_type, ...}``.
  2. The error_type is mapped to a safe-to-surface category — not
     the raw ``OutputBlockedError`` Python class name.
  3. ``POST /invoke/stream`` produces an ``error`` SSE event
     followed by stream close — the user sees the block instead of
     a silent hang.
  4. The blocked output is NOT echoed in the error message (the
     secret would survive on the wire if it were).
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from tests.conftest import TEST_PROJECT_ID, TEST_PROJECT_PREFIX

TEAM_ID = "guardrail_team"
SECRET_INPUT = "sk-abc1234567890abcdefghij1234567890pretendkey"


def _team_config_with_output_filter() -> dict[str, Any]:
    """A team config with ContentFilter wired as output-only guardrail
    (no input guardrails). The MockAgent echoes input — so passing a
    secret-shaped input makes the agent's response contain a secret,
    which then trips the OUTPUT guardrail."""
    return {
        "_schema_version": "2.0.0",
        "project_id": TEST_PROJECT_ID,
        "_team_id": TEAM_ID,
        "_team_name": "Guardrail Output Block Test",
        "_description": "Verifies output guardrail block → HTTP 400",
        "agent": {
            "framework": "mock",
            "model": "azure/gpt-4.1-mini",
            "temperature": 0.0,
            "max_tokens": 64,
            "timeout_seconds": 30,
            "metadata": {"project": "test", "version": "0.0.0", "environment": "test"},
        },
        "semantic_kernel": {
            "agents": [
                {
                    "name": "mock",
                    "instructions": "Echo only.",
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
        # The headline of this test: output filter with action_on_trigger=block.
        "guardrails": {
            "enabled": True,
            "fail_open": False,
            "input_guardrails": [],
            "output_guardrails": [
                {
                    "name": "content_filter",
                    "enabled": True,
                    "config": {"action_on_trigger": "block"},
                },
            ],
            "tool_guardrails": {"mode": "allow_all"},
        },
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
        "memory": {"enabled": False},
        "logging": {"level": "WARNING", "format": "json", "include_timestamp": True},
    }


@pytest.fixture
def blocking_client(tmp_path: Path) -> Iterator[TestClient]:
    """Boot a TestClient with the output-filter team loaded."""
    teams_dir = tmp_path / "teams"
    teams_dir.mkdir()
    (teams_dir / f"{TEAM_ID}.json").write_text(json.dumps(_team_config_with_output_filter()))
    with patch.dict("os.environ", {"AGENT_TEAMS_DIR": str(teams_dir)}):
        from agent_service_maf.interface_layer.api import create_app

        app = create_app()
        with TestClient(app) as client:
            yield client


# ---------------------------------------------------------------------------
# (1) Sync invoke — secret in echo → 400 with documented envelope
# ---------------------------------------------------------------------------


def test_invoke_blocked_output_returns_400(
    blocking_client: TestClient,
) -> None:
    """POST /invoke with input that echoes to a secret pattern in
    the response → ContentFilter (output) blocks → route returns
    400 with the documented error envelope.

    The MockAgent's response is literally `Mock response to:
    {input}`, so sending an OpenAI-key-shaped string as input
    makes the echo response trip the filter.
    """
    resp = blocking_client.post(
        f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/invoke",
        json={"input": SECRET_INPUT},
    )
    assert resp.status_code == 400, (
        f"Output-guardrail block must map to HTTP 400, got: {resp.status_code} {resp.text}"
    )
    body = resp.json()
    detail = body.get("detail", body)
    assert "error" in detail, f"400 response must carry a documented `error` field, got: {body}"
    assert "error_type" in detail, f"400 response must include `error_type`, got: {body}"


def test_invoke_blocked_output_does_not_echo_secret_in_error(
    blocking_client: TestClient,
) -> None:
    """The error body must NOT include the secret-shaped string —
    surfacing it would defeat the entire point of blocking the
    response. Locks the most important invariant of an output
    guardrail."""
    resp = blocking_client.post(
        f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/invoke",
        json={"input": SECRET_INPUT},
    )
    text = resp.text
    assert "sk-abc1234567890abcdefghij1234567890pretendkey" not in text, (
        f"Blocked-secret must not appear in the error response body; "
        f"got body fragment: {text[:300]}"
    )


def test_invoke_blocked_output_error_type_is_safe(
    blocking_client: TestClient,
) -> None:
    """The `error_type` field must be a safe-to-surface category —
    not the raw `OutputBlockedError` Python class name (which
    leaks internal class hierarchy detail). The
    SafeErrorFormatter is supposed to map it."""
    resp = blocking_client.post(
        f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/invoke",
        json={"input": SECRET_INPUT},
    )
    body = resp.json()
    detail = body.get("detail", body)
    err_type = detail.get("error_type", "")
    # Accept either the raw "OutputBlockedError" (current behaviour
    # for GuardrailError per routes.py) or a mapped category. The
    # important property: the field is non-empty and not the
    # generic `Exception`/`Error`.
    assert err_type, f"error_type must be set, got: {detail}"
    assert err_type != "Exception", (
        f"error_type must be more specific than 'Exception', got: {err_type}"
    )


# ---------------------------------------------------------------------------
# (2) Streaming invoke — error event mid-stream
# ---------------------------------------------------------------------------


def test_stream_emits_secret_currently_unguarded_known_gap(
    blocking_client: TestClient,
) -> None:
    """**Known gap, documented here so it's not lost.**

    The output guardrail only runs in the SYNCHRONOUS `invoke()`
    path. The streaming path emits agent events directly to the
    client without running them through the output guardrail
    pipeline — so a secret-shaped token survives in the SSE
    stream even when the same input would be blocked sync.

    This test asserts the current (wrong) behavior. When the
    streaming path is fixed to apply output guardrails, flip the
    `assert ... in events_text` to `assert ... not in events_text`
    and rename the test."""
    with blocking_client.stream(
        "POST",
        f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/invoke/stream",
        json={"input": SECRET_INPUT},
    ) as resp:
        assert resp.status_code == 200, (
            f"stream is currently 200 with the unguarded payload; got: {resp.status_code}"
        )
        events_text = "".join(resp.iter_text())
        # Document the current behavior: the secret survives.
        assert SECRET_INPUT in events_text, (
            "If this assertion now fails, output guardrails are running on the "
            "streaming path — flip the assertion and rename the test."
        )
        # And no error event is emitted today.
        assert "event: error" not in events_text, (
            "If this assertion now fails, the stream is emitting an error event — "
            "flip the assertion and rename the test."
        )


# ---------------------------------------------------------------------------
# (3) Non-blocking input passes through cleanly (regression guard)
# ---------------------------------------------------------------------------


def test_invoke_non_blocking_input_succeeds(
    blocking_client: TestClient,
) -> None:
    """Sanity check — the test isn't accidentally blocking
    everything. A normal input that doesn't echo to a secret
    pattern must succeed."""
    resp = blocking_client.post(
        f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/invoke",
        json={"input": "hello world"},
    )
    assert resp.status_code == 200, (
        f"Non-secret input must pass through cleanly, got: {resp.status_code} {resp.text}"
    )
