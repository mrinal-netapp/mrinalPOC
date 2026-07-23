"""Tool authorizer and call counter guardrails.

Implements the Single Responsibility Principle by separating:

- :class:`ToolCallCounter`: Tracks per-correlation-id tool call counts.
  Owns no policy logic — only accounting.
- :class:`ToolAuthorizer`: Enforces allowlist/denylist policy by delegating
  call counting to an injected :class:`ToolCallCounter`.

This separation makes each class independently testable and mockable.
"""

from __future__ import annotations

import threading
from collections import defaultdict
from typing import TYPE_CHECKING, Any

import structlog

from agent_service_maf.guardrails.base import (
    GuardrailAction,
    GuardrailContext,
    GuardrailResult,
    ToolGuardrail,
)
from agent_service_maf.guardrails.registry import GuardrailRegistry

if TYPE_CHECKING:
    from agent_service_maf.config.validators import ToolPolicy

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# ToolCallCounter (SRP: accounting only)
# ---------------------------------------------------------------------------


@GuardrailRegistry.register_tool("tool_call_counter")
class ToolCallCounter(ToolGuardrail):
    """Tracks the number of tool calls per correlation ID within a request.

    This class is responsible solely for counting — it applies no policy.
    :class:`ToolAuthorizer` calls :meth:`check_limit` to verify the count
    before incrementing.

    The counter is thread-safe using a :class:`threading.Lock`.

    Args:
        config: Optional configuration dict (currently unused; reserved for
            future persistence backends).

    Example:
        >>> counter = ToolCallCounter()
        >>> counter.check_limit("corr-123", max_calls=5)  # True — under limit
        True
        >>> counter.increment("corr-123")
        >>> counter.get_count("corr-123")
        1
    """

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        # dict[correlation_id, count]
        self._counts: dict[str, int] = defaultdict(int)
        self._lock = threading.Lock()

    @property
    def name(self) -> str:
        """Return the guardrail registry name.

        Returns:
            ``"tool_call_counter"``
        """
        return "tool_call_counter"

    async def check(self, ctx: GuardrailContext) -> GuardrailResult:
        """Passthrough — counter does not enforce policy on its own.

        The :class:`ToolAuthorizer` is responsible for calling
        :meth:`check_limit` and then :meth:`increment`. This method is
        implemented to satisfy the :class:`~agent_service_maf.guardrails.base.ToolGuardrail`
        ABC contract but always returns ``ALLOW``.

        Args:
            ctx: Guardrail context (unused by the counter).

        Returns:
            Always ``ALLOW``.
        """
        return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

    def check_limit(self, correlation_id: str, max_calls: int) -> bool:
        """Check whether the current count is below the limit.

        Args:
            correlation_id: The request correlation ID.
            max_calls: The maximum number of tool calls allowed for this request.

        Returns:
            ``True`` if the current count is **strictly less than** ``max_calls``
            (i.e., incrementing would not exceed the limit). ``False`` if the
            limit has already been reached or exceeded.
        """
        with self._lock:
            return self._counts[correlation_id] < max_calls

    def increment(self, correlation_id: str) -> int:
        """Increment the call count for a correlation ID.

        Args:
            correlation_id: The request correlation ID.

        Returns:
            The new count after incrementing.
        """
        with self._lock:
            self._counts[correlation_id] += 1
            return self._counts[correlation_id]

    def get_count(self, correlation_id: str) -> int:
        """Return the current tool call count for a correlation ID.

        Args:
            correlation_id: The request correlation ID.

        Returns:
            The current count (0 if the correlation ID has not been seen).
        """
        with self._lock:
            return self._counts[correlation_id]

    def reset(self, correlation_id: str) -> None:
        """Reset the count for a correlation ID (e.g., after request completion).

        Args:
            correlation_id: The request correlation ID to reset.
        """
        with self._lock:
            self._counts.pop(correlation_id, None)


# ---------------------------------------------------------------------------
# ToolAuthorizer (SRP: policy enforcement only)
# ---------------------------------------------------------------------------


