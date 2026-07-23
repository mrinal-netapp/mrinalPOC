"""Unit tests for LLMGateway.

Tests cover complete(), stream_complete(), complete_with_tools(),
check_health(), retry logic, error mapping, and usage tracking integration.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from agent_service_maf.config.validators import GatewaySection
from agent_service_maf.core.exceptions import GatewayError
from agent_service_maf.core.interfaces import TokenUsage
from agent_service_maf.gateway.cost_tracker import UsageTracker
from agent_service_maf.gateway.llm_gateway import (
    GatewayToolResult,
    LLMCompletionResponse,
    LLMGateway,
)

# ---------------------------------------------------------------------------
# Fixtures and helpers
# ---------------------------------------------------------------------------


def make_config(
    url: str = "http://bifrost:4000",
    default_model: str = "anthropic/claude-sonnet-4-20250514",
    retry_on_timeout: bool = False,
    max_retries: int = 0,
    request_timeout_seconds: int = 30,
) -> GatewaySection:
    return GatewaySection(
        url=url,
        default_model=default_model,
        retry_on_timeout=retry_on_timeout,
        max_retries=max_retries,
        request_timeout_seconds=request_timeout_seconds,
    )


_DEFAULT_USAGE: dict[str, Any] = {
    "prompt_tokens": 10,
    "completion_tokens": 20,
    "total_tokens": 30,
    "cost": 0.001,
}


def make_raw_response(
    content: str = "Hello",
    tool_calls: list[dict[str, Any]] | None = None,
    model: str = "anthropic/claude-sonnet-4-20250514",
    usage: dict[str, Any] | None = None,
    usage_explicitly_empty: bool = False,
) -> dict[str, Any]:
    if usage_explicitly_empty:
        resolved_usage: dict[str, Any] = {}
    else:
        resolved_usage = usage if usage is not None else _DEFAULT_USAGE
    return {
        "content": content,
        "tool_calls": tool_calls or [],
        "model": model,
        "usage": resolved_usage,
    }


def make_mock_client(
    raw_response: dict[str, Any] | None = None,
    side_effect: Exception | None = None,
) -> AsyncMock:
    client = AsyncMock()
    if side_effect:
        client.complete.side_effect = side_effect
    else:
        client.complete.return_value = raw_response or make_raw_response()
    return client


async def async_generator_from_list(items: list[dict[str, Any]]) -> AsyncIterator[dict[str, Any]]:
    for item in items:
        yield item


MESSAGES = [{"role": "user", "content": "Hello"}]
MODEL = "anthropic/claude-sonnet-4-20250514"


# ---------------------------------------------------------------------------
# LLMCompletionResponse model
# ---------------------------------------------------------------------------


class TestLLMCompletionResponse:
    """Tests for the LLMCompletionResponse Pydantic model."""

    def test_model_has_required_fields(self) -> None:
        usage = TokenUsage(prompt_tokens=10, completion_tokens=20, total_tokens=30)
        response = LLMCompletionResponse(
            content="hi",
            usage=usage,
            model=MODEL,
        )
        assert response.content == "hi", "content should be stored correctly"
        assert response.model == MODEL, "model should be stored correctly"
        assert response.tool_calls == [], "tool_calls should default to empty list"

    def test_model_with_tool_calls(self) -> None:
        usage = TokenUsage()
        tc = [
            {
                "id": "tc1",
                "type": "function",
                "function": {"name": "get_weather", "arguments": "{}"},
            }
        ]
        response = LLMCompletionResponse(content="", usage=usage, model=MODEL, tool_calls=tc)
        assert len(response.tool_calls) == 1, "tool_calls should contain the provided tool call"
        assert response.tool_calls[0]["id"] == "tc1", "tool_call id should be preserved"


# ---------------------------------------------------------------------------
# GatewayToolResult dataclass
# ---------------------------------------------------------------------------


class TestGatewayToolResult:
    """Tests for the GatewayToolResult dataclass."""

    def test_dataclass_fields(self) -> None:
        usage = TokenUsage()
        result = GatewayToolResult(
            content="done",
            usage=usage,
            model=MODEL,
            tool_calls_made=2,
        )
        assert result.content == "done", "content should be stored"
        assert result.tool_calls_made == 2, "tool_calls_made should be stored"
        assert result.tool_history == [], "tool_history should default to empty list"


# ---------------------------------------------------------------------------
# LLMGateway.complete() — happy path
# ---------------------------------------------------------------------------


class TestLLMGatewayComplete:
    """Tests for LLMGateway.complete() happy-path behaviour."""

    @pytest.mark.asyncio
    async def test_complete_returns_llm_completion_response(self) -> None:
        client = make_mock_client(make_raw_response(content="World"))
        gateway = LLMGateway(make_config(), http_client=client)
        result = await gateway.complete(messages=MESSAGES, model=MODEL)
        assert isinstance(result, LLMCompletionResponse), (
            "complete() should return an LLMCompletionResponse instance"
        )

    @pytest.mark.asyncio
    async def test_complete_content_from_client(self) -> None:
        client = make_mock_client(make_raw_response(content="test response"))
        gateway = LLMGateway(make_config(), http_client=client)
        result = await gateway.complete(messages=MESSAGES, model=MODEL)
        assert result.content == "test response", (
            "complete() content should match the client's response content"
        )

    @pytest.mark.asyncio
    async def test_complete_uses_default_model_when_none_given(self) -> None:
        default = "anthropic/claude-haiku-4-20250414"
        client = make_mock_client(make_raw_response(model=default))
        gateway = LLMGateway(make_config(default_model=default), http_client=client)
        await gateway.complete(messages=MESSAGES)
        # Client should have been called with the default model
        call_kwargs = client.complete.call_args
        assert call_kwargs.kwargs["model"] == default, (
            f"When model=None, default_model '{default}' should be used, "
            f"got '{call_kwargs.kwargs['model']}'"
        )

    @pytest.mark.asyncio
    async def test_complete_model_override_used(self) -> None:
        override = "openai/gpt-4o"
        client = make_mock_client(make_raw_response(model=override))
        gateway = LLMGateway(make_config(), http_client=client)
        await gateway.complete(messages=MESSAGES, model=override)
        call_kwargs = client.complete.call_args
        assert call_kwargs.kwargs["model"] == override, (
            f"Explicit model override '{override}' should be forwarded to client"
        )

    @pytest.mark.asyncio
    async def test_complete_forwards_temperature_and_max_tokens(self) -> None:
        client = make_mock_client()
        gateway = LLMGateway(make_config(), http_client=client)
        await gateway.complete(messages=MESSAGES, model=MODEL, temperature=0.3, max_tokens=512)
        call_kwargs = client.complete.call_args
        assert call_kwargs.kwargs["temperature"] == 0.3, (
            "temperature should be forwarded to the HTTP client"
        )
        assert call_kwargs.kwargs["max_tokens"] == 512, (
            "max_tokens should be forwarded to the HTTP client"
        )

    @pytest.mark.asyncio
    async def test_complete_records_usage_in_tracker(self) -> None:
        client = make_mock_client(
            make_raw_response(
                usage={
                    "prompt_tokens": 5,
                    "completion_tokens": 15,
                    "total_tokens": 20,
                    "cost": 0.002,
                }
            )
        )
        tracker = UsageTracker()
        gateway = LLMGateway(make_config(), usage_tracker=tracker, http_client=client)
        await gateway.complete(messages=MESSAGES, model=MODEL)
        summary = tracker.get_summary()
        assert summary["total_tokens"] == 20, (
            "UsageTracker should be updated with tokens from the response"
        )
        assert summary["request_count"] == 1, (
            "UsageTracker request_count should be 1 after one complete() call"
        )

    @pytest.mark.asyncio
    async def test_complete_with_tools_forwarded_to_client(self) -> None:
        tools = [{"type": "function", "function": {"name": "search"}}]
        client = make_mock_client()
        gateway = LLMGateway(make_config(), http_client=client)
        await gateway.complete(messages=MESSAGES, model=MODEL, tools=tools)
        call_kwargs = client.complete.call_args
        assert call_kwargs.kwargs["tools"] == tools, (
            "tools list should be forwarded to the HTTP client"
        )

    @pytest.mark.asyncio
    async def test_complete_empty_usage_dict_produces_zero_usage(self) -> None:
        client = make_mock_client(make_raw_response(usage_explicitly_empty=True))
        tracker = UsageTracker()
        gateway = LLMGateway(make_config(), usage_tracker=tracker, http_client=client)
        result = await gateway.complete(messages=MESSAGES, model=MODEL)
        assert result.usage.total_tokens == 0, (
            "Empty usage dict from client should produce zero-valued TokenUsage"
        )

    @pytest.mark.asyncio
    async def test_complete_none_usage_dict_produces_zero_usage(self) -> None:
        raw = make_raw_response()
        raw["usage"] = None
        client = make_mock_client(raw)
        gateway = LLMGateway(make_config(), http_client=client)
        result = await gateway.complete(messages=MESSAGES, model=MODEL)
        assert result.usage.total_tokens == 0, (
            "None usage from client should produce zero-valued TokenUsage"
        )


# ---------------------------------------------------------------------------
# LLMGateway.complete() — model validation
# ---------------------------------------------------------------------------


class TestLLMGatewayModelValidation:
    """Tests for model string format validation."""

    @pytest.mark.asyncio
    async def test_complete_invalid_model_raises_gateway_error(self) -> None:
        client = make_mock_client()
        gateway = LLMGateway(make_config(), http_client=client)
        with pytest.raises(GatewayError, match="provider/model-name"):
            await gateway.complete(messages=MESSAGES, model="invalid-model")

    @pytest.mark.asyncio
    async def test_complete_model_without_slash_raises_gateway_error(self) -> None:
        client = make_mock_client()
        gateway = LLMGateway(make_config(), http_client=client)
        with pytest.raises(GatewayError):
            await gateway.complete(messages=MESSAGES, model="claude-sonnet")

    @pytest.mark.asyncio
    async def test_complete_empty_model_falls_back_to_default(self) -> None:
        """Empty string model falls back to config.default_model (falsy check)."""
        default = "anthropic/claude-sonnet-4-20250514"
        client = make_mock_client(make_raw_response(model=default))
        gateway = LLMGateway(make_config(default_model=default), http_client=client)
        # model="" is falsy, so default_model is used — this should succeed
        await gateway.complete(messages=MESSAGES, model="")
        call_kwargs = client.complete.call_args
        assert call_kwargs.kwargs["model"] == default, (
            "Empty string model should fall back to config.default_model"
        )

    @pytest.mark.asyncio
    async def test_complete_valid_model_format_accepted(self) -> None:
        client = make_mock_client(make_raw_response(model="openai/gpt-4o"))
        gateway = LLMGateway(make_config(), http_client=client)
        # Should NOT raise
        result = await gateway.complete(messages=MESSAGES, model="openai/gpt-4o")
        assert result.model == "openai/gpt-4o", (
            "Valid provider/model-name format should be accepted"
        )

    @pytest.mark.asyncio
    async def test_complete_model_with_dots_and_dashes_accepted(self) -> None:
        model = "anthropic/claude-3.5-sonnet-20241022"
        client = make_mock_client(make_raw_response(model=model))
        gateway = LLMGateway(make_config(), http_client=client)
        result = await gateway.complete(messages=MESSAGES, model=model)
        assert result.model == model, "Model names with dots and dashes should be accepted"


# ---------------------------------------------------------------------------
# LLMGateway.complete() — retry on timeout
# ---------------------------------------------------------------------------


class TestLLMGatewayRetryOnTimeout:
    """Tests for exponential-backoff retry logic on TimeoutError."""

    @pytest.mark.asyncio
    async def test_complete_no_retry_on_timeout_when_disabled(self) -> None:
        client = make_mock_client(side_effect=TimeoutError("timed out"))
        gateway = LLMGateway(
            make_config(retry_on_timeout=False, max_retries=3),
            http_client=client,
        )
        with pytest.raises(GatewayError, match="timed out"):
            await gateway.complete(messages=MESSAGES, model=MODEL)
        assert client.complete.call_count == 1, (
            "With retry_on_timeout=False, no retry should occur on TimeoutError"
        )

    @pytest.mark.asyncio
    async def test_complete_retries_on_timeout_up_to_max(self) -> None:
        client = make_mock_client(side_effect=TimeoutError("timeout"))
        gateway = LLMGateway(
            make_config(retry_on_timeout=True, max_retries=2),
            http_client=client,
        )
        with patch("asyncio.sleep", new_callable=AsyncMock), pytest.raises(GatewayError):
            await gateway.complete(messages=MESSAGES, model=MODEL)
        # 1 initial attempt + 2 retries = 3 total calls
        assert client.complete.call_count == 3, (
            f"With max_retries=2, should attempt 3 times total, got {client.complete.call_count}"
        )

    @pytest.mark.asyncio
    async def test_complete_succeeds_after_timeout_retry(self) -> None:
        """First call times out, second call succeeds."""
        call_count = 0

        async def flaky_complete(**kwargs: Any) -> dict[str, Any]:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise TimeoutError("first timeout")
            return make_raw_response(content="retry success")

        client = AsyncMock()
        client.complete.side_effect = flaky_complete
        gateway = LLMGateway(
            make_config(retry_on_timeout=True, max_retries=2),
            http_client=client,
        )
        with patch("asyncio.sleep", new_callable=AsyncMock):
            result = await gateway.complete(messages=MESSAGES, model=MODEL)
        assert result.content == "retry success", (
            "complete() should return successful response after a timeout retry"
        )

    @pytest.mark.asyncio
    async def test_complete_does_not_retry_on_rate_limit(self) -> None:
        mock_response = httpx.Response(
            429, request=httpx.Request("POST", "http://bifrost:4000/chat/completions")
        )
        client = make_mock_client(
            side_effect=httpx.HTTPStatusError(
                message="rate limit", request=mock_response.request, response=mock_response
            )
        )
        gateway = LLMGateway(
            make_config(retry_on_timeout=True, max_retries=3),
            http_client=client,
        )
        with pytest.raises(GatewayError, match="Rate limited"):
            await gateway.complete(messages=MESSAGES, model=MODEL)
        assert client.complete.call_count == 1, (
            "Rate limit error should NOT trigger retry — only 1 attempt expected"
        )

    @pytest.mark.asyncio
    async def test_complete_does_not_retry_on_auth_failure(self) -> None:
        mock_response = httpx.Response(
            401, request=httpx.Request("POST", "http://bifrost:4000/chat/completions")
        )
        client = make_mock_client(
            side_effect=httpx.HTTPStatusError(
                message="auth failed", request=mock_response.request, response=mock_response
            )
        )
        gateway = LLMGateway(
            make_config(retry_on_timeout=True, max_retries=3),
            http_client=client,
        )
        with pytest.raises(GatewayError, match="authentication failed"):
            await gateway.complete(messages=MESSAGES, model=MODEL)
        assert client.complete.call_count == 1, (
            "Authentication error should NOT trigger retry — only 1 attempt expected"
        )


# ---------------------------------------------------------------------------
# LLMGateway.complete() — error mapping
# ---------------------------------------------------------------------------


class TestLLMGatewayErrorMapping:
    """Tests for exception mapping to GatewayError."""

    @pytest.mark.asyncio
    async def test_rate_limit_mapped_to_gateway_error(self) -> None:
        mock_response = httpx.Response(
            429, request=httpx.Request("POST", "http://bifrost:4000/chat/completions")
        )
        client = make_mock_client(
            side_effect=httpx.HTTPStatusError(
                message="429", request=mock_response.request, response=mock_response
            )
        )
        gateway = LLMGateway(make_config(), http_client=client)
        with pytest.raises(GatewayError) as exc_info:
            await gateway.complete(messages=MESSAGES, model=MODEL)
        assert "Rate limited" in str(exc_info.value), (
            "HTTPStatusError 429 should be mapped to GatewayError with 'Rate limited' message"
        )

    @pytest.mark.asyncio
    async def test_auth_failure_mapped_to_gateway_error(self) -> None:
        mock_response = httpx.Response(
            401, request=httpx.Request("POST", "http://bifrost:4000/chat/completions")
        )
        client = make_mock_client(
            side_effect=httpx.HTTPStatusError(
                message="401", request=mock_response.request, response=mock_response
            )
        )
        gateway = LLMGateway(make_config(), http_client=client)
        with pytest.raises(GatewayError) as exc_info:
            await gateway.complete(messages=MESSAGES, model=MODEL)
        assert "authentication failed" in str(exc_info.value).lower(), (
            "HTTPStatusError 401 should be mapped to GatewayError with auth message"
        )

    @pytest.mark.asyncio
    async def test_timeout_mapped_to_gateway_error(self) -> None:
        client = make_mock_client(side_effect=TimeoutError("timed out"))
        gateway = LLMGateway(make_config(retry_on_timeout=False), http_client=client)
        with pytest.raises(GatewayError) as exc_info:
            await gateway.complete(messages=MESSAGES, model=MODEL)
        assert (
            "timed out" in str(exc_info.value).lower() or "timeout" in str(exc_info.value).lower()
        ), "TimeoutError should be mapped to GatewayError with timeout message"

    @pytest.mark.asyncio
    async def test_generic_exception_mapped_to_gateway_error(self) -> None:
        client = make_mock_client(side_effect=RuntimeError("unexpected error"))
        gateway = LLMGateway(make_config(), http_client=client)
        with pytest.raises(GatewayError) as exc_info:
            await gateway.complete(messages=MESSAGES, model=MODEL)
        assert "unexpected error" in str(exc_info.value), (
            "Generic RuntimeError should be wrapped in GatewayError with original message"
        )

    @pytest.mark.asyncio
    async def test_gateway_error_details_contain_model(self) -> None:
        mock_response = httpx.Response(
            429, request=httpx.Request("POST", "http://bifrost:4000/chat/completions")
        )
        client = make_mock_client(
            side_effect=httpx.HTTPStatusError(
                message="rate limited", request=mock_response.request, response=mock_response
            )
        )
        gateway = LLMGateway(make_config(), http_client=client)
        with pytest.raises(GatewayError) as exc_info:
            await gateway.complete(messages=MESSAGES, model=MODEL)
        assert exc_info.value.details.get("model") == MODEL, (
            "GatewayError.details should contain the model string"
        )


# ---------------------------------------------------------------------------
# LLMGateway.stream_complete()
# ---------------------------------------------------------------------------


class TestLLMGatewayStreamComplete:
    """Tests for stream_complete() yielding chunks.

    stream_complete() is an async generator — iterate with `async for` directly,
    do NOT await it.
    """

    @pytest.mark.asyncio
    async def test_stream_complete_yields_chunks(self) -> None:
        chunks = [
            {"content": "Hello", "tool_calls": None, "finish_reason": None},
            {"content": " World", "tool_calls": None, "finish_reason": "stop"},
        ]

        client = AsyncMock()
        # ``stream_complete`` must itself return an async iterator (not a
        # coroutine that resolves to one), so use a plain side_effect lambda.
        client.stream_complete = MagicMock(return_value=async_generator_from_list(chunks))
        gateway = LLMGateway(make_config(), http_client=client)

        collected = []
        async for chunk in gateway.stream_complete(messages=MESSAGES, model=MODEL):
            collected.append(chunk)

        assert len(collected) == 2, f"stream_complete() should yield 2 chunks, got {len(collected)}"
        assert collected[0]["content"] == "Hello", "First chunk content should be 'Hello'"
        assert collected[1]["finish_reason"] == "stop", (
            "Last chunk should have finish_reason='stop'"
        )

    @pytest.mark.asyncio
    async def test_stream_complete_validates_model_format(self) -> None:
        client = AsyncMock()
        gateway = LLMGateway(make_config(), http_client=client)
        with pytest.raises(GatewayError):
            async for _ in gateway.stream_complete(messages=MESSAGES, model="bad-model"):
                pass

    @pytest.mark.asyncio
    async def test_stream_complete_uses_default_model(self) -> None:
        chunks = [{"content": "ok", "tool_calls": None, "finish_reason": "stop"}]
        client = AsyncMock()
        client.stream_complete = MagicMock(return_value=async_generator_from_list(chunks))
        default = "anthropic/claude-haiku-4-20250414"
        gateway = LLMGateway(make_config(default_model=default), http_client=client)

        async for _ in gateway.stream_complete(messages=MESSAGES):
            pass

        call_kwargs = client.stream_complete.call_args
        assert call_kwargs.kwargs["model"] == default, (
            f"stream_complete() with no model should use default '{default}'"
        )

    @pytest.mark.asyncio
    async def test_stream_complete_rate_limit_raises_gateway_error(self) -> None:
        mock_response = httpx.Response(
            429, request=httpx.Request("POST", "http://bifrost:4000/chat/completions")
        )
        client = AsyncMock()

        def _raise(*_args: Any, **_kwargs: Any) -> Any:
            raise httpx.HTTPStatusError(
                message="rate limit",
                request=mock_response.request,
                response=mock_response,
            )

        client.stream_complete = MagicMock(side_effect=_raise)
        gateway = LLMGateway(make_config(), http_client=client)

        with pytest.raises(GatewayError, match="Rate limited"):
            async for _ in gateway.stream_complete(messages=MESSAGES, model=MODEL):
                pass


# ---------------------------------------------------------------------------
# LLMGateway.complete_with_tools() — stub
# ---------------------------------------------------------------------------


class TestLLMGatewayCompleteWithTools:
    """Tests for :meth:`LLMGateway.complete_with_tools`.

    The method was a NotImplementedError stub in early phases; Phase 5 wired it
    up to run a tool-execution loop driven by a caller-supplied ``tool_executor``.
    These tests now exercise the ``tool_executor`` contract instead of the
    pre-Phase-5 stub.
    """

    @pytest.mark.asyncio
    async def test_complete_with_tools_requires_tool_executor(self) -> None:
        """``tool_executor`` is a required positional arg — missing it raises TypeError."""
        gateway = LLMGateway(make_config(), http_client=make_mock_client())
        with pytest.raises(TypeError, match="tool_executor"):
            await gateway.complete_with_tools(  # type: ignore[call-arg]
                messages=MESSAGES,
                tools=[{"type": "function", "function": {"name": "search"}}],
                model=MODEL,
            )

    @pytest.mark.asyncio
    async def test_complete_with_tools_returns_when_no_tool_calls(self) -> None:
        """When the first LLM response has no tool_calls, the loop returns the text directly."""
        # mock client returns a plain assistant message, no tool_calls
        client = make_mock_client()
        gateway = LLMGateway(make_config(), http_client=client)

        async def _never_called(_tc: dict[str, Any]) -> str:
            raise AssertionError("tool_executor should not run when no tool_calls present")

        result = await gateway.complete_with_tools(
            messages=MESSAGES,
            tools=[],
            tool_executor=_never_called,
            model=MODEL,
        )
        assert isinstance(result.content, str), "result.content should be a string"


# ---------------------------------------------------------------------------
# LLMGateway.check_health()
# ---------------------------------------------------------------------------


class TestLLMGatewayCheckHealth:
    """Tests for check_health() returning Bifrost connectivity status."""

    @pytest.mark.asyncio
    async def test_check_health_returns_healthy_on_200(self) -> None:
        mock_response = MagicMock()
        mock_response.status_code = 200

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.get.return_value = mock_response

        gateway = LLMGateway(make_config(), http_client=make_mock_client())
        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await gateway.check_health()

        assert result["healthy"] is True, (
            "check_health() should return healthy=True when /health returns 200"
        )
        assert result["latency_ms"] >= 0, (
            "check_health() should return non-negative latency_ms on success"
        )

    @pytest.mark.asyncio
    async def test_check_health_returns_unhealthy_on_500(self) -> None:
        mock_response = MagicMock()
        mock_response.status_code = 500

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.get.return_value = mock_response

        gateway = LLMGateway(make_config(), http_client=make_mock_client())
        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await gateway.check_health()

        assert result["healthy"] is False, (
            "check_health() should return healthy=False when /health returns non-200"
        )

    @pytest.mark.asyncio
    async def test_check_health_handles_connection_error(self) -> None:
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.get.side_effect = ConnectionError("connection refused")

        gateway = LLMGateway(make_config(), http_client=make_mock_client())
        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await gateway.check_health()

        assert result["healthy"] is False, (
            "check_health() should return healthy=False on connection error"
        )
        assert result["latency_ms"] == -1, (
            "check_health() should return latency_ms=-1 when request fails"
        )

    @pytest.mark.asyncio
    async def test_check_health_handles_timeout(self) -> None:
        import httpx

        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)
        mock_client.get.side_effect = httpx.TimeoutException("timeout")

        gateway = LLMGateway(make_config(), http_client=make_mock_client())
        with patch("httpx.AsyncClient", return_value=mock_client):
            result = await gateway.check_health()

        assert result["healthy"] is False, "check_health() should return healthy=False on timeout"
        assert result["latency_ms"] == -1, "check_health() should return latency_ms=-1 on timeout"


# ---------------------------------------------------------------------------
# LLMGateway — constructor
# ---------------------------------------------------------------------------


class TestLLMGatewayConstructor:
    """Tests for LLMGateway constructor."""

    def test_default_usage_tracker_created(self) -> None:
        gateway = LLMGateway(make_config(), http_client=make_mock_client())
        assert isinstance(gateway.usage_tracker, UsageTracker), (
            "When no usage_tracker is provided, a UsageTracker should be created"
        )

    def test_injected_usage_tracker_used(self) -> None:
        tracker = UsageTracker()
        gateway = LLMGateway(make_config(), usage_tracker=tracker, http_client=make_mock_client())
        assert gateway.usage_tracker is tracker, (
            "Injected usage_tracker should be the one used by the gateway"
        )

    def test_config_stored(self) -> None:
        config = make_config(url="http://custom:5000")
        gateway = LLMGateway(config, http_client=make_mock_client())
        assert gateway.config is config, "Gateway should store the config object as-is"
