"""Phase 3b tests for the MAF adapter's remaining orchestration topologies.

Exercises ``graph``, ``group_chat``, ``handoff``, ``triage`` and ``magentic``
end-to-end through a fake ``LLMGateway``: builds real AF agents, wires them into
the matching ``agent_framework`` workflow, runs it, and asserts the wire contract
the adapter produces.

Where a topology's output is LLM-driven (handoff routing, magentic planning,
group-chat selection), a trivial fake gateway cannot reproduce the real decision
flow, so those tests assert the *invariants* that must hold regardless: the
workflow runs to completion within bounded rounds, produces a non-empty response,
and aggregates token usage across every participant (plus manager). The fully
deterministic topologies (graph, round-robin group chat) assert exact
per-participant traces and final output.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest

from agent_service_maf.config.validators import (
    AgentConfig,
    AgentSection,
    GraphEdge,
    HandoffDefinition,
    OrchestrationConfig,
    SelectionStrategyConfig,
    SemanticKernelSection,
    SKAgentDefinition,
    TerminationStrategyConfig,
)
from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.interfaces import AgentRequest, TokenUsage
from agent_service_maf.framework.maf.adapter import AgentFrameworkAdapter
from agent_service_maf.framework.maf.orchestration_builder import (
    _MAX_ROUNDS_CEILING,
    MafOrchestrationBuilder,
)
from agent_service_maf.gateway.llm_gateway import LLMCompletionResponse


class _PerAgentGateway:
    """Fake gateway returning a deterministic reply keyed on the agent's model."""

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
        yield {"content": self._reply_for(model), "tool_calls": None, "finish_reason": "stop"}
        # Terminal usage chunk -- mirrors Bifrost's streaming contract so the
        # streamed (graceful-timeout) path aggregates token usage too.
        yield {
            "usage": {
                "prompt_tokens": 8,
                "completion_tokens": 4,
                "total_tokens": 12,
                "cost": 0.001,
            }
        }


def _config(orchestration: OrchestrationConfig) -> AgentConfig:
    return AgentConfig(
        agent=AgentSection(framework="maf", model="azure/gpt-4.1-mini"),
        semantic_kernel=SemanticKernelSection(
            agents=[
                SKAgentDefinition(name="alpha", instructions="step 1", model="model/alpha"),
                SKAgentDefinition(name="beta", instructions="step 2", model="model/beta"),
            ],
            orchestration=orchestration,
        ),
    )


def _ctx(config: AgentConfig, gateway: Any) -> AgentExecutionContext:  # noqa: ANN401
    return AgentExecutionContext(config=config, gateway=gateway)  # type: ignore[arg-type]


def _request(text: str = "go") -> AgentRequest:
    return AgentRequest(agent_id="alpha", input=text)


async def _run(orchestration: OrchestrationConfig, gw: _PerAgentGateway) -> Any:  # noqa: ANN401
    config = _config(orchestration)
    adapter = AgentFrameworkAdapter(config)
    ctx = _ctx(config, gw)
    await adapter.initialize(ctx)
    return await adapter.invoke(_request(), ctx)


# ---------------------------------------------------------------------------
# graph -- fully deterministic
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_graph_chain_traces_each_participant() -> None:
    """A linear graph (default chain) runs alpha -> beta; beta is the terminal."""
    gw = _PerAgentGateway({"model/alpha": "alpha-step", "model/beta": "beta-final"})
    response = await _run(OrchestrationConfig(type="graph", max_rounds=4), gw)

    assert response.output == "beta-final"
    assert response.metadata["orchestration_type"] == "graph"

    citations = response.citations
    assert citations is not None
    assert [s.agent_name for s in citations.agent_trace] == ["alpha", "beta"]
    assert response.usage is not None
    assert response.usage.total_tokens == 24


