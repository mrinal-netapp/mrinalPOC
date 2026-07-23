"""Unit tests for the production echo adapter.

Covers :mod:`agent_service_maf.framework.echo_adapter` — the
``@FrameworkRegistry.register("echo")``-decorated adapter that emits the
full §5.4 wire vocabulary (``started`` → ``thinking`` → ``token`` * N →
``completed``) and populates ``completed.metadata.invokeResponse`` via
:class:`ResponseBuilder`. Distinct from
:mod:`agent_service_maf.examples.echo_agent` (covered by
``test_echo_agent.py``), which is a minimal documentation template
without citations / token usage / response building.

These tests pin the adapter's externally-observable contract:

- ``invoke()`` returns a populated :class:`AgentResponse` (output text,
  parsed output, token usage, citations, session_id).
- ``stream()`` yields the §5.4 event sequence with the same
  ``invokeResponse`` shape on its terminal ``completed`` event that
  ``invoke()`` returns in REST sync — locking the three-transport
  parity guarantee.
- ``_resolve_request_output_schema`` honors both snake_case
  (``output_schema``) and camelCase (``outputSchema``) keys, and
  rejects non-dict values.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest

from agent_service_maf.config.validators import AgentConfig
from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.interfaces import (
    AgentEvent,
    AgentRequest,
    EventType,
)
from agent_service_maf.framework.echo_adapter import (
    EchoAgent,
    _resolve_request_output_schema,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _ctx() -> AgentExecutionContext:
    return AgentExecutionContext(config=AgentConfig())


def _req(
    input_text: str = "hello world",
    *,
    context: dict | None = None,
    session_id: str | None = None,
) -> AgentRequest:
    return AgentRequest(
        agent_id="echo",
        input=input_text,
        context=context or {},
        session_id=session_id,
    )


async def _collect(stream: AsyncIterator[AgentEvent]) -> list[AgentEvent]:
    return [event async for event in stream]


# ---------------------------------------------------------------------------
# _resolve_request_output_schema
# ---------------------------------------------------------------------------


class TestResolveRequestOutputSchema:
    """Per-request override resolution. Echo has no agent-level config,
    so this helper is the only place schemas can come from."""

    def test_no_context_returns_none(self) -> None:
        assert _resolve_request_output_schema(_req()) is None

    def test_snake_case_key_wins(self) -> None:
        schema = {"type": "object", "properties": {"x": {"type": "integer"}}}
        out = _resolve_request_output_schema(_req(context={"output_schema": schema}))
        assert out is schema

    def test_camel_case_key_also_supported(self) -> None:
        # Wire convention is camelCase; the adapter checks both forms so
        # snake_case configs and camelCase request bodies both work.
        schema = {"type": "object"}
        out = _resolve_request_output_schema(_req(context={"outputSchema": schema}))
        assert out is schema

    def test_snake_case_takes_precedence_over_camel(self) -> None:
        snake = {"type": "object", "_form": "snake"}
        camel = {"type": "object", "_form": "camel"}
        out = _resolve_request_output_schema(
            _req(context={"output_schema": snake, "outputSchema": camel})
        )
        assert out is snake

    def test_non_dict_schema_is_rejected(self) -> None:
        # A stray string / list / number sneaking into the field must
        # not become a "schema" — the helper returns None so downstream
        # extract_parsed_output sees the no-schema path.
        assert _resolve_request_output_schema(_req(context={"output_schema": "x"})) is None
        assert _resolve_request_output_schema(_req(context={"output_schema": [1, 2]})) is None
        assert _resolve_request_output_schema(_req(context={"output_schema": 42})) is None


# ---------------------------------------------------------------------------
# EchoAgent.invoke
# ---------------------------------------------------------------------------


class TestEchoAgentInvoke:
    """Synchronous invocation path. Locks the AgentResponse shape that
    REST /invoke returns for the echo adapter."""

    @pytest.mark.asyncio
    async def test_output_is_prefixed_input(self) -> None:
        agent = EchoAgent(config={})
        resp = await agent.invoke(_req("hello world"), _ctx())
        assert resp.output == "Echo: hello world"

    @pytest.mark.asyncio
    async def test_agent_id_propagates_from_request(self) -> None:
        agent = EchoAgent(config={})
        req = _req()
        resp = await agent.invoke(req, _ctx())
        assert resp.agent_id == req.agent_id

    @pytest.mark.asyncio
    async def test_session_id_propagates_to_response(self) -> None:
        agent = EchoAgent(config={})
        resp = await agent.invoke(_req(session_id="sess-001"), _ctx())
        assert resp.session_id == "sess-001"

    @pytest.mark.asyncio
    async def test_usage_token_counts_match_word_count(self) -> None:
        # Echo's "token" model is one prompt token per word and one
        # completion token per word; the sentinel cost is zero.
        agent = EchoAgent(config={})
        resp = await agent.invoke(_req("one two three"), _ctx())
        assert resp.usage is not None
        assert resp.usage.prompt_tokens == 3
        assert resp.usage.completion_tokens == 3
        assert resp.usage.total_tokens == 6
        assert resp.usage.estimated_cost_usd == 0.0

    @pytest.mark.asyncio
    async def test_usage_for_empty_input(self) -> None:
        # ``"".split()`` returns ``[]`` — usage counts must be zero,
        # not a NoneType error.
        agent = EchoAgent(config={})
        resp = await agent.invoke(_req(""), _ctx())
        assert resp.usage is not None
        assert resp.usage.prompt_tokens == 0
        assert resp.usage.completion_tokens == 0
        assert resp.usage.total_tokens == 0

    @pytest.mark.asyncio
    async def test_metadata_marks_framework_as_echo(self) -> None:
        agent = EchoAgent(config={})
        resp = await agent.invoke(_req(), _ctx())
        assert resp.metadata.get("framework") == "echo"

    @pytest.mark.asyncio
    async def test_citations_responding_agent_is_set(self) -> None:
        # Echo populates the responding-agent citation so the §5.3.4
        # citation pipeline has a non-null source even with no tool calls.
        agent = EchoAgent(config={})
        req = _req()
        resp = await agent.invoke(req, _ctx())
        assert resp.citations is not None
        assert resp.citations.responding_agent is not None
        assert resp.citations.responding_agent.name == req.agent_id
        assert resp.citations.responding_agent.framework == "echo"
        assert resp.citations.responding_agent.model == "echo"

    @pytest.mark.asyncio
    async def test_parsed_output_none_when_no_schema(self) -> None:
        # Without an output schema and with expect_json=False, the
        # extractor returns None and the raw text stays on .output.
        agent = EchoAgent(config={})
        resp = await agent.invoke(_req("plain text"), _ctx())
        assert resp.parsed_output is None
        assert resp.output == "Echo: plain text"


# ---------------------------------------------------------------------------
# EchoAgent.stream
# ---------------------------------------------------------------------------


class TestEchoAgentStream:
    """Streaming path. Locks the §5.4 event sequence and the
    invokeResponse parity with ``invoke()``."""

    @pytest.mark.asyncio
    async def test_event_sequence_for_multi_word_input(self) -> None:
        # Multi-word input exercises the loop body (branch line 152 →
        # 153): prefix + N TOKEN events, one per word.
        agent = EchoAgent(config={})
        events = await _collect(agent.stream(_req("one two three"), _ctx()))

        event_types = [e.event_type for e in events]
        assert event_types == [
            EventType.STARTED,
            EventType.THINKING,
            EventType.TOKEN,  # prefix "Echo: "
            EventType.TOKEN,  # "one"
            EventType.TOKEN,  # " two"
            EventType.TOKEN,  # " three"
            EventType.COMPLETED,
        ]

    @pytest.mark.asyncio
    async def test_event_sequence_for_empty_input(self) -> None:
        # Empty input exercises the loop's zero-iterations exit (branch
        # line 152 → 161): the prefix TOKEN is still emitted, then the
        # generator falls through to COMPLETED without per-word tokens.
        agent = EchoAgent(config={})
        events = await _collect(agent.stream(_req(""), _ctx()))

        event_types = [e.event_type for e in events]
        assert event_types == [
            EventType.STARTED,
            EventType.THINKING,
            EventType.TOKEN,  # only the prefix
            EventType.COMPLETED,
        ]

    @pytest.mark.asyncio
    async def test_started_event_metadata(self) -> None:
        agent = EchoAgent(config={})
        events = await _collect(agent.stream(_req(), _ctx()))
        started = events[0]
        assert started.metadata == {"agentId": "echo", "framework": "echo"}

    @pytest.mark.asyncio
    async def test_thinking_event_carries_progress_text(self) -> None:
        agent = EchoAgent(config={})
        events = await _collect(agent.stream(_req(), _ctx()))
        thinking = events[1]
        assert thinking.event_type == EventType.THINKING
        assert thinking.data == "Processing..."
        assert thinking.metadata == {"agentId": "echo"}

    @pytest.mark.asyncio
    async def test_token_payloads_concatenate_to_output(self) -> None:
        # Re-assembling the TOKEN events in order must reproduce the
        # same ``output`` text that ``invoke()`` returns.
        agent = EchoAgent(config={})
        events = await _collect(agent.stream(_req("one two three"), _ctx()))
        token_data = [e.data for e in events if e.event_type == EventType.TOKEN]
        assert "".join(token_data) == "Echo: one two three"

    @pytest.mark.asyncio
    async def test_first_word_has_no_leading_space(self) -> None:
        # Per the adapter logic, the first word's TOKEN payload is the
        # bare word; subsequent words are " word". This is what keeps
        # the reassembled output's spacing correct.
        agent = EchoAgent(config={})
        events = await _collect(agent.stream(_req("alpha beta"), _ctx()))
        tokens = [e.data for e in events if e.event_type == EventType.TOKEN]
        # tokens = ["Echo: ", "alpha", " beta"]
        assert tokens == ["Echo: ", "alpha", " beta"]

    @pytest.mark.asyncio
    async def test_completed_event_carries_invoke_response(self) -> None:
        # The terminal COMPLETED event must carry an ``invokeResponse``
        # whose ``output`` matches the assembled tokens — three-transport
        # parity per §5.4.4.
        agent = EchoAgent(config={})
        events = await _collect(agent.stream(_req("hello world"), _ctx()))
        completed = events[-1]
        assert completed.event_type == EventType.COMPLETED
        invoke_response = completed.metadata.get("invokeResponse")
        assert invoke_response is not None
        # ResponseBuilder dumps with by_alias=True so keys are camelCase.
        assert invoke_response["output"] == "Echo: hello world"

    @pytest.mark.asyncio
    async def test_completed_event_usage_matches_word_count(self) -> None:
        # ResponseBuilder receives the same usage payload invoke() builds;
        # the camelCase dump shows up under "usage" on the invokeResponse.
        agent = EchoAgent(config={})
        events = await _collect(agent.stream(_req("one two"), _ctx()))
        invoke_response = events[-1].metadata["invokeResponse"]
        usage = invoke_response.get("usage")
        assert usage is not None
        # Wire field is "promptTokens" via CamelCaseModel
        assert usage["promptTokens"] == 2
        assert usage["completionTokens"] == 2
        assert usage["totalTokens"] == 4


# ---------------------------------------------------------------------------
# EchoAgent.get_capabilities
# ---------------------------------------------------------------------------


class TestEchoAgentCapabilities:
    """``get_capabilities()`` must work before ``initialize()`` is called
    and must declare the framework identifier the registry uses."""

    def test_capabilities_are_static_and_streaming_capable(self) -> None:
        agent = EchoAgent(config={})
        caps = agent.get_capabilities()
        assert caps.agent_id == "echo"
        assert caps.framework == "echo"
        assert caps.supports_streaming is True
        assert "Echo agent" in caps.description
