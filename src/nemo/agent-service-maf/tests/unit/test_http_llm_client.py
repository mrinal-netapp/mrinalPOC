"""Unit tests for BifrostClient (HttpLLMClient implementation).

Tests cover complete(), stream_complete(), response normalization,
and edge cases like missing usage fields.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from agent_service_maf.gateway.http_llm_client import BifrostClient, HttpLLMClient

# ---------------------------------------------------------------------------
# Helpers to build mock httpx responses
# ---------------------------------------------------------------------------


def make_httpx_response(
    content: str = "Hello",
    model: str = "anthropic/claude-sonnet-4-20250514",
    tool_calls: list[dict[str, Any]] | None = None,
    usage: dict[str, Any] | None = None,
    status_code: int = 200,
) -> httpx.Response:
    """Build a mock httpx.Response matching Bifrost JSON shape."""
    if usage is None:
        usage = {
            "prompt_tokens": 10,
            "completion_tokens": 20,
            "total_tokens": 30,
            "cost": 0.001,
        }
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
        "usage": usage,
    }
    return httpx.Response(
        status_code=status_code,
        json=body,
        request=httpx.Request("POST", "http://bifrost:4000/chat/completions"),
    )


def make_httpx_stream_lines(
    chunks: list[dict[str, Any]],
) -> list[str]:
    """Build SSE lines for streaming responses."""
    lines = []
    for chunk in chunks:
        lines.append(f"data: {json.dumps(chunk)}")
    lines.append("data: [DONE]")
    return lines


def make_stream_chunk_data(
    content: str = "",
    finish_reason: str | None = None,
    tool_calls: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build a single SSE chunk in OpenAI format."""
    delta: dict[str, Any] = {"content": content}
    if tool_calls is not None:
        delta["tool_calls"] = tool_calls
    return {
        "choices": [
            {
                "delta": delta,
                "finish_reason": finish_reason,
            }
        ]
    }


def make_mock_streaming_client(lines: list[str]) -> AsyncMock:
    """Build a mock httpx.AsyncClient suitable for stream_complete() tests.

    The mock properly supports ``async with client.stream(...) as resp``.
    """

    async def mock_aiter_lines() -> Any:
        for line in lines:
            yield line

    mock_stream_resp = MagicMock()
    mock_stream_resp.status_code = 200  # real int so ``if resp.status_code >= 400`` works
    mock_stream_resp.raise_for_status = MagicMock()
    mock_stream_resp.aiter_lines = mock_aiter_lines
    mock_stream_resp.__aenter__ = AsyncMock(return_value=mock_stream_resp)
    mock_stream_resp.__aexit__ = AsyncMock(return_value=False)

    mock_client = AsyncMock()
    # stream() is not a coroutine — it returns a context manager directly
    mock_client.stream = MagicMock(return_value=mock_stream_resp)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    return mock_client


# ---------------------------------------------------------------------------
# HttpLLMClient Protocol compliance
# ---------------------------------------------------------------------------


class TestHttpLLMClientProtocol:
    """Tests that BifrostClient satisfies the HttpLLMClient Protocol."""

    def test_bifrost_client_is_http_llm_client(self) -> None:
        client = BifrostClient(api_base="http://bifrost:4000", api_key="sk-test")
        assert isinstance(client, HttpLLMClient), (
            "BifrostClient should satisfy the HttpLLMClient Protocol via runtime_checkable"
        )


# ---------------------------------------------------------------------------
# BifrostClient construction
# ---------------------------------------------------------------------------


class TestBifrostClientInit:
    """Tests for BifrostClient constructor."""

    def test_api_base_stored(self) -> None:
        client = BifrostClient(api_base="http://bifrost:4000", api_key="sk-test")
        assert client.api_base == "http://bifrost:4000", "api_base should be stored on the client"

    def test_api_key_stored(self) -> None:
        client = BifrostClient(api_base="http://bifrost:4000", api_key="sk-test-key")
        assert client.api_key == "sk-test-key", "api_key should be stored on the client"

    def test_default_timeout(self) -> None:
        client = BifrostClient(api_base="http://bifrost:4000", api_key="")
        assert client.timeout == 30.0, "Default timeout should be 30.0 seconds"

    def test_custom_timeout(self) -> None:
        client = BifrostClient(api_base="http://bifrost:4000", api_key="", timeout=60.0)
        assert client.timeout == 60.0, "Custom timeout should be stored on the client"


# ---------------------------------------------------------------------------
# BifrostClient.complete()
# ---------------------------------------------------------------------------