@pytest.mark.asyncio
async def test_agent_trace_steps_carry_input_alongside_output() -> None:
    """Every participant trace step must record the input text that triggered
    it, mirroring the input/output pair tool executions already carry.

    AF emits an ``executor_invoked`` event with ``data=AgentExecutorRequest``
    immediately before each executor turn; ``extract_participant_steps``
    pairs that input with the executor's next ``output`` event. Without this,
    the Tracing tab can only show what each agent SAID, not what they SAW —
    the inverse of how tool I/O renders today.
    """
    gw = _PerAgentGateway({"model/alpha": "alpha-step", "model/beta": "beta-final"})
    response = await _run(OrchestrationConfig(type="graph", max_rounds=4), gw)

    citations = response.citations
    assert citations is not None
    trace = citations.agent_trace
    assert trace, "graph orchestration should emit per-participant trace steps"
    # Every step has the field present (additive, default ""), and at least
    # one step has a non-empty input — the latest message that triggered it.
    for step in trace:
        assert hasattr(step, "input")
    non_empty_inputs = [s.input for s in trace if s.input]
    assert non_empty_inputs, (
        f"expected at least one trace step to carry a non-empty input; "
        f"got inputs={[s.input for s in trace]!r}"
    )
    # The first participant's input should reflect the initial user message.
    assert "go" in trace[0].input, (
        f"first step's input should include the user prompt 'go', got {trace[0].input!r}"
    )


@pytest.mark.asyncio
async def test_graph_explicit_edges() -> None:
    """Explicit edges alpha -> beta produce the same terminal output."""
    gw = _PerAgentGateway({"model/alpha": "alpha-step", "model/beta": "beta-final"})
    orchestration = OrchestrationConfig(
        type="graph",
        max_rounds=4,
        edges=[GraphEdge(source="alpha", target="beta")],
        selection_strategy=SelectionStrategyConfig(initial_agent="alpha"),
    )
    response = await _run(orchestration, gw)

    assert response.output == "beta-final"
    assert {s.agent_name for s in response.citations.agent_trace} == {"alpha", "beta"}


# ---------------------------------------------------------------------------
# group_chat -- deterministic round-robin selection
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_group_chat_round_robin() -> None:
    """Round-robin group chat lets each participant speak within bounded rounds."""
    gw = _PerAgentGateway({"model/alpha": "alpha-view", "model/beta": "beta-view"})
    orchestration = OrchestrationConfig(type="group_chat", max_rounds=2)
    response = await _run(orchestration, gw)

    assert response.metadata["orchestration_type"] == "group_chat"
    citations = response.citations
    assert citations is not None
    traced = {s.agent_name for s in citations.agent_trace}
    assert traced == {"alpha", "beta"}
    # The last participant turn is the surfaced answer (not the orchestrator notice).
    assert response.output == "beta-view"
    assert response.usage is not None
    assert response.usage.total_tokens >= 24


# ---------------------------------------------------------------------------
# handoff / triage -- LLM-driven; assert bounded completion + usage
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_handoff_completes_within_bounds() -> None:
    gw = _PerAgentGateway({"model/alpha": "alpha-handoff", "model/beta": "beta-handoff"})
    orchestration = OrchestrationConfig(
        type="handoff",
        max_rounds=2,
        handoffs=[
            HandoffDefinition(source="alpha", target="beta", description="escalate"),
            HandoffDefinition(source="beta", target="alpha", description="return"),
        ],
    )
    response = await _run(orchestration, gw)

    assert response.metadata["orchestration_type"] == "handoff"
    assert response.output  # non-empty
    assert response.usage is not None
    assert response.usage.total_tokens > 0


@pytest.mark.asyncio
async def test_triage_routes_to_specialist() -> None:
    gw = _PerAgentGateway({"model/alpha": "router", "model/beta": "specialist-answer"})
    orchestration = OrchestrationConfig(
        type="triage",
        max_rounds=2,
        selection_strategy=SelectionStrategyConfig(initial_agent="alpha"),
    )
    response = await _run(orchestration, gw)

    assert response.metadata["orchestration_type"] == "triage"
    assert response.output
    assert response.usage is not None
    assert response.usage.total_tokens > 0


