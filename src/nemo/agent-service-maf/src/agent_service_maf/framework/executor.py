"""Agent executor — routes requests to the appropriate framework adapter.

The :class:`AgentExecutor` is the high-level orchestrator that:
1. Resolves the framework name from the execution context config.
2. Creates an adapter instance via the registry.
3. Initializes the adapter with the execution context.
4. Runs input guardrails before calling the adapter.
5. Runs ``invoke()`` or ``stream()`` on the adapter.
6. Runs output guardrails after the adapter returns.
7. Runs tool guardrails inline during streaming.
8. Tracks wall-clock duration.
9. Wraps any adapter exceptions in :class:`~agent_service_maf.core.exceptions.AgentInvocationError`.

Routes and the :class:`~agent_service_maf.core.service.AgentService` call this
executor rather than touching adapters directly.

Dependency Inversion: The executor receives a ``registry`` parameter implementing
:class:`~agent_service_maf.framework.registry.FrameworkRegistryProtocol` via
constructor injection. This allows unit tests to inject mock registries without
patching global state.

Guardrail integration:
    - Input guardrails run before the adapter sees the request.
    - Output guardrails run after the adapter returns.
    - Tool guardrails run inline during streaming when ``TOOL_CALL`` events are yielded.
    - If ``context.guardrails`` is ``None``, all guardrail steps are skipped.
    - ``GuardrailError`` subclasses propagate to the caller without wrapping.
"""

from __future__ import annotations

import time
from collections.abc import AsyncIterator

import structlog

from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.exceptions import AgentInvocationError, GuardrailError
from agent_service_maf.core.interfaces import AgentEvent, AgentRequest, AgentResponse, EventType
from agent_service_maf.framework.registry import FrameworkRegistry, FrameworkRegistryProtocol

logger = structlog.get_logger(__name__)


