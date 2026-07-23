"""Tests for the MAF adapter's OpenTelemetry observability wiring."""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest

from agent_service_maf.config.validators import (
    AgentConfig,
    AgentSection,
    SemanticKernelSection,
    SKAgentDefinition,
)
from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.interfaces import TokenUsage
from agent_service_maf.framework.maf import observability
from agent_service_maf.framework.maf.adapter import AgentFrameworkAdapter
from agent_service_maf.gateway.llm_gateway import LLMCompletionResponse


class _Gateway:
    def __init__(self) -> None:
        self.config = type("Cfg", (), {"url": "http://bifrost.test/v1"})()

    async def complete(
        self, messages: list[dict[str, Any]], **kwargs: Any
    ) -> LLMCompletionResponse:
        return LLMCompletionResponse(
            content="ok",
            tool_calls=[],
            usage=TokenUsage(prompt_tokens=1, completion_tokens=1, total_tokens=2),
            model="m",
        )

    async def stream_complete(
        self, messages: list[dict[str, Any]], **kwargs: Any
    ) -> AsyncIterator[dict[str, Any]]:
        yield {"content": "ok", "tool_calls": None, "finish_reason": "stop"}


@pytest.fixture(autouse=True)
def _reset_observability() -> Any:
    observability.reset_af_observability_for_tests()
    yield
    observability.reset_af_observability_for_tests()


def test_enable_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[bool | None] = []

    def _fake_enable(*, enable_sensitive_data: bool | None = None, force: bool = False) -> None:
        calls.append(enable_sensitive_data)

    monkeypatch.setattr("agent_framework.observability.enable_instrumentation", _fake_enable)

    assert observability.enable_af_observability() is True
    assert observability.enable_af_observability() is False  # already enabled
    assert calls == [False]  # underlying instrumentation called exactly once


def test_failure_is_swallowed(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(**kwargs: Any) -> None:
        raise RuntimeError("otel exploded")

    monkeypatch.setattr("agent_framework.observability.enable_instrumentation", _boom)

    # Telemetry failures must never raise; they return False and log.
    assert observability.enable_af_observability() is False


@pytest.mark.asyncio
async def test_adapter_enables_telemetry_when_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    enabled: list[str] = []
    monkeypatch.setattr(
        observability,
        "enable_af_observability",
        lambda **_: enabled.append("yes") or True,
    )

    config = AgentConfig(
        agent=AgentSection(framework="maf", model="azure/gpt-4.1-mini"),
        semantic_kernel=SemanticKernelSection(
            agents=[SKAgentDefinition(name="solo", instructions="x")],
            enable_telemetry=True,
        ),
    )
    adapter = AgentFrameworkAdapter(config)
    await adapter.initialize(AgentExecutionContext(config=config, gateway=_Gateway()))  # type: ignore[arg-type]

    assert enabled == ["yes"]


@pytest.mark.asyncio
async def test_adapter_skips_telemetry_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    enabled: list[str] = []
    monkeypatch.setattr(
        observability,
        "enable_af_observability",
        lambda **_: enabled.append("yes") or True,
    )

    config = AgentConfig(
        agent=AgentSection(framework="maf", model="azure/gpt-4.1-mini"),
        semantic_kernel=SemanticKernelSection(
            agents=[SKAgentDefinition(name="solo", instructions="x")],
        ),
    )
    adapter = AgentFrameworkAdapter(config)
    await adapter.initialize(AgentExecutionContext(config=config, gateway=_Gateway()))  # type: ignore[arg-type]

    assert enabled == []