@pytest.mark.asyncio
async def test_triage_uses_manager_block_as_start_agent() -> None:
    """When ``manager_*`` is configured, the triage router is built from the
    manager block, not pulled out of the team's members. All members remain
    available as specialists the router can delegate to.
    """
    gw = _PerAgentGateway(
        {
            "model/alpha": "alpha-out",
            "model/beta": "beta-out",
            "model/mgr": "router-routing-to-alpha",
        }
    )
    orchestration = OrchestrationConfig(
        type="triage",
        max_rounds=2,
        manager_model="model/mgr",
        manager_name="Router",
        manager_instructions="Pick the best specialist for each user request.",
    )
    response = await _run(orchestration, gw)

    assert response.metadata["orchestration_type"] == "triage"
    assert response.output
    # The manager (model/mgr) must have made at least one LLM call —
    # otherwise the manager-driven path didn't apply.
    assert response.usage is not None
    assert response.usage.total_tokens > 0
    # The manager's calls land in the gateway alongside the members'.
    assert gw.calls >= 1


@pytest.mark.asyncio
async def test_triage_manager_name_with_spaces_is_sanitized() -> None:
    """A human-friendly ``manager_name`` (e.g. UI-set "Triage Agent" with a
    space) must not crash the run. It's an internal router name, so it's
    normalised to a valid agent name instead of raising ConfigurationError.

    Regression: the triage build called ``build_manager_agent(name="Triage
    Agent")`` which failed ``^[a-zA-Z0-9_-]{1,64}$`` validation, surfacing as
    "An error occurred during streaming" for the whole run.
    """
    gw = _PerAgentGateway(
        {
            "model/alpha": "alpha-out",
            "model/beta": "beta-out",
            "model/mgr": "router-routing-to-alpha",
        }
    )
    orchestration = OrchestrationConfig(
        type="triage",
        max_rounds=2,
        manager_model="model/mgr",
        manager_name="Triage Agent",  # space — previously rejected
        manager_instructions="Route to the best specialist.",
    )
    # Must not raise ConfigurationError; the run completes with output.
    response = await _run(orchestration, gw)
    assert response.metadata["orchestration_type"] == "triage"
    assert response.output


# Legacy-fallback triage (no manager block) is exercised by
# ``test_triage_routes_to_specialist`` above, which calls _run() with an
# OrchestrationConfig that has no manager_* fields set.


class _RoutingGateway:
    """Fake gateway for Option B triage: the router calls the specialist tool
    named ``<target>`` (an ``Agent.as_tool`` tool), the specialist returns plain
    text, and the router then synthesizes a final answer.

    The router is identified by having the specialist tool in its tool list;
    specialists have no such tool and just reply. This drives the real one-hop
    route: router tool-call → specialist runs → router relays.
    """

    def __init__(
        self,
        *,
        target: str,
        specialist_reply: str,
        router_final: str = "Handled by the specialist.",
    ) -> None:
        self.config = type("Cfg", (), {"url": "http://bifrost.test/v1"})()
        self._target = target
        self._specialist_reply = specialist_reply
        self._router_final = router_final
        self.calls = 0
        self._router_calls = 0

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
        usage = TokenUsage(
            prompt_tokens=10, completion_tokens=5, total_tokens=15, estimated_cost_usd=0.0
        )
        tool_names = {t.get("function", {}).get("name") for t in (tools or [])}
        # Router: has the specialist as a tool. First turn → call it; second
        # turn (after the tool result) → synthesize the final answer.
        if self._target in tool_names:
            self._router_calls += 1
            if self._router_calls == 1:
                return LLMCompletionResponse(
                    content="",
                    tool_calls=[
                        {
                            "id": "call-1",
                            "type": "function",
                            "function": {
                                "name": self._target,
                                "arguments": '{"task": "handle this"}',
                            },
                        }
                    ],
                    usage=usage,
                    model=model or "azure/test",
                )
            return LLMCompletionResponse(
                content=self._router_final, tool_calls=[], usage=usage, model=model or "azure/test"
            )
        # Specialist (no routing tool) → plain text reply.
        return LLMCompletionResponse(
            content=self._specialist_reply,
            tool_calls=[],
            usage=usage,
            model=model or "azure/test",
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
        result = await self.complete(messages, model=model, tools=tools)
        if result.tool_calls:
            yield {
                "content": "",
                "tool_calls": result.tool_calls,
                "finish_reason": "tool_calls",
            }
        else:
            yield {"content": result.content, "tool_calls": None, "finish_reason": "stop"}
        yield {
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
                "cost": 0.0,
            }
        }


