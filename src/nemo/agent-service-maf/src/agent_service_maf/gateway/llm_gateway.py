"""LLMGateway — thin client that routes all LLM calls through the Bifrost proxy.

This is the single point of LLM access for all agent adapters. Adapters MUST
NOT call LLM provider APIs directly; they MUST go through this gateway. The
gateway:

- Validates the model string format (``provider/model-name``).
- Delegates HTTP calls to an injected ``HttpLLMClient`` (DIP — swappable for
  testing or alternative backends).
- Retries on timeout with exponential backoff (never on 429 or 401).
- Records ``TokenUsage`` in the injected ``UsageTracker`` after every success.
- Maps all HTTP / provider exceptions to ``GatewayError``.
- Returns a typed ``LLMCompletionResponse`` Pydantic model (never a bare dict).
- Provides ``check_health()`` for the ``/health`` endpoint.

Tool execution via ``complete_with_tools()`` is a stub until Phase 5
(MCPManager + ToolRegistry) is available.

Example::

    from agent_service_maf.config.validators import GatewaySection
    from agent_service_maf.gateway.llm_gateway import LLMGateway
    from agent_service_maf.gateway.cost_tracker import UsageTracker
    from agent_service_maf.gateway.http_llm_client import BifrostClient

    config = GatewaySection(url="https://bifrost.example.io/v1")
    tracker = UsageTracker()
    client = BifrostClient(api_base=config.url, api_key=config.api_key)
    gateway = LLMGateway(config, usage_tracker=tracker, http_client=client)

    response = await gateway.complete(
        messages=[{"role": "user", "content": "hello"}],
    )
    print(response.content)
"""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

import httpx
import structlog
from pydantic import BaseModel

from agent_service_maf.config.validators import GatewaySection
from agent_service_maf.core.exceptions import GatewayError
from agent_service_maf.core.interfaces import TokenUsage
from agent_service_maf.gateway.cost_tracker import UsageTracker
from agent_service_maf.gateway.http_llm_client import BifrostClient, HttpLLMClient

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_MODEL_PATTERN: re.Pattern[str] = re.compile(r"^[A-Za-z0-9_\-\.]+/[A-Za-z0-9_\-\.]+$")
"""Model strings must follow the ``provider/model-name`` format expected by Bifrost."""


# ---------------------------------------------------------------------------
# Typed response models
# ---------------------------------------------------------------------------


class LLMCompletionResponse(BaseModel):
    """Typed response from a single LLM completion call through the gateway.

    All ``LLMGateway.complete()`` calls return this model. Callers should
    prefer accessing ``content`` and ``usage`` rather than the raw API dict.

    Attributes:
        content: The assistant's text reply.
        tool_calls: List of OpenAI-format tool-call objects. Empty when the LLM
            produced a plain text response with no tool invocations.
        usage: Token and cost figures as reported by Bifrost.
        model: Actual model used (may differ from requested if Bifrost routed
            to a fallback).
    """

    content: str
    tool_calls: list[dict[str, Any]] = []
    usage: TokenUsage
    model: str


# ---------------------------------------------------------------------------
# GatewayToolResult — placeholder until Phase 5
# ---------------------------------------------------------------------------


