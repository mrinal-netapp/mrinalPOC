"""Phase 3a tests for the MAF adapter's multi-agent orchestration.

Exercises ``sequential`` and ``concurrent`` orchestration end-to-end through a
fake ``LLMGateway``: builds real AF agents, wires them into an
``agent_framework.orchestrations`` workflow, runs it, and asserts the wire
contract (final output, per-participant ``agentTrace``, aggregated usage, SSE
ordering) plus that unsupported topologies error clearly.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest

from agent_service_maf.config.validators import (
    AgentConfig,
    AgentSection,
    OrchestrationConfig,
    SelectionStrategyConfig,
    SemanticKernelSection,
    SKAgentDefinition,
)
from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.exceptions import AgentInvocationError
from agent_service_maf.core.interfaces import AgentEvent, AgentRequest, EventType, TokenUsage
from agent_service_maf.framework.maf.adapter import AgentFrameworkAdapter
from agent_service_maf.gateway.llm_gateway import LLMCompletionResponse


class _PerAgentGateway:
    """Fake gateway returning a deterministic reply keyed on the agent's model.

    Each agent in the team is configured with a distinct model string, so the
    gateway can return a recognizably different reply per participant and we can
    assert per-participant trace ordering.
    """

    def __init__(self, replies_by_model: dict[str, str]) -> None:
        self.config = type("Cfg", (), {"url": "http://bifrost.test/v1"})()
        self._replies = replies_by_model
        self.calls = 0

    def _reply_for(self, model: str | None) -> str:
        return self._replies.get(model or "", "default-reply")

    async def complete(
        self,
        messages: list[dict[str, Any]],
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> LLMCompletionResponse:
        self.calls += 1
        return LLMCompletionResponse(
            content=self._reply_for(model),
            tool_calls=[],
            usage=TokenUsage(
                prompt_tokens=8, completion_tokens=4, total_tokens=12, estimated_cost_usd=0.001
            ),
            model=model or "azure/gpt-4.1-mini",
        )

    async def stream_complete(
        self,
        messages: list[dict[str, Any]],
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[dict[str, Any]]:
        self.calls += 1
        # Real Bifrost emits token usage in the terminal streaming chunk; mirror
        # that so the streaming usage-capture path (usage_capture_scope) sees it,
        # matching the non-streaming ``complete`` totals above (12 tokens/call).
        yield {
            "content": self._reply_for(model),
            "tool_calls": None,
            "finish_reason": "stop",
            "usage": {
                "prompt_tokens": 8,
                "completion_tokens": 4,
                "total_tokens": 12,
                "cost": 0.001,
            },
        }


def _config(orchestration_type: str) -> AgentConfig:
    return AgentConfig(
        agent=AgentSection(framework="maf", model="azure/gpt-4.1-mini"),
        semantic_kernel=SemanticKernelSection(
            agents=[
                SKAgentDefinition(name="alpha", instructions="step 1", model="model/alpha"),
                SKAgentDefinition(name="beta", instructions="step 2", model="model/beta"),
            ],
            orchestration=OrchestrationConfig(type=orchestration_type),
        ),
    )


def _ctx(config: AgentConfig, gateway: Any) -> AgentExecutionContext:  # noqa: ANN401
    return AgentExecutionContext(config=config, gateway=gateway)  # type: ignore[arg-type]


def _request(text: str = "go") -> AgentRequest:
    return AgentRequest(agent_id="alpha", input=text)


async def _collect(stream: AsyncIterator[AgentEvent]) -> list[AgentEvent]:
    return [event async for event in stream]


@pytest.mark.asyncio
async def test_sequential_invoke_traces_each_participant() -> None:
    config = _config("sequential")
    gw = _PerAgentGateway({"model/alpha": "alpha-said-hi", "model/beta": "beta-final-answer"})
    adapter = AgentFrameworkAdapter(config)
    ctx = _ctx(config, gw)
    await adapter.initialize(ctx)

    response = await adapter.invoke(_request(), ctx)

    # Sequential output is the terminal (last) agent's response.
    assert response.output == "beta-final-answer"
    assert response.metadata["orchestration_type"] == "sequential"
    assert response.metadata["agent_names"] == ["alpha", "beta"]

    # One trace step per participant, in execution order.
    citations = response.citations
    assert citations is not None
    trace = citations.agent_trace
    assert [step.agent_name for step in trace] == ["alpha", "beta"]
    assert trace[0].output == "alpha-said-hi"
    assert trace[1].output == "beta-final-answer"

    # Usage is aggregated across both participants (2 agents x 12 tokens).
    assert response.usage is not None
    assert response.usage.total_tokens == 24
    assert citations.performance is not None
    assert citations.performance.llm_call_count == 2

    # The terminal agent is the responding agent.
    assert citations.responding_agent is not None
    assert citations.responding_agent.name == "beta"


@pytest.mark.asyncio
async def test_concurrent_invoke_aggregates_participants() -> None:
    config = _config("concurrent")
    gw = _PerAgentGateway({"model/alpha": "alpha-view", "model/beta": "beta-view"})
    adapter = AgentFrameworkAdapter(config)
    ctx = _ctx(config, gw)
    await adapter.initialize(ctx)

    response = await adapter.invoke(_request(), ctx)

    # Both participants contribute to the aggregated output.
    assert "alpha-view" in response.output
    assert "beta-view" in response.output
    assert response.metadata["orchestration_type"] == "concurrent"

    citations = response.citations
    assert citations is not None
    traced_agents = {step.agent_name for step in citations.agent_trace}
    assert traced_agents == {"alpha", "beta"}
    assert response.usage is not None
    assert response.usage.total_tokens == 24


@pytest.mark.asyncio
async def test_sequential_stream_emits_completed_envelope() -> None:
    config = _config("sequential")
    gw = _PerAgentGateway({"model/alpha": "alpha-said-hi", "model/beta": "beta-final-answer"})
    adapter = AgentFrameworkAdapter(config)
    ctx = _ctx(config, gw)
    await adapter.initialize(ctx)

    events = await _collect(adapter.stream(_request(), ctx))

    assert events[0].event_type == EventType.STARTED
    assert events[-1].event_type == EventType.COMPLETED

    # Per-agent lifecycle: each participant emits a started -> completed pair, in
    # execution order, so the client can show which agent is running. The agent's
    # output is NOT streamed as a per-agent TOKEN (that would mash every turn into
    # the chat body); only the lifecycle events are emitted per agent.
    started = [e.metadata["agentName"] for e in events if e.event_type == EventType.AGENT_STARTED]
    completed = [
        e.metadata["agentName"] for e in events if e.event_type == EventType.AGENT_COMPLETED
    ]
    assert started == ["alpha", "beta"]
    assert completed == ["alpha", "beta"]

    # The only TOKEN is the terminal answer (single blob) so the chat message
    # shows the final output, not a concatenation of every agent's turn.
    tokens = [e.data for e in events if e.event_type == EventType.TOKEN and e.data]
    assert tokens == ["beta-final-answer"]
    assert all(
        e.metadata.get("agentName") is None for e in events if e.event_type == EventType.TOKEN
    )

    # started/completed ordering is alpha fully before beta, each with a duration.
    lifecycle = [
        (e.event_type, e.metadata.get("agentName"))
        for e in events
        if e.event_type in (EventType.AGENT_STARTED, EventType.AGENT_COMPLETED)
    ]
    assert lifecycle == [
        (EventType.AGENT_STARTED, "alpha"),
        (EventType.AGENT_COMPLETED, "alpha"),
        (EventType.AGENT_STARTED, "beta"),
        (EventType.AGENT_COMPLETED, "beta"),
    ]
    assert all(
        isinstance(e.metadata.get("durationMs"), int)
        for e in events
        if e.event_type == EventType.AGENT_COMPLETED
    )

    # The authoritative final envelope is unchanged: terminal output + full trace.
    invoke_response = events[-1].metadata["invokeResponse"]
    assert invoke_response["output"] == "beta-final-answer"
    trace = invoke_response["citations"]["agentTrace"]
    assert [step["agentName"] for step in trace] == ["alpha", "beta"]
    assert invoke_response["usage"]["totalTokens"] == 24

    # metadata must be populated on the streaming path (same keys as sync invoke)
    assert invoke_response["metadata"]["orchestration_type"] == "sequential"
    assert invoke_response["metadata"]["agent_names"] == ["alpha", "beta"]
    assert "model" in invoke_response["metadata"]


@pytest.mark.asyncio
async def test_triage_stream_closes_out_fanned_out_specialists() -> None:
    """Every AGENT_STARTED must get an AGENT_COMPLETED before the terminal
    COMPLETED — even the specialists a triage router fans out to but does not
    route to.

    Regression: AF's HandoffBuilder emits ``executor_invoked`` (→ AGENT_STARTED)
    for every specialist, but the ones the router did not select complete with an
    empty ``executor_completed`` (``data=None``). ``_translate_orchestration_event``
    only completes turns that carry output, so those specialists used to stay in
    ``state["active"]`` forever — the client showed them spinning while the
    terminal answer streamed past. ``_stream_orchestrated_wrapper`` now drains any
    still-active agent after the workflow ends.
    """
    config = AgentConfig(
        agent=AgentSection(framework="maf", model="azure/gpt-4.1-mini"),
        semantic_kernel=SemanticKernelSection(
            agents=[
                SKAgentDefinition(name="router", instructions="route", model="model/router"),
                SKAgentDefinition(name="hello", instructions="hi", model="model/hello"),
                SKAgentDefinition(name="clock", instructions="time", model="model/clock"),
            ],
            orchestration=OrchestrationConfig(
                type="triage",
                max_rounds=3,
                selection_strategy=SelectionStrategyConfig(initial_agent="router"),
            ),
        ),
    )
    gw = _PerAgentGateway({"model/router": "routing", "model/hello": "hi", "model/clock": "time"})
    adapter = AgentFrameworkAdapter(config)
    ctx = _ctx(config, gw)
    await adapter.initialize(ctx)

    events = await _collect(adapter.stream(_request(), ctx))

    started = [e.metadata["agentName"] for e in events if e.event_type == EventType.AGENT_STARTED]
    completed = [
        e.metadata["agentName"] for e in events if e.event_type == EventType.AGENT_COMPLETED
    ]
    # Every started agent is reported complete exactly once — no stuck spinners.
    assert sorted(started) == sorted(completed)
    assert len(completed) == len(set(completed))
    assert started, "triage should report at least the router starting"

    # The terminal COMPLETED envelope is the last event, strictly after every
    # per-agent AGENT_COMPLETED (so the client resolves all spinners first).
    assert events[-1].event_type == EventType.COMPLETED
    last_agent_completed = max(
        i for i, e in enumerate(events) if e.event_type == EventType.AGENT_COMPLETED
    )
    assert last_agent_completed < len(events) - 1
    # Drained stragglers still carry a duration, like a real completion.
    assert all(
        isinstance(e.metadata.get("durationMs"), int)
        for e in events
        if e.event_type == EventType.AGENT_COMPLETED
    )


@pytest.mark.asyncio
async def test_concurrent_stream_metadata_matches_sync() -> None:
    """Streamed concurrent invoke must carry orchestration_type + agent_names in metadata.

    Regression test for the bug where ``_stream_orchestrated_wrapper`` transferred
    citations and usage from the inner ``AgentResponse`` into the builder but silently
    dropped ``response.metadata``, leaving ``invokeResponse.metadata == {}``.
    """
    config = _config("concurrent")
    gw = _PerAgentGateway({"model/alpha": "alpha-view", "model/beta": "beta-view"})
    adapter = AgentFrameworkAdapter(config)
    ctx = _ctx(config, gw)
    await adapter.initialize(ctx)

    events = await _collect(adapter.stream(_request(), ctx))

    assert events[0].event_type == EventType.STARTED
    assert events[-1].event_type == EventType.COMPLETED

    invoke_response = events[-1].metadata["invokeResponse"]
    assert invoke_response["metadata"]["orchestration_type"] == "concurrent"
    assert set(invoke_response["metadata"]["agent_names"]) == {"alpha", "beta"}
    assert "model" in invoke_response["metadata"]


@pytest.mark.asyncio
async def test_unknown_orchestration_type_raises() -> None:
    config = _config("teleportation")
    gw = _PerAgentGateway({})
    adapter = AgentFrameworkAdapter(config)
    ctx = _ctx(config, gw)
    await adapter.initialize(ctx)

    with pytest.raises(AgentInvocationError, match="Unknown orchestration type"):
        await adapter.invoke(_request(), ctx)


@pytest.mark.asyncio
async def test_sequential_with_single_agent_falls_back_to_single_workflow() -> None:
    """A multi-agent orchestration declared with one member runs as a trivial
    single-participant sequential workflow rather than failing the build.

    Rationale (see ``orchestration_builder.py``): teams mid-edit (e.g. a UI
    flow that picks the orchestration type before the second agent is added)
    would otherwise hit a hard error. Falling back keeps the response shape
    unchanged — output, trace, and usage still flow through the normal
    orchestration path — while behaving like the prior Agno/SK adapters.
    """
    config = AgentConfig(
        agent=AgentSection(framework="maf", model="azure/gpt-4.1-mini"),
        semantic_kernel=SemanticKernelSection(
            agents=[SKAgentDefinition(name="solo", instructions="x", model="model/alpha")],
            orchestration=OrchestrationConfig(type="sequential"),
        ),
    )
    gw = _PerAgentGateway({"model/alpha": "solo-out"})
    adapter = AgentFrameworkAdapter(config)
    ctx = _ctx(config, gw)
    await adapter.initialize(ctx)

    response = await adapter.invoke(_request(), ctx)

    # No raise — the workflow ran and the lone agent's reply is the output.
    assert response.output == "solo-out"
    # The trace still records the participant turn so downstream consumers
    # (Citations / SSE) get the same shape they would for a 2+ agent run.
    assert response.citations is not None
    assert [s.agent_name for s in response.citations.agent_trace] == ["solo"]


# ---------------------------------------------------------------------------
# Per-agent lifecycle emission (_translate_orchestration_event) -- regression
# tests for the started/completed "storm" (one pair per turn, not per output).
# ---------------------------------------------------------------------------


class _Ev:
    """Duck-typed stand-in for an agent_framework WorkflowEvent."""

    def __init__(self, type: str | None = None, executor_id: str | None = None, data: Any = None):  # noqa: A002
        self.type = type
        self.executor_id = executor_id
        self.data = data


class _Item:
    """executor_completed list item: carries an agent_response with .text."""

    def __init__(self, executor_id: str, text: str) -> None:
        self.executor_id = executor_id
        self.agent_response = type("_Resp", (), {"text": text})()


class _Out:
    """Single 'output' event payload: an object exposing .text."""

    def __init__(self, text: str) -> None:
        self.text = text


def _new_state() -> dict[str, Any]:
    return {"active": {}, "closed": set()}


def test_lifecycle_dedupes_list_completions_no_storm() -> None:
    """One executor_completed carrying many updates for the SAME agent with
    varying text (e.g. different random numbers) yields exactly ONE completed --
    not a started/completed@0ms storm."""
    adapter = AgentFrameworkAdapter(_config("sequential"))
    participants = {"gamma"}
    state = _new_state()

    started = adapter._translate_orchestration_event(
        _Ev("executor_invoked", "gamma"), participants, state
    )
    assert [e.event_type for e in started] == [EventType.AGENT_STARTED]

    list_event = _Ev("executor_completed", None, [_Item("gamma", f"num-{i}") for i in range(6)])
    completed = adapter._translate_orchestration_event(list_event, participants, state)

    assert [e.event_type for e in completed] == [EventType.AGENT_COMPLETED]
    assert completed[0].metadata["agentName"] == "gamma"


def test_lifecycle_drops_output_plus_completed_duplicate() -> None:
    """The output + executor_completed pair AF emits for one turn (even with
    differing text) collapses to a single completed."""
    adapter = AgentFrameworkAdapter(_config("sequential"))
    participants = {"gamma"}
    state = _new_state()
    translate = adapter._translate_orchestration_event

    events: list[AgentEvent] = []
    events += translate(_Ev("executor_invoked", "gamma"), participants, state)
    events += translate(
        _Ev("executor_completed", None, [_Item("gamma", "final")]), participants, state
    )
    events += translate(_Ev("output", "gamma", _Out("final-streamed-delta")), participants, state)

    kinds = [e.event_type for e in events]
    assert kinds == [EventType.AGENT_STARTED, EventType.AGENT_COMPLETED]


def test_lifecycle_reports_each_genuine_repeat_turn() -> None:
    """A real repeat turn (group_chat/handoff) -- a fresh executor_invoked --
    still emits its own started/completed pair."""
    adapter = AgentFrameworkAdapter(_config("group_chat"))
    participants = {"gamma"}
    state = _new_state()
    translate = adapter._translate_orchestration_event

    events: list[AgentEvent] = []
    events += translate(_Ev("executor_invoked", "gamma"), participants, state)
    events += translate(_Ev("output", "gamma", _Out("turn one")), participants, state)
    events += translate(_Ev("executor_invoked", "gamma"), participants, state)
    events += translate(_Ev("output", "gamma", _Out("turn two")), participants, state)

    kinds = [e.event_type for e in events]
    assert kinds == [
        EventType.AGENT_STARTED,
        EventType.AGENT_COMPLETED,
        EventType.AGENT_STARTED,
        EventType.AGENT_COMPLETED,
    ]


def test_lifecycle_synthesizes_one_pair_without_invoke() -> None:
    """An AF variant that completes with no executor_invoked gets exactly one
    synthesized started/completed pair; later duplicates are dropped."""
    adapter = AgentFrameworkAdapter(_config("group_chat"))
    participants = {"gamma"}
    state = _new_state()
    translate = adapter._translate_orchestration_event

    first = translate(_Ev("output", "gamma", _Out("value-1")), participants, state)
    assert [e.event_type for e in first] == [
        EventType.AGENT_STARTED,
        EventType.AGENT_COMPLETED,
    ]

    # Same (already-closed) turn, different text -> no second synthesized pair.
    second = translate(_Ev("output", "gamma", _Out("value-2")), participants, state)
    assert second == []


class _Update:
    """Streaming delta payload whose type name ends in 'Update', so
    ``_is_stream_update`` treats it as a per-token fragment (like AF's
    ``AgentResponseUpdate``)."""

    def __init__(self, text: str) -> None:
        self.text = text


def test_reconstruct_stream_steps_accumulates_deltas_per_turn() -> None:
    """Handoff/triage streaming: the specialist's text arrives only as
    ``AgentResponseUpdate`` deltas. ``reconstruct_stream_participant_steps``
    accumulates consecutive deltas per executor and flushes one step per turn."""
    from agent_service_maf.framework.maf.event_mapper import MafEventMapper

    events = [
        _Ev("output", "Router", _Update("")),  # router routes; no visible text
        _Ev("executor_completed", "Router", None),
        _Ev("output", "alpha", _Update("alpha-")),  # specialist streams in parts
        _Ev("output", "alpha", _Update("answer")),
        _Ev("executor_completed", "alpha", None),
    ]
    steps = MafEventMapper.reconstruct_stream_participant_steps(events, {"Router", "alpha", "beta"})
    assert steps == [("alpha", "", "alpha-answer")]


def test_reconstruct_stream_steps_filters_non_participants() -> None:
    """Deltas from executors outside ``participant_names`` are ignored."""
    from agent_service_maf.framework.maf.event_mapper import MafEventMapper

    events = [
        _Ev("output", "aggregator", _Update("noise")),
        _Ev("executor_completed", "aggregator", None),
        _Ev("output", "alpha", _Update("real")),
        _Ev("executor_completed", "alpha", None),
    ]
    steps = MafEventMapper.reconstruct_stream_participant_steps(events, {"alpha"})
    assert steps == [("alpha", "", "real")]


@pytest.mark.asyncio
async def test_single_agent_stream_emits_no_agent_lifecycle() -> None:
    """A single agent (orchestration.type == 'single') never emits AGENT_STARTED
    / AGENT_COMPLETED -- so the storm fix and lifecycle changes cannot affect the
    single-agent experience."""
    config = AgentConfig(
        agent=AgentSection(framework="maf", model="azure/gpt-4.1-mini"),
        semantic_kernel=SemanticKernelSection(
            agents=[SKAgentDefinition(name="solo", instructions="answer", model="model/alpha")],
            orchestration=OrchestrationConfig(type="single"),
        ),
    )
    gw = _PerAgentGateway({"model/alpha": "solo-answer"})
    adapter = AgentFrameworkAdapter(config)
    ctx = _ctx(config, gw)
    await adapter.initialize(ctx)

    events = await _collect(adapter.stream(_request(), ctx))

    assert not any(
        e.event_type in (EventType.AGENT_STARTED, EventType.AGENT_COMPLETED) for e in events
    )
    tokens = "".join(e.data for e in events if e.event_type == EventType.TOKEN and e.data)
    assert "solo-answer" in tokens


class _StreamingChunksGateway:
    """Fake gateway whose ``stream_complete`` emits many token deltas.

    Mirrors a model (e.g. gpt-5.x) that streams token-by-token: AF surfaces one
    ``output`` event per delta (an ``AgentRunResponseUpdate``) plus a terminal
    ``executor_completed`` with the assembled response. Regression guard for the
    bug where each delta became its own agentTrace step / agent_completed and the
    final output was the last token fragment.
    """

    def __init__(self, chunks: list[str]) -> None:
        self.config = type("Cfg", (), {"url": "http://bifrost.test/v1"})()
        self._chunks = chunks

    async def complete(
        self, messages: list[dict[str, Any]], model: str | None = None, **kwargs: Any
    ) -> LLMCompletionResponse:
        return LLMCompletionResponse(
            content="".join(self._chunks),
            tool_calls=[],
            usage=TokenUsage(
                prompt_tokens=8, completion_tokens=4, total_tokens=12, estimated_cost_usd=0.001
            ),
            model=model or "azure/gpt-4.1-mini",
        )

    async def stream_complete(
        self, messages: list[dict[str, Any]], model: str | None = None, **kwargs: Any
    ) -> AsyncIterator[dict[str, Any]]:
        for chunk in self._chunks:
            yield {"content": chunk, "tool_calls": None, "finish_reason": None}
        yield {
            "content": "",
            "tool_calls": None,
            "finish_reason": "stop",
            "usage": {
                "prompt_tokens": 8,
                "completion_tokens": 4,
                "total_tokens": 12,
                "cost": 0.001,
            },
        }


@pytest.mark.asyncio
async def test_streaming_token_deltas_do_not_pollute_trace_or_output() -> None:
    """A token-streaming agent must yield ONE trace step + the assembled answer.

    Regression: per-token ``output`` deltas were each recorded as a trace step
    and the final output was the last fragment (a lone ```` ``` ````). The trace,
    final output, and per-agent lifecycle must reflect the whole turn, not deltas.
    """
    config = AgentConfig(
        agent=AgentSection(framework="maf", model="azure/gpt-4.1-mini"),
        semantic_kernel=SemanticKernelSection(
            agents=[SKAgentDefinition(name="jsonbot", instructions="json", model="model/x")],
            orchestration=OrchestrationConfig(type="sequential"),
        ),
    )
    chunks = ["```", "json", "\n", "{", ' "id": ', '"731"', " }\n", "```"]
    full = "".join(chunks)
    adapter = AgentFrameworkAdapter(config)
    ctx = _ctx(config, _StreamingChunksGateway(chunks))
    await adapter.initialize(ctx)

    events = await _collect(adapter.stream(_request(), ctx))

    # Exactly one started/completed pair — deltas do not each fire a lifecycle.
    started = [e.metadata["agentName"] for e in events if e.event_type == EventType.AGENT_STARTED]
    completed = [
        e.metadata["agentName"] for e in events if e.event_type == EventType.AGENT_COMPLETED
    ]
    assert started == ["jsonbot"]
    assert completed == ["jsonbot"]

    invoke_response = events[-1].metadata["invokeResponse"]
    # Final output is the assembled answer, not the last token fragment.
    assert invoke_response["output"] == full
    # Trace has ONE step carrying the full turn output — no per-token steps.
    trace = invoke_response["citations"]["agentTrace"]
    assert len(trace) == 1
    assert trace[0]["agentName"] == "jsonbot"
    assert trace[0]["output"] == full
