"""BifrostChatClient — a Microsoft Agent Framework ``ChatClient`` over the LLMGateway.

This is the critical bridge that ensures Agent Framework agents never call
provider APIs directly. Every LLM request is routed through the in-repo
:class:`~agent_service_maf.gateway.llm_gateway.LLMGateway`, which in turn calls the
external Bifrost proxy.

Unlike the SK client (which subclassed SK's ``ChatCompletionClientBase`` and relied
on SK's auto function-invocation loop), this client subclasses AF's
:class:`agent_framework.BaseChatClient` and implements the single required hook
``_inner_get_response()``. Tool/function-call orchestration is layered separately by
AF's higher-level client layers / the agent loop and is wired in Phase 2 — this
Phase-0/1 client implements the text + usage path (streaming and non-streaming) and
forwards tool definitions best-effort.

Type/usage mapping (verified against ``agent-framework-core`` 1.9):
    - AF ``Message`` (``.role``, ``.text``) → gateway ``{"role", "content"}`` dicts.
    - Non-streaming → :class:`agent_framework.ChatResponse` with ``usage_details``.
    - Streaming → :class:`agent_framework.ChatResponseUpdate` text chunks plus a
      terminal ``Content.from_usage(...)`` update; ``ChatResponse.from_updates``
      aggregates text **and** usage, which closes the streaming-usage gap natively.

Usage::

    from agent_service_maf.gateway.llm_gateway import LLMGateway
    from agent_service_maf.framework.maf import BifrostChatClient

    gateway = LLMGateway(config)
    client = BifrostChatClient(gateway=gateway, model="azure/gpt-4.1-mini")
    agent = client.as_agent(instructions="You are helpful.")
    response = await agent.run("Hello!")
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator, Awaitable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from contextvars import ContextVar
from typing import TYPE_CHECKING, Any

import structlog
from agent_framework import (
    BaseChatClient,
    ChatMiddlewareLayer,
    ChatResponse,
    ChatResponseUpdate,
    Content,
    FunctionInvocationLayer,
    Message,
    ResponseStream,
    UsageDetails,
)
from agent_framework.observability import ChatTelemetryLayer

from agent_service_maf.core.exceptions import AgentInvocationError
from agent_service_maf.core.interfaces import TokenUsage

if TYPE_CHECKING:
    from agent_service_maf.gateway.llm_gateway import LLMGateway

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Orchestration usage sink (mirrors the SK client's proven ContextVar pattern)
# ---------------------------------------------------------------------------

# AF's multi-agent orchestrations may run agents through layers that do not share
# the originating client instance, so a per-instance accumulator can be lost. A
# module-level ``ContextVar`` lets every gateway call append its usage to a
# request-scoped buffer regardless of which client clone made the call. Phase 3
# orchestration code wraps the run in :func:`usage_capture_scope` to aggregate.
_CURRENT_USAGE_BUFFER: ContextVar[list[TokenUsage] | None] = ContextVar(
    "_maf_gateway_chat_client_usage_buffer",
    default=None,
)


@contextmanager
def usage_capture_scope() -> Iterator[list[TokenUsage]]:
    """Capture token-usage from all gateway calls made inside the ``with`` block.

    Returns a list populated with one :class:`TokenUsage` per LLM call. Nested
    scopes are safe — each ``set``/``reset`` pair restores the outer buffer.
    """
    buf: list[TokenUsage] = []
    token = _CURRENT_USAGE_BUFFER.set(buf)
    try:
        yield buf
    finally:
        _CURRENT_USAGE_BUFFER.reset(token)


def _zero_usage() -> TokenUsage:
    """Return a fresh zero-valued :class:`TokenUsage` (explicit args keep mypy happy)."""
    return TokenUsage(
        prompt_tokens=0,
        completion_tokens=0,
        total_tokens=0,
        estimated_cost_usd=0.0,
    )


def sum_token_usage(buf: list[TokenUsage]) -> TokenUsage:
    """Sum a list of :class:`TokenUsage` entries into one aggregate (zero if empty)."""
    if not buf:
        return _zero_usage()
    return TokenUsage(
        prompt_tokens=sum(u.prompt_tokens for u in buf),
        completion_tokens=sum(u.completion_tokens for u in buf),
        total_tokens=sum(u.total_tokens for u in buf),
        estimated_cost_usd=sum(u.estimated_cost_usd for u in buf),
    )


def _record_usage_to_context(usage: TokenUsage) -> None:
    """Append one call's usage to the active :func:`usage_capture_scope` (no-op if none)."""
    buf = _CURRENT_USAGE_BUFFER.get()
    if buf is not None:
        buf.append(usage)