class TestBifrostClientComplete:
    """Tests for BifrostClient.complete() delegation and normalization."""

    @pytest.mark.asyncio
    async def test_complete_calls_httpx_post(self) -> None:
        mock_resp = make_httpx_response(content="Hi there")
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            client = BifrostClient(api_base="http://bifrost:4000", api_key="sk-test")
            await client.complete(
                messages=[{"role": "user", "content": "Hello"}],
                model="anthropic/claude-sonnet-4-20250514",
            )
            assert mock_client.post.called, "complete() should delegate to httpx.AsyncClient.post"

    @pytest.mark.asyncio
    async def test_complete_passes_model_in_payload(self) -> None:
        mock_resp = make_httpx_response()
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            client = BifrostClient(api_base="http://bifrost:4000", api_key="sk-test")
            model = "openai/gpt-4o"
            await client.complete(
                messages=[{"role": "user", "content": "Hello"}],
                model=model,
            )
            call_kwargs = mock_client.post.call_args
            payload = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
            assert payload["model"] == model, (
                f"Model '{model}' should be passed in the httpx request payload"
            )

    @pytest.mark.asyncio
    async def test_complete_sends_authorization_header(self) -> None:
        mock_resp = make_httpx_response()
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            client = BifrostClient(api_base="http://my-proxy:9000", api_key="sk-mykey")
            await client.complete(
                messages=[{"role": "user", "content": "Hello"}],
                model="anthropic/claude-sonnet-4-20250514",
            )
            call_kwargs = mock_client.post.call_args
            headers = call_kwargs.kwargs.get("headers") or call_kwargs[1].get("headers")
            assert headers["Authorization"] == "Bearer sk-mykey", (
                "Authorization header should contain the api_key as Bearer token"
            )

    @pytest.mark.asyncio
    async def test_complete_normalizes_content(self) -> None:
        mock_resp = make_httpx_response(content="Hello, World!")
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            client = BifrostClient(api_base="http://bifrost:4000", api_key="sk-test")
            result = await client.complete(
                messages=[{"role": "user", "content": "Hello"}],
                model="anthropic/claude-sonnet-4-20250514",
            )
            assert result["content"] == "Hello, World!", (
                "complete() should normalize response content into result['content']"
            )

    @pytest.mark.asyncio
    async def test_complete_normalizes_usage(self) -> None:
        usage = {
            "prompt_tokens": 50,
            "completion_tokens": 100,
            "total_tokens": 150,
            "cost": 0.005,
        }
        mock_resp = make_httpx_response(usage=usage)
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            client = BifrostClient(api_base="http://bifrost:4000", api_key="sk-test")
            result = await client.complete(
                messages=[{"role": "user", "content": "Hello"}],
                model="anthropic/claude-sonnet-4-20250514",
            )
            assert result["usage"]["prompt_tokens"] == 50, (
                "Normalized usage should contain prompt_tokens"
            )
            assert result["usage"]["completion_tokens"] == 100, (
                "Normalized usage should contain completion_tokens"
            )
            assert result["usage"]["total_tokens"] == 150, (
                "Normalized usage should contain total_tokens"
            )
            assert result["usage"]["cost"] == pytest.approx(0.005, rel=1e-6), (
                "Normalized usage should contain cost from Bifrost"
            )

    @pytest.mark.asyncio
    async def test_complete_handles_missing_usage(self) -> None:
        """When response has no usage field, usage dict should have zero defaults."""
        body = {
            "id": "mock-cmpl-001",
            "object": "chat.completion",
            "model": "anthropic/claude-sonnet-4-20250514",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": "Hello", "tool_calls": []},
                    "finish_reason": "stop",
                }
            ],
        }
        mock_resp = httpx.Response(
            status_code=200,
            json=body,
            request=httpx.Request("POST", "http://bifrost:4000/chat/completions"),
        )
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            client = BifrostClient(api_base="http://bifrost:4000", api_key="sk-test")
            result = await client.complete(
                messages=[{"role": "user", "content": "Hello"}],
                model="anthropic/claude-sonnet-4-20250514",
            )
            assert result["usage"]["total_tokens"] == 0, (
                "Missing response usage should produce zero-valued usage dict"
            )

    @pytest.mark.asyncio
    async def test_complete_normalizes_model_from_response(self) -> None:
        mock_resp = make_httpx_response(model="openai/gpt-4o-mini")
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            client = BifrostClient(api_base="http://bifrost:4000", api_key="sk-test")
            result = await client.complete(
                messages=[{"role": "user", "content": "Hello"}],
                model="openai/gpt-4o",
            )
            assert result["model"] == "openai/gpt-4o-mini", (
                "Model in result should come from the response (may differ from request)"
            )

    @pytest.mark.asyncio
    async def test_complete_normalizes_tool_calls(self) -> None:
        tc = {
            "id": "tc-001",
            "type": "function",
            "function": {"name": "search", "arguments": '{"q": "test"}'},
        }
        mock_resp = make_httpx_response(tool_calls=[tc])
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            client = BifrostClient(api_base="http://bifrost:4000", api_key="sk-test")
            result = await client.complete(
                messages=[{"role": "user", "content": "Hello"}],
                model="anthropic/claude-sonnet-4-20250514",
            )
            assert len(result["tool_calls"]) == 1, "complete() should normalize tool_calls list"
            assert result["tool_calls"][0]["id"] == "tc-001", (
                "Tool call id should be preserved in normalization"
            )
            assert result["tool_calls"][0]["function"]["name"] == "search", (
                "Tool call function name should be preserved in normalization"
            )
            assert result["tool_calls"][0]["function"]["arguments"] == '{"q": "test"}', (
                "Tool call function arguments should be preserved in normalization"
            )

    @pytest.mark.asyncio
    async def test_complete_empty_tool_calls_in_response(self) -> None:
        mock_resp = make_httpx_response(tool_calls=[])
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            client = BifrostClient(api_base="http://bifrost:4000", api_key="sk-test")
            result = await client.complete(
                messages=[{"role": "user", "content": "Hello"}],
                model="anthropic/claude-sonnet-4-20250514",
            )
            assert result["tool_calls"] == [], (
                "When no tool calls are made, tool_calls should be empty list"
            )

    @pytest.mark.asyncio
    async def test_complete_passes_temperature_when_set(self) -> None:
        mock_resp = make_httpx_response()
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            client = BifrostClient(api_base="http://bifrost:4000", api_key="sk-test")
            await client.complete(
                messages=[{"role": "user", "content": "Hello"}],
                model="anthropic/claude-sonnet-4-20250514",
                temperature=0.5,
            )
            call_kwargs = mock_client.post.call_args
            payload = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
            assert payload["temperature"] == 0.5, (
                "temperature should be passed in the httpx request payload when set"
            )

    @pytest.mark.asyncio
    async def test_complete_skips_temperature_when_none(self) -> None:
        mock_resp = make_httpx_response()
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            client = BifrostClient(api_base="http://bifrost:4000", api_key="sk-test")
            await client.complete(
                messages=[{"role": "user", "content": "Hello"}],
                model="anthropic/claude-sonnet-4-20250514",
                temperature=None,
            )
            call_kwargs = mock_client.post.call_args
            payload = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
            assert "temperature" not in payload, (
                "temperature=None should NOT be included in the httpx request payload"
            )

    @pytest.mark.asyncio
    async def test_complete_passes_max_tokens_when_set(self) -> None:
        mock_resp = make_httpx_response()
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            client = BifrostClient(api_base="http://bifrost:4000", api_key="sk-test")
            await client.complete(
                messages=[{"role": "user", "content": "Hello"}],
                model="anthropic/claude-sonnet-4-20250514",
                max_tokens=1024,
            )
            call_kwargs = mock_client.post.call_args
            payload = call_kwargs.kwargs.get("json") or call_kwargs[1].get("json")
            assert payload["max_tokens"] == 1024, (
                "max_tokens should be passed in the httpx request payload when set"
            )

    @pytest.mark.asyncio
    async def test_complete_empty_api_key_no_auth_header(self) -> None:
        mock_resp = make_httpx_response()
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            client = BifrostClient(api_base="http://bifrost:4000", api_key="")
            await client.complete(
                messages=[{"role": "user", "content": "Hello"}],
                model="anthropic/claude-sonnet-4-20250514",
            )
            call_kwargs = mock_client.post.call_args
            headers = call_kwargs.kwargs.get("headers") or call_kwargs[1].get("headers")
            assert "Authorization" not in headers, (
                "Empty api_key should result in no Authorization header"
            )

    @pytest.mark.asyncio
    async def test_complete_null_message_content_returns_empty_string(self) -> None:
        body = {
            "id": "mock-cmpl-001",
            "object": "chat.completion",
            "model": "anthropic/claude-sonnet-4-20250514",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": None, "tool_calls": []},
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 20,
                "total_tokens": 30,
                "cost": 0.001,
            },
        }
        mock_resp = httpx.Response(
            status_code=200,
            json=body,
            request=httpx.Request("POST", "http://bifrost:4000/chat/completions"),
        )
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        with patch("httpx.AsyncClient", return_value=mock_client):
            client = BifrostClient(api_base="http://bifrost:4000", api_key="sk-test")
            result = await client.complete(
                messages=[{"role": "user", "content": "Hello"}],
                model="anthropic/claude-sonnet-4-20250514",
            )
            assert result["content"] == "", (
                "None message content should be normalized to empty string"
            )


