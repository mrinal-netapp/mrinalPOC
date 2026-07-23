"""Schema validator guardrail — validates structured output format.

Checks that agent output conforms to an expected format (JSON, markdown, or
plain text) and that required fields are present in JSON output.

This guardrail defaults to ``WARN`` action — format violations are typically
recoverable (the caller can handle non-conforming output), so blocking by
default would be too aggressive.
"""

from __future__ import annotations

import json
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

#: ``schema_validator`` cannot ``MODIFY`` malformed output, so it supports
#: ``warn`` (default) and ``block``.
_SCHEMA_VALIDATOR_ALLOWED_ACTIONS = frozenset({GuardrailAction.WARN, GuardrailAction.BLOCK})


@GuardrailRegistry.register_output("schema_validator")
class SchemaValidator(OutputGuardrail):
    """Validates agent output against expected format and field requirements.

    Checks:
    1. If ``expected_format="json"``: output must be valid JSON.
    2. If ``required_fields`` is set: each field name must appear as a top-level
       key in the parsed JSON object.

    The default action on failure is ``WARN`` (configurable via the guardrail
    rule's ``action_on_trigger`` field).

    Args:
        config: Optional configuration dict. Recognised keys:
            - ``required_fields`` (list[str]): Field names that must appear as
              top-level keys in the JSON output.
            - ``expected_format`` (str): Expected format: ``"json"``,
              ``"markdown"``, or ``"plain"``. Default: ``""`` (no format check).
            - ``action_on_trigger`` (str): ``"warn"`` or ``"block"``. Default ``"warn"``.

    Example:
        >>> sv = SchemaValidator(config={
        ...     "required_fields": ["summary", "issues"],
        ...     "expected_format": "json",
        ... })
        >>> ctx = GuardrailContext.for_output('{"summary": "ok"}', "agent", "cid")
        >>> result = await sv.check(ctx)
        >>> result.action
        <GuardrailAction.WARN: 'warn'>
    """

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        cfg = config or {}
        self._required_fields: list[str] = list(cfg.get("required_fields", []))
        self._expected_format: str = str(cfg.get("expected_format", "")).lower()
        self._trigger_action: GuardrailAction = resolve_action(
            cfg.get("action_on_trigger"),
            default=GuardrailAction.WARN,
            allowed=_SCHEMA_VALIDATOR_ALLOWED_ACTIONS,
        )

    @property
    def name(self) -> str:
        """Return the guardrail registry name.

        Returns:
            ``"schema_validator"``
        """
        return "schema_validator"

    async def check(self, ctx: GuardrailContext) -> GuardrailResult:
        """Validate the output format and required fields.

        Args:
            ctx: Guardrail context. ``ctx.content`` is the agent response to validate.

        Returns:
            ``ALLOW`` if no validation is configured or all checks pass.
            ``WARN`` (or ``BLOCK`` if configured) if validation fails.

        Example:
            >>> result = await sv.check(ctx)
        """
        content = ctx.content

        # No validation configured — allow through
        if not self._required_fields and not self._expected_format:
            return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

        # JSON format and field checks
        if self._expected_format == "json" or self._required_fields:
            parsed = self._try_parse_json(content)
            if parsed is None:
                return GuardrailResult(
                    action=self._trigger_action,
                    guardrail_name=self.name,
                    message=(
                        "Agent output is not valid JSON. "
                        "Ensure the agent's output schema is correctly configured "
                        "or adjust the schema_validator expected_format."
                    ),
                    details={"expected_format": self._expected_format},
                )

            missing = self._check_required_fields(parsed)
            if missing:
                return GuardrailResult(
                    action=self._trigger_action,
                    guardrail_name=self.name,
                    message=(
                        f"Agent output is missing required JSON fields: {missing}. "
                        f"Adjust the agent's output instructions to include these fields."
                    ),
                    details={"missing_fields": missing, "required_fields": self._required_fields},
                )

        return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

    def _try_parse_json(self, content: str) -> dict[str, Any] | None:
        """Attempt to parse content as JSON.

        Args:
            content: The string to parse.

        Returns:
            Parsed dict if valid JSON object, ``None`` otherwise.
        """
        try:
            parsed = json.loads(content.strip())
            if isinstance(parsed, dict):
                return parsed
            return None
        except (json.JSONDecodeError, ValueError):
            return None

    def _check_required_fields(self, parsed: dict[str, Any]) -> list[str]:
        """Return list of required fields missing from the parsed output.

        Args:
            parsed: The parsed JSON dict to check.

        Returns:
            List of missing field names. Empty if all required fields are present.
        """
        return [f for f in self._required_fields if f not in parsed]