# ---------------------------------------------------------------------------
# Role mapping
# ---------------------------------------------------------------------------

_VALID_ROLES = {"system", "user", "assistant", "tool"}


def _role_to_str(role: Any) -> str:  # noqa: ANN401  # AF Role | str | None
    """Normalize an AF ``Role`` (or string) to an OpenAI-wire role string."""
    if role is None:
        return "user"
    value = getattr(role, "value", None)
    candidate = (value if isinstance(value, str) else str(role)).lower()
    return candidate if candidate in _VALID_ROLES else "user"


# ---------------------------------------------------------------------------
# BifrostChatClient
# ---------------------------------------------------------------------------


class BifrostChatClient(  # type: ignore[misc]  # AF's standard layer-stack MRO; layered get_response overloads differ across mixins by design.
    ChatMiddlewareLayer,
    FunctionInvocationLayer,
    ChatTelemetryLayer,
    BaseChatClient,
):
    """Routes Agent Framework LLM calls through the in-repo ``LLMGateway`` (Bifrost).

    The class composes AF's standard chat-client layers in the same order the
    framework's built-in providers do
    (``ChatMiddlewareLayer -> FunctionInvocationLayer -> ChatTelemetryLayer ->
    BaseChatClient``). Inheriting from :class:`FunctionInvocationLayer` is what
    enables the **automatic tool-calling loop**: when an agent run carries
    ``tools``, the layer detects ``function_call`` content in the response,
    invokes the matching tool, appends the ``function_result``, and re-calls the
    model until a plain-text answer is produced. Without this layer AF logs a
    "does not support function invoking" warning and tools are never executed.

    Args:
        gateway: The :class:`LLMGateway` instance used for every LLM call.
        model: Default model string in ``provider/model-name`` format. A per-call
            ``options["model"]`` overrides it.
        temperature: Resolved default sampling temperature. Used as a fallback when
            a per-call ``options["temperature"]`` is absent.
        max_tokens: Resolved default max output-tokens cap. Used as a fallback when
            a per-call ``options["max_tokens"]`` is absent.
    """

    OTEL_PROVIDER_NAME = "bifrost"

    def __init__(
        self,
        *,
        gateway: LLMGateway,
        model: str = "",
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> None:
        super().__init__()
        self._gateway = gateway
        self._model = model
        # Resolved knobs held on the client so they remain authoritative even when
        # AF does not forward the agent's ``default_options`` into the per-call
        # ``options`` mapping (observed for ``max_tokens`` — the cap was silently
        # dropped, leaving the response uncapped). ``model`` already relied on this
        # client-level fallback; ``temperature`` / ``max_tokens`` now match it.
        self._temperature = temperature
        self._max_tokens = max_tokens
        self._llm_duration_ms: int = 0
        self._llm_call_count: int = 0
        self._accumulated_usage: TokenUsage = _zero_usage()

    # ------------------------------------------------------------------
    # Timing / usage accessors (parity with the SK client; used by the trace)
    # ------------------------------------------------------------------

    def get_llm_duration_ms(self) -> int:
        """Total wall-clock time spent in gateway calls during this invocation (ms)."""
        return self._llm_duration_ms

    def get_llm_call_count(self) -> int:
        """Number of gateway calls made during this invocation."""
        return self._llm_call_count

    def get_accumulated_usage(self) -> TokenUsage:
        """Aggregate token usage across every gateway call since the last reset.

        Mirrors the SK ``GatewayChatCompletion.get_accumulated_usage`` so the
        single-agent adapter path can read usage off the client instance without
        relying on the :func:`usage_capture_scope` ContextVar (which is reserved
        for the Phase 3 multi-agent orchestration paths).
        """
        return self._accumulated_usage

    def reset_usage(self) -> None:
        """Reset per-invocation timing and usage accumulators. Call before each run."""
        self._llm_duration_ms = 0
        self._llm_call_count = 0
        self._accumulated_usage = _zero_usage()

    def _accumulate_usage(self, usage: TokenUsage) -> None:
        """Fold one call's usage into the per-instance running total."""
        self._accumulated_usage = TokenUsage(
            prompt_tokens=self._accumulated_usage.prompt_tokens + usage.prompt_tokens,
            completion_tokens=self._accumulated_usage.completion_tokens + usage.completion_tokens,
            total_tokens=self._accumulated_usage.total_tokens + usage.total_tokens,
            estimated_cost_usd=(
                self._accumulated_usage.estimated_cost_usd + usage.estimated_cost_usd
            ),
        )

    def service_url(self) -> str:
        """Return the configured gateway URL (used by AF telemetry)."""
        return str(getattr(getattr(self._gateway, "config", None), "url", "Unknown"))

    # ------------------------------------------------------------------
    # ChatMiddlewareLayer ↔ FunctionInvocationLayer middleware rerouter
    # ------------------------------------------------------------------

    def get_response(self, *args: Any, **kwargs: Any) -> Any:  # noqa: ANN401
        """Salvage function middleware from AF's combined ``client_kwargs["middleware"]``.

        AF 1.9 has a categorisation gap that silently strips function
        middleware (e.g. :class:`_AutoHandoffMiddleware` used by
        ``HandoffBuilder`` for triage routing) between the layers:

        1. ``AgentMiddlewareLayer.run`` categorises the agent's ``middleware``
           attribute and combines function + chat middleware into
           ``client_kwargs["middleware"]`` before calling
           ``client.get_response(...)`` (``_middleware.py:1361-1369``).
        2. ``ChatMiddlewareLayer.get_response`` then **pops the whole list**
           and feeds it to ``ChatMiddlewarePipeline`` without categorising
           (``_middleware.py:1187, 1193``).
        3. ``ChatMiddlewarePipeline._register_middleware_with_wrapper`` only
           keeps items that are ``ChatMiddleware`` instances or plain
           callables (``_middleware.py:841-844``). ``_AutoHandoffMiddleware``
           is a ``FunctionMiddleware`` subclass without ``__call__`` → silently
           dropped.
        4. ``ChatMiddlewareLayer`` then calls ``super().get_response(...)``
           with ``client_kwargs["middleware"]`` already popped, so
           ``FunctionInvocationLayer`` builds an empty function-middleware
           pipeline. ``_AutoHandoffMiddleware`` never fires; the no-op handoff
           tool runs; ``_is_handoff_requested`` finds nothing; triage stalls
           with the router as the sole emitter and empty output.

        We work around it by routing function middleware through the
        top-level ``middleware=`` kwarg AND skipping ``ChatMiddlewareLayer``
        for the function-middleware case — ``FunctionInvocationLayer``
        accepts ``middleware=`` and merges it correctly at
        ``_tools.py:2493-2502``. Chat middleware is left in
        ``client_kwargs["middleware"]`` so the chat layer can still use it
        when we don't bypass.

        Once AF categorises in ``ChatMiddlewareLayer`` (or accepts a
        top-level ``middleware`` kwarg there), this override can shrink to a
        no-op.
        """
        from agent_framework._middleware import (  # noqa: PLC0415
            ChatMiddleware,
            FunctionMiddleware,
        )
        from agent_framework._tools import FunctionInvocationLayer  # noqa: PLC0415

        client_kwargs = kwargs.get("client_kwargs")
        bundled = (
            list(client_kwargs.get("middleware") or [])
            if isinstance(client_kwargs, Mapping) and "middleware" in client_kwargs
            else []
        )
        if not bundled:
            return super().get_response(*args, **kwargs)

        function_mw = [m for m in bundled if isinstance(m, FunctionMiddleware)]
        if not function_mw:
            # Only chat / unknown middleware — the chat layer handles those
            # correctly. Pass through unchanged.
            return super().get_response(*args, **kwargs)

        # Re-pack: chat-only stays in client_kwargs (for any chat pipeline
        # that does run), function middleware moves to a top-level kwarg.
        chat_mw = [m for m in bundled if isinstance(m, ChatMiddleware)]
        new_client_kwargs = dict(client_kwargs) if isinstance(client_kwargs, Mapping) else {}
        if chat_mw:
            new_client_kwargs["middleware"] = chat_mw
        else:
            new_client_kwargs.pop("middleware", None)
        kwargs["client_kwargs"] = new_client_kwargs
        existing_top = list(kwargs.get("middleware") or [])
        kwargs["middleware"] = [*existing_top, *function_mw]

        # When there are chat middlewares to honour we still need
        # ChatMiddlewareLayer in the chain — but it would also drop our
        # top-level ``middleware`` kwarg (its signature doesn't accept it).
        # The chat-middleware-and-function-middleware case is rare for
        # triage; when it arises we accept skipping the chat pipeline for
        # this call (the chat middleware is still consumed at the
        # AgentMiddlewareLayer boundary via different mechanisms).
        # Bypass ChatMiddlewareLayer by calling FunctionInvocationLayer
        # directly with the unbound method (Python resolves it on the
        # current instance, preserving the rest of the MRO from there
        # downward — FunctionInvocationLayer → ChatTelemetryLayer →
        # BaseChatClient).
        return FunctionInvocationLayer.get_response(self, *args, **kwargs)

    # ------------------------------------------------------------------
    # Required BaseChatClient hook
    # ------------------------------------------------------------------

    def _inner_get_response(
        self,
        *,
        messages: Sequence[Message],
        stream: bool,
        options: Mapping[str, Any],
        **kwargs: Any,  # noqa: ANN401
    ) -> Awaitable[ChatResponse] | ResponseStream[ChatResponseUpdate, ChatResponse]:
        """Send a chat request through the gateway.

        Returns an awaitable :class:`ChatResponse` when ``stream`` is ``False`` and a
        :class:`ResponseStream` of :class:`ChatResponseUpdate` when ``True`` (built via
        the base helper so the standard finalizer assembles the terminal response).
        """
        gw_messages = self._to_gateway_messages(messages)
        # AF carries the agent's system prompt via ``options["instructions"]`` rather
        # than as a message, so prepend it as a system turn for the gateway.
        instructions = options.get("instructions")
        if instructions:
            gw_messages.insert(0, {"role": "system", "content": str(instructions)})
        opts = self._extract_options(options)
        if stream:
            return self._build_response_stream(self._stream_updates(gw_messages, opts))
        return self._complete(gw_messages, opts)

    # ------------------------------------------------------------------
    # Non-streaming
    # ------------------------------------------------------------------

    async def _complete(
        self, gw_messages: list[dict[str, Any]], opts: dict[str, Any]
    ) -> ChatResponse:
        call_start = time.monotonic()
        try:
            result = await self._gateway.complete(
                messages=gw_messages,
                model=opts["model"],
                temperature=opts["temperature"],
                max_tokens=opts["max_tokens"],
                tools=opts["tools"],
                **opts["extra"],
            )
        except Exception as exc:  # noqa: BLE001
            raise AgentInvocationError(
                f"LLM gateway call failed for model {opts['model']}: {exc}. "
                "Check gateway connectivity and model availability.",
                details={"model": opts["model"]},
            ) from exc
        finally:
            self._llm_duration_ms += int((time.monotonic() - call_start) * 1000)
            self._llm_call_count += 1

        usage: TokenUsage = result.usage
        _record_usage_to_context(usage)
        self._accumulate_usage(usage)

        # Build the assistant message contents: any text plus one
        # ``function_call`` Content per tool call the model requested. The
        # FunctionInvocationLayer detects the function_call contents, runs the
        # matching tool, and loops — so the tool-calling path lives entirely in
        # how we shape these contents (and how _to_gateway_messages serializes
        # the resulting function_call / function_result messages back).
        contents: list[Content] = []
        if result.content:
            contents.append(Content.from_text(result.content))
        for tool_call in result.tool_calls or []:
            fn = tool_call.get("function", {})
            contents.append(
                Content.from_function_call(
                    call_id=str(tool_call.get("id") or ""),
                    name=str(fn.get("name") or ""),
                    arguments=fn.get("arguments") or "{}",
                )
            )
        if not contents:
            contents.append(Content.from_text(""))

        return ChatResponse(
            messages=[Message("assistant", contents)],
            model=result.model or opts["model"],
            usage_details=_usage_to_details(usage),
            additional_properties={"estimated_cost_usd": usage.estimated_cost_usd},
        )

    # ------------------------------------------------------------------
    # Streaming
    # ------------------------------------------------------------------

    async def _stream_updates(
        self, gw_messages: list[dict[str, Any]], opts: dict[str, Any]
    ) -> AsyncIterator[ChatResponseUpdate]:
        call_start = time.monotonic()
        self._llm_call_count += 1
        # Accumulate streamed tool-call fragments. Bifrost's stream drops the
        # OpenAI ``index`` field, so we key on name-presence: a fragment with a
        # non-empty ``name`` starts a new call; subsequent name-less fragments
        # append argument deltas to the most recent call (the standard OpenAI
        # streaming-tool-call convention).
        acc_calls: list[dict[str, str]] = []
        try:
            stream = self._gateway.stream_complete(
                messages=gw_messages,
                model=opts["model"],
                temperature=opts["temperature"],
                max_tokens=opts["max_tokens"],
                tools=opts["tools"],
                **opts["extra"],
            )
            async for chunk in stream:
                content = chunk.get("content") or ""
                if content:
                    yield ChatResponseUpdate(
                        contents=[Content.from_text(content)],
                        role="assistant",
                    )
                for tool_call in chunk.get("tool_calls") or []:
                    fn = tool_call.get("function", {})
                    name = fn.get("name") or ""
                    args_fragment = fn.get("arguments") or ""
                    if name or not acc_calls:
                        acc_calls.append(
                            {
                                "id": str(tool_call.get("id") or ""),
                                "name": name,
                                "arguments": args_fragment,
                            }
                        )
                    else:
                        acc_calls[-1]["arguments"] += args_fragment
                # Bifrost's terminal SSE chunk carries token usage; surface it as a
                # usage Content so ChatResponse.from_updates aggregates it.
                chunk_usage = chunk.get("usage")
                if isinstance(chunk_usage, dict):
                    usage = TokenUsage(
                        prompt_tokens=int(chunk_usage.get("prompt_tokens", 0) or 0),
                        completion_tokens=int(chunk_usage.get("completion_tokens", 0) or 0),
                        total_tokens=int(chunk_usage.get("total_tokens", 0) or 0),
                        estimated_cost_usd=float(chunk_usage.get("cost", 0.0) or 0.0),
                    )
                    _record_usage_to_context(usage)
                    self._accumulate_usage(usage)
                    yield ChatResponseUpdate(
                        contents=[Content.from_usage(_usage_to_details(usage))],
                        role="assistant",
                    )
            # Emit the assembled tool calls so the FunctionInvocationLayer can run
            # them and re-stream the follow-up turn.
            if acc_calls:
                yield ChatResponseUpdate(
                    contents=[
                        Content.from_function_call(
                            call_id=call["id"],
                            name=call["name"],
                            arguments=call["arguments"] or "{}",
                        )
                        for call in acc_calls
                    ],
                    role="assistant",
                )
        except AgentInvocationError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise AgentInvocationError(
                f"LLM gateway streaming failed for model {opts['model']}: {exc}. "
                "Check gateway connectivity and model availability.",
                details={"model": opts["model"]},
            ) from exc
        finally:
            self._llm_duration_ms += int((time.monotonic() - call_start) * 1000)

    # ------------------------------------------------------------------
    # Conversion helpers
    # ------------------------------------------------------------------

    def _to_gateway_messages(self, messages: Sequence[Message]) -> list[dict[str, Any]]:
        """Convert AF messages to the gateway's OpenAI-compatible wire shape.

        Handles three content shapes the function-invocation loop produces:

        - **text** → ``{"role", "content"}``.
        - **function_call** (assistant) → ``{"role": "assistant", "content",
          "tool_calls": [{"id", "type": "function", "function": {...}}]}``.
        - **function_result** (tool) → one ``{"role": "tool", "tool_call_id",
          "content"}`` message per result.
        """
        out: list[dict[str, Any]] = []
        for msg in messages:
            role = _role_to_str(getattr(msg, "role", None))
            text_parts: list[str] = []
            tool_calls: list[dict[str, Any]] = []
            results: list[tuple[str, str]] = []
            for content in getattr(msg, "contents", None) or []:
                ctype = getattr(content, "type", None)
                if ctype == "function_call":
                    tool_calls.append(
                        {
                            "id": getattr(content, "call_id", "") or "",
                            "type": "function",
                            "function": {
                                "name": getattr(content, "name", "") or "",
                                "arguments": _arguments_to_str(getattr(content, "arguments", None)),
                            },
                        }
                    )
                elif ctype == "function_result":
                    results.append(
                        (
                            getattr(content, "call_id", "") or "",
                            _result_to_str(getattr(content, "result", None)),
                        )
                    )
                else:
                    text = getattr(content, "text", "") or ""
                    if text:
                        text_parts.append(text)

            # Tool results become standalone ``tool`` messages.
            for call_id, result_text in results:
                out.append({"role": "tool", "tool_call_id": call_id, "content": result_text})

            if tool_calls:
                out.append(
                    {
                        "role": "assistant",
                        "content": "".join(text_parts) or None,
                        "tool_calls": tool_calls,
                    }
                )
            elif not results:
                # Plain text turn (emit even when empty so user turns are preserved).
                out.append({"role": role, "content": "".join(text_parts)})
        return out

    def _extract_options(self, options: Mapping[str, Any]) -> dict[str, Any]:
        """Pull the gateway-relevant knobs out of AF's validated ChatOptions dict.

        AF tools arrive as :class:`agent_framework.FunctionTool` objects; they are
        serialized to OpenAI tool-definition dicts via ``to_json_schema_spec()``
        for the gateway. ``extra`` carries optional OpenAI-compatible passthroughs
        (``tool_choice``, ``response_format``) only when set, so the gateway never
        serializes ``null`` values that some providers reject.
        """
        tools = _tools_to_specs(options.get("tools"))
        extra: dict[str, Any] = {}
        tool_choice = options.get("tool_choice")
        if tool_choice is not None and tools:
            extra["tool_choice"] = _tool_choice_to_wire(tool_choice)
        response_format = options.get("response_format")
        if response_format is not None:
            extra["response_format"] = response_format
        temperature = options.get("temperature")
        if temperature is None:
            temperature = self._temperature
        max_tokens = options.get("max_tokens")
        if max_tokens is None:
            max_tokens = self._max_tokens
        return {
            "model": options.get("model") or self._model,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "tools": tools,
            "extra": extra,
        }


def _usage_to_details(usage: TokenUsage) -> UsageDetails:
    """Map the in-repo :class:`TokenUsage` to AF's :class:`UsageDetails` TypedDict."""
    return UsageDetails(
        input_token_count=usage.prompt_tokens,
        output_token_count=usage.completion_tokens,
        total_token_count=usage.total_tokens,
    )


def _arguments_to_str(arguments: Any) -> str:  # noqa: ANN401
    """Serialize function-call arguments (dict or str) to an OpenAI JSON string."""
    if arguments is None:
        return "{}"
    if isinstance(arguments, str):
        return arguments
    try:
        return json.dumps(arguments)
    except (TypeError, ValueError):
        return str(arguments)


def _result_to_str(result: Any) -> str:  # noqa: ANN401
    """Serialize a function-result payload to the string the gateway expects."""
    if result is None:
        return ""
    if isinstance(result, str):
        return result
    if isinstance(result, (dict, list)):
        try:
            return json.dumps(result)
        except (TypeError, ValueError):
            return str(result)
    return str(result)


def _tools_to_specs(tools: Any) -> list[dict[str, Any]] | None:  # noqa: ANN401
    """Convert AF tool objects to OpenAI tool-definition dicts for the gateway."""
    if not tools:
        return None
    specs: list[dict[str, Any]] = []
    for tool_obj in tools:
        to_spec = getattr(tool_obj, "to_json_schema_spec", None)
        if callable(to_spec):
            specs.append(to_spec())
    return specs or None


def _tool_choice_to_wire(tool_choice: Any) -> Any:  # noqa: ANN401
    """Normalize AF's ``tool_choice`` (ToolMode/str/dict) to an OpenAI-wire value."""
    value = getattr(tool_choice, "value", None)
    if isinstance(value, str):
        return value
    mode = getattr(tool_choice, "mode", None)
    if isinstance(mode, str):
        return mode
    return tool_choice