@pytest.mark.asyncio
async def test_triage_routes_to_specialist_via_as_tool() -> None:
    """End-to-end (sync): the router calls the ``alpha`` specialist tool, alpha
    runs and replies, and the router synthesizes the final answer. The specialist
    appears in the trace with its own answer.

    Option B: triage is a single router agent with the members exposed as
    ``Agent.as_tool`` tools -- no HandoffBuilder, no interactive ``request_info``.
    """
    gw = _RoutingGateway(
        target="alpha",
        specialist_reply="alpha-specialist-answer",
        router_final="Alpha handled it.",
    )
    orchestration = OrchestrationConfig(
        type="triage",
        max_rounds=2,
        manager_model="model/mgr",
        manager_name="Router",
        manager_instructions="Pick the best specialist for each user request.",
    )
    response = await _run(orchestration, gw)

    assert response.metadata["orchestration_type"] == "triage"
    # The router synthesizes the final answer from the specialist's reply.
    assert response.output == "Alpha handled it."
    citations = response.citations
    assert citations is not None
    # The routed-to specialist appears in the trace, carrying its own answer.
    trace = {s.agent_name: s.output for s in citations.agent_trace}
    assert "alpha" in trace, f"specialist 'alpha' missing from trace: {list(trace)}"
    assert trace["alpha"] == "alpha-specialist-answer"
    # The router produced the terminal turn, so it is the responder.
    assert citations.responding_agent.name == "Router"


@pytest.mark.asyncio
async def test_triage_stream_reports_specialist_lifecycle() -> None:
    """Streaming triage: the specialist's per-agent lifecycle is re-sourced from
    the router's tool-call stream. Router + routed specialist each get a started
    → completed pair, the router's synthesis is the output, and COMPLETED is last.

    Option B: members run as the router's ``as_tool`` calls (not executors), so
    ``_translate_orchestration_event`` maps FunctionCall/FunctionResult content to
    AGENT_STARTED / AGENT_COMPLETED to preserve the "which agent is running" UI.
    """
    from agent_service_maf.core.interfaces import EventType

    gw = _RoutingGateway(
        target="alpha",
        specialist_reply="alpha-specialist-answer",
        router_final="Alpha handled it.",
    )
    orchestration = OrchestrationConfig(
        type="triage",
        max_rounds=2,
        manager_model="model/mgr",
        manager_name="Router",
        manager_instructions="Pick the best specialist for each user request.",
    )
    config = _config(orchestration)
    adapter = AgentFrameworkAdapter(config)
    ctx = _ctx(config, gw)
    await adapter.initialize(ctx)

    events = [e async for e in adapter.stream(_request(), ctx)]

    invoke_response = events[-1].metadata["invokeResponse"]
    assert invoke_response["output"] == "Alpha handled it."

    started = [e.metadata["agentName"] for e in events if e.event_type == EventType.AGENT_STARTED]
    completed = [
        e.metadata["agentName"] for e in events if e.event_type == EventType.AGENT_COMPLETED
    ]
    # The routed-to specialist is reported as a running agent (re-sourced from
    # the router's tool call), and every started agent completes exactly once.
    assert "alpha" in started
    assert sorted(started) == sorted(completed)
    assert len(completed) == len(set(completed))
    assert events[-1].event_type == EventType.COMPLETED


