"""Timeout-termination tests for the MAF adapter.

Ports SK's ``termination_strategy`` timeout semantics to Agent Framework:

* ``type == "timeout"`` with ``timeout_seconds`` -> **graceful** wall-clock cap:
  on expiry the orchestration returns the last collected participant output with
  ``terminated_by="timeout"`` (streamed run so partial progress is observable).
* Any other type with ``timeout_seconds`` -> **hard** cap: raises
  :class:`AgentInvocationError` on expiry.
* No explicit ``timeout_seconds`` -> a hard cap derived from ``max_rounds``.

The graceful / hard-cap runners are exercised directly against a hand-built AF
``SequentialBuilder`` workflow with a deliberately slow fake gateway, and the
budget-resolution logic is unit-tested in isolation.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest
from agent_framework import Message
from agent_framework.orchestrations import SequentialBuilder

from agent_service_maf.config.validators import (
    AgentConfig,
    AgentSection,
    OrchestrationConfig,
    SemanticKernelSection,
    SKAgentDefinition,
    TerminationStrategyConfig,
)
from agent_service_maf.core.exceptions import AgentInvocationError
from agent_service_maf.core.interfaces import TokenUsage
from agent_service_maf.framework.maf.adapter import (
    _ORCHESTRATION_TIMEOUT_DEFAULT,
    _SECONDS_PER_ROUND_HEURISTIC,
    AgentFrameworkAdapter,
)
from agent_service_maf.framework.maf.agent_builder import MafAgentBuilder
from agent_service_maf.gateway.llm_gateway import LLMCompletionResponse

_USAGE = TokenUsage(prompt_tokens=8, completion_tokens=4, total_tokens=12, estimated_cost_usd=0.001)


class _SlowGateway:
    """Fake gateway that can sleep per-model on the streaming and/or completion path."""

    def __init__(
        self,
        replies: dict[str, str],
        *,
        stream_delay: dict[str, float] | None = None,
        complete_delay: float = 0.0,
    ) -> None:
        self.config = type("Cfg", (), {"url": "http://bifrost.test/v1"})()
        self._replies = replies
        self._stream_delay = stream_delay or {}
        self._complete_delay = complete_delay

    def _reply(self, model: str | None) -> str:
        return self._replies.get(model or "", "default-reply")

    async def complete(
        self,
        messages: list[dict[str, Any]],
        model: str | None = None,
        **kwargs: Any,
    ) -> LLMCompletionResponse:
        if self._complete_delay:
            await asyncio.sleep(self._complete_delay)
        return LLMCompletionResponse(
            content=self._reply(model),
            tool_calls=[],
            usage=_USAGE,
            model=model or "azure/gpt-4.1-mini",
        )

    async def stream_complete(
        self,
        messages: list[dict[str, Any]],
        model: str | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[dict[str, Any]]:
        delay = self._stream_delay.get(model or "", 0.0)
        if delay:
            await asyncio.sleep(delay)
        yield {"content": self._reply(model)}
        yield {
            "usage": {
                "prompt_tokens": 8,
                "completion_tokens": 4,
                "total_tokens": 12,
                "cost": 0.001,
            }
        }


def _adapter(orchestration_type: str = "sequential") -> AgentFrameworkAdapter:
    """An adapter instance with just enough state for the timeout runners."""
    config = AgentConfig(
        agent=AgentSection(framework="maf", model="azure/gpt-4.1-mini"),
        semantic_kernel=SemanticKernelSection(),
    )
    adapter = AgentFrameworkAdapter(config)
    adapter._orchestration_type = orchestration_type
    return adapter


def _sequential_workflow(gw: _SlowGateway) -> Any:  # noqa: ANN401
    """Build a 2-agent (alpha -> beta) AF sequential workflow over *gw*."""
    builder = MafAgentBuilder(
        gateway=gw,  # type: ignore[arg-type]
        mcp_registry=None,
        default_model="model/alpha",
        default_temperature=0.0,
        default_max_tokens=256,
    )
    runners = [
        builder.build_agent(
            SKAgentDefinition(name="alpha", instructions="a", model="model/alpha")
        ).runner,
        builder.build_agent(
            SKAgentDefinition(name="beta", instructions="b", model="model/beta")
        ).runner,
    ]
    return SequentialBuilder(participants=runners).build()


# ---------------------------------------------------------------------------
# Budget resolution
# ---------------------------------------------------------------------------


def test_resolve_timeout_graceful_when_type_timeout() -> None:
    adapter = _adapter()
    adapter._orchestration_config = OrchestrationConfig(
        type="group_chat",
        termination_strategy=TerminationStrategyConfig(type="timeout", timeout_seconds=42.0),
    )
    timeout, graceful = adapter._resolve_orchestration_timeout()
    assert timeout == 42.0
    assert graceful is True


def test_resolve_timeout_hard_cap_for_non_timeout_type() -> None:
    adapter = _adapter()
    adapter._orchestration_config = OrchestrationConfig(
        type="group_chat",
        termination_strategy=TerminationStrategyConfig(type="keyword", timeout_seconds=15.0),
    )
    timeout, graceful = adapter._resolve_orchestration_timeout()
    assert timeout == 15.0
    assert graceful is False


def test_resolve_timeout_defaults_from_max_rounds() -> None:
    adapter = _adapter()
    adapter._orchestration_config = OrchestrationConfig(type="sequential", max_rounds=4)
    timeout, graceful = adapter._resolve_orchestration_timeout()
    assert timeout == 4 * _SECONDS_PER_ROUND_HEURISTIC
    assert graceful is False


def test_resolve_timeout_falls_back_to_default_constant() -> None:
    adapter = _adapter()
    adapter._orchestration_config = None
    timeout, graceful = adapter._resolve_orchestration_timeout()
    assert timeout == _ORCHESTRATION_TIMEOUT_DEFAULT
    assert graceful is False


# ---------------------------------------------------------------------------
# Graceful timeout -- partial output, no raise
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_graceful_timeout_returns_partial_output() -> None:
    """beta stalls past the budget; alpha's output is returned with terminated_by=timeout."""
    gw = _SlowGateway(
        {"model/alpha": "alpha-out", "model/beta": "beta-out"},
        stream_delay={"model/beta": 5.0},
    )
    adapter = _adapter("sequential")
    workflow = _sequential_workflow(gw)
    messages = [Message("user", ["go"])]

    output, steps, terminated_by = await adapter._run_workflow_graceful(
        workflow,
        messages,
        timeout_seconds=0.5,
        participant_names={"alpha", "beta"},
        prefer_last=True,
    )

    assert terminated_by == "timeout"
    # alpha completed before the budget; beta never did. Steps now carry
    # (name, input, output) — only assert on name + output.
    step_pairs = [(name, output_text) for name, _input, output_text in steps]
    assert ("alpha", "alpha-out") in step_pairs
    assert all(name != "beta" for name, *_ in steps)
    assert output == "alpha-out"


