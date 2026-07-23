"""Content filter guardrail — detects leaked secrets in agent output.

Scans agent responses for patterns that indicate leaked API keys, tokens, or
other credentials. If any pattern matches, the response is blocked to prevent
secrets from reaching the caller.

This guardrail is a defence-in-depth measure: secrets should never appear in
LLM output, but if they do (e.g., echoed from a tool result), this guardrail
catches them before the response leaves the service.
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
    OutputGuardrail,
    resolve_action,
)
from agent_service_maf.guardrails.registry import GuardrailRegistry

logger = structlog.get_logger(__name__)

#: Placeholder substituted for detected secrets when ``action_on_trigger="modify"``.
_SECRET_PLACEHOLDER = "[SECRET_REDACTED]"

#: Actions ``content_filter`` can produce on a secret hit. ``BLOCK`` rejects,
#: ``WARN`` allows but logs, ``MODIFY`` redacts the secret in place.
_CONTENT_FILTER_ALLOWED_ACTIONS = frozenset(
    {GuardrailAction.BLOCK, GuardrailAction.WARN, GuardrailAction.MODIFY}
)

#: Built-in secret detection patterns. Additional patterns can be added via
#: ``config.extra_patterns`` in the guardrail rule config.
_SECRET_PATTERNS: list[str] = [
    r"sk-[a-zA-Z0-9]{20,}",  # OpenAI API keys
    r"sk-ant-[a-zA-Z0-9\-]{20,}",  # Anthropic API keys
    r"AKIA[0-9A-Z]{16}",  # AWS access key IDs
    r"ghp_[a-zA-Z0-9]{36}",  # GitHub personal access tokens
    r"ghs_[a-zA-Z0-9]{36}",  # GitHub Actions tokens
    r"xoxb-[0-9A-Z\-]+",  # Slack bot tokens
    r"xoxp-[0-9A-Z\-]+",  # Slack user tokens
    r"AIza[0-9A-Za-z\-_]{35}",  # Google API keys
    r"[0-9a-f]{32}-us[0-9]+",  # Mailchimp API keys
    r"eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+",  # JWTs
]


@GuardrailRegistry.register_input("content_filter")
@GuardrailRegistry.register_output("content_filter")
class ContentFilter(InputGuardrail, OutputGuardrail):
    r"""Detects leaked secrets or credentials in agent input or output.

    Scans the content against a list of compiled regex patterns. The built-in
    patterns cover OpenAI, Anthropic, AWS, GitHub, Slack, Google, Mailchimp API
    keys and JWTs.

    Registered on **both** the input and output phases:

    - **Output:** prevents secrets echoed from tool results / training data from
      reaching the caller (default ``block``).
    - **Input:** prevents users from pasting credentials into prompts before they
      reach the LLM / gateway logs.

    The action taken on a match is configurable via the rule's
    ``action_on_trigger`` (merged into ``config`` by the registry):

    - ``block`` (default) — reject the request/response.
    - ``warn`` — allow but log a warning.
    - ``modify`` — redact each matched secret to ``[SECRET_REDACTED]``.

    Additional patterns can be added via ``config.extra_patterns``.

    Args:
        config: Optional configuration dict. Recognised keys:
            - ``extra_patterns`` (list[str]): Additional regex patterns to check
              alongside the built-in ones.
            - ``action_on_trigger`` (str): ``block`` | ``warn`` | ``modify``.
              Default ``block``.
            - ``message`` (str): Custom message for the result.

    Example:
        >>> cf = ContentFilter(config={"extra_patterns": [r"my_secret_prefix_\w+"]})
        >>> ctx = GuardrailContext.for_output("Here is the key: sk-abc123...", "agent", "cid")
        >>> result = await cf.check(ctx)
        >>> result.action
        <GuardrailAction.BLOCK: 'block'>
    """

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        cfg = config or {}
        extra: list[str] = list(cfg.get("extra_patterns", []))
        all_patterns = _SECRET_PATTERNS + extra

        self._compiled: list[re.Pattern[str]] = [re.compile(p, re.IGNORECASE) for p in all_patterns]
        # action_on_trigger merged in by GuardrailRegistry.build_pipeline.
        # Default ``block`` preserves historical output-filter behaviour.
        self._trigger_action: GuardrailAction = resolve_action(
            cfg.get("action_on_trigger"),
            default=GuardrailAction.BLOCK,
            allowed=_CONTENT_FILTER_ALLOWED_ACTIONS,
        )
        self._custom_message: str | None = cfg.get("message")

    @property
    def name(self) -> str:
        """Return the guardrail registry name.

        Returns:
            ``"content_filter"``
        """
        return "content_filter"

    async def check(self, ctx: GuardrailContext) -> GuardrailResult:
        """Scan content for leaked secrets and act per ``action_on_trigger``.

        Args:
            ctx: Guardrail context. ``ctx.content`` is the text to scan (user
                prompt on the input phase, agent response on the output phase).

        Returns:
            ``ALLOW`` if no secret pattern matches. Otherwise ``BLOCK`` / ``WARN``
            / ``MODIFY`` (redacted content) per the configured action.

        Example:
            >>> result = await cf.check(ctx)
            >>> result.action in (GuardrailAction.ALLOW, GuardrailAction.BLOCK)
            True
        """
        matched_patterns = [c.pattern for c in self._compiled if c.search(ctx.content)]

        if not matched_patterns:
            return GuardrailResult(
                action=GuardrailAction.ALLOW,
                guardrail_name=self.name,
            )

        logger.warning(
            "Content filter detected potential secret",
            match_count=len(matched_patterns),
            action=self._trigger_action.value,
            guardrail_type=ctx.guardrail_type,
            agent_id=ctx.agent_id,
            correlation_id=ctx.correlation_id,
        )
        details = {
            "matched_pattern": matched_patterns[0],
            "matched_patterns": matched_patterns,
        }

        if self._trigger_action == GuardrailAction.WARN:
            return GuardrailResult(
                action=GuardrailAction.WARN,
                guardrail_name=self.name,
                message=self._custom_message
                or "Content contains a potential leaked secret or credential "
                "(allowed with warning).",
                details=details,
            )

        if self._trigger_action == GuardrailAction.MODIFY:
            redacted = ctx.content
            for compiled in self._compiled:
                redacted = compiled.sub(_SECRET_PLACEHOLDER, redacted)
            return GuardrailResult(
                action=GuardrailAction.MODIFY,
                guardrail_name=self.name,
                message=self._custom_message
                or "Redacted potential leaked secret(s) or credential(s).",
                modified_content=redacted,
                details=details,
            )

        # Default: BLOCK.
        return GuardrailResult(
            action=GuardrailAction.BLOCK,
            guardrail_name=self.name,
            message=self._custom_message
            or "Content contains a potential leaked secret or credential.",
            details=details,
        )