@GuardrailRegistry.register_tool("tool_authorizer")
class ToolAuthorizer(ToolGuardrail):
    """Enforces tool allowlist/denylist policy and max call limits.

    Checks (in order):
    1. **Call count**: If ``max_calls_per_request`` is reached, block.
    2. **Allowlist mode**: Only tools in ``policy.tools`` are permitted.
    3. **Denylist mode**: All tools except those in ``policy.tools`` are permitted.

    On ``ALLOW``, increments the counter via the injected :class:`ToolCallCounter`.

    Args:
        policy: The :class:`~agent_service_maf.config.validators.ToolPolicy`
            specifying mode, tools list, and max_calls_per_request.
        counter: An injected :class:`ToolCallCounter` for call accounting.
        config: Optional configuration dict (currently unused).

    Example:
        >>> from agent_service_maf.config.validators import ToolPolicy
        >>> policy = ToolPolicy(mode="allowlist", tools=["search", "read_file"])
        >>> counter = ToolCallCounter()
        >>> auth = ToolAuthorizer(policy=policy, counter=counter)
        >>> ctx = GuardrailContext.for_tool("search", {}, "agent", "corr-1")
        >>> result = await auth.check(ctx)
        >>> result.action
        <GuardrailAction.ALLOW: 'allow'>
    """

    def __init__(
        self,
        policy: ToolPolicy,
        counter: ToolCallCounter,
        config: dict[str, Any] | None = None,
    ) -> None:
        self._policy = policy
        self._counter = counter

    @property
    def name(self) -> str:
        """Return the guardrail registry name.

        Returns:
            ``"tool_authorizer"``
        """
        return "tool_authorizer"

    async def check(self, ctx: GuardrailContext) -> GuardrailResult:
        """Authorise a tool call against the configured policy.

        Args:
            ctx: Guardrail context with ``guardrail_type="tool"``.
                ``ctx.extra["tool_name"]`` must contain the tool name.
                ``ctx.correlation_id`` is used for call counting.

        Returns:
            ``ALLOW`` if the tool call is authorised (and increments the counter).
            ``BLOCK`` if the tool is not in the allowlist, is in the denylist,
            or the call limit has been reached.

        Example:
            >>> result = await auth.check(ctx)
        """
        tool_name: str = ctx.extra.get("tool_name", "")
        correlation_id = ctx.correlation_id
        max_calls = self._policy.max_calls_per_request

        # 1. Check call count limit
        if not self._counter.check_limit(correlation_id, max_calls):
            current_count = self._counter.get_count(correlation_id)
            logger.warning(
                "Tool call limit exceeded",
                tool_name=tool_name,
                current_count=current_count,
                max_calls=max_calls,
                agent_id=ctx.agent_id,
                correlation_id=correlation_id,
            )
            return GuardrailResult(
                action=GuardrailAction.BLOCK,
                guardrail_name=self.name,
                message=(
                    f"Maximum tool call limit reached ({current_count}/{max_calls}). "
                    f"Increase tool_policy.max_calls_per_request or reduce the number "
                    f"of tool calls in the agent's instructions."
                ),
                details={
                    "tool_name": tool_name,
                    "current_count": current_count,
                    "max_calls": max_calls,
                },
            )

        # 2. Check allowlist / denylist
        mode = self._policy.mode.lower()
        allowed_tools = list(self._policy.tools)

        if mode == "allowlist":
            if tool_name not in allowed_tools:
                logger.warning(
                    "Tool blocked by allowlist policy",
                    tool_name=tool_name,
                    allowed_tools=allowed_tools,
                    agent_id=ctx.agent_id,
                    correlation_id=correlation_id,
                )
                return GuardrailResult(
                    action=GuardrailAction.BLOCK,
                    guardrail_name=self.name,
                    message=(
                        f"Tool '{tool_name}' is not in the agent's allowed tool list. "
                        f"Add it to tool_policy.tools or switch to denylist mode."
                    ),
                    details={"tool_name": tool_name, "mode": "allowlist"},
                )

        elif mode == "denylist" and tool_name in allowed_tools:
            logger.warning(
                "Tool blocked by denylist policy",
                tool_name=tool_name,
                denied_tools=allowed_tools,
                agent_id=ctx.agent_id,
                correlation_id=correlation_id,
            )
            return GuardrailResult(
                action=GuardrailAction.BLOCK,
                guardrail_name=self.name,
                message=(
                    f"Tool '{tool_name}' is explicitly denied by the agent's tool policy. "
                    f"Remove it from tool_policy.tools to allow access."
                ),
                details={"tool_name": tool_name, "mode": "denylist"},
            )

        # 3. Authorised — increment counter
        new_count = self._counter.increment(correlation_id)
        logger.debug(
            "Tool call authorised",
            tool_name=tool_name,
            call_count=new_count,
            max_calls=max_calls,
            agent_id=ctx.agent_id,
            correlation_id=correlation_id,
        )

        return GuardrailResult(
            action=GuardrailAction.ALLOW,
            guardrail_name=self.name,
        )