class AgentExecutor:
    """High-level executor that resolves a framework adapter, applies guardrails, and runs it.

    This is the primary entry point for programmatic agent invocation. Route
    handlers and the ``AgentService`` call this executor rather than the registry
    or adapters directly.

    The executor:
    - Resolves ``config.agent.framework`` to find the adapter class.
    - Creates and initializes the adapter for each request (stateless per-request).
    - Runs input guardrails (if configured) before passing to the adapter.
    - Measures wall-clock duration for both ``invoke()`` and ``stream()``.
    - Wraps all adapter exceptions in
      :class:`~agent_service_maf.core.exceptions.AgentInvocationError`
      with ``correlation_id`` and ``duration_ms`` in the details dict.
    - Emits structured log entries at start, completion, and failure.
    - Allows :class:`~agent_service_maf.core.exceptions.GuardrailError` subclasses to
      propagate to the caller unchanged.

    Attributes:
        registry: The framework registry protocol implementation used to create
            adapters. Defaults to :class:`~agent_service_maf.framework.registry.FrameworkRegistry`.
            Inject a mock registry in tests for isolation.

    Args:
        registry: Registry class implementing
            :class:`~agent_service_maf.framework.registry.FrameworkRegistryProtocol`.
            Defaults to :class:`~agent_service_maf.framework.registry.FrameworkRegistry`.

    Example:
        >>> executor = AgentExecutor()
        >>> response = await executor.invoke(request, context)

        >>> # With injected mock registry for testing:
        >>> executor = AgentExecutor(registry=MockRegistry)
        >>> response = await executor.invoke(request, context)
    """

    def __init__(
        self,
        registry: type[FrameworkRegistryProtocol] = FrameworkRegistry,
    ) -> None:
        self.registry = registry

    async def invoke(
        self,
        request: AgentRequest,
        context: AgentExecutionContext,
    ) -> AgentResponse:
        """Execute a synchronous agent invocation with pre/post guardrails.

        Pipeline:
        1. Run input guardrails — may sanitise input (MODIFY) or block (raises
           :class:`~agent_service_maf.core.exceptions.InputBlockedError`).
        2. Create and initialise the framework adapter.
        3. Invoke the adapter with the (possibly sanitised) request.
        4. Run output guardrails — may truncate output or block (raises
           :class:`~agent_service_maf.core.exceptions.OutputBlockedError`).
        5. Return the (possibly sanitised) response.

        Args:
            request: The invocation request. ``request.agent_id`` is used for
                logging; the framework name comes from ``context.config.agent.framework``.
            context: Runtime dependencies. ``context.correlation_id`` is included
                in error details for log correlation. ``context.guardrails`` is
                the pipeline to run (may be ``None``).

        Returns:
            :class:`~agent_service_maf.core.interfaces.AgentResponse` with
            ``duration_ms`` set to the measured wall-clock time.

        Raises:
            InputBlockedError: If input guardrails block the request.
            OutputBlockedError: If output guardrails block the response.
            AgentInvocationError: If the adapter raises any exception during
                ``create()``, ``initialize()``, or ``invoke()``. The original
                exception is chained via ``__cause__``. Details include
                ``agent_id``, ``framework``, ``correlation_id``, and ``duration_ms``.
            FrameworkNotFoundError: Re-raised as ``AgentInvocationError`` if the
                framework name is not registered.

        Example:
            >>> response = await executor.invoke(request, context)
            >>> print(response.output, response.duration_ms)
        """
        start = time.monotonic()
        framework = context.config.agent.framework
        guardrails = context.guardrails
        guardrail_ctx: dict[str, str] = {"correlation_id": context.correlation_id}

        logger.info(
            "Executing agent",
            agent_id=request.agent_id,
            framework=framework,
            correlation_id=context.correlation_id,
        )

        try:
            # === INPUT GUARDRAILS ===
            effective_input = request.input
            if guardrails is not None:
                effective_input = await guardrails.check_input(
                    input_text=request.input,
                    agent_id=request.agent_id,
                    context=guardrail_ctx,
                )

            sanitized_request = request.model_copy(update={"input": effective_input})

            # === AGENT EXECUTION ===
            agent = self.registry.create(framework, context.config)
            await agent.initialize(context)
            response = await agent.invoke(sanitized_request, context)
            response.duration_ms = int((time.monotonic() - start) * 1000)

            # === OUTPUT GUARDRAILS ===
            if guardrails is not None:
                sanitized_output = await guardrails.check_output(
                    output_text=response.output,
                    agent_id=request.agent_id,
                    original_input=request.input,
                    context=guardrail_ctx,
                )
                response = response.model_copy(update={"output": sanitized_output})

            logger.info(
                "Agent completed",
                agent_id=request.agent_id,
                framework=framework,
                duration_ms=response.duration_ms,
                correlation_id=context.correlation_id,
            )
            return response

        except GuardrailError:
            # Guardrail errors propagate unchanged — the caller maps them to HTTP codes.
            raise
        except AgentInvocationError:
            # Already wrapped — re-raise to avoid double-wrapping.
            raise
        except Exception as exc:
            duration_ms = int((time.monotonic() - start) * 1000)
            logger.error(
                "Agent invocation failed",
                agent_id=request.agent_id,
                framework=framework,
                error_type=type(exc).__name__,
                duration_ms=duration_ms,
                correlation_id=context.correlation_id,
            )
            raise AgentInvocationError(
                f"Agent '{request.agent_id}' invocation failed with {type(exc).__name__}: {exc}. "
                f"Check adapter logs for correlation_id='{context.correlation_id}' "
                f"and ensure the '{framework}' adapter is correctly configured.",
                details={
                    "agent_id": request.agent_id,
                    "framework": framework,
                    "correlation_id": context.correlation_id,
                    "duration_ms": duration_ms,
                    "error_type": type(exc).__name__,
                },
            ) from exc

    async def stream(
        self,
        request: AgentRequest,
        context: AgentExecutionContext,
    ) -> AsyncIterator[AgentEvent]:
        """Execute a streaming agent invocation with pre/post guardrails.

        Pipeline:
        1. Run input guardrails before the adapter starts streaming.
        2. Create and initialise the framework adapter.
        3. Yield events from the adapter's ``stream()`` method.
        4. For ``TOOL_CALL`` events: run tool guardrails inline. If blocked,
           yield an ``ERROR`` event and stop streaming.
        5. After all tokens are collected: run output guardrails on the full output.
           If blocked, yield a final ``ERROR`` event.

        Cancellation: If the caller breaks out of the async for loop (e.g., client
        disconnects), the generator is closed and cleanup is delegated to the adapter's
        ``stream()`` method.

        Args:
            request: The invocation request.
            context: Runtime dependencies. ``context.correlation_id`` is included
                in error details for log correlation. ``context.guardrails`` is
                the pipeline to run (may be ``None``).

        Yields:
            :class:`~agent_service_maf.core.interfaces.AgentEvent` instances from
            the adapter's ``stream()`` method.

        Raises:
            InputBlockedError: If input guardrails block the request (raised before
                any events are yielded).
            AgentInvocationError: If the adapter raises before or during streaming.

        Example:
            >>> async for event in executor.stream(request, context):
            ...     print(event.event_type, event.data)
        """
        framework = context.config.agent.framework
        guardrails = context.guardrails
        guardrail_ctx: dict[str, str] = {"correlation_id": context.correlation_id}

        logger.info(
            "Starting agent stream",
            agent_id=request.agent_id,
            framework=framework,
            correlation_id=context.correlation_id,
        )

        try:
            # === INPUT GUARDRAILS (before streaming begins) ===
            effective_input = request.input
            if guardrails is not None:
                effective_input = await guardrails.check_input(
                    input_text=request.input,
                    agent_id=request.agent_id,
                    context=guardrail_ctx,
                )

            sanitized_request = request.model_copy(update={"input": effective_input})

            agent = self.registry.create(framework, context.config)
            await agent.initialize(context)

            collected_tokens: list[str] = []

            async for event in agent.stream(sanitized_request, context):
                if event.event_type == EventType.TOKEN:
                    collected_tokens.append(event.data)

                elif event.event_type == EventType.TOOL_CALL and guardrails is not None:
                    # === TOOL GUARDRAILS (inline during streaming) ===
                    tool_name = str(event.data)
                    raw_params = event.metadata.get("params", {})
                    tool_params: dict[str, object] = dict(raw_params)
                    try:
                        await guardrails.check_tool(
                            tool_name=tool_name,
                            tool_params=tool_params,
                            agent_id=request.agent_id,
                            context=guardrail_ctx,
                        )
                    except GuardrailError as exc:
                        logger.warning(
                            "Tool call blocked by guardrail during stream",
                            tool_name=tool_name,
                            error=str(exc),
                            correlation_id=context.correlation_id,
                        )
                        yield AgentEvent(
                            event_type=EventType.ERROR,
                            data=f"Tool call blocked: {exc}",
                            metadata={"error_type": type(exc).__name__},
                        )
                        return

                yield event

            # === OUTPUT GUARDRAILS (after streaming completes) ===
            if guardrails is not None and collected_tokens:
                full_output = "".join(collected_tokens)
                try:
                    await guardrails.check_output(
                        output_text=full_output,
                        agent_id=request.agent_id,
                        original_input=request.input,
                        context=guardrail_ctx,
                    )
                except GuardrailError as exc:
                    logger.warning(
                        "Output blocked by guardrail after streaming",
                        error=str(exc),
                        correlation_id=context.correlation_id,
                    )
                    yield AgentEvent(
                        event_type=EventType.ERROR,
                        data=f"Output blocked: {exc}",
                        metadata={"error_type": type(exc).__name__},
                    )
                    return

            logger.info(
                "Agent stream completed",
                agent_id=request.agent_id,
                framework=framework,
                correlation_id=context.correlation_id,
            )

        except GuardrailError:
            # Input guardrail blocks propagate to the caller.
            raise
        except AgentInvocationError:
            raise
        except Exception as exc:
            logger.error(
                "Agent stream failed",
                agent_id=request.agent_id,
                framework=framework,
                error_type=type(exc).__name__,
                correlation_id=context.correlation_id,
            )
            raise AgentInvocationError(
                f"Agent '{request.agent_id}' stream failed with {type(exc).__name__}: {exc}. "
                f"Check adapter logs for correlation_id='{context.correlation_id}' "
                f"and ensure the '{framework}' adapter supports streaming.",
                details={
                    "agent_id": request.agent_id,
                    "framework": framework,
                    "correlation_id": context.correlation_id,
                    "error_type": type(exc).__name__,
                },
            ) from exc
