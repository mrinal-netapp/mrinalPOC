"""Custom regex filter guardrail (Task 004 #3).

Dual-phase (input + output) guardrail that applies **operator-defined** regex
patterns from ``config.patterns[]`` only — there is **no built-in pattern pack**
and no semantic defaults. It is the canonical standalone guardrail for generic
team policies (competitor names, internal codes, hostnames, custom prefixes).

Pure standard-library regex (no external dependency, no ML):

- ``config.patterns`` — flat list of Python regex strings; the only match source.
- Matches are redacted with ``config.placeholder`` (default ``[CUSTOM_REDACTED]``).
- Empty / missing ``patterns`` -> the guardrail always returns ``ALLOW`` (not an error).
- An invalid regex in ``patterns`` raises :class:`ConfigurationError` at build time.

Do **not** modify ``prompt_injection`` / ``content_filter`` / ``tool_result_guardrail``.
Use this guardrail for generic operator regex; use ``word_blocklist`` for plain
words / phrases without regex knowledge.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import structlog

from agent_service_maf.core.exceptions import ConfigurationError
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

#: Actions ``custom_regex`` can produce on a hit.
_CUSTOM_REGEX_ALLOWED_ACTIONS = frozenset(
    {GuardrailAction.MODIFY, GuardrailAction.BLOCK, GuardrailAction.WARN}
)

_DEFAULT_PLACEHOLDER = "[CUSTOM_REDACTED]"

#: Existing redaction placeholders, e.g. ``[PAN_REDACTED]`` — matches inside one
#: are skipped to avoid double-wrapping.
_PLACEHOLDER_RE = re.compile(r"\[[A-Z0-9_]+_REDACTED\]")


# ---------------------------------------------------------------------------
# CustomRegexConfig
# ---------------------------------------------------------------------------


@dataclass
class CustomRegexConfig:
    """Resolved custom-regex config.

    Attributes:
        patterns: Operator-supplied regex strings. Default empty list.
        placeholder: Replacement text used on ``MODIFY``. Default ``[CUSTOM_REDACTED]``.
        case_insensitive: Compile patterns with ``re.IGNORECASE``. Default ``True``.
    """

    patterns: list[str] = field(default_factory=list)
    placeholder: str = _DEFAULT_PLACEHOLDER
    case_insensitive: bool = True

    @classmethod
    def from_dict(cls, config: dict[str, Any]) -> CustomRegexConfig:
        """Build from config dict (``patterns`` / ``placeholder`` / ``case_insensitive``)."""
        return cls(
            patterns=list(config.get("patterns", [])),
            placeholder=str(config.get("placeholder", _DEFAULT_PLACEHOLDER)),
            case_insensitive=bool(config.get("case_insensitive", True)),
        )


# ---------------------------------------------------------------------------
# CustomRegexDetector (compile + scan)
# ---------------------------------------------------------------------------


class CustomRegexDetector:
    """Compiles operator patterns and finds / redacts matches."""

    def __init__(self, config: CustomRegexConfig) -> None:
        self._config = config
        flags = re.UNICODE | (re.IGNORECASE if config.case_insensitive else 0)
        self._compiled: list[re.Pattern[str]] = []
        for pattern in config.patterns:
            try:
                self._compiled.append(re.compile(pattern, flags))
            except re.error as exc:
                raise ConfigurationError(
                    f"Invalid 'custom_regex' pattern '{pattern}': {exc}. "
                    "Fix the pattern in the guardrail rule's config.patterns in team config.",
                    details={"invalid_pattern": pattern},
                ) from exc

    @property
    def pattern_count(self) -> int:
        """Number of compiled patterns."""
        return len(self._compiled)

    def find_all(self, text: str) -> list[tuple[int, int]]:
        """Return de-overlapped match spans, excluding spans inside existing placeholders."""
        protected = [(m.start(), m.end()) for m in _PLACEHOLDER_RE.finditer(text)]
        spans: list[tuple[int, int]] = []
        for compiled in self._compiled:
            for m in compiled.finditer(text):
                if m.start() == m.end():
                    continue
                if any(p_start <= m.start() < p_end for p_start, p_end in protected):
                    continue
                spans.append((m.start(), m.end()))
        return self._dedupe(spans)

    @staticmethod
    def _dedupe(spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
        """Merge overlapping spans so all matched text is redacted."""
        if not spans:
            return []

        ordered = sorted(spans, key=lambda s: (s[0], s[1]))
        merged: list[tuple[int, int]] = []
        cur_start, cur_end = ordered[0]
        for start, end in ordered[1:]:
            if start > cur_end:
                merged.append((cur_start, cur_end))
                cur_start, cur_end = start, end
            else:
                cur_end = max(cur_end, end)
        merged.append((cur_start, cur_end))
        return merged

    def redact(self, text: str, spans: list[tuple[int, int]]) -> str:
        """Replace matched spans with the placeholder, end -> start."""
        result = text
        for start, end in sorted(spans, key=lambda s: s[0], reverse=True):
            result = result[:start] + self._config.placeholder + result[end:]
        return result


# ---------------------------------------------------------------------------
# CustomRegexGuard (dual-phase guardrail)
# ---------------------------------------------------------------------------


@GuardrailRegistry.register_input("custom_regex")
@GuardrailRegistry.register_output("custom_regex")
class CustomRegexGuard(InputGuardrail, OutputGuardrail):
    r"""Applies operator-defined regex patterns on input or output.

    Honours ``action_on_trigger`` (merged into config by the registry):
    ``modify`` (default) redacts matches, ``block`` rejects, ``warn`` logs.
    With no patterns configured, always returns ``ALLOW``.

    Args:
        config: Optional config dict. Recognised keys: ``patterns`` (list[str],
            default ``[]``), ``placeholder`` (str, default ``[CUSTOM_REDACTED]``),
            ``case_insensitive`` (bool, default ``True``), plus ``action_on_trigger``
            / ``message`` (merged by the registry).

    Raises:
        ConfigurationError: If any pattern in ``patterns`` is invalid regex.
    """

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        cfg = config or {}
        self._config = CustomRegexConfig.from_dict(cfg)
        self._detector = CustomRegexDetector(self._config)
        self._trigger_action: GuardrailAction = resolve_action(
            cfg.get("action_on_trigger"),
            default=GuardrailAction.MODIFY,
            allowed=_CUSTOM_REGEX_ALLOWED_ACTIONS,
        )
        self._custom_message: str | None = cfg.get("message")

    @property
    def name(self) -> str:
        """Return the guardrail registry name."""
        return "custom_regex"

    async def check(self, ctx: GuardrailContext) -> GuardrailResult:
        """Scan content against the operator patterns and act on matches."""
        if self._detector.pattern_count == 0:
            return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

        spans = self._detector.find_all(ctx.content)
        if not spans:
            return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

        total = len(spans)
        logger.info(
            "Custom regex pattern matched",
            match_count=total,
            pattern_count=self._detector.pattern_count,
            action=self._trigger_action.value,
            guardrail_type=ctx.guardrail_type,
            agent_id=ctx.agent_id,
            correlation_id=ctx.correlation_id,
        )
        details = {"match_count": total, "pattern_count": self._detector.pattern_count}

        if self._trigger_action == GuardrailAction.BLOCK:
            return GuardrailResult(
                action=GuardrailAction.BLOCK,
                guardrail_name=self.name,
                message=self._custom_message
                or f"Blocked content matching {total} custom pattern(s).",
                details=details,
            )

        if self._trigger_action == GuardrailAction.WARN:
            return GuardrailResult(
                action=GuardrailAction.WARN,
                guardrail_name=self.name,
                message=self._custom_message
                or f"Matched {total} custom pattern(s) (allowed with warning).",
                details=details,
            )

        return GuardrailResult(
            action=GuardrailAction.MODIFY,
            guardrail_name=self.name,
            message=self._custom_message or f"Redacted {total} custom pattern match(es).",
            modified_content=self._detector.redact(ctx.content, spans),
            details=details,
        )