# ---------------------------------------------------------------------------
# BifrostClient.stream_complete()
# ---------------------------------------------------------------------------


class TestBifrostClientStreamComplete:
    """Tests for BifrostClient.stream_complete() delegation and chunk normalization."""

    @pytest.mark.asyncio
    async def test_stream_complete_calls_httpx_with_stream_true(self) -> None:
        chunk_data = make_stream_chunk_data(content="Hello", finish_reason="stop")
        lines = make_httpx_stream_lines([chunk_data])
        mock_client = make_mock_streaming_client(lines)

        with patch("httpx.AsyncClient", return_value=mock_client):
            client = BifrostClient(api_base="http://bifrost:4000", api_key="sk-test")
            async for _ in client.stream_complete(
                messages=[{"role": "user", "content": "Hello"}],
                model="anthropic/claude-sonnet-4-20250514",
            ):
                pass
            call_args = mock_client.stream.call_args
            payload = call_args.kwargs.get("json") or call_args[1].get("json")
            assert payload.get("stream") is True, (
                "stream_complete() should send stream=True in the request payload"
            )

    @pytest.mark.asyncio
    async def test_stream_complete_yields_content_chunks(self) -> None:
        chunk_data_list = [
            make_stream_chunk_data(content="Hello", finish_reason=None),
            make_stream_chunk_data(content=" World", finish_reason="stop"),
        ]
        lines = make_httpx_stream_lines(chunk_data_list)
        mock_client = make_mock_streaming_client(lines)

        with patch("httpx.AsyncClient", return_value=mock_client):
            client = BifrostClient(api_base="http://bifrost:4000", api_key="sk-test")
            collected = []
            async for chunk in client.stream_complete(
                messages=[{"role": "user", "content": "Hello"}],
                model="anthropic/claude-sonnet-4-20250514",
            ):
                collected.append(chunk)

        assert len(collected) == 2, f"stream_complete() should yield 2 chunks, got {len(collected)}"
        assert collected[0]["content"] == "Hello", "First chunk content should be 'Hello'"
        assert collected[1]["content"] == " World", "Second chunk content should be ' World'"

    @pytest.mark.asyncio
    async def test_stream_complete_chunk_has_required_keys(self) -> None:
        chunk_data = make_stream_chunk_data(content="test", finish_reason="stop")
        lines = make_httpx_stream_lines([chunk_data])
        mock_client = make_mock_streaming_client(lines)

        with patch("httpx.AsyncClient", return_value=mock_client):
            client = BifrostClient(api_base="http://bifrost:4000", api_key="sk-test")
            async for chunk in client.stream_complete(
                messages=[{"role": "user", "content": "Hello"}],
                model="anthropic/claude-sonnet-4-20250514",
            ):
                required_keys = {"content", "tool_calls", "finish_reason"}
                assert required_keys.issubset(chunk.keys()), (
                    f"Streaming chunk should have keys {required_keys}, got {set(chunk.keys())}"
                )

    @pytest.mark.asyncio
    async def test_stream_complete_none_delta_content_yields_empty_string(self) -> None:
        chunk_data = {
            "choices": [
                {
                    "delta": {"content": None},
                    "finish_reason": "stop",
                }
            ]
        }
        lines = make_httpx_stream_lines([chunk_data])
        mock_client = make_mock_streaming_client(lines)

        with patch("httpx.AsyncClient", return_value=mock_client):
            client = BifrostClient(api_base="http://bifrost:4000", api_key="sk-test")
            collected = []
            async for c in client.stream_complete(
                messages=[{"role": "user", "content": "Hello"}],
                model="anthropic/claude-sonnet-4-20250514",
            ):
                collected.append(c)
        assert collected[0]["content"] == "", (
            "None delta content should be normalized to empty string in streaming"
        )

    @pytest.mark.asyncio
    async def test_stream_complete_tool_call_chunks_normalized(self) -> None:
        tc = {
            "id": "stream-tc",
            "type": "function",
            "function": {"name": "search", "arguments": '{"q": "test"}'},
        }
        chunk_data = {
            "choices": [
                {
                    "delta": {"content": "", "tool_calls": [tc]},
                    "finish_reason": "tool_calls",
                }
            ]
        }
        lines = make_httpx_stream_lines([chunk_data])
        mock_client = make_mock_streaming_client(lines)

        with patch("httpx.AsyncClient", return_value=mock_client):
            client = BifrostClient(api_base="http://bifrost:4000", api_key="sk-test")
            collected = []
            async for c in client.stream_complete(
                messages=[{"role": "user", "content": "Hello"}],
                model="anthropic/claude-sonnet-4-20250514",
            ):
                collected.append(c)

        assert collected[0]["tool_calls"] is not None, (
            "Streaming tool call chunk should have non-None tool_calls"
        )
        assert collected[0]["tool_calls"][0]["id"] == "stream-tc", (
            "Streaming tool call id should be preserved in normalization"
        )
