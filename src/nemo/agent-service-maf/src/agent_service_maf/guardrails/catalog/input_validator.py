"""Input validator guardrail — enforces length and basic format constraints.

Validates user input before it reaches the agent adapter. Blocks requests that
are empty, too short, too long, or contain invalid content.
"""

from __future__ import annotations

from typing import Any

from agent_service_maf.guardrails.base import (
    GuardrailAction,
    GuardrailContext,
    GuardrailResult,
    InputGuardrail,
    resolve_action,
)
from agent_service_maf.guardrails.registry import GuardrailRegistry

_DEFAULT_MAX_LENGTH = 10_000
_DEFAULT_MIN_LENGTH = 1

#: ``input_validator`` cannot meaningfully ``MODIFY`` a length violation, so it
#: only supports ``block`` (default) and ``warn``.
_INPUT_VALIDATOR_ALLOWED_ACTIONS = frozenset({GuardrailAction.BLOCK, GuardrailAction.WARN})


@GuardrailRegistry.register_input("input_validator")
class InputValidator(InputGuardrail):
    """Validates input length and basic format constraints.

    Blocks requests that are empty, too short, or exceed the configured
    maximum length. All checks are performed locally without LLM calls.

    Args:
        config: Optional configuration dict. Recognised keys:
            - ``max_length`` (int): Maximum allowed character count (default 10 000).
            - ``min_length`` (int): Minimum allowed character count (default 1).

    Example:
        >>> validator = InputValidator(config={"max_length": 5000, "min_length": 10})
        >>> result = await validator.check(ctx)
    """

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        cfg = config or {}
        self._max_length: int = int(cfg.get("max_length", _DEFAULT_MAX_LENGTH))
        self._min_length: int = int(cfg.get("min_length", _DEFAULT_MIN_LENGTH))
        # action_on_trigger merged in by GuardrailRegistry.build_pipeline.
        self._trigger_action: GuardrailAction = resolve_action(
            cfg.get("action_on_trigger"),
            default=GuardrailAction.BLOCK,
            allowed=_INPUT_VALIDATOR_ALLOWED_ACTIONS,
        )

    @property
    def name(self) -> str:
        """Return the guardrail registry name.

        Returns:
            ``"input_validator"``
        """
        return "input_validator"

    async def check(self, ctx: GuardrailContext) -> GuardrailResult:
        """Validate the input content length.

        Args:
            ctx: Guardrail context. ``ctx.content`` is the text to validate.

        Returns:
            ``ALLOW`` if the input passes all length checks.
            ``BLOCK`` if the input is empty, too short, or too long.

        Example:
            >>> ctx = GuardrailContext.for_input("Hello!", "agent-1", "corr-1")
            >>> result = await validator.check(ctx)
            >>> result.action
            <GuardrailAction.ALLOW: 'allow'>
        """
        content = ctx.content
        length = len(content)

        if length < self._min_length:
            return GuardrailResult(
                action=self._trigger_action,
                guardrail_name=self.name,
                message=(
                    f"Input is too short: {length} character(s). "
                    f"Minimum required: {self._min_length}. "
                    f"Provide a non-empty input with at least {self._min_length} character(s)."
                ),
                details={"length": length, "min_length": self._min_length},
            )

        if length > self._max_length:
            return GuardrailResult(
                action=self._trigger_action,
                guardrail_name=self.name,
                message=(
                    f"Input exceeds maximum length: {length} characters "
                    f"(limit: {self._max_length}). "
                    f"Shorten the input or increase input_validator.config.max_length "
                    f"in agent_config.json."
                ),
                details={"length": length, "max_length": self._max_length},
            )

        return GuardrailResult(
            action=GuardrailAction.ALLOW,
            guardrail_name=self.name,
        )