@dataclass
class GatewayToolResult:
    """Result of a multi-round tool-use conversation.

    Returned by ``LLMGateway.complete_with_tools()`` after the tool-use loop
    completes. Aggregates token usage across all LLM roundtrips.

    Attributes:
        content: The LLM's final text response after all tool calls are resolved.
        usage: Aggregated ``TokenUsage`` across every roundtrip in the loop.
        model: Model used for the completions.
        tool_calls_made: Number of tool-call rounds completed.
        tool_history: Ordered list of ``{"tool_name", "arguments", "result"}``
            dicts recording every tool invocation.
    """

    content: str
    usage: TokenUsage
    model: str
    tool_calls_made: int
    tool_history: list[dict[str, Any]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# LLMGateway
# ---------------------------------------------------------------------------


class LLMGateway:
    """Thin client that routes all agent LLM calls through the Bifrost proxy.

    All agent adapters in the framework must obtain an LLM response by calling
    ``complete()`` or ``stream_complete()`` on this gateway instance — they
    must never call provider APIs directly.

    Args:
        config: ``GatewaySection`` containing proxy URL, API key, timeout,
            retry settings, and default model.
        usage_tracker: Optional ``UsageTracker`` instance. If provided, usage
            is recorded after every successful completion. Defaults to a new
            ``UsageTracker`` when omitted.
        http_client: Optional ``HttpLLMClient`` implementation. If omitted, a
            ``BifrostClient`` is constructed from ``config``.

    Example::

        gateway = LLMGateway(config)
        response = await gateway.complete(
            messages=[{"role": "user", "content": "hi"}],
        )
        print(response.content)
    """

    def __init__(
        self,
        config: GatewaySection,
        usage_tracker: UsageTracker | None = None,
        http_client: HttpLLMClient | None = None,
    ) -> None:
        self.config = config
        self.usage_tracker: UsageTracker = usage_tracker or UsageTracker()
        # §F2 — pass identity-propagation knobs to the production
        # client. ``forward_user_identity`` defaults true (attribution
        # headers on); ``forward_user_token`` defaults false (opt in
        # per deployment).
        resolved_client: HttpLLMClient = http_client or BifrostClient(  # type: ignore[assignment]
            api_base=config.url,
            api_key=config.api_key,
            timeout=float(config.request_timeout_seconds),
            forward_user_identity=getattr(config, "forward_user_identity", True),
            forward_user_token=getattr(config, "forward_user_token", False),
        )
        self._http_client: HttpLLMClient = resolved_client

        # Per-request accumulator for LLM call timing and usage.
        # Call reset_request_metrics() before each request, then
        # read get_request_metrics() after to get aggregate stats.
        self._req_llm_duration_ms: int = 0
        self._req_llm_call_count: int = 0
        self._req_usage: TokenUsage = TokenUsage()

        logger.info(
            "llm_gateway_initialized",
            gateway_url=config.url,
            default_model=config.default_model,
        )

    def reset_request_metrics(self) -> None:
        """Reset per-request LLM timing and usage counters."""
        self._req_llm_duration_ms = 0
        self._req_llm_call_count = 0
        self._req_usage = TokenUsage()

    def get_request_metrics(self) -> dict[str, Any]:
        """Return accumulated LLM metrics for the current request."""
        return {
            "llm_duration_ms": self._req_llm_duration_ms,
            "llm_call_count": self._req_llm_call_count,
            "usage": self._req_usage,
        }

    # ------------------------------------------------------------------
    # Public completion API
    # ------------------------------------------------------------------

    async def complete(  # noqa: ANN401
        self,
        messages: list[dict[str, Any]],
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,  # noqa: ANN401
    ) -> LLMCompletionResponse:
        """Send a completion request to Bifrost and return a typed response.

        The model string must follow ``provider/model-name`` format. If no
        model is provided, ``config.default_model`` is used.

        On timeout, the request is retried up to ``config.max_retries``
        times with exponential backoff (1 s, 2 s, 4 s, …) if
        ``config.retry_on_timeout`` is ``True``. Rate-limit (429) and
        authentication (401) errors are never retried.

        Args:
            messages: Conversation history — list of ``{"role": …, "content": …}`` dicts.
            model: Override model string. Falls back to ``config.default_model``.
            temperature: Sampling temperature. ``None`` lets Bifrost use the model default.
            max_tokens: Max output tokens. ``None`` lets Bifrost use the model default.
            tools: Optional list of OpenAI-format tool definitions.
            **kwargs: Extra parameters forwarded to the underlying HTTP client.

        Returns:
            ``LLMCompletionResponse`` with ``content``, ``tool_calls``, ``usage``,
            and ``model``.

        Raises:
            GatewayError: On rate limit, auth failure, timeout after retries, or any
                other provider/network error.
            GatewayError: If the model string is not in ``provider/model-name`` format.
        """
        resolved_model = model or self.config.default_model
        self._validate_model(resolved_model)

        max_retries = self.config.max_retries if self.config.retry_on_timeout else 0
        call_start = time.time()

        for attempt in range(max_retries + 1):
            try:
                raw = await self._http_client.complete(
                    messages=messages,
                    model=resolved_model,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    tools=tools,
                    **kwargs,
                )
                response = self._build_response(raw, resolved_model)
                await self.usage_tracker.record(response.usage, response.model)

                # Accumulate per-request metrics
                call_ms = int((time.time() - call_start) * 1000)
                self._req_llm_duration_ms += call_ms
                self._req_llm_call_count += 1
                self._req_usage = TokenUsage(
                    prompt_tokens=self._req_usage.prompt_tokens + response.usage.prompt_tokens,
                    completion_tokens=self._req_usage.completion_tokens
                    + response.usage.completion_tokens,
                    total_tokens=self._req_usage.total_tokens + response.usage.total_tokens,
                    estimated_cost_usd=self._req_usage.estimated_cost_usd
                    + response.usage.estimated_cost_usd,
                )

                return response

            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code
                if status == 429:
                    logger.warning(
                        "gateway_rate_limited",
                        model=resolved_model,
                    )
                    raise GatewayError(
                        f"Rate limited by Bifrost for model {resolved_model}. "
                        "Reduce request frequency or increase gateway rate limit config.",
                        details={"model": resolved_model, "status": status},
                    ) from exc
                if status == 401:
                    logger.error("gateway_auth_failed", model=resolved_model)
                    raise GatewayError(
                        "Bifrost authentication failed — check api_key in gateway config "
                        "or AGENT_GATEWAY__API_KEY environment variable.",
                        details={"model": resolved_model, "status": status},
                    ) from exc
                raise GatewayError(
                    f"Bifrost returned HTTP {status}: {exc.response.text}",
                    details={"model": resolved_model, "status": status},
                ) from exc

            except (httpx.TimeoutException, TimeoutError) as exc:
                if not self.config.retry_on_timeout or attempt >= max_retries:
                    logger.error(
                        "gateway_timeout_exhausted",
                        model=resolved_model,
                        attempt=attempt,
                    )
                    raise GatewayError(
                        f"Bifrost request timed out after {attempt + 1} attempt(s) for model "
                        f"{resolved_model}. Increase gateway.request_timeout_seconds or "
                        "check Bifrost connectivity.",
                        details={"model": resolved_model, "attempts": attempt + 1},
                    ) from exc
                backoff = 2**attempt
                logger.warning(
                    "gateway_timeout_retry",
                    model=resolved_model,
                    attempt=attempt,
                    backoff_seconds=backoff,
                )
                await asyncio.sleep(backoff)

            except Exception as exc:
                logger.error(
                    "gateway_request_failed",
                    model=resolved_model,
                    error=str(exc),
                )
                raise GatewayError(
                    f"Bifrost request failed: {exc}",
                    details={"model": resolved_model},
                ) from exc

        # Should be unreachable — loop always raises or returns.
        raise GatewayError(
            f"Bifrost request failed after retries for model {resolved_model}.",
            details={"model": resolved_model},
        )

    async def stream_complete(  # noqa: ANN401
        self,
        messages: list[dict[str, Any]],
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        tools: list[dict[str, Any]] | None = None,
        **kwargs: Any,  # noqa: ANN401
    ) -> AsyncIterator[dict[str, Any]]:
        """Stream a completion request from Bifrost.

        Yields token chunks as they arrive from the proxy. Each chunk is a
        ``{"content": str, "tool_calls": list|None, "finish_reason": str|None}``
        dict. Usage tracking for streamed responses is not supported; the
        ``UsageTracker`` is only updated after full (non-streamed) completions.

        Args:
            messages: Conversation history.
            model: Override model string. Falls back to ``config.default_model``.
            temperature: Sampling temperature override.
            max_tokens: Max output tokens.
            tools: Optional list of tool definitions.
            **kwargs: Extra parameters forwarded to the underlying HTTP client.

        Yields:
            Chunk dicts with ``content``, ``tool_calls``, and ``finish_reason``.

        Raises:
            GatewayError: On any streaming error from the provider or network.
            GatewayError: If the model string is not in ``provider/model-name`` format.
        """
        resolved_model = model or self.config.default_model
        self._validate_model(resolved_model)

        try:
            async for chunk in self._http_client.stream_complete(
                messages=messages,
                model=resolved_model,
                temperature=temperature,
                max_tokens=max_tokens,
                tools=tools,
                **kwargs,
            ):
                yield chunk
        except GatewayError:
            raise
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status == 429:
                raise GatewayError(
                    f"Rate limited by Bifrost for model {resolved_model} during streaming.",
                    details={"model": resolved_model, "status": status},
                ) from exc
            if status == 401:
                raise GatewayError(
                    "Bifrost authentication failed during streaming — check api_key.",
                    details={"model": resolved_model, "status": status},
                ) from exc
            raise GatewayError(
                f"Bifrost streaming returned HTTP {status}: {exc.response.text}",
                details={"model": resolved_model, "status": status},
            ) from exc
        except Exception as exc:
            raise GatewayError(
                f"Bifrost streaming failed: {exc}",
                details={"model": resolved_model},
            ) from exc

    async def complete_with_tools(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        tool_executor: Callable[[dict[str, Any]], Awaitable[str]],
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        max_tool_rounds: int = 10,
        **kwargs: Any,  # noqa: ANN401
    ) -> GatewayToolResult:
        """Complete with automatic tool-use loop.

        Framework-agnostic tool execution loop. The gateway handles the
        LLM ↔ tool roundtrip cycle; the caller provides a ``tool_executor``
        callback that knows how to run tools (via MCP, local functions, etc.).

        Flow::

            messages + tools → LLM → tool_calls?
              yes → tool_executor(call) → append result → loop
              no  → return final text

        Args:
            messages: Conversation history.
            tools: OpenAI-format tool definitions to expose to the LLM.
            tool_executor: Async callback ``(tool_call_dict) -> str`` that
                executes a single tool call and returns the result as a string.
                Receives the full OpenAI tool_call dict with ``id``, ``function.name``,
                ``function.arguments``.
            model: Override model string.
            temperature: Sampling temperature override.
            max_tokens: Max output tokens.
            max_tool_rounds: Hard cap on tool-call iterations to prevent infinite loops.
            **kwargs: Additional parameters forwarded to the completion call.

        Returns:
            ``GatewayToolResult`` aggregating the final response and usage.

        Raises:
            GatewayError: On any LLM or tool execution error.
        """
        resolved_model = model or self.config.default_model
        self._validate_model(resolved_model)

        aggregated_usage = TokenUsage(
            prompt_tokens=0,
            completion_tokens=0,
            total_tokens=0,
            estimated_cost_usd=0.0,
        )
        tool_history: list[dict[str, Any]] = []
        tool_rounds = 0
        content = ""

        for _round in range(max_tool_rounds):
            response = await self.complete(
                messages=messages,
                model=resolved_model,
                temperature=temperature,
                max_tokens=max_tokens,
                tools=tools,
                **kwargs,
            )

            # Aggregate usage
            aggregated_usage = TokenUsage(
                prompt_tokens=aggregated_usage.prompt_tokens + response.usage.prompt_tokens,
                completion_tokens=aggregated_usage.completion_tokens
                + response.usage.completion_tokens,
                total_tokens=aggregated_usage.total_tokens + response.usage.total_tokens,
                estimated_cost_usd=aggregated_usage.estimated_cost_usd
                + response.usage.estimated_cost_usd,
            )

            content = response.content

            # No tool calls — final response
            if not response.tool_calls:
                break

            tool_rounds += 1

            # Append assistant message with tool calls
            messages.append(
                {
                    "role": "assistant",
                    "content": content or None,
                    "tool_calls": response.tool_calls,
                }
            )

            # Execute each tool call
            for tc in response.tool_calls:
                fn_data = tc.get("function", {})
                try:
                    result_str = await tool_executor(tc)
                except Exception as exc:
                    logger.warning(
                        "tool_execution_failed",
                        tool=fn_data.get("name", ""),
                        error=str(exc),
                    )
                    result_str = f"Tool error: {exc}"

                tool_history.append(
                    {
                        "tool_name": fn_data.get("name", ""),
                        "arguments": fn_data.get("arguments", "{}"),
                        "result": result_str,
                    }
                )

                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.get("id", ""),
                        "content": result_str,
                    }
                )

        return GatewayToolResult(
            content=content,
            usage=aggregated_usage,
            model=resolved_model,
            tool_calls_made=tool_rounds,
            tool_history=tool_history,
        )

    # ------------------------------------------------------------------
    # Health check
    # ------------------------------------------------------------------

    async def check_health(self) -> dict[str, Any]:
        """Check Bifrost proxy connectivity by hitting its ``/health`` endpoint.

        Sends a lightweight GET request to ``{config.url}/health`` and measures
        round-trip latency. Returns a summary dict that is safe to include in
        the framework's ``/health`` response.

        Returns:
            Dict with:
                - ``healthy`` (bool) — ``True`` if ``/health`` returned HTTP 200.
                - ``latency_ms`` (float) — Round-trip time in milliseconds, or
                  ``-1`` if the request failed.

        Example::

            status = await gateway.check_health()
            # {"healthy": True, "latency_ms": 12.4}
        """
        import httpx  # local import to keep top-level dependencies minimal

        try:
            start = time.monotonic()
            async with httpx.AsyncClient() as client:
                resp = await client.get(
                    f"{self.config.url}/health",
                    timeout=5.0,
                )
            latency_ms = (time.monotonic() - start) * 1000
            healthy = resp.status_code == 200
            logger.debug(
                "gateway_health_check",
                healthy=healthy,
                latency_ms=round(latency_ms, 1),
            )
            return {"healthy": healthy, "latency_ms": round(latency_ms, 1)}
        except Exception as exc:
            logger.warning("gateway_health_check_failed", error=str(exc))
            return {"healthy": False, "latency_ms": -1}

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _validate_model(self, model: str) -> None:
        """Validate that the model string follows ``provider/model-name`` format.

        Args:
            model: The model string to validate.

        Raises:
            GatewayError: If the string does not match
                ``^[A-Za-z0-9_\\-.]+/[A-Za-z0-9_\\-.]+$``.
        """
        if not _MODEL_PATTERN.match(model):
            raise GatewayError(
                f"Invalid model string '{model}'. Model must follow the "
                "'provider/model-name' format, e.g. 'anthropic/claude-sonnet-4-20250514' "
                "or 'openai/gpt-4o'. "
                "Check gateway.default_model in config or the model override per-request.",
                details={"model": model},
            )

    def _build_response(
        self,
        raw: dict[str, Any],
        resolved_model: str,
    ) -> LLMCompletionResponse:
        """Build a typed ``LLMCompletionResponse`` from a normalized raw dict.

        Args:
            raw: Dict returned by ``HttpLLMClient.complete()``.
            resolved_model: Model string used for the request (fallback if
                ``raw["model"]`` is absent).

        Returns:
            Populated ``LLMCompletionResponse``.
        """
        usage = self._extract_usage(raw.get("usage") or {})
        return LLMCompletionResponse(
            content=raw.get("content") or "",
            tool_calls=raw.get("tool_calls") or [],
            usage=usage,
            model=raw.get("model") or resolved_model,
        )

    def _extract_usage(self, usage_dict: dict[str, Any]) -> TokenUsage:
        """Extract ``TokenUsage`` from a raw usage dict returned by the proxy.

        Cost is read from ``usage_dict["cost"]`` as provided by Bifrost — it is
        never calculated locally.

        Args:
            usage_dict: Raw usage dict from the proxy response, keyed by
                ``prompt_tokens``, ``completion_tokens``, ``total_tokens``,
                and optionally ``cost``.

        Returns:
            Populated ``TokenUsage`` instance.
        """
        if not usage_dict:
            return TokenUsage(
                prompt_tokens=0,
                completion_tokens=0,
                total_tokens=0,
                estimated_cost_usd=0.0,
            )
        return TokenUsage(
            prompt_tokens=int(usage_dict.get("prompt_tokens", 0)),
            completion_tokens=int(usage_dict.get("completion_tokens", 0)),
            total_tokens=int(usage_dict.get("total_tokens", 0)),
            estimated_cost_usd=float(usage_dict.get("cost", 0.0)),
        )