# ---------------------------------------------------------------------------
# magentic -- manager-driven; assert bounded completion + aggregated usage
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_magentic_completes_and_aggregates_manager_usage() -> None:
    gw = _PerAgentGateway(
        {
            "model/alpha": "alpha-out",
            "model/beta": "beta-out",
            "model/mgr": "manager-plan",
        }
    )
    orchestration = OrchestrationConfig(
        type="magentic",
        max_rounds=2,
        magentic_manager_model="model/mgr",
    )
    response = await _run(orchestration, gw)

    assert response.metadata["orchestration_type"] == "magentic"
    assert response.output
    # The manager (model/mgr) makes LLM calls; its usage must be aggregated.
    assert response.usage is not None
    assert response.usage.total_tokens > 0


# ---------------------------------------------------------------------------
# Termination / round-cap fidelity
# ---------------------------------------------------------------------------


def test_bounded_rounds_honors_maximum_iterations() -> None:
    """The stricter of max_rounds / termination_strategy.maximum_iterations wins."""
    bound = MafOrchestrationBuilder._bounded_rounds

    # maximum_iterations (3) is stricter than the default max_rounds (20).
    cfg = OrchestrationConfig(
        type="group_chat",
        termination_strategy=TerminationStrategyConfig(type="keyword", maximum_iterations=3),
    )
    assert bound(cfg) == 3

    # max_rounds (2) is stricter than maximum_iterations (10).
    cfg = OrchestrationConfig(
        type="group_chat",
        max_rounds=2,
        termination_strategy=TerminationStrategyConfig(maximum_iterations=10),
    )
    assert bound(cfg) == 2

    # Both large -> clamped to the hard ceiling.
    cfg = OrchestrationConfig(
        type="group_chat",
        max_rounds=1000,
        termination_strategy=TerminationStrategyConfig(maximum_iterations=1000),
    )
    assert bound(cfg) == _MAX_ROUNDS_CEILING


@pytest.mark.asyncio
async def test_group_chat_graceful_timeout_completes_within_budget() -> None:
    """``type="timeout"`` takes the graceful path; a fast run completes normally.

    The wall-clock budget (30s) is never hit by the trivial fake gateway, so the
    run finishes with ``terminated_by="completed"`` -- the timeout machinery is
    exercised without tripping (partial-output behavior is covered in
    ``test_maf_orchestration_timeout``).
    """
    gw = _PerAgentGateway({"model/alpha": "alpha-view", "model/beta": "beta-view"})
    orchestration = OrchestrationConfig(
        type="group_chat",
        max_rounds=2,
        termination_strategy=TerminationStrategyConfig(type="timeout", timeout_seconds=30.0),
    )
    response = await _run(orchestration, gw)

    assert response.metadata["orchestration_type"] == "group_chat"
    assert response.metadata["terminated_by"] == "completed"
    assert response.output
    assert response.usage is not None


@pytest.mark.asyncio
async def test_magentic_requires_manager_model_falls_back_to_default() -> None:
    """No explicit manager model -> falls back to the global default model."""
    gw = _PerAgentGateway({"model/alpha": "a", "model/beta": "b"})
    response = await _run(OrchestrationConfig(type="magentic", max_rounds=2), gw)
    assert response.output
    assert response.usage is not None


# ---------------------------------------------------------------------------
# Manager configurability: instructions (system prompt) + name
# ---------------------------------------------------------------------------


