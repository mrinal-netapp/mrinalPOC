"""§G3 — Four-payload parity scenario for an SK-shaped adapter.

The migration plan's §G3 mandates **one** end-to-end scenario that runs
the same input through every external surface and proves the assembled
``InvokeResponse`` envelope is byte-equivalent across:

1. **SSE stream** — the ``completed.metadata.invokeResponse`` blob
   reassembled from the SSE wire (§5.4.4 / §B1).
2. **REST sync** — ``POST /agents/{aid}/invoke``.
3. **REST async** — ``POST /agents/{aid}/invoke/async`` + polling
   ``GET /tasks/{tid}`` until terminal (§5.5.4 ``result`` is a full
   ``InvokeResponse``).
4. **Session persistence** — ``GET /sessions/{sid}`` past assistant
   message's ``metadata.citations`` / ``metadata.toolCalls`` /
   ``metadata.usage`` block (§5.6.4 / §B9).

The SK adapter is the production target, but standing up the full SK
runtime in a fast in-process suite is heavy. Instead this test
registers a *production-shape* adapter (``ParityAdapter``) that
faithfully implements the §B1 / §B9 contract:

* ``invoke()`` returns a deterministic ``AgentResponse`` carrying the
  unified ``Citations`` envelope (responding agent + agent trace +
  KB citations + tool execution).
* ``stream()`` emits the exact §5.4 wire vocabulary
  ``started → thinking → token*N → completed`` with
  ``completed.metadata.invokeResponse`` populated by ``ResponseBuilder``.
* Both paths write the user + assistant ``ConversationMessage`` to
  the team's :class:`SessionManager` BEFORE the route layer enriches
  the assistant message with the full
  :class:`AssistantMessageMetadata` block.

This mirrors what ``framework/semantic_kernel/adapter.py`` already
does at lines ~1070 and ~1374 (sync + stream session writes). The
deep SK orchestration code paths (group_chat / handoff / magentic
/ skip_post_tool_synthesis) are covered by
``tests/integration/test_orchestration_e2e.py`` — this G3 test pins
the *cross-channel envelope contract*, which is framework-agnostic.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.interfaces import (
    AgentCapabilities,
    AgentCitationSource,
    AgentEvent,
    AgentRequest,
    AgentResponse,
    AgentTraceStep,
    Citations,
    EventType,
    PerformanceBreakdown,
    TokenUsage,
    ToolExecution,
)
from agent_service_maf.core.session import ConversationMessage
from agent_service_maf.framework.base_agent import BaseAgent
from agent_service_maf.framework.registry import FrameworkRegistry
from agent_service_maf.framework.response_builder import ResponseBuilder
from tests.conftest import TEST_PROJECT_ID, TEST_PROJECT_PREFIX

PARITY_FRAMEWORK = "parity_sk"
PARITY_AGENT_ID = "parity"
TEAM_ID = "parity_team"
USER_ID = "parity-user"

# Pinned timestamp so the citations envelope is byte-deterministic across
# the four channels (sync / SSE / async / persisted session). The
# AgentTraceStep otherwise defaults to ``datetime.now()`` which would
# differ per call.
from datetime import UTC as _UTC
from datetime import datetime as _datetime  # noqa: E402

_PARITY_TS = _datetime(2026, 5, 19, 12, 0, 0, tzinfo=_UTC)


# ---------------------------------------------------------------------------
# Production-shape test adapter
# ---------------------------------------------------------------------------


class ParityAdapter(BaseAgent):
    """SK-shape adapter that emits the full §B1 / §B9 envelope.

    Why duplicate behaviour that's already in EchoAgent / SK adapter?
    The migrated EchoAgent (see ``framework/echo_adapter.py``) skips
    the session write step. The SK adapter writes sessions but
    pulling its full machinery requires LLM gateway + SK orchestration
    + plugin registry — too heavy for a fast in-process E2E. This
    minimal adapter faithfully implements the *contract* both paths
    are supposed to honor:

    * a fully-populated :class:`Citations` envelope on ``invoke()``,
    * a streaming sequence whose ``completed.metadata.invokeResponse``
      is byte-equal to ``invoke().to_response_dict()`` for the same
      input,
    * user + bare-assistant :class:`ConversationMessage` writes to
      the shared :class:`SessionManager`.
    """

    def _build_citations(self) -> Citations:
        return Citations(
            responding_agent=AgentCitationSource(
                name=PARITY_AGENT_ID,
                model="azure/gpt-4.1-mini",
                temperature=0.0,
                framework=PARITY_FRAMEWORK,
                instructions_preview="Be brief.",
            ),
            agent_trace=[
                AgentTraceStep(
                    step_index=0,
                    agent_name=PARITY_AGENT_ID,
                    action="respond",
                    output="Parity output v1",
                    duration_ms=5,
                    tool_executions=[
                        ToolExecution(
                            tool_name="calculator",
                            tool_call_id="call_parity_001",
                            arguments={"expression": "2+2"},
                            result_summary="4",
                            duration_ms=2,
                            error=None,
                        ),
                    ],
                    # Pin the timestamp so the citations envelope is
                    # byte-deterministic across the four channels.
                    timestamp=_PARITY_TS,
                ),
            ],
            performance=PerformanceBreakdown(
                total_duration_ms=10,
                llm_duration_ms=5,
                tool_duration_ms=2,
                framework_overhead_ms=3,
                llm_call_count=1,
            ),
            kb_citations=[],
        )

    def _build_response(self, request: AgentRequest) -> AgentResponse:
        return AgentResponse(
            agent_id=PARITY_AGENT_ID,
            output="Parity output v1",
            usage=TokenUsage(
                prompt_tokens=10,
                completion_tokens=5,
                total_tokens=15,
                estimated_cost_usd=0.0,
            ),
            metadata={"framework": PARITY_FRAMEWORK},
            citations=self._build_citations(),
            session_id=request.session_id,
            duration_ms=0,
        )

    async def _write_session(
        self,
        context: AgentExecutionContext,
        request: AgentRequest,
        output: str,
    ) -> None:
        sm = getattr(context, "session_manager", None)
        if sm is None or not request.session_id:
            return
        await sm.append_message(
            request.session_id,
            ConversationMessage(role="user", content=request.input),
        )
        await sm.append_message(
            request.session_id,
            ConversationMessage(role="assistant", content=output),
        )

    async def invoke(
        self,
        request: AgentRequest,
        context: AgentExecutionContext,
    ) -> AgentResponse:
        response = self._build_response(request)
        await self._write_session(context, request, response.output)
        return response

    async def stream(
        self,
        request: AgentRequest,
        context: AgentExecutionContext,
    ) -> AsyncIterator[AgentEvent]:
        response = self._build_response(request)

        builder = ResponseBuilder(
            agent_id=PARITY_AGENT_ID,
            session_id=request.session_id,
            framework=PARITY_FRAMEWORK,
        )
        builder.set_citations(response.citations)
        # ResponseBuilder.finalize() returns InvokeResponse whose
        # ``usage`` is a free-form dict -- Pydantic does NOT re-alias
        # dict contents, so we MUST pass camelCase keys here so the
        # SSE wire shape matches REST sync's `from_agent_response`
        # path (which also dumps with by_alias=True).
        builder.set_usage(response.usage.model_dump(by_alias=True))
        builder.merge_metadata(response.metadata)

        yield AgentEvent(
            event_type=EventType.STARTED,
            metadata={"agentId": PARITY_AGENT_ID, "framework": PARITY_FRAMEWORK},
        )
        yield AgentEvent(
            event_type=EventType.THINKING,
            data="Processing...",
            metadata={"agentId": PARITY_AGENT_ID},
        )

        for chunk in response.output.split(" "):
            chunk_with_space = chunk if chunk == response.output.split(" ")[0] else f" {chunk}"
            builder.add_token(chunk_with_space)
            yield AgentEvent(
                event_type=EventType.TOKEN,
                data=chunk_with_space,
                metadata={"agentId": PARITY_AGENT_ID},
            )

        await self._write_session(context, request, response.output)

        # ``mode='json'`` serializes datetime objects (used by the
        # AgentTraceStep timestamps) as ISO-8601 strings so the SSE
        # ``json.dumps`` step in ``sse_handler._format_event`` does
        # not TypeError on the raw datetime objects.
        invoke_response = builder.finalize().model_dump(by_alias=True, mode="json")
        yield AgentEvent(
            event_type=EventType.COMPLETED,
            metadata={"invokeResponse": invoke_response},
        )

    def get_capabilities(self) -> AgentCapabilities:
        return AgentCapabilities(
            agent_id=PARITY_AGENT_ID,
            framework=PARITY_FRAMEWORK,
            supports_streaming=True,
            description="SK-shape parity adapter for §G3 cross-channel tests.",
        )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _team_config_with_memory() -> dict[str, Any]:
    """Single-team config with memory enabled so /sessions/{sid} works."""
    return {
        "_schema_version": "2.0.0",
        "project_id": TEST_PROJECT_ID,
        "_team_id": TEAM_ID,
        "_team_name": "Parity Team",
        "_description": "G3 four-payload parity scenario",
        "agent": {
            "framework": PARITY_FRAMEWORK,
            "model": "azure/gpt-4.1-mini",
            "temperature": 0.0,
            "max_tokens": 64,
            "timeout_seconds": 30,
            "metadata": {
                "project": "g3",
                "version": "0.0.0",
                "environment": "test",
            },
        },
        "semantic_kernel": {
            "agents": [
                {
                    "name": PARITY_AGENT_ID,
                    "instructions": "Be brief.",
                    "description": "parity",
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
def parity_client(tmp_path: Path) -> Iterator[TestClient]:
    """Boot FastAPI with the ParityAdapter registered and memory enabled."""
    import os

    teams_dir = tmp_path / "teams"
    teams_dir.mkdir()
    (teams_dir / f"{TEAM_ID}.json").write_text(json.dumps(_team_config_with_memory()))

    os.environ["AGENT_TEAMS_DIR"] = str(teams_dir)
    os.environ.pop("AGENT_CONFIG_PATH", None)

    # The framework registry is a class-level dict, so registering once
    # here persists across tests. Re-registering the same class is
    # idempotent (the registry warns about an overwrite of an identical
    # class, which is harmless).
    FrameworkRegistry.register(PARITY_FRAMEWORK)(ParityAdapter)

    from agent_service_maf.interface_layer.api import create_app

    app = create_app()
    with TestClient(app) as client:
        yield client
    os.environ.pop("AGENT_TEAMS_DIR", None)


# ---------------------------------------------------------------------------
# SSE parser (shared with §G2 SSE parity tests)
# ---------------------------------------------------------------------------


def _parse_sse(body: str) -> list[dict[str, Any]]:
    """Split a raw SSE body into ``[{event, data}]`` records."""
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


def _strip_volatile_fields(envelope: dict[str, Any]) -> dict[str, Any]:
    """Drop fields that legitimately differ between channels.

    * ``durationMs`` — wall-clock, varies per run.
    * ``traceId`` — request-scoped uuid, intentionally different per call.
    * ``sessionId`` — server-minted per request when the caller supplies none,
      so independent invokes legitimately differ here.
    * ``performance.*Ms`` — wall-clock subfields.
    """
    envelope = dict(envelope)
    envelope.pop("durationMs", None)
    envelope.pop("traceId", None)
    envelope.pop("sessionId", None)
    citations = envelope.get("citations")
    if isinstance(citations, dict):
        citations = dict(citations)
        perf = citations.get("performance")
        if isinstance(perf, dict):
            perf = {
                k: v
                for k, v in perf.items()
                if not k.endswith("DurationMs") and not k.endswith("OverheadMs")
            }
            citations["performance"] = perf
        envelope["citations"] = citations
    return envelope


# ---------------------------------------------------------------------------
# §G3 — Four-payload parity scenario
# ---------------------------------------------------------------------------


PARITY_INPUT = "Run the parity scenario"
SESSION_ID = "g3-session"


def _invoke_sync(client: TestClient, *, session_id: str | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"input": PARITY_INPUT}
    if session_id is not None:
        payload["session_id"] = session_id
    r = client.post(
        f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/invoke",
        headers={"X-User-ID": USER_ID},
        json=payload,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _invoke_stream(client: TestClient, *, session_id: str | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"input": PARITY_INPUT}
    if session_id is not None:
        payload["session_id"] = session_id
    r = client.post(
        f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/invoke/stream",
        headers={"X-User-ID": USER_ID},
        json=payload,
    )
    assert r.status_code == 200, r.text
    records = _parse_sse(r.text)
    completed = [rec for rec in records if rec["event"] == "completed"]
    assert completed, f"No completed event. Records: {records}"
    payload_dict = completed[-1]["data"]
    assert isinstance(payload_dict, dict)
    envelope = payload_dict.get("metadata", {}).get("invokeResponse")
    assert isinstance(envelope, dict), (
        f"completed event must carry metadata.invokeResponse (§5.4.4 / §B1). Got: {payload_dict!r}"
    )
    return envelope


def _invoke_async(client: TestClient, *, session_id: str | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"input": PARITY_INPUT}
    if session_id is not None:
        payload["session_id"] = session_id
    r = client.post(
        f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/invoke/async",
        headers={"X-User-ID": USER_ID},
        json=payload,
    )
    assert r.status_code == 202, r.text
    task_id = r.json()["taskId"]

    deadline = time.monotonic() + 10.0
    last_body: dict[str, Any] | None = None
    while time.monotonic() < deadline:
        poll = client.get(
            f"{TEST_PROJECT_PREFIX}/tasks/{task_id}",
            headers={"X-User-ID": USER_ID},
        )
        assert poll.status_code == 200, poll.text
        body = poll.json()
        last_body = body
        status = body["status"]
        if status in ("completed", "failed", "cancelled"):
            assert status == "completed", body
            result = body.get("result")
            assert isinstance(result, dict), "§5.5.4 requires result to be a typed InvokeResponse"
            return result
        time.sleep(0.05)
    pytest.fail(f"Async task {task_id} did not terminate in 10s. Last poll body: {last_body!r}")


def _session_assistant_metadata(
    client: TestClient,
    *,
    session_id: str,
) -> dict[str, Any]:
    r = client.get(
        f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/sessions/{session_id}",
        headers={"X-User-ID": USER_ID},
    )
    assert r.status_code == 200, r.text
    detail = r.json()
    assistant_msgs = [m for m in detail["messages"] if m["role"] == "assistant"]
    assert assistant_msgs, f"No assistant messages persisted: {detail}"
    metadata = assistant_msgs[-1].get("metadata")
    assert isinstance(metadata, dict), (
        f"Assistant message must carry typed metadata (§B9). Got: {assistant_msgs[-1]!r}"
    )
    return metadata


@pytest.mark.e2e
class TestSkParityScenario:
    """§G3 — Four-payload byte-equivalence for the same input.

    Acceptance criteria from §G3:
      "Assert the four payloads are byte-equivalent for the same turn."

    The wall-clock fields (``durationMs``, ``traceId``, performance
    sub-timings) are stripped via ``_strip_volatile_fields`` since the
    plan acknowledges those as legitimately per-request — what must be
    byte-equal is the *content*: ``output``, ``citations``, ``usage``,
    ``parsedOutput``, ``memoryDegraded``.
    """

    def test_sync_invoke_envelope_shape(self, parity_client: TestClient) -> None:
        """REST sync invoke returns the §A2 InvokeResponse envelope."""
        envelope = _invoke_sync(parity_client)
        assert envelope["agentId"] == PARITY_AGENT_ID
        assert envelope["output"] == "Parity output v1"
        assert isinstance(envelope["citations"], dict)
        assert envelope["citations"]["respondingAgent"]["name"] == PARITY_AGENT_ID
        assert isinstance(envelope["usage"], dict)
        assert envelope["usage"]["totalTokens"] == 15

    def test_sse_completed_envelope_matches_sync(
        self,
        parity_client: TestClient,
    ) -> None:
        """§B1 -- SSE completed.metadata.invokeResponse equals REST sync envelope."""
        sync = _invoke_sync(parity_client)
        sse = _invoke_stream(parity_client)
        assert _strip_volatile_fields(sse) == _strip_volatile_fields(sync), (
            "SSE completed envelope must match REST sync envelope "
            "(after stripping wall-clock fields)"
        )

    def test_async_result_envelope_matches_sync(
        self,
        parity_client: TestClient,
    ) -> None:
        """§5.5.4 -- task.result is the full InvokeResponse, equal to sync."""
        sync = _invoke_sync(parity_client)
        asyn = _invoke_async(parity_client)
        assert _strip_volatile_fields(asyn) == _strip_volatile_fields(sync), (
            "Async task.result must equal REST sync envelope (after stripping wall-clock fields)"
        )

    def test_persisted_session_metadata_matches_live(
        self,
        parity_client: TestClient,
    ) -> None:
        """§B9 -- past assistant message's metadata block equals the live response.

        Concretely, the persisted ``metadata.citations`` /
        ``metadata.toolCalls`` / ``metadata.usage`` must equal the
        live ``InvokeResponse``'s same fields for the same turn.
        """
        envelope = _invoke_sync(parity_client, session_id=SESSION_ID)
        metadata = _session_assistant_metadata(parity_client, session_id=SESSION_ID)

        # Persisted citations equal live citations (§B9 acceptance).
        assert metadata["citations"] == envelope["citations"], (
            "Persisted assistant message must carry the same citations "
            "envelope as the live InvokeResponse for the same turn."
        )
        # Persisted usage equals live usage.
        assert metadata["usage"] == envelope["usage"]
        # Persisted toolCalls equals the denormalized tool executions
        # across the agentTrace (§B9 "toolCalls[] per past turn").
        denormalized: list[Any] = []
        for step in envelope["citations"]["agentTrace"]:
            denormalized.extend(step.get("toolExecutions", []) or [])
        assert metadata["toolCalls"] == denormalized, (
            "Persisted toolCalls must equal denormalized agentTrace tools."
        )
        # memory_degraded flag round-trips as false (no errors injected).
        assert metadata["memoryDegraded"] is False

    def test_four_channel_parity(self, parity_client: TestClient) -> None:
        """The hero assertion -- the four payloads are byte-equivalent.

        Runs all four channels on the same input + session and asserts
        their normalized envelopes match.
        """
        session_id = f"{SESSION_ID}-hero"
        sync = _invoke_sync(parity_client, session_id=session_id)
        sse = _invoke_stream(parity_client, session_id=session_id)
        asyn = _invoke_async(parity_client, session_id=session_id)
        metadata = _session_assistant_metadata(parity_client, session_id=session_id)

        sync_n = _strip_volatile_fields(sync)
        sse_n = _strip_volatile_fields(sse)
        asyn_n = _strip_volatile_fields(asyn)
        assert sync_n == sse_n == asyn_n, (
            "SSE / REST sync / REST async envelopes must agree on the "
            "stable fields (output, citations, usage, parsedOutput, "
            "memoryDegraded). Diffs:\n"
            f"  sync vs sse:   {set(sync_n.items()) ^ set(sse_n.items())}\n"
            f"  sync vs async: {set(sync_n.items()) ^ set(asyn_n.items())}"
        )

        # Session detail's persisted metadata is a *subset* of the live
        # envelope (it doesn't store agentId / output / parsedOutput
        # since those live on the ConversationMessage itself), but
        # the parts it does store (citations, usage, toolCalls,
        # memoryDegraded) must match the live envelope.
        assert metadata["citations"] == sync["citations"]
        assert metadata["usage"] == sync["usage"]
