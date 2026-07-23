"""Prompt injection detector guardrail.

Detects common prompt injection attack patterns using compiled regex. Patterns
are loaded from guardrail config first, with hard-coded :data:`DEFAULT_PATTERNS`
as a fallback — ensuring behaviour can be changed via config without code changes.

All pattern matching uses case-insensitive compiled :mod:`re` objects for performance.
"""

from __future__ import annotations

import re
from typing import Any

import structlog

from agent_service_maf.guardrails.base import (
    GuardrailAction,
    GuardrailContext,
    GuardrailResult,
    InputGuardrail,
    resolve_action,
)
from agent_service_maf.guardrails.registry import GuardrailRegistry

logger = structlog.get_logger(__name__)

#: ``prompt_injection`` cannot ``MODIFY`` an injection attempt, so it only
#: supports ``block`` (default) and ``warn``.
_PROMPT_INJECTION_ALLOWED_ACTIONS = frozenset({GuardrailAction.BLOCK, GuardrailAction.WARN})

#: Default prompt injection patterns used when none are configured.
#: These cover the most common attack vectors. Override or extend via config.
DEFAULT_PATTERNS: list[str] = [
    r"ignore\s+(all\s+)?previous\s+instructions",
    r"you\s+are\s+now\s+",
    r"(system|new)\s+(prompt|instructions)\s*:",
    r"forget\s+(everything|all|your)",
    r"disregard\s+(all|previous|your)",
    r"override\s+(your\s+)?(previous\s+)?instructions",
    r"act\s+as\s+if\s+you\s+are",
    r"pretend\s+you\s+are\s+(a|an|the)\s+",
    r"jailbreak",
    r"do\s+anything\s+now",
    r"dan\s+mode",
    r"developer\s+mode\s+(enabled|on|activated)",
]


@GuardrailRegistry.register_input("prompt_injection")
class PromptInjectionDetector(InputGuardrail):
    r"""Detects prompt injection patterns in user input.

    Uses compiled regular expressions. Patterns are merged from:
    1. ``config.patterns`` — custom patterns from guardrail rule config.
    2. :data:`DEFAULT_PATTERNS` — built-in fallback patterns.

    All patterns use case-insensitive matching. Config patterns are prepended
    before the defaults so they take priority.

    Args:
        config: Optional configuration dict. Recognised keys:
            - ``patterns`` (list[str]): Additional regex patterns to prepend to
              the default set. Each pattern must be a valid Python regex.

    Raises:
        re.error: At construction time if a configured pattern is invalid regex.
            Fix by correcting the pattern in ``guardrails.input_guardrails
            [prompt_injection].config.patterns`` in agent_config.json.

    Example:
        >>> detector = PromptInjectionDetector(config={"patterns": [r"evil\s+command"]})
        >>> ctx = GuardrailContext.for_input("ignore previous instructions", "agent", "cid")
        >>> result = await detector.check(ctx)
        >>> result.action
        <GuardrailAction.BLOCK: 'block'>
    """

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        cfg = config or {}
        config_patterns: list[str] = list(cfg.get("patterns", []))

        # action_on_trigger merged in by GuardrailRegistry.build_pipeline.
        self._trigger_action: GuardrailAction = resolve_action(
            cfg.get("action_on_trigger"),
            default=GuardrailAction.BLOCK,
            allowed=_PROMPT_INJECTION_ALLOWED_ACTIONS,
        )

        # Merge config patterns first (they can override/extend defaults)
        all_patterns = config_patterns + DEFAULT_PATTERNS

        self._compiled: list[re.Pattern[str]] = []
        for pattern in all_patterns:
            try:
                self._compiled.append(re.compile(pattern, re.IGNORECASE | re.UNICODE))
            except re.error as exc:
                raise re.error(
                    f"Invalid prompt injection pattern '{pattern}': {exc}. "
                    f"Fix the pattern in guardrails.input_guardrails"
                    f"[prompt_injection].config.patterns in agent_config.json."
                ) from exc

        logger.debug(
            "PromptInjectionDetector initialised",
            pattern_count=len(self._compiled),
            config_pattern_count=len(config_patterns),
        )

    @property
    def name(self) -> str:
        """Return the guardrail registry name.

        Returns:
            ``"prompt_injection"``
        """
        return "prompt_injection"

    async def check(self, ctx: GuardrailContext) -> GuardrailResult:
        """Scan input content for prompt injection patterns.

        Args:
            ctx: Guardrail context. ``ctx.content`` is the text to scan.

        Returns:
            ``BLOCK`` if any pattern matches.
            ``ALLOW`` otherwise.

        Example:
            >>> ctx = GuardrailContext.for_input("Hello! How are you?", "agent", "cid")
            >>> result = await detector.check(ctx)
            >>> result.action
            <GuardrailAction.ALLOW: 'allow'>
        """
        for compiled in self._compiled:
            match = compiled.search(ctx.content)
            if match:
                logger.info(
                    "Prompt injection pattern detected",
                    pattern=compiled.pattern,
                    action=self._trigger_action.value,
                    agent_id=ctx.agent_id,
                    correlation_id=ctx.correlation_id,
                )
                return GuardrailResult(
                    action=self._trigger_action,
                    guardrail_name=self.name,
                    message="Prompt injection pattern detected in input.",
                    details={"matched_pattern": compiled.pattern},
                )

        return GuardrailResult(
            action=GuardrailAction.ALLOW,
            guardrail_name=self.name,
        )
