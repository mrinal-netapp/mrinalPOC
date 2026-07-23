"""HttpLLMClient — protocol interface and Bifrost httpx implementation.

This module defines the ``HttpLLMClient`` Protocol that decouples the
``LLMGateway`` from any specific SDK (Dependency Inversion Principle). Any
implementation that satisfies the protocol may be injected into the gateway
without code changes — useful for testing, alternative backends, or future
migrations.

The ``BifrostClient`` is the production implementation that uses ``httpx`` to
send OpenAI-compatible requests directly to the Bifrost proxy.

Example::

    from agent_service_maf.gateway.http_llm_client import BifrostClient

    client = BifrostClient(
        api_base="https://bifrost.example.io/v1",
        api_key="sk-bifrost-1234",
        timeout=30.0,
    )
    response = await client.complete(
        messages=[{"role": "user", "content": "hello"}],
        model="azure/gpt-4.1-mini",
    )
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextvars import ContextVar
from typing import Any, Protocol, runtime_checkable

import httpx
import structlog

logger = structlog.get_logger(__name__)


# Per-invocation override map. The adapter sets this immediately before
# ``agent.runner.run(...)`` and resets it in a ``finally`` block so the
# extra headers are scoped to exactly one chat-completion request and
# can't leak into concurrent invocations (the same ``BifrostClient``
# instance is shared across asyncio tasks; a ContextVar is task-scoped).
#
# Current sole consumer: per-agent ``x-bf-mcp-include-tools`` filtering,
# which has to override the project VK's auto-generated MCP scope.
# Intentionally generic so future per-request headers don't need
# another ContextVar.
_REQUEST_EXTRA_HEADERS: ContextVar[dict[str, str] | None] = ContextVar(
    "bifrost_request_extra_headers", default=None
)


def set_request_extra_headers(headers: dict[str, str] | None) -> Any:  # noqa: ANN401
    """Bind per-request headers; pass the returned token to ``reset_request_extra_headers``.

    Return type is ``Any`` (rather than ``object``) because ``ContextVar.set``
    returns a ``contextvars.Token`` -- a generic-parameterized type whose
    public surface callers should not depend on. ``Any`` matches the
    convention used elsewhere in this module for the token/opaque-handle
    pattern and avoids a misleading ``object`` annotation.
    """
    return _REQUEST_EXTRA_HEADERS.set(headers)


def reset_request_extra_headers(token: Any) -> None:  # noqa: ANN401
    """Restore the previous per-request header binding.

    ``token`` is the opaque handle returned by ``set_request_extra_headers``.
    Typed as ``Any`` for the same reason as the setter's return type.
    """
    _REQUEST_EXTRA_HEADERS.reset(token)


@runtime_checkable
class HttpLLMClient(Protocol):
    """Protocol for HTTP-based LLM completion clients.

    Implement this protocol to swap the underlying HTTP client without touching
    ``LLMGateway``. Both methods must be ``async``.

    Implementors MUST return normalized dicts — not raw SDK response objects —
    so that ``LLMGateway`` is not coupled to any specific SDK response shape.

    The ``complete`` dict keys are::

        {
            "content":    str,            # The assistant's text response
            "tool_calls": list[dict],     # OpenAI-format tool call objects (may be empty)
            "usage":      dict,           # Raw usage dict from the provider
            "model":      str,            # Actual model used
        }

    Each ``stream_complete`` chunk dict has::

        {
            "content":      str,          # Incremental text delta
            "tool_calls":   list | None,  # Incremental tool call delta or None
            "finish_reason": str | None,  # "stop", "tool_calls", etc., or None
        }
    """

    async def complete(  # noqa: ANN401
        self,
        messages: list[dict[str, Any]],
        model: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,  # noqa: ANN401
    ) -> dict[str, Any]:
        """Send a completion request to the LLM provider.

        Args:
            messages: Conversation history as a list of role/content dicts.
            model: Model identifier string (e.g. ``azure/gpt-4.1-mini``).
            temperature: Sampling temperature override. ``None`` uses provider default.
            max_tokens: Maximum output tokens. ``None`` uses provider default.
            tools: Optional list of tool definitions in OpenAI function-call format.
            **kwargs: Additional provider-specific parameters forwarded as-is.

        Returns:
            Normalized dict with ``content``, ``tool_calls``, ``usage``, and ``model`` keys.

        Raises:
            httpx.HTTPStatusError: On non-2xx responses from the proxy.
            httpx.TimeoutException: If the request exceeds the configured timeout.
        """
        ...

    async def stream_complete(  # noqa: ANN401
        self,
        messages: list[dict[str, Any]],
        model: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,  # noqa: ANN401
    ) -> AsyncIterator[dict[str, Any]]:
        """Send a streaming completion request to the LLM provider.

        Args:
            messages: Conversation history as a list of role/content dicts.
            model: Model identifier string.
            temperature: Sampling temperature override.
            max_tokens: Maximum output tokens.
            tools: Optional list of tool definitions.
            **kwargs: Additional provider-specific parameters.

        Yields:
            Chunk dicts with ``content``, ``tool_calls``, and ``finish_reason`` keys.

        Raises:
            httpx.HTTPStatusError: On non-2xx responses from the proxy.
            httpx.TimeoutException: If the request exceeds the configured timeout.
        """
        ...


class BifrostClient:
    """httpx-based HTTP client that sends OpenAI-compatible requests to Bifrost.

    Sends raw JSON POST requests to ``{api_base}/chat/completions``. Bifrost
    handles all provider routing (Azure, Anthropic, OpenAI, etc.) based on the
    model string — no client-side model interpretation needed.

    Args:
        api_base: Base URL of the Bifrost proxy
            (e.g. ``"https://bifrost.example.io/v1"``).
        api_key: Authentication key for the proxy. Pass ``""`` if no key is
            required (the proxy itself handles upstream provider keys).
        timeout: Per-request timeout in seconds. Defaults to 30.0.

    Example::

        client = BifrostClient("https://bifrost.example.io/v1", api_key="sk-test", timeout=60.0)
        resp = await client.complete(
            messages=[{"role": "user", "content": "hi"}],
            model="azure/gpt-4.1-mini",
        )
        print(resp["content"])
    """

    def __init__(
        self,
        api_base: str,
        api_key: str,
        timeout: float = 30.0,
        *,
        forward_user_identity: bool = True,
        forward_user_token: bool = False,
    ) -> None:
        # Implementation note: per-request header overrides are stored
        # on the module-level ContextVar declared below, NOT on the
        # instance. The same ``BifrostClient`` is shared across async
        # tasks, so an instance attribute would race; the ContextVar
        # is scoped to the asyncio task that ``adapter`` runs in.
        self.api_base = api_base.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        # §F1+F2 — identity-propagation knobs. Default is "attribution
        # headers on, user token off" because Bifrost generally
        # cannot validate user JWTs but operators still want
        # per-user observability / rate-limit attribution. Per
        # deployment, enabling ``forward_user_token`` plugs in audit
        # / forward-to-provider scenarios.
        self._forward_user_identity = forward_user_identity
        self._forward_user_token = forward_user_token

    def _build_headers(self) -> dict[str, str]:
        """Build HTTP headers for Bifrost requests.

        Always carries:
        * ``Content-Type: application/json``
        * ``Authorization: Bearer <BIFROST_API_KEY>`` -- the
          Bifrost service-account token (§3 two-token model). NEVER
          replaced with the inbound user JWT; Bifrost authenticates
          MAF *as itself*.

        Conditionally adds, when an :class:`IdentityContext` is bound
        and the corresponding feature flag is enabled:
        * ``X-User-ID`` / ``X-Project-ID`` / ``X-User-Email`` /
          ``X-User-Name`` -- when ``forward_user_identity`` is true
          (default).
        * ``X-User-Token`` -- when ``forward_user_token`` is true
          (default off).
        """
        headers: dict[str, str] = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        # Lazy import to avoid a hard dep at module-load time
        # (callers may construct ``BifrostClient`` directly in tests
        # before any identity is bound).
        from agent_service_maf.core.identity import get_current_identity

        identity = get_current_identity()
        if identity is None:
            return headers

        if self._forward_user_identity:
            if identity.user_id:
                headers["X-User-ID"] = identity.user_id
            if identity.project_id:
                headers["X-Project-ID"] = identity.project_id
            if identity.user_email:
                headers["X-User-Email"] = identity.user_email
            if identity.user_name:
                headers["X-User-Name"] = identity.user_name
            if identity.correlation_id:
                headers["X-Correlation-ID"] = identity.correlation_id

        if self._forward_user_token and identity.user_token:
            headers["X-User-Token"] = identity.user_token

        # Per-invocation overrides set by the adapter (see
        # set_request_extra_headers). Applied last so they win over
        # anything above -- the adapter is closest to the agent
        # definition and is the source of truth for per-request scoping
        # (notably the ``x-bf-mcp-include-tools`` MCP filter).
        extra = _REQUEST_EXTRA_HEADERS.get()
        if extra:
            headers.update(extra)

        return headers

    def _build_payload(
        self,
        messages: list[dict[str, Any]],
        model: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
        tools: list[dict[str, Any]] | None = None,
        stream: bool = False,
        **kwargs: Any,  # noqa: ANN401
    ) -> dict[str, Any]:
        """Build the OpenAI-compatible request payload."""
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
        }
        if temperature is not None:
            payload["temperature"] = temperature
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        if tools is not None:
            payload["tools"] = tools
        payload["stream"] = stream
        payload.update(kwargs)
        return payload

    async def complete(  # noqa: ANN401
        self,
        messages: list[dict[str, Any]],
        model: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,  # noqa: ANN401
    ) -> dict[str, Any]:
        """Send a completion request to Bifrost.

        Args:
            messages: Conversation history as a list of role/content dicts.
            model: Model identifier string.
            temperature: Sampling temperature override.
            max_tokens: Maximum output tokens.
            tools: Optional list of OpenAI-format tool definitions.
            **kwargs: Additional parameters included in the request payload.

        Returns:
            Normalized dict with ``content``, ``tool_calls``, ``usage``, and ``model``.

        Raises:
            httpx.HTTPStatusError: On non-2xx responses from Bifrost.
            httpx.TimeoutException: If the request exceeds ``self.timeout``.
        """
        url = f"{self.api_base}/chat/completions"
        payload = self._build_payload(
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            tools=tools,
            **kwargs,
        )

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(url, json=payload, headers=self._build_headers())
            resp.raise_for_status()
            data = resp.json()

        choice = data["choices"][0]
        message = choice["message"]
        raw_usage = data.get("usage") or {}

        usage_dict: dict[str, Any] = {
            "prompt_tokens": raw_usage.get("prompt_tokens", 0),
            "completion_tokens": raw_usage.get("completion_tokens", 0),
            "total_tokens": raw_usage.get("total_tokens", 0),
            "cost": raw_usage.get("cost", 0.0),
        }

        raw_tool_calls = message.get("tool_calls") or []
        tool_calls: list[dict[str, Any]] = []
        for tc in raw_tool_calls:
            fn = tc.get("function", {})
            tool_calls.append(
                {
                    "id": tc.get("id", ""),
                    "type": tc.get("type", "function"),
                    "function": {
                        "name": fn.get("name", ""),
                        "arguments": fn.get("arguments", "{}"),
                    },
                }
            )

        return {
            "content": message.get("content") or "",
            "tool_calls": tool_calls,
            "usage": usage_dict,
            "model": data.get("model", model),
        }

    async def stream_complete(  # noqa: ANN401
        self,
        messages: list[dict[str, Any]],
        model: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,  # noqa: ANN401
    ) -> AsyncIterator[dict[str, Any]]:
        """Send a streaming completion request to Bifrost.

        Args:
            messages: Conversation history as a list of role/content dicts.
            model: Model identifier string.
            temperature: Sampling temperature override.
            max_tokens: Maximum output tokens.
            tools: Optional list of OpenAI-format tool definitions.
            **kwargs: Additional parameters included in the request payload.

        Yields:
            Chunk dicts with ``content``, ``tool_calls``, and ``finish_reason`` keys.

        Raises:
            httpx.HTTPStatusError: On non-2xx responses from Bifrost.
            httpx.TimeoutException: If the request exceeds ``self.timeout``.
        """
        url = f"{self.api_base}/chat/completions"
        payload = self._build_payload(
            messages=messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            tools=tools,
            stream=True,
            **kwargs,
        )

        # Parse SSE chunks inside the httpx context managers, then yield
        # from a collected list. This avoids the "Attempted to access
        # streaming response content without having called read()" error
        # that occurs when an async generator is abandoned while httpx
        # context managers are still open (e.g. SK InProcessRuntime
        # deep-copies agents and may not fully drain the generator).
        chunks: list[dict[str, Any]] = []

        async with (
            httpx.AsyncClient(timeout=self.timeout) as client,
            client.stream("POST", url, json=payload, headers=self._build_headers()) as resp,
        ):
            if resp.status_code >= 400:
                await resp.aread()
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                data_str = line[len("data: ") :]
                if data_str.strip() == "[DONE]":
                    break
                try:
                    chunk = json.loads(data_str)
                except json.JSONDecodeError:
                    continue

                # Bifrost emits a terminal chunk carrying token usage in
                # ``chunk["usage"]`` (Azure / OpenAI shape). Older provider
                # streams emit ``usage: null`` on every chunk and never
                # surface it — those degrade gracefully (accumulator stays
                # at zero). The terminal usage chunk also still has a
                # ``choices`` entry, so we read both fields together.
                #
                # Defensive: ``choices`` is typed as a list in the OpenAI
                # spec but some proxies/providers ship it as a dict (or omit
                # it entirely). Indexing a dict with ``[0]`` would raise
                # ``KeyError`` and tear down the whole stream, so validate
                # the shape before indexing — anything that isn't a non-empty
                # list collapses to the empty-choice fallback used below.
                raw_choices = chunk.get("choices")
                if isinstance(raw_choices, list) and raw_choices:
                    first_choice = raw_choices[0]
                else:
                    first_choice = {}
                if isinstance(first_choice, dict):
                    delta = first_choice.get("delta", {})
                    finish_reason = first_choice.get("finish_reason")
                else:
                    delta = {}
                    finish_reason = None
                raw_usage = chunk.get("usage")

                raw_tc = delta.get("tool_calls")
                tool_calls_chunk: list[dict[str, Any]] | None = None
                if raw_tc:
                    tool_calls_chunk = []
                    for tc in raw_tc:
                        fn = tc.get("function", {})
                        tool_calls_chunk.append(
                            {
                                "id": tc.get("id", ""),
                                "type": tc.get("type", "function"),
                                "function": {
                                    "name": fn.get("name", ""),
                                    "arguments": fn.get("arguments", ""),
                                },
                            }
                        )

                chunks.append(
                    {
                        "content": delta.get("content") or "",
                        "tool_calls": tool_calls_chunk,
                        "finish_reason": finish_reason,
                        "usage": raw_usage if isinstance(raw_usage, dict) else None,
                    }
                )

        # Yield outside the httpx context managers — safe even if the
        # consumer abandons the generator mid-iteration.
        for c in chunks:
            yield c
