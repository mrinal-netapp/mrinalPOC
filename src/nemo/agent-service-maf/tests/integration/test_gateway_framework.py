"""Integration tests for Gateway ↔ Framework adapter boundary.

Validates that:
- Framework adapters can use LLMGateway for completions (mocked HTTP)
- UsageTracker records usage from gateway calls
- SecretRedactor masks keys in log output
- Gateway model validation is enforced at the framework boundary
- Gateway errors propagate correctly to framework callers
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from agent_service_maf.config.validators import AgentConfig, GatewaySection
from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.exceptions import GatewayError
from agent_service_maf.gateway.cost_tracker import UsageTracker
from agent_service_maf.gateway.http_llm_client import HttpLLMClient
from agent_service_maf.gateway.llm_gateway import LLMCompletionResponse, LLMGateway
from agent_service_maf.gateway.secret_redactor import SecretRedactor, _redact_string

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_mock_http_client(
    content: str = "Mock LLM response",
    model: str = "openai/gpt-4o",
    prompt_tokens: int = 10,
    completion_tokens: int = 20,
    total_tokens: int = 30,
    cost: float = 0.001,
) -> MagicMock:
    """Build a mock HttpLLMClient that returns a fixed response."""
    client = MagicMock(spec=HttpLLMClient)
    client.complete = AsyncMock(
        return_value={
            "content": content,
            "tool_calls": [],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": total_tokens,
                "cost": cost,
            },
            "model": model,
        }
    )
    return client


def _make_gateway(
    http_client: HttpLLMClient | None = None,
    usage_tracker: UsageTracker | None = None,
    default_model: str = "openai/gpt-4o",
) -> LLMGateway:
    """Build an LLMGateway with a mock HTTP client and configurable tracker."""
    config = GatewaySection(url="http://mock-bifrost:4000", default_model=default_model)
    tracker = usage_tracker or UsageTracker()
    client = http_client or _make_mock_http_client()
    return LLMGateway(config=config, usage_tracker=tracker, http_client=client)


def _make_context(gateway: LLMGateway | None = None) -> AgentExecutionContext:
    """Create a minimal execution context."""
    config = AgentConfig()
    return AgentExecutionContext(
        config=config,
        gateway=gateway,
        correlation_id=str(uuid.uuid4()),
    )


# ---------------------------------------------------------------------------
# Tests: framework adapter uses LLMGateway for completions
# ---------------------------------------------------------------------------


async def test_gateway_complete_returns_typed_response_to_adapter() -> None:
    """LLMGateway.complete() should return a typed LLMCompletionResponse."""
    http_client = _make_mock_http_client(content="Hello from mock LLM", model="openai/gpt-4o")
    gateway = _make_gateway(http_client=http_client)

    response = await gateway.complete(
        messages=[{"role": "user", "content": "Say hello"}],
        model="openai/gpt-4o",
    )

    assert isinstance(response, LLMCompletionResponse), (
        "LLMGateway.complete() must return a typed LLMCompletionResponse, not a bare dict"
    )
    assert response.content == "Hello from mock LLM", (
        "Response content should match what the mock HTTP client returned"
    )
    assert response.model == "openai/gpt-4o", (
        "Response model field should reflect the model returned by the gateway"
    )


async def test_gateway_complete_passes_messages_to_http_client() -> None:
    """Gateway must forward messages unchanged to the HTTP client."""
    http_client = _make_mock_http_client()
    gateway = _make_gateway(http_client=http_client)

    messages = [
        {"role": "system", "content": "You are helpful."},
        {"role": "user", "content": "What is 2+2?"},
    ]
    await gateway.complete(messages=messages, model="openai/gpt-4o")

    http_client.complete.assert_called_once()
    call_kwargs = http_client.complete.call_args[1]
    assert call_kwargs["messages"] == messages, (
        "Gateway must pass the messages list to the HTTP client unchanged"
    )


async def test_gateway_complete_uses_default_model_when_none_specified() -> None:
    """When no model is given, LLMGateway must use config.default_model."""
    http_client = _make_mock_http_client(model="anthropic/claude-haiku-4")
    gateway = _make_gateway(
        http_client=http_client,
        default_model="anthropic/claude-haiku-4",
    )

    await gateway.complete(messages=[{"role": "user", "content": "hi"}])

    http_client.complete.assert_called_once()
    call_kwargs = http_client.complete.call_args[1]
    assert call_kwargs["model"] == "anthropic/claude-haiku-4", (
        "Gateway must use config.default_model when no model is explicitly provided"
    )


async def test_gateway_validates_model_format_before_calling_http() -> None:
    """Invalid model strings should be rejected before any HTTP call is made."""
    http_client = _make_mock_http_client()
    gateway = _make_gateway(http_client=http_client)

    with pytest.raises(GatewayError) as exc_info:
        await gateway.complete(
            messages=[{"role": "user", "content": "hi"}],
            model="invalid-model-no-slash",
        )

    assert "provider/model-name" in str(exc_info.value), (
        "GatewayError message should explain the required model string format"
    )
    (
        http_client.complete.assert_not_called(),
        ("HTTP client must not be called when the model string is invalid"),
    )


async def test_gateway_exposes_context_gateway_to_framework_adapters() -> None:
    """The execution context should carry the gateway so adapters can access it."""
    http_client = _make_mock_http_client()
    gateway = _make_gateway(http_client=http_client)
    context = _make_context(gateway=gateway)

    assert context.gateway is not None, (
        "AgentExecutionContext.gateway must be set when a gateway is provided"
    )
    assert context.gateway is gateway, (
        "AgentExecutionContext.gateway must be the exact gateway instance passed in"
    )

    # Simulate an adapter using context.gateway
    response = await context.gateway.complete(
        messages=[{"role": "user", "content": "test from adapter"}],
        model="openai/gpt-4o",
    )
    assert isinstance(response, LLMCompletionResponse), (
        "A framework adapter accessing context.gateway.complete() should get a typed response"
    )


# ---------------------------------------------------------------------------
# Tests: UsageTracker records usage from gateway calls
# ---------------------------------------------------------------------------


async def test_usage_tracker_records_tokens_after_gateway_complete() -> None:
    """UsageTracker should accumulate token counts from each successful gateway call."""
    tracker = UsageTracker()
    http_client = _make_mock_http_client(
        prompt_tokens=100,
        completion_tokens=200,
        total_tokens=300,
        cost=0.005,
    )
    gateway = _make_gateway(http_client=http_client, usage_tracker=tracker)

    await gateway.complete(
        messages=[{"role": "user", "content": "count my tokens"}],
        model="openai/gpt-4o",
    )

    summary = tracker.get_summary()

    assert summary["total_prompt_tokens"] == 100, (
        "UsageTracker should record prompt_tokens from the gateway response"
    )
    assert summary["total_completion_tokens"] == 200, (
        "UsageTracker should record completion_tokens from the gateway response"
    )
    assert summary["total_tokens"] == 300, (
        "UsageTracker should record total_tokens from the gateway response"
    )
    assert summary["request_count"] == 1, (
        "UsageTracker should increment request_count for each successful gateway call"
    )


async def test_usage_tracker_accumulates_across_multiple_calls() -> None:
    """UsageTracker totals should accumulate over multiple gateway calls."""
    tracker = UsageTracker()
    http_client = _make_mock_http_client(
        prompt_tokens=50, completion_tokens=100, total_tokens=150, cost=0.001
    )
    gateway = _make_gateway(http_client=http_client, usage_tracker=tracker)

    for _ in range(3):
        await gateway.complete(
            messages=[{"role": "user", "content": "call"}],
            model="openai/gpt-4o",
        )

    summary = tracker.get_summary()

    assert summary["request_count"] == 3, "UsageTracker should count all 3 gateway calls"
    assert summary["total_prompt_tokens"] == 150, (
        "UsageTracker should sum prompt_tokens across all calls: 3 × 50 = 150"
    )
    assert summary["total_completion_tokens"] == 300, (
        "UsageTracker should sum completion_tokens across all calls: 3 × 100 = 300"
    )


async def test_usage_tracker_records_per_model_breakdown() -> None:
    """UsageTracker.get_summary_by_model() should break down usage per model."""
    tracker = UsageTracker()

    model_a = "openai/gpt-4o"
    model_b = "anthropic/claude-haiku-4"

    http_client_a = _make_mock_http_client(
        model=model_a, prompt_tokens=10, completion_tokens=20, total_tokens=30
    )
    http_client_b = _make_mock_http_client(
        model=model_b, prompt_tokens=5, completion_tokens=10, total_tokens=15
    )

    gateway_a = _make_gateway(
        http_client=http_client_a, usage_tracker=tracker, default_model=model_a
    )
    gateway_b = _make_gateway(
        http_client=http_client_b, usage_tracker=tracker, default_model=model_b
    )

    await gateway_a.complete(messages=[{"role": "user", "content": "a"}], model=model_a)
    await gateway_b.complete(messages=[{"role": "user", "content": "b"}], model=model_b)

    by_model = tracker.get_summary_by_model()

    assert model_a in by_model, (
        "UsageTracker should track usage under the exact model identifier returned by the gateway"
    )
    assert model_b in by_model, "UsageTracker should track usage for each distinct model used"
    assert by_model[model_a]["request_count"] == 1, (
        "Per-model request_count should be 1 for a single call to that model"
    )
    assert by_model[model_b]["request_count"] == 1, (
        "Per-model request_count should be 1 for a single call to that model"
    )


async def test_usage_tracker_not_updated_on_gateway_error() -> None:
    """Failed gateway calls should not record any usage in the tracker."""
    tracker = UsageTracker()
    http_client = MagicMock(spec=HttpLLMClient)
    http_client.complete = AsyncMock(side_effect=RuntimeError("simulated network failure"))

    gateway = _make_gateway(http_client=http_client, usage_tracker=tracker)

    with pytest.raises(GatewayError):
        await gateway.complete(
            messages=[{"role": "user", "content": "fail"}],
            model="openai/gpt-4o",
        )

    summary = tracker.get_summary()
    assert summary["request_count"] == 0, (
        "UsageTracker should not record usage when the gateway call fails"
    )
    assert summary["total_tokens"] == 0, (
        "UsageTracker total_tokens must remain zero when gateway raises an error"
    )


# ---------------------------------------------------------------------------
# Tests: SecretRedactor masks secrets in log-related data
# ---------------------------------------------------------------------------


def test_secret_redactor_masks_openai_key() -> None:
    """SecretRedactor must replace OpenAI-style API keys with a masked placeholder."""
    raw = "The API key is sk-AABBCCDDEEAABBCCDDEEAABB"
    redacted = _redact_string(raw)

    assert "sk-AABB" not in redacted, (
        "SecretRedactor must replace the full OpenAI API key in the string"
    )
    assert "sk-***" in redacted, (
        "SecretRedactor should replace the OpenAI key with the 'sk-***' placeholder"
    )


def test_secret_redactor_masks_anthropic_key() -> None:
    """SecretRedactor must replace Anthropic API keys with a masked placeholder."""
    raw = "auth header: sk-ant-api03-XXXXXXXXXXXXXXXXXXXX"
    redacted = _redact_string(raw)

    assert "sk-ant-api03" not in redacted, (
        "SecretRedactor must replace the Anthropic API key pattern in the string"
    )


def test_secret_redactor_masks_bearer_token() -> None:
    """SecretRedactor must replace Bearer tokens in strings."""
    raw = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
    redacted = _redact_string(raw)

    assert "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" not in redacted, (
        "SecretRedactor must replace Bearer token values to prevent credential leakage"
    )


def test_secret_redactor_processor_handles_event_dict() -> None:
    """SecretRedactor structlog processor should redact secrets from all string values."""
    redactor = SecretRedactor()
    event_dict: dict[str, Any] = {
        "event": "gateway_request",
        "api_key": "sk-AAAAAAAAAAAAAAAAAAAAAA",
        "url": "http://bifrost:4000",
        "nested": {
            "token": "Bearer sk-BBBBBBBBBBBBBBBBBBBBBB",
        },
    }

    redacted = redactor(None, "info", event_dict)

    assert "sk-AAA" not in str(redacted["api_key"]), (
        "SecretRedactor processor must mask API key values in the event dict"
    )
    assert "sk-BBB" not in str(redacted["nested"]["token"]), (
        "SecretRedactor processor must recursively redact secrets in nested dicts"
    )
    assert redacted["url"] == "http://bifrost:4000", (
        "SecretRedactor must preserve non-secret values unchanged"
    )


def test_secret_redactor_does_not_alter_safe_strings() -> None:
    """SecretRedactor should leave normal strings that contain no secrets unchanged."""
    raw = "The weather is nice today with temperature 25 degrees"
    redacted = _redact_string(raw)

    assert redacted == raw, "SecretRedactor must not modify strings that contain no secret patterns"


def test_secret_redactor_handles_list_values() -> None:
    """SecretRedactor processor should redact secrets inside list values."""
    redactor = SecretRedactor()
    event_dict: dict[str, Any] = {
        "event": "test",
        "tokens": ["sk-AAAAAAAAAAAAAAAAAAAAAA", "safe-value"],
    }

    redacted = redactor(None, "info", event_dict)

    tokens = redacted["tokens"]
    assert isinstance(tokens, list), "List values must remain as lists after redaction"
    assert "sk-AAA" not in tokens[0], (
        "SecretRedactor must redact secret patterns inside list values"
    )
    assert tokens[1] == "safe-value", "SecretRedactor must leave non-secret list items unchanged"


# ---------------------------------------------------------------------------
# Tests: gateway error propagation to framework layer
# ---------------------------------------------------------------------------


async def test_gateway_rate_limit_raises_gateway_error() -> None:
    """Rate-limit errors from the HTTP client should surface as GatewayError."""
    import httpx

    mock_response = httpx.Response(
        429, request=httpx.Request("POST", "http://mock-bifrost:4000/chat/completions")
    )
    http_client = MagicMock(spec=HttpLLMClient)
    http_client.complete = AsyncMock(
        side_effect=httpx.HTTPStatusError(
            message="rate limited",
            request=mock_response.request,
            response=mock_response,
        )
    )
    gateway = _make_gateway(http_client=http_client)

    with pytest.raises(GatewayError) as exc_info:
        await gateway.complete(
            messages=[{"role": "user", "content": "hello"}],
            model="openai/gpt-4o",
        )

    assert "Rate limited" in str(exc_info.value), (
        "GatewayError for rate limiting should include a human-readable rate-limit message"
    )


async def test_gateway_auth_failure_raises_gateway_error() -> None:
    """Authentication failures from the HTTP client should surface as GatewayError."""
    import httpx

    mock_response = httpx.Response(
        401, request=httpx.Request("POST", "http://mock-bifrost:4000/chat/completions")
    )
    http_client = MagicMock(spec=HttpLLMClient)
    http_client.complete = AsyncMock(
        side_effect=httpx.HTTPStatusError(
            message="invalid key",
            request=mock_response.request,
            response=mock_response,
        )
    )
    gateway = _make_gateway(http_client=http_client)

    with pytest.raises(GatewayError) as exc_info:
        await gateway.complete(
            messages=[{"role": "user", "content": "hello"}],
            model="openai/gpt-4o",
        )

    assert "authentication" in str(exc_info.value).lower(), (
        "GatewayError for auth failure should include the word 'authentication'"
    )


async def test_gateway_generic_error_wraps_into_gateway_error() -> None:
    """Unexpected exceptions from the HTTP client must be wrapped in GatewayError."""
    http_client = MagicMock(spec=HttpLLMClient)
    http_client.complete = AsyncMock(side_effect=ConnectionRefusedError("connection refused"))
    gateway = _make_gateway(http_client=http_client)

    with pytest.raises(GatewayError) as exc_info:
        await gateway.complete(
            messages=[{"role": "user", "content": "hello"}],
            model="openai/gpt-4o",
        )

    assert exc_info.value.__cause__ is not None, (
        "GatewayError should chain the original exception via __cause__"
    )
    assert isinstance(exc_info.value.__cause__, ConnectionRefusedError), (
        "The chained exception must be the original ConnectionRefusedError"
    )


# ---------------------------------------------------------------------------
# Tests: gateway health check boundary
# ---------------------------------------------------------------------------


async def test_gateway_health_check_returns_dict_with_required_keys() -> None:
    """check_health() must return a dict with 'healthy' and 'latency_ms' keys."""
    gateway = _make_gateway()

    with patch("httpx.AsyncClient") as mock_client_cls:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(return_value=mock_resp)
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=None)

        result = await gateway.check_health()

    assert "healthy" in result, "check_health() must return a dict with a 'healthy' boolean key"
    assert "latency_ms" in result, (
        "check_health() must return a dict with a 'latency_ms' numeric key"
    )
    assert result["healthy"] is True, (
        "check_health() should return healthy=True when /health returns HTTP 200"
    )


async def test_gateway_health_check_returns_unhealthy_on_exception() -> None:
    """check_health() should return healthy=False when the HTTP call fails."""
    gateway = _make_gateway()

    with patch("httpx.AsyncClient") as mock_client_cls:
        mock_client = AsyncMock()
        mock_client.get = AsyncMock(side_effect=ConnectionRefusedError("refused"))
        mock_client_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=None)

        result = await gateway.check_health()

    assert result["healthy"] is False, (
        "check_health() should return healthy=False when the /health endpoint is unreachable"
    )
    assert result["latency_ms"] == -1, (
        "check_health() should return latency_ms=-1 when the request fails"
    )