def test_manager_runner_wires_instructions_and_name() -> None:
    """``manager_instructions`` / ``manager_name`` are passed to the manager agent."""
    from unittest.mock import MagicMock

    config = _config(
        OrchestrationConfig(
            type="magentic",
            max_rounds=2,
            magentic_manager_model="model/mgr",
            manager_instructions="You are the lead. Keep it concise.",
            manager_name="lead",
        )
    )
    adapter = AgentFrameworkAdapter(config)
    adapter._orchestration_config = config.semantic_kernel.orchestration
    adapter._default_model = "azure/gpt-4.1-mini"
    adapter._manager_agents = []

    captured: dict[str, Any] = {}

    def _capture(
        *,
        model: str,
        temperature: float,
        name: str,
        instructions: str,
        max_tokens: int | None = None,
        function_choice_behavior: str = "auto",
        model_display_name: str | None = None,
    ) -> Any:  # noqa: ANN401
        captured.update(model=model, temperature=temperature, name=name, instructions=instructions)
        built = MagicMock()
        built.runner = MagicMock()
        return built

    adapter._agent_builder = MagicMock()
    adapter._agent_builder.build_manager_agent.side_effect = _capture

    adapter._build_manager_runner()

    assert captured["model"] == "model/mgr"
    assert captured["name"] == "lead"
    assert captured["instructions"] == "You are the lead. Keep it concise."


def test_manager_runner_defaults_when_unset() -> None:
    """Unset -> empty instructions, 'orchestrator' name, default model fallback."""
    from unittest.mock import MagicMock

    config = _config(OrchestrationConfig(type="magentic", max_rounds=2))
    adapter = AgentFrameworkAdapter(config)
    adapter._orchestration_config = config.semantic_kernel.orchestration
    adapter._default_model = "azure/gpt-4.1-mini"
    adapter._manager_agents = []

    captured: dict[str, Any] = {}

    def _capture(
        *,
        model: str,
        temperature: float,
        name: str,
        instructions: str,
        max_tokens: int | None = None,
        function_choice_behavior: str = "auto",
        model_display_name: str | None = None,
    ) -> Any:  # noqa: ANN401
        captured.update(model=model, name=name, instructions=instructions)
        built = MagicMock()
        built.runner = MagicMock()
        return built

    adapter._agent_builder = MagicMock()
    adapter._agent_builder.build_manager_agent.side_effect = _capture

    adapter._build_manager_runner()

    assert captured["instructions"] == ""
    assert captured["name"] == "orchestrator"
    assert captured["model"] == "azure/gpt-4.1-mini"


def test_manager_runner_keeps_auto_for_triage() -> None:
    """Triage's router uses ``function_choice_behavior="auto"`` — the same
    default as magentic / group_chat. ``required`` was tried but produced
    empty outputs because the model emitted forced tool calls AF couldn't
    always interpret as valid handoffs. With ``auto`` plus a tight routing
    prompt and per-target handoff descriptions, the LLM still picks a
    handoff function when the user's intent matches a specialist.
    """
    from unittest.mock import MagicMock

    config = _config(OrchestrationConfig(type="triage", max_rounds=3, manager_model="model/mgr"))
    adapter = AgentFrameworkAdapter(config)
    adapter._orchestration_config = config.semantic_kernel.orchestration
    adapter._orchestration_type = "triage"
    adapter._default_model = "azure/gpt-4.1-mini"
    adapter._manager_agents = []

    captured: dict[str, Any] = {}

    def _capture(
        *,
        model: str,
        temperature: float,
        name: str,
        instructions: str,
        max_tokens: int | None = None,
        function_choice_behavior: str = "auto",
        model_display_name: str | None = None,
    ) -> Any:  # noqa: ANN401
        captured["function_choice_behavior"] = function_choice_behavior
        built = MagicMock()
        built.runner = MagicMock()
        return built

    adapter._agent_builder = MagicMock()
    adapter._agent_builder.build_manager_agent.side_effect = _capture

    adapter._build_manager_runner()

    assert captured["function_choice_behavior"] == "auto"


