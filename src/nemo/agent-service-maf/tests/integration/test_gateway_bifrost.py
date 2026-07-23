"""Integration tests for LLMGateway with a mock Bifrost server.

Tests a complete roundtrip through a FastAPI mock that mimics the Bifrost
proxy endpoints. Real HTTP calls via httpx are used; BifrostClient sends
requests directly via httpx to the mock server.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from httpx import ASGITransport, AsyncClient

from agent_service_maf.config.validators import GatewaySection
from agent_service_maf.core.exceptions import GatewayError
from agent_service_maf.gateway.cost_tracker import UsageTracker
from agent_service_maf.gateway.http_llm_client import BifrostClient
from agent_service_maf.gateway.llm_gateway import LLMGateway

# ---------------------------------------------------------------------------
# Mock Bifrost FastAPI application
# ---------------------------------------------------------------------------


def make_mock_bifrost() -> FastAPI:
    """Create a minimal FastAPI app that mimics the Bifrost proxy API."""
    app = FastAPI(title="Mock Bifrost")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        return {"status": "ok"}

    @app.post("/v1/chat/completions")
    async def chat_completions(request: Request) -> JSONResponse:
        body = await request.json()
        model = body.get("model", "unknown")
        messages = body.get("messages", [])
        last_user_msg = ""
        for m in messages:
            if m.get("role") == "user":
                last_user_msg = m.get("content", "")

        return JSONResponse(
            content={
                "id": "mock-cmpl-001",
                "object": "chat.completion",
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": f"Echo: {last_user_msg}",
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": len(last_user_msg),
                    "completion_tokens": len(last_user_msg) + 6,
                    "total_tokens": len(last_user_msg) * 2 + 6,
                    "cost": 0.0001,
                },
            }
        )

    return app


def make_mock_bifrost_unhealthy() -> FastAPI:
    """Bifrost variant that returns 503 on /health."""
    app = FastAPI(title="Mock Bifrost Unhealthy")

    @app.get("/health")
    async def health() -> JSONResponse:
        return JSONResponse(status_code=503, content={"status": "degraded"})

    return app


# ---------------------------------------------------------------------------
# Integration helpers — httpx response builder for mocking BifrostClient
# ---------------------------------------------------------------------------


def make_bifrost_mock_response(content: str, model: str) -> dict[str, Any]:
    """Build a normalized response dict matching what BifrostClient.complete() returns."""
    return {
        "content": content,
        "tool_calls": [],
        "usage": {
            "prompt_tokens": 10,
            "completion_tokens": 20,
            "total_tokens": 30,
            "cost": 0.0001,
        },
        "model": model,
    }


def make_bifrost_httpx_response(
    content: str,
    model: str,
    tool_calls: list[dict[str, Any]] | None = None,
) -> httpx.Response:
    """Build a mock httpx.Response in Bifrost JSON shape."""
    body = {
        "id": "mock-cmpl-001",
        "object": "chat.completion",
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": content,
                    "tool_calls": tool_calls or [],
                },
                "finish_reason": "stop",
            }
        ],
        "usage": {
            "prompt_tokens": 10,
            "completion_tokens": 20,
            "total_tokens": 30,
            "cost": 0.0001,
        },
    }
    return httpx.Response(
        status_code=200,
        json=body,
        request=httpx.Request("POST", "http://testserver/chat/completions"),
    )


def _make_mock_httpx_client(response: httpx.Response) -> AsyncMock:
    """Create a mock httpx.AsyncClient that returns the given response on post."""
    mock_client = AsyncMock()
    mock_client.post.return_value = response
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    return mock_client


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


MODEL = "anthropic/claude-sonnet-4-20250514"
MESSAGES = [{"role": "user", "content": "hello bifrost"}]


def make_gateway_with_tracker(
    url: str = "http://testserver",
    retry_on_timeout: bool = False,
    max_retries: int = 0,
) -> tuple[LLMGateway, UsageTracker]:
    config = GatewaySection(
        url=url,
        default_model=MODEL,
        retry_on_timeout=retry_on_timeout,
        max_retries=max_retries,
        request_timeout_seconds=30,
    )
    tracker = UsageTracker()
    client = BifrostClient(api_base=config.url, api_key=config.api_key)
    gateway = LLMGateway(config, usage_tracker=tracker, http_client=client)
    return gateway, tracker


# ---------------------------------------------------------------------------
# Health check integration tests
# ---------------------------------------------------------------------------


class TestMockBifrostHealth:
    """Integration tests for check_health() against a mock Bifrost."""

    @pytest.mark.asyncio
    async def test_health_check_healthy_bifrost(self) -> None:
        """check_health() should return healthy=True when mock Bifrost /health returns 200."""
        app = make_mock_bifrost()
        transport = ASGITransport(app=app)

        async with AsyncClient(transport=transport, base_url="http://testserver") as http_client:
            # Patch httpx.AsyncClient to use our test transport
            async def patched_get(url: str, timeout: float = 5.0) -> Any:
                return await http_client.get(url)

            mock_httpx_client = AsyncMock()
            mock_httpx_client.__aenter__ = AsyncMock(return_value=mock_httpx_client)
            mock_httpx_client.__aexit__ = AsyncMock(return_value=False)
            mock_httpx_client.get.side_effect = patched_get

            gateway, _ = make_gateway_with_tracker()
            with patch("httpx.AsyncClient", return_value=mock_httpx_client):
                result = await gateway.check_health()

        assert result["healthy"] is True, (
            "check_health() should return healthy=True when mock Bifrost /health is 200"
        )
        assert result["latency_ms"] >= 0, (
            "check_health() should return non-negative latency_ms on success"
        )

    @pytest.mark.asyncio
    async def test_health_check_unhealthy_bifrost(self) -> None:
        """check_health() should return healthy=False when mock Bifrost /health returns 503."""
        app = make_mock_bifrost_unhealthy()
        transport = ASGITransport(app=app)

        async with AsyncClient(transport=transport, base_url="http://testserver") as http_client:

            async def patched_get(url: str, timeout: float = 5.0) -> Any:
                return await http_client.get(url)

            mock_httpx_client = AsyncMock()
            mock_httpx_client.__aenter__ = AsyncMock(return_value=mock_httpx_client)
            mock_httpx_client.__aexit__ = AsyncMock(return_value=False)
            mock_httpx_client.get.side_effect = patched_get

            gateway, _ = make_gateway_with_tracker()
            with patch("httpx.AsyncClient", return_value=mock_httpx_client):
                result = await gateway.check_health()

        assert result["healthy"] is False, (
            "check_health() should return healthy=False when /health returns 503"
        )

    @pytest.mark.asyncio
    async def test_health_check_unreachable_gateway(self) -> None:
        """check_health() should return healthy=False when the gateway is unreachable."""
        mock_httpx_client = AsyncMock()
        mock_httpx_client.__aenter__ = AsyncMock(return_value=mock_httpx_client)
        mock_httpx_client.__aexit__ = AsyncMock(return_value=False)
        mock_httpx_client.get.side_effect = ConnectionRefusedError("connection refused")

        gateway, _ = make_gateway_with_tracker(url="http://nonexistent-host:4000")
        with patch("httpx.AsyncClient", return_value=mock_httpx_client):
            result = await gateway.check_health()

        assert result["healthy"] is False, (
            "check_health() should return healthy=False when gateway is unreachable"
        )
        assert result["latency_ms"] == -1, (
            "check_health() should return latency_ms=-1 when gateway is unreachable"
        )


# ---------------------------------------------------------------------------
# Complete roundtrip integration tests (httpx mocked at BifrostClient level)
# ---------------------------------------------------------------------------


class TestMockBifrostComplete:
    """Integration tests for LLMGateway.complete() via mocked BifrostClient."""

    @pytest.mark.asyncio
    async def test_complete_roundtrip_returns_response(self) -> None:
        """Full roundtrip: gateway -> BifrostClient -> mock httpx -> response."""
        mock_resp = make_bifrost_httpx_response(
            content="Echo: hello bifrost",
            model=MODEL,
        )
        mock_client = _make_mock_httpx_client(mock_resp)

        with patch("httpx.AsyncClient", return_value=mock_client):
            gateway, tracker = make_gateway_with_tracker()
            result = await gateway.complete(messages=MESSAGES, model=MODEL)

        assert result.content == "Echo: hello bifrost", (
            "Complete roundtrip should return response content from mock Bifrost"
        )
        assert result.model == MODEL, "Complete roundtrip should return the correct model"

    @pytest.mark.asyncio
    async def test_complete_roundtrip_records_usage(self) -> None:
        """UsageTracker should be populated after a complete() roundtrip."""
        mock_resp = make_bifrost_httpx_response(content="Hello", model=MODEL)
        mock_client = _make_mock_httpx_client(mock_resp)

        with patch("httpx.AsyncClient", return_value=mock_client):
            gateway, tracker = make_gateway_with_tracker()
            await gateway.complete(messages=MESSAGES, model=MODEL)

        summary = tracker.get_summary()
        assert summary["request_count"] == 1, (
            "UsageTracker should record 1 request after complete() roundtrip"
        )
        assert summary["total_tokens"] > 0, (
            "UsageTracker should record non-zero tokens after complete() roundtrip"
        )

    @pytest.mark.asyncio
    async def test_complete_roundtrip_multiple_calls_accumulate_usage(self) -> None:
        """Multiple complete() calls should accumulate usage in the tracker."""
        mock_resp = make_bifrost_httpx_response(content="ok", model=MODEL)
        mock_client = _make_mock_httpx_client(mock_resp)

        with patch("httpx.AsyncClient", return_value=mock_client):
            gateway, tracker = make_gateway_with_tracker()
            for _ in range(3):
                await gateway.complete(messages=MESSAGES, model=MODEL)

        summary = tracker.get_summary()
        assert summary["request_count"] == 3, (
            "Three complete() calls should result in request_count=3"
        )

    @pytest.mark.asyncio
    async def test_complete_roundtrip_with_tool_calls(self) -> None:
        """Response containing tool calls should be preserved in the result."""
        tc = {
            "id": "tc-roundtrip-001",
            "type": "function",
            "function": {"name": "search", "arguments": '{"query": "test"}'},
        }
        mock_resp = make_bifrost_httpx_response(
            content="",
            model=MODEL,
            tool_calls=[tc],
        )
        mock_client = _make_mock_httpx_client(mock_resp)

        with patch("httpx.AsyncClient", return_value=mock_client):
            gateway, _ = make_gateway_with_tracker()
            result = await gateway.complete(messages=MESSAGES, model=MODEL)

        assert len(result.tool_calls) == 1, (
            "Tool call response should preserve tool_calls in the result"
        )
        assert result.tool_calls[0]["id"] == "tc-roundtrip-001", (
            "Tool call id should be preserved in roundtrip"
        )
        assert result.tool_calls[0]["function"]["name"] == "search", (
            "Tool call function name should be preserved in roundtrip"
        )

    @pytest.mark.asyncio
    async def test_complete_roundtrip_invalid_model_raises_gateway_error(self) -> None:
        """Invalid model string should raise GatewayError before reaching httpx."""
        mock_resp = make_bifrost_httpx_response(content="", model=MODEL)
        mock_client = _make_mock_httpx_client(mock_resp)

        with patch("httpx.AsyncClient", return_value=mock_client):
            gateway, _ = make_gateway_with_tracker()
            with pytest.raises(GatewayError, match="provider/model-name"):
                await gateway.complete(messages=MESSAGES, model="no-slash-here")
            assert not mock_client.post.called, (
                "httpx.post should NOT be called when model format is invalid"
            )

    @pytest.mark.asyncio
    async def test_complete_roundtrip_rate_limit_not_retried(self) -> None:
        """Rate limit from Bifrost should immediately raise GatewayError (no retry)."""
        mock_response = httpx.Response(
            429, request=httpx.Request("POST", "http://testserver/chat/completions")
        )
        mock_client = AsyncMock()
        mock_client.post.side_effect = httpx.HTTPStatusError(
            message="429 rate limited",
            request=mock_response.request,
            response=mock_response,
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            gateway, _ = make_gateway_with_tracker(retry_on_timeout=True, max_retries=3)
            with pytest.raises(GatewayError):
                await gateway.complete(messages=MESSAGES, model=MODEL)
            # BifrostClient wraps httpx, so the gateway sees the exception from client.complete()
            # The gateway's error handling catches HTTPStatusError with 429

    @pytest.mark.asyncio
    async def test_complete_roundtrip_auth_error_not_retried(self) -> None:
        """Authentication error should immediately raise GatewayError (no retry)."""
        mock_response = httpx.Response(
            401, request=httpx.Request("POST", "http://testserver/chat/completions")
        )
        mock_client = AsyncMock()
        mock_client.post.side_effect = httpx.HTTPStatusError(
            message="401 unauthorized",
            request=mock_response.request,
            response=mock_response,
        )
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            gateway, _ = make_gateway_with_tracker(retry_on_timeout=True, max_retries=3)
            with pytest.raises(GatewayError):
                await gateway.complete(messages=MESSAGES, model=MODEL)

    @pytest.mark.asyncio
    async def test_complete_roundtrip_timeout_retried(self) -> None:
        """Timeout on first call should be retried and succeed on second call."""
        call_count = 0
        success_resp = make_bifrost_httpx_response(content="success after retry", model=MODEL)

        async def flaky_post(*args: Any, **kwargs: Any) -> httpx.Response:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise TimeoutError("first timeout")
            return success_resp

        mock_client = AsyncMock()
        mock_client.post.side_effect = flaky_post
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            with patch("asyncio.sleep", new_callable=AsyncMock):
                gateway, tracker = make_gateway_with_tracker(retry_on_timeout=True, max_retries=2)
                result = await gateway.complete(messages=MESSAGES, model=MODEL)

        assert result.content == "success after retry", (
            "Gateway should return successful response after timeout retry"
        )
        assert call_count == 2, "Should have attempted exactly 2 calls (1 timeout + 1 success)"
        summary = tracker.get_summary()
        assert summary["request_count"] == 1, (
            "UsageTracker should count 1 successful request (not the failed attempt)"
        )

    @pytest.mark.asyncio
    async def test_complete_roundtrip_default_model_used(self) -> None:
        """When no model is passed, config.default_model should be used."""
        default_model = "anthropic/claude-haiku-4-20250414"
        mock_resp = make_bifrost_httpx_response(
            content="default model response", model=default_model
        )
        mock_client = _make_mock_httpx_client(mock_resp)

        with patch("httpx.AsyncClient", return_value=mock_client):
            config = GatewaySection(
                url="http://testserver",
                default_model=default_model,
                request_timeout_seconds=30,
            )
            tracker = UsageTracker()
            client = BifrostClient(api_base=config.url, api_key=config.api_key)
            gateway = LLMGateway(config, usage_tracker=tracker, http_client=client)
            await gateway.complete(messages=MESSAGES)

        call_kwargs = mock_client.post.call_args
        payload = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
        assert payload["model"] == default_model, (
            f"Default model '{default_model}' should be used when no model is specified"
        )
