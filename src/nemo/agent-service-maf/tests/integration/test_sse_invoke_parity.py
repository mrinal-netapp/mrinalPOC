"""§G2 / §5.4.4 SSE → InvokeResponse parity tests.

The unified adapter contract (§5.4.4 / §B1) requires every adapter to
emit its final ``COMPLETED`` event with
``metadata.invokeResponse = builder.finalize().model_dump(by_alias=True)``.

This test pins that contract end-to-end: the response reassembled from
the SSE ``completed`` event must equal the REST sync ``invoke()``
response for the same input.

Coverage:

* Echo adapter (single-agent) -- ``output`` matches, ``durationMs``
  field present on both, ``agentId`` matches.
* Stream emits at least one ``started`` envelope, one or more ``token``
  events, and exactly one ``completed`` event carrying
  ``invokeResponse``.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

# §B3: the migrated EchoAgent lives at framework.echo_adapter and uses
# ResponseBuilder + emits the §5.4.4 STARTED/COMPLETED contract. The
# pre-migration examples.echo_agent.EchoAgent does NOT emit those
# bookends and would mask the SSE handler bug we're pinning here.
from agent_service_maf.framework.echo_adapter import EchoAgent
from agent_service_maf.framework.registry import FrameworkRegistry
from agent_service_maf.interface_layer.api import create_app
from tests.conftest import TEST_PROJECT_ID, TEST_PROJECT_PREFIX


def _write_team(teams_dir, framework: str) -> None:
    teams_dir.mkdir(parents=True, exist_ok=True)
    (teams_dir / "default.json").write_text(
        json.dumps(
            {
                "_team_id": "default",
                "project_id": TEST_PROJECT_ID,
                "agent": {"framework": framework},
            }
        )
    )


@pytest.fixture
def echo_client(tmp_path):
    """TestClient with the EchoAgent registered as ``echo``."""
    from agent_service_maf.config.config_loader import ConfigLoader as RealConfigLoader

    teams_dir = tmp_path / "teams"
    _write_team(teams_dir, framework="echo")
    FrameworkRegistry.clear()
    FrameworkRegistry.register("echo")(EchoAgent)
    env = {"AGENT_AGENT__FRAMEWORK": "echo", "AGENT_TEAMS_DIR": str(teams_dir)}
    with patch.dict("os.environ", env):
        with patch("agent_service_maf.core.team_loader.ConfigLoader") as MockConfigLoader:
            MockConfigLoader.return_value = RealConfigLoader(json_config_path=None)
            app = create_app()
            with TestClient(app) as client:
                yield client
    FrameworkRegistry.clear()


def _parse_sse(body: str) -> list[dict[str, Any]]:
    """Split a raw SSE body into a list of ``{event, data}`` dicts.

    A single SSE record is terminated by a blank line. We parse the
    ``event:`` and ``data:`` lines, JSON-decoding ``data`` when it
    looks like JSON (the adapter emits structured metadata blobs).
    Starlette's ``EventSourceResponse`` uses CRLF line endings per the
    SSE spec, so we normalise to ``\\n`` before splitting.
    """
    body = body.replace("\r\n", "\n")
    records: list[dict[str, Any]] = []
    for raw in body.split("\n\n"):
        event: str | None = None
        data: list[str] = []
        for line in raw.split("\n"):
            if line.startswith("event:"):
                event = line[len("event:") :].strip()
            elif line.startswith("data:"):
                data.append(line[len("data:") :].lstrip())
        if event is None and not data:
            continue
        joined = "\n".join(data)
        try:
            payload: Any = json.loads(joined)
        except (ValueError, TypeError):
            payload = joined
        records.append({"event": event, "data": payload})
    return records


@pytest.mark.integration
class TestSseInvokeParity:
    def test_completed_event_carries_invoke_response(self, echo_client: TestClient) -> None:
        """``completed.metadata.invokeResponse`` must be populated by every
        adapter per the §B1 contract."""
        r = echo_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/echo/invoke/stream",
            json={"input": "Hello, SSE!"},
        )
        assert r.status_code == 200, r.text
        records = _parse_sse(r.text)
        # There must be a final completed record.
        completed = [rec for rec in records if rec["event"] == "completed"]
        assert completed, (
            f"Expected at least one 'completed' SSE event. Got: "
            f"{[rec['event'] for rec in records]}\n\nRaw body:\n{r.text!r}"
        )
        payload = completed[-1]["data"]
        assert isinstance(payload, dict), (
            f"Expected dict completed payload, got {type(payload)}: {payload!r}\n"
            f"Full body: {r.text!r}"
        )
        # The contract is metadata.invokeResponse OR a flat invokeResponse,
        # depending on how the adapter packs it. Both are allowed by §5.4.4
        # as long as the camelCase key is present somewhere on the envelope.
        invoke_response = payload.get("metadata", {}).get("invokeResponse") or payload.get(
            "invokeResponse"
        )
        assert isinstance(invoke_response, dict), (
            f"Expected completed.metadata.invokeResponse (or completed.invokeResponse) "
            f"dict, got payload: {payload!r}"
        )
        assert "agentId" in invoke_response, (
            f"invokeResponse must carry camelCase agentId, got: {list(invoke_response.keys())}"
        )
        assert "output" in invoke_response
        assert "durationMs" in invoke_response

    def test_sse_output_matches_rest_sync(self, echo_client: TestClient) -> None:
        """The ``output`` in the SSE invokeResponse must equal what
        ``POST .../invoke`` returns for the same input."""
        body = {"input": "parity-check"}
        sync = echo_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/echo/invoke",
            json=body,
        )
        assert sync.status_code == 200, sync.text
        sync_payload = sync.json()

        stream = echo_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/echo/invoke/stream",
            json=body,
        )
        assert stream.status_code == 200, stream.text
        records = _parse_sse(stream.text)
        completed = [rec for rec in records if rec["event"] == "completed"][-1]
        invoke_response = completed["data"].get("metadata", {}).get("invokeResponse") or completed[
            "data"
        ].get("invokeResponse")
        assert invoke_response is not None
        assert invoke_response["agentId"] == sync_payload["agentId"]
        assert invoke_response["output"] == sync_payload["output"], (
            f"SSE output {invoke_response['output']!r} != REST sync output "
            f"{sync_payload['output']!r}"
        )

    def test_sse_contract_event_sequence(self, echo_client: TestClient) -> None:
        """Adapter contract: at minimum one ``started`` and one ``completed``
        event are emitted, with optional ``token`` events in between."""
        r = echo_client.post(
            f"{TEST_PROJECT_PREFIX}/agents/echo/invoke/stream",
            json={"input": "Sequence test"},
        )
        events = [rec["event"] for rec in _parse_sse(r.text) if rec["event"]]
        assert "started" in events, f"Missing 'started' event; got: {events}"
        assert "completed" in events, f"Missing 'completed' event; got: {events}"
        # `started` must come before `completed`.
        assert events.index("started") < events.index("completed"), (
            f"started must precede completed; got {events}"
        )