def test_manager_runner_keeps_auto_for_magentic() -> None:
    """Magentic / group_chat keep ``auto`` because those managers do
    planning / selection in free-form text, not handoff tool calls.
    """
    from unittest.mock import MagicMock

    config = _config(OrchestrationConfig(type="magentic", max_rounds=3, manager_model="model/mgr"))
    adapter = AgentFrameworkAdapter(config)
    adapter._orchestration_config = config.semantic_kernel.orchestration
    adapter._orchestration_type = "magentic"
    adapter._default_model = "azure/gpt-4.1-mini"
    adapter._manager_agents = []

    captured: dict[str, Any] = {}

    def _capture(
        *,
        model: str,
        temperature: float,
        name: str,
        instructions: str,
        max_tokens: int | None = None,
        function_choice_behavior: str = "auto",
        model_display_name: str | None = None,
    ) -> Any:  # noqa: ANN401
        captured["function_choice_behavior"] = function_choice_behavior
        built = MagicMock()
        built.runner = MagicMock()
        return built

    adapter._agent_builder = MagicMock()
    adapter._agent_builder.build_manager_agent.side_effect = _capture

    adapter._build_manager_runner()

    assert captured["function_choice_behavior"] == "auto"


@pytest.mark.asyncio
async def test_magentic_with_prior_history_does_not_replay_transcript() -> None:
    """Regression: Magentic must receive a single task message, not replayed history.

    AF raises ``ValueError: Magentic only support a single task message to start the
    workflow`` when handed >1 message. With prior session history present, the adapter
    must reduce the magentic input to just the latest user message so the run still
    completes (other orchestration types keep the full transcript).
    """
    from agent_service_maf.core.session import ConversationMessage

    class _FakeSessionManager:
        def __init__(self) -> None:
            self.appended: list[ConversationMessage] = []

        async def get_history(self, session_id: str) -> list[ConversationMessage]:
            # A multi-message transcript that would crash Magentic if replayed.
            return [
                ConversationMessage(role="user", content="earlier question"),
                ConversationMessage(role="assistant", content="earlier answer"),
            ]

        async def append_message(self, session_id: str, message: ConversationMessage) -> None:
            self.appended.append(message)

    gw = _PerAgentGateway(
        {"model/alpha": "alpha-out", "model/beta": "beta-out", "model/mgr": "manager-plan"}
    )
    config = _config(
        OrchestrationConfig(type="magentic", max_rounds=2, magentic_manager_model="model/mgr")
    )
    adapter = AgentFrameworkAdapter(config)
    session_mgr = _FakeSessionManager()
    ctx = AgentExecutionContext(  # type: ignore[call-arg]
        config=config, gateway=gw, session_manager=session_mgr
    )
    await adapter.initialize(ctx)

    request = AgentRequest(agent_id="alpha", input="new question", session_id="sess-1")
    # Must NOT raise "Magentic only support a single task message".
    response = await adapter.invoke(request, ctx)

    assert response.metadata["orchestration_type"] == "magentic"
    assert response.output
    # The turn is still persisted even though history isn't replayed into the planner.
    assert any(m.role == "assistant" for m in session_mgr.appended)


# ---------------------------------------------------------------------------
# Single-member team: multi-agent types degrade to single instead of raising
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("otype", ["sequential", "concurrent", "triage", "group_chat", "magentic"])
@pytest.mark.asyncio
async def test_single_member_team_runs_instead_of_raising(otype: str) -> None:
    """A 1-member team with a multi-agent orchestration type runs (degrades to a
    single-agent workflow) rather than failing with 'requires at least 2 agents'."""
    gw = _PerAgentGateway({"model/solo": "solo-answer"})
    config = AgentConfig(
        agent=AgentSection(framework="maf", model="azure/gpt-4.1-mini"),
        semantic_kernel=SemanticKernelSection(
            agents=[SKAgentDefinition(name="solo", instructions="answer", model="model/solo")],
            orchestration=OrchestrationConfig(
                type=otype, max_rounds=2, magentic_manager_model="model/solo"
            ),
        ),
    )
    adapter = AgentFrameworkAdapter(config)
    ctx = AgentExecutionContext(config=config, gateway=gw)  # type: ignore[arg-type]
    await adapter.initialize(ctx)

    response = await adapter.invoke(AgentRequest(agent_id="solo", input="hi"), ctx)

    assert response.output == "solo-answer"
    # Declared type is preserved in metadata even though it ran as a single agent.
    assert response.metadata["orchestration_type"] == otype
