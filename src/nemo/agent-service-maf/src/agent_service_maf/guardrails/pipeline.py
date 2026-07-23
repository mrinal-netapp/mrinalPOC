"""Guardrail pipeline — runs ordered guardrails in sequence.

The :class:`GuardrailPipeline` is the central orchestrator for the guardrail
system. It composes lists of input, output, and tool guardrails and runs them
in order with the following semantics:

- **ALLOW**: Continue to the next guardrail unchanged.
- **BLOCK**: Stop immediately and raise the appropriate exception.
- **MODIFY**: Replace ``content`` with ``modified_content`` and continue.
- **WARN**: Log a structured warning and continue unchanged.

Pipeline instances are created per-request by
:class:`~agent_service_maf.guardrails.registry.GuardrailRegistry`.
They are stateless with respect to content (each run is independent) but the
underlying guardrail objects may carry config state (e.g., compiled regexes).

The pipeline respects the ``fail_open`` setting: when ``fail_open=True``, any
internal guardrail error is caught, logged, and processing continues. When
``fail_open=False`` (default), internal errors propagate as
:class:`~agent_service_maf.core.exceptions.GuardrailError`.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import structlog

from agent_service_maf.core.exceptions import (
    GuardrailError,
    InputBlockedError,
    OutputBlockedError,
    ToolUnauthorizedError,
)
from agent_service_maf.guardrails.base import (
    GuardrailAction,
    GuardrailContext,
    GuardrailResult,
    InputGuardrail,
    OutputGuardrail,
    ToolGuardrail,
)

logger = structlog.get_logger(__name__)


class GuardrailPipeline:
    """Composes and runs ordered guardrails for input, output, and tool phases.

    Instances are typically built by
    :class:`~agent_service_maf.guardrails.registry.GuardrailRegistry`
    from :class:`~agent_service_maf.config.validators.GuardrailSection` config and
    stored on :class:`~agent_service_maf.core.context.AgentExecutionContext`.

    Args:
        input_guardrails: Ordered sequence of input guardrail instances to run
            before agent execution.
        output_guardrails: Ordered sequence of output guardrail instances to run
            after agent execution.
        tool_guardrails: Ordered sequence of tool guardrail instances to run
            before each tool call.
        fail_open: When ``True``, an exception raised by a guardrail itself (not
            a BLOCK result) is logged and ignored so the request continues. When
            ``False`` (default), such exceptions are re-raised as
            :class:`~agent_service_maf.core.exceptions.GuardrailError`.

    Example:
        >>> pipeline = GuardrailPipeline(
        ...     input_guardrails=[InputValidator(max_length=5000)],
        ...     output_guardrails=[ContentFilter()],
        ...     tool_guardrails=[ToolAuthorizer(policy=policy, counter=counter)],
        ... )
        >>> sanitized = await pipeline.check_input("Hello!", "agent-1", {"correlation_id": "abc"})
    """

    def __init__(
        self,
        input_guardrails: Sequence[InputGuardrail] | None = None,
        output_guardrails: Sequence[OutputGuardrail] | None = None,
        tool_guardrails: Sequence[ToolGuardrail] | None = None,
        fail_open: bool = False,
    ) -> None:
        self._input_guardrails: list[InputGuardrail] = list(input_guardrails or [])
        self._output_guardrails: list[OutputGuardrail] = list(output_guardrails or [])
        self._tool_guardrails: list[ToolGuardrail] = list(tool_guardrails or [])
        self._fail_open = fail_open

    # ------------------------------------------------------------------
    # Public check methods
    # ------------------------------------------------------------------

    async def check_input(
        self,
        input_text: str,
        agent_id: str,
        context: dict[str, Any] | None = None,
    ) -> str:
        """Run all input guardrails against user input.

        Runs each guardrail in registration order. MODIFY results chain — the
        modified content is passed to subsequent guardrails. BLOCK raises
        :class:`~agent_service_maf.core.exceptions.InputBlockedError`.

        Args:
            input_text: The raw user prompt to evaluate.
            agent_id: The agent identifier for per-agent policy lookups.
            context: Optional dict with extra context. Recognised keys:
                ``correlation_id`` (str).

        Returns:
            The (possibly modified) input string after all guardrails have run.

        Raises:
            InputBlockedError: If any guardrail returns ``BLOCK``.
            GuardrailError: If a guardrail raises an internal exception and
                ``fail_open=False``.

        Example:
            >>> safe_input = await pipeline.check_input("Hello!", "my-agent")
        """
        ctx_dict = context or {}
        correlation_id = str(ctx_dict.get("correlation_id", ""))
        ctx = GuardrailContext.for_input(
            content=input_text,
            agent_id=agent_id,
            correlation_id=correlation_id,
            extra={k: v for k, v in ctx_dict.items() if k != "correlation_id"},
        )
        return await self._run_pipeline(ctx, self._input_guardrails, InputBlockedError)

    async def check_output(
        self,
        output_text: str,
        agent_id: str,
        original_input: str = "",
        context: dict[str, Any] | None = None,
    ) -> str:
        """Run all output guardrails against agent output.

        Args:
            output_text: The agent's response to evaluate.
            agent_id: The agent identifier for per-agent policy lookups.
            original_input: The user prompt that produced this response. Passed
                through ``ctx.extra["original_input"]``.
            context: Optional dict with extra context (``correlation_id``).

        Returns:
            The (possibly modified) output string after all guardrails have run.

        Raises:
            OutputBlockedError: If any guardrail returns ``BLOCK``.
            GuardrailError: If a guardrail raises an internal exception and
                ``fail_open=False``.
        """
        ctx_dict = context or {}
        correlation_id = str(ctx_dict.get("correlation_id", ""))
        extra = {k: v for k, v in ctx_dict.items() if k != "correlation_id"}
        ctx = GuardrailContext.for_output(
            content=output_text,
            agent_id=agent_id,
            correlation_id=correlation_id,
            original_input=original_input,
            extra=extra,
        )
        return await self._run_pipeline(ctx, self._output_guardrails, OutputBlockedError)

    async def check_tool(
        self,
        tool_name: str,
        tool_params: dict[str, Any],
        agent_id: str,
        context: dict[str, Any] | None = None,
    ) -> None:
        """Run all tool guardrails before a tool call.

        Unlike input/output, tool checks do not produce a modified content
        string — they either allow the call (return) or block it (raise).

        Args:
            tool_name: The name of the tool the agent wants to call.
            tool_params: The parameters the agent is passing to the tool.
            agent_id: The agent identifier.
            context: Optional dict with extra context (``correlation_id``).

        Returns:
            None — the tool call is allowed to proceed.

        Raises:
            ToolUnauthorizedError: If any guardrail returns ``BLOCK``.
            GuardrailError: If a guardrail raises an internal exception and
                ``fail_open=False``.
        """
        ctx_dict = context or {}
        correlation_id = str(ctx_dict.get("correlation_id", ""))
        extra = {k: v for k, v in ctx_dict.items() if k != "correlation_id"}
        ctx = GuardrailContext.for_tool(
            tool_name=tool_name,
            tool_params=tool_params,
            agent_id=agent_id,
            correlation_id=correlation_id,
            extra=extra,
        )
        await self._run_pipeline(ctx, self._tool_guardrails, ToolUnauthorizedError)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _run_pipeline(
        self,
        ctx: GuardrailContext,
        guardrails: list[InputGuardrail] | list[OutputGuardrail] | list[ToolGuardrail],
        block_exception_cls: type[GuardrailError],
    ) -> str:
        """Run a sequence of guardrails against the context.

        Implements ALLOW/BLOCK/MODIFY/WARN semantics. MODIFY updates
        ``ctx.content`` in place before passing to the next guardrail.

        Args:
            ctx: The guardrail context to evaluate. ``content`` may be mutated
                on MODIFY actions.
            guardrails: The ordered list of guardrails to run.
            block_exception_cls: Which exception class to raise on BLOCK.

        Returns:
            The final (possibly modified) content string.

        Raises:
            GuardrailError: Subclass of ``block_exception_cls`` on BLOCK, or
                :class:`~agent_service_maf.core.exceptions.GuardrailError` on
                internal error when ``fail_open=False``.
        """
        items: list[InputGuardrail | OutputGuardrail | ToolGuardrail] = list(guardrails)

        for guardrail in items:
            result = await self._safe_check(guardrail, ctx)
            if result is None:
                # fail_open handled the exception — skip this guardrail
                continue

            await self._process_result(result, ctx, block_exception_cls)

        return ctx.content

    async def _safe_check(
        self,
        guardrail: InputGuardrail | OutputGuardrail | ToolGuardrail,
        ctx: GuardrailContext,
    ) -> GuardrailResult | None:
        """Run a single guardrail's check() with error handling.

        Args:
            guardrail: The guardrail instance to check.
            ctx: The current guardrail context.

        Returns:
            The :class:`GuardrailResult`, or ``None`` if ``fail_open=True`` and
            the guardrail raised an internal exception.

        Raises:
            GuardrailError: If the guardrail raises and ``fail_open=False``.
        """
        try:
            result: GuardrailResult = await guardrail.check(ctx)
            return result
        except (InputBlockedError, OutputBlockedError, ToolUnauthorizedError, GuardrailError):
            # These are intentional block signals — re-raise regardless of fail_open
            raise
        except Exception as exc:
            guardrail_name = getattr(guardrail, "name", type(guardrail).__name__)
            logger.error(
                "Guardrail raised an internal exception",
                guardrail_name=guardrail_name,
                error_type=type(exc).__name__,
                error=str(exc),
                correlation_id=ctx.correlation_id,
                fail_open=self._fail_open,
            )
            if self._fail_open:
                return None
            raise GuardrailError(
                f"Guardrail '{guardrail_name}' encountered an internal error: "
                f"{type(exc).__name__}. "
                f"Check logs for correlation_id='{ctx.correlation_id}'. "
                f"Set guardrails.fail_open=true to allow requests through on errors.",
                details={
                    "guardrail_name": guardrail_name,
                    "error_type": type(exc).__name__,
                    "correlation_id": ctx.correlation_id,
                },
            ) from exc

    async def _process_result(
        self,
        result: GuardrailResult,
        ctx: GuardrailContext,
        block_exception_cls: type[GuardrailError],
    ) -> None:
        """Process a single guardrail result and mutate ctx.content if MODIFY.

        Args:
            result: The guardrail's evaluation result.
            ctx: Mutable context. On MODIFY, ``ctx.content`` is replaced with
                ``result.modified_content``.
            block_exception_cls: Exception class to raise on BLOCK.

        Raises:
            GuardrailError: Subclass of ``block_exception_cls`` on BLOCK action.
        """
        action = result.action

        if action == GuardrailAction.ALLOW:
            return

        if action == GuardrailAction.BLOCK:
            logger.warning(
                "Guardrail blocked request",
                guardrail_name=result.guardrail_name,
                message=result.message,
                correlation_id=ctx.correlation_id,
                agent_id=ctx.agent_id,
                guardrail_type=ctx.guardrail_type,
            )
            raise block_exception_cls(
                f"Request blocked by guardrail '{result.guardrail_name}': {result.message}",
                details={
                    "guardrail_name": result.guardrail_name,
                    "guardrail_type": ctx.guardrail_type,
                    "correlation_id": ctx.correlation_id,
                },
            )

        if action == GuardrailAction.MODIFY:
            if result.modified_content is not None:
                logger.info(
                    "Guardrail modified content",
                    guardrail_name=result.guardrail_name,
                    message=result.message,
                    correlation_id=ctx.correlation_id,
                    agent_id=ctx.agent_id,
                )
                ctx.content = result.modified_content
            return

        if action == GuardrailAction.WARN:
            logger.warning(
                "Guardrail issued warning",
                guardrail_name=result.guardrail_name,
                message=result.message,
                correlation_id=ctx.correlation_id,
                agent_id=ctx.agent_id,
                guardrail_type=ctx.guardrail_type,
            )
            return
