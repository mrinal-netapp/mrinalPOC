"""Phase 0 spike test — the AF BifrostChatClient over a fake LLMGateway.

Proves the Phase 0 exit criterion from AGENT_FRAMEWORK_MIGRATION_PLAN.md: a custom
Agent Framework ``ChatClient`` wrapping the gateway returns text + usage for one
model, both streaming and non-streaming, and integrates with ``client.as_agent``.

No live Bifrost: a fake gateway mimics ``LLMGateway.complete`` /
``stream_complete``.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest

from agent_service_maf.core.interfaces import TokenUsage
from agent_service_maf.framework.maf.gateway_chat_client import (
    BifrostChatClient,
    sum_token_usage,
    usage_capture_scope,
)
from agent_service_maf.gateway.llm_gateway import LLMCompletionResponse


class _FakeGateway:
    """Mimics the slice of LLMGateway that BifrostChatClient depends on."""

    def __init__(self) -> None:
        self.config = type("Cfg", (), {"url": "http://bifrost.test/v1"})()
        self.last_messages: list[dict[str, Any]] | None = None
        self.last_model: str | None = None
        self.last_temperature: float | None = None
        self.last_max_tokens: int | None = None

    async def complete(
        self,
        messages: list[dict[str, Any]],
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,
    ) -> LLMCompletionResponse:
        self.last_messages = messages
        self.last_model = model
        self.last_temperature = temperature
        self.last_max_tokens = max_tokens
        return LLMCompletionResponse(
            content="Hello from Bifrost",
            tool_calls=[],
            usage=TokenUsage(
                prompt_tokens=11,
                completion_tokens=7,
                total_tokens=18,
                estimated_cost_usd=0.0009,
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
        self.last_messages = messages
        self.last_model = model
        for piece in ("Hello", " from", " Bifrost"):
            yield {"content": piece, "tool_calls": None, "finish_reason": None}
        # Terminal chunk carries usage, mirroring Bifrost's final SSE frame.
        yield {
            "content": "",
            "tool_calls": None,
            "finish_reason": "stop",
            "usage": {
                "prompt_tokens": 11,
                "completion_tokens": 7,
                "total_tokens": 18,
                "cost": 0.0009,
            },
        }


def _client() -> tuple[BifrostChatClient, _FakeGateway]:
    gw = _FakeGateway()
    return BifrostChatClient(gateway=gw, model="azure/gpt-4.1-mini"), gw


@pytest.mark.asyncio
async def test_non_streaming_returns_text_and_usage() -> None:
    from agent_framework import Message

    client, gw = _client()
    response = await client.get_response([Message("user", ["Hi"])])

    assert response.text == "Hello from Bifrost"
    assert response.usage_details["input_token_count"] == 11
    assert response.usage_details["output_token_count"] == 7
    assert response.usage_details["total_token_count"] == 18
    assert response.additional_properties["estimated_cost_usd"] == pytest.approx(0.0009)
    # Role + content reached the gateway in wire shape.
    assert gw.last_messages == [{"role": "user", "content": "Hi"}]
    assert client.get_llm_call_count() == 1


@pytest.mark.asyncio
async def test_streaming_assembles_text_and_usage() -> None:
    from agent_framework import ChatResponse, Message

    client, _ = _client()
    updates = []
    async for update in client.get_response([Message("user", ["Hi"])], stream=True):
        updates.append(update)

    text = "".join(u.text for u in updates)
    assert text == "Hello from Bifrost"

    # The standard finalizer assembles updates (text + usage Content) into a response.
    assembled = ChatResponse.from_updates(updates)
    assert assembled.text == "Hello from Bifrost"
    assert assembled.usage_details["total_token_count"] == 18


@pytest.mark.asyncio
async def test_usage_capture_scope_aggregates_calls() -> None:
    from agent_framework import Message

    client, _ = _client()
    with usage_capture_scope() as buf:
        await client.get_response([Message("user", ["one"])])
        await client.get_response([Message("user", ["two"])])

    total = sum_token_usage(buf)
    assert total.prompt_tokens == 22
    assert total.completion_tokens == 14
    assert total.total_tokens == 36


@pytest.mark.asyncio
async def test_as_agent_runs_through_gateway() -> None:
    client, gw = _client()
    agent = client.as_agent(instructions="You are helpful.")
    result = await agent.run("Hi")

    assert "Hello from Bifrost" in result.text
    # Agent injects the instructions as a leading system message.
    assert gw.last_messages is not None
    assert gw.last_messages[0]["role"] == "system"
    assert gw.last_messages[0]["content"] == "You are helpful."


def test_extract_options_uses_client_defaults_when_options_missing() -> None:
    """Resolved temperature / max_tokens on the client are the fallback.

    Regression for the per-invoke ``configOverrides.max_tokens`` cap being
    silently dropped: AF does not always forward the agent's
    ``default_options`` into the per-call ``options`` mapping, so the client
    must hold the resolved knobs and apply them when ``options`` omits them
    (mirroring the long-standing ``model`` fallback).
    """
    gw = _FakeGateway()
    client = BifrostChatClient(
        gateway=gw,
        model="azure/gpt-4.1-mini",
        temperature=0.3,
        max_tokens=10,
    )
    opts = client._extract_options({})
    assert opts["max_tokens"] == 10
    assert opts["temperature"] == 0.3
    assert opts["model"] == "azure/gpt-4.1-mini"


def test_extract_options_per_call_overrides_client_defaults() -> None:
    """An explicit per-call option still wins over the client default."""
    gw = _FakeGateway()
    client = BifrostChatClient(gateway=gw, model="m", temperature=0.3, max_tokens=10)
    opts = client._extract_options({"temperature": 1.5, "max_tokens": 4000})
    assert opts["max_tokens"] == 4000
    assert opts["temperature"] == 1.5


def test_extract_options_model_per_call_overrides_client_default() -> None:
    """An explicit per-call ``model`` still wins over the client default."""
    gw = _FakeGateway()
    client = BifrostChatClient(
        gateway=gw, model="azure/gpt-4.1-mini", temperature=0.5, max_tokens=100
    )
    opts = client._extract_options({"model": "azure/gpt-5"})
    assert opts["model"] == "azure/gpt-5"
    # temperature / max_tokens not in per-call options → fall back to client defaults
    assert opts["temperature"] == 0.5
    assert opts["max_tokens"] == 100


def test_extract_options_partial_override_only_model() -> None:
    """Only ``model`` provided per-call — temperature and max_tokens fall back."""
    gw = _FakeGateway()
    client = BifrostChatClient(
        gateway=gw, model="azure/gpt-4.1-mini", temperature=0.7, max_tokens=256
    )
    opts = client._extract_options({"model": "azure/gpt-5"})
    assert opts["model"] == "azure/gpt-5"
    assert opts["temperature"] == 0.7
    assert opts["max_tokens"] == 256


def test_extract_options_partial_override_only_max_tokens() -> None:
    """Only ``max_tokens`` provided per-call — model and temperature fall back."""
    gw = _FakeGateway()
    client = BifrostChatClient(
        gateway=gw, model="azure/gpt-4.1-mini", temperature=0.2, max_tokens=50
    )
    opts = client._extract_options({"max_tokens": 9999})
    assert opts["model"] == "azure/gpt-4.1-mini"
    assert opts["temperature"] == 0.2
    assert opts["max_tokens"] == 9999


def test_extract_options_none_client_defaults_stay_none() -> None:
    """When client has no defaults, absent per-call options produce ``None`` — not a stale value."""
    gw = _FakeGateway()
    client = BifrostChatClient(gateway=gw, model="azure/gpt-4.1-mini")
    opts = client._extract_options({})
    assert opts["temperature"] is None
    assert opts["max_tokens"] is None


@pytest.mark.asyncio
async def test_client_defaults_reach_gateway_complete() -> None:
    """Client-level temperature and max_tokens must flow through to ``gateway.complete()``.

    End-to-end regression for AIAS-1330: the fix stores the resolved knobs on
    the client and feeds them into ``_extract_options``; this test verifies
    they are not dropped on the way to the actual gateway call.
    """
    from agent_framework import Message

    gw = _FakeGateway()
    client = BifrostChatClient(
        gateway=gw, model="azure/gpt-4.1-mini", temperature=0.1, max_tokens=42
    )
    await client.get_response([Message("user", ["hi"])])

    assert gw.last_temperature == 0.1, f"Expected 0.1, got {gw.last_temperature}"
    assert gw.last_max_tokens == 42, f"Expected 42, got {gw.last_max_tokens}"


@pytest.mark.asyncio
async def test_per_call_model_override_reaches_gateway_complete() -> None:
    """A per-call ``model`` override in ``options`` must be forwarded to the gateway."""
    from agent_framework import Message

    gw = _FakeGateway()
    client = BifrostChatClient(
        gateway=gw, model="azure/gpt-4.1-mini", temperature=0.5, max_tokens=100
    )
    # Simulate AF passing a per-call model override via ChatOptions
    await client.get_response([Message("user", ["hi"])], options={"model": "azure/gpt-5"})

    assert gw.last_model == "azure/gpt-5", f"Expected azure/gpt-5, got {gw.last_model}"
    # Other knobs fall back to client defaults
    assert gw.last_temperature == 0.5
    assert gw.last_max_tokens == 100
