"""Output length guard — enforces maximum output character count.

Prevents excessively long agent responses from reaching the caller. Can either
block the response or truncate it depending on configuration.
"""

from __future__ import annotations

from typing import Any

import structlog

from agent_service_maf.guardrails.base import (
    GuardrailAction,
    GuardrailContext,
    GuardrailResult,
    OutputGuardrail,
    resolve_action,
)
from agent_service_maf.guardrails.registry import GuardrailRegistry

logger = structlog.get_logger(__name__)

_DEFAULT_MAX_CHARS = 50_000

#: ``output_length`` supports ``block`` (default) and ``modify`` (truncate).
_OUTPUT_LENGTH_ALLOWED_ACTIONS = frozenset({GuardrailAction.BLOCK, GuardrailAction.MODIFY})


@GuardrailRegistry.register_output("output_length")
class OutputLengthGuard(OutputGuardrail):
    """Enforces a maximum character count on agent output.

    Behaviour depends on ``action_on_trigger``:
    - ``"block"`` (default): Returns ``BLOCK`` if output exceeds ``max_chars``.
    - ``"modify"``: Returns ``MODIFY`` with the output truncated to ``max_chars``,
      appending ``"... [TRUNCATED]"`` to indicate the truncation.

    Args:
        config: Optional configuration dict. Recognised keys:
            - ``max_chars`` (int): Maximum allowed character count. Default 50 000.
            - ``action_on_trigger`` (str): ``"block"`` or ``"modify"``.
              Default ``"block"``.

    Example:
        >>> guard = OutputLengthGuard(config={"max_chars": 1000, "action_on_trigger": "modify"})
        >>> ctx = GuardrailContext.for_output("A" * 2000, "agent", "cid")
        >>> result = await guard.check(ctx)
        >>> result.action
        <GuardrailAction.MODIFY: 'modify'>
        >>> len(result.modified_content) <= 1010  # max_chars + len(" [TRUNCATED]")
        True
    """

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        cfg = config or {}
        self._max_chars: int = int(cfg.get("max_chars", _DEFAULT_MAX_CHARS))
        self._trigger_action: GuardrailAction = resolve_action(
            cfg.get("action_on_trigger"),
            default=GuardrailAction.BLOCK,
            allowed=_OUTPUT_LENGTH_ALLOWED_ACTIONS,
        )

    @property
    def name(self) -> str:
        """Return the guardrail registry name.

        Returns:
            ``"output_length"``
        """
        return "output_length"

    async def check(self, ctx: GuardrailContext) -> GuardrailResult:
        """Check the output length against the configured maximum.

        Args:
            ctx: Guardrail context. ``ctx.content`` is the agent response.

        Returns:
            ``ALLOW`` if within limit.
            ``BLOCK`` if over limit and ``action_on_trigger="block"``.
            ``MODIFY`` with truncated content if over limit and
            ``action_on_trigger="modify"``.

        Example:
            >>> result = await guard.check(ctx)
        """
        length = len(ctx.content)

        if length <= self._max_chars:
            return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

        logger.warning(
            "Output exceeds maximum length",
            length=length,
            max_chars=self._max_chars,
            agent_id=ctx.agent_id,
            correlation_id=ctx.correlation_id,
            action=self._trigger_action.value,
        )

        if self._trigger_action == GuardrailAction.MODIFY:
            truncated = ctx.content[: self._max_chars] + " [TRUNCATED]"
            return GuardrailResult(
                action=GuardrailAction.MODIFY,
                guardrail_name=self.name,
                message=(
                    f"Output truncated from {length} to {self._max_chars} characters. "
                    f"Increase guardrails output_length.config.max_chars if needed."
                ),
                modified_content=truncated,
                details={"original_length": length, "max_chars": self._max_chars},
            )

        return GuardrailResult(
            action=GuardrailAction.BLOCK,
            guardrail_name=self.name,
            message=(
                f"Output exceeds maximum length: {length} characters "
                f"(limit: {self._max_chars}). "
                f"Reduce agent max_tokens or increase output_length.config.max_chars."
            ),
            details={"length": length, "max_chars": self._max_chars},
        )