@pytest.mark.asyncio
async def test_graceful_timeout_completes_within_budget() -> None:
    """When everything finishes under budget the graceful runner reports completed."""
    gw = _SlowGateway({"model/alpha": "alpha-out", "model/beta": "beta-out"})
    adapter = _adapter("sequential")
    workflow = _sequential_workflow(gw)
    messages = [Message("user", ["go"])]

    output, steps, terminated_by = await adapter._run_workflow_graceful(
        workflow,
        messages,
        timeout_seconds=30.0,
        participant_names={"alpha", "beta"},
        prefer_last=True,
    )

    assert terminated_by == "completed"
    assert output == "beta-out"
    assert steps  # both participants traced


# ---------------------------------------------------------------------------
# Hard cap -- raises on expiry
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_hard_cap_timeout_raises() -> None:
    gw = _SlowGateway({"model/alpha": "alpha-out", "model/beta": "beta-out"}, complete_delay=5.0)
    adapter = _adapter("sequential")
    workflow = _sequential_workflow(gw)
    messages = [Message("user", ["go"])]

    with pytest.raises(AgentInvocationError, match="wall-clock budget"):
        await adapter._run_workflow_hard_cap(
            workflow,
            messages,
            timeout_seconds=0.3,
            participant_names={"alpha", "beta"},
            prefer_last=False,
        )


@pytest.mark.asyncio
async def test_hard_cap_completes_within_budget() -> None:
    gw = _SlowGateway({"model/alpha": "alpha-out", "model/beta": "beta-out"})
    adapter = _adapter("sequential")
    workflow = _sequential_workflow(gw)
    messages = [Message("user", ["go"])]

    output, steps, terminated_by = await adapter._run_workflow_hard_cap(
        workflow,
        messages,
        timeout_seconds=30.0,
        participant_names={"alpha", "beta"},
        prefer_last=False,
    )

    assert terminated_by == "completed"
    assert output == "beta-out"
    assert steps


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def test_drop_empty_steps_filters_blank_text() -> None:
    # Steps now carry (name, input, output); filter keys on output.
    steps = [
        ("alpha", "say hi", "a"),
        ("beta", "say hi", ""),
        ("alpha", "say hi", ""),
        ("beta", "say hi", "b"),
    ]
    assert AgentFrameworkAdapter._drop_empty_steps(steps) == [
        ("alpha", "say hi", "a"),
        ("beta", "say hi", "b"),
    ]
