"""Word / phrase blocklist guardrail (Task 004 #4).

Dual-phase (input + output) guardrail for **plain word and phrase** denylists —
operators supply plain terms, never regex. It complements ``custom_regex``
(which is for operators who need regex power):

- ``words[]``   -> whole-word match only (``\b`` boundaries; ``"ass"`` never matches ``"class"``).
- ``phrases[]`` -> contiguous phrase match (whitespace between tokens is flexible).

Pure standard-library regex with ``re.escape`` (no external dependency, no ML;
no ReDoS risk since operators never write raw regex):

- ``case_insensitive`` (default ``True``) compiles patterns with ``re.IGNORECASE``.
- Empty / missing ``words`` **and** ``phrases`` -> the guardrail always returns ``ALLOW``.
- Default action is ``block``; ``modify`` redacts with ``placeholder`` (default ``[BLOCKED]``).

v1 reads lists from team JSON only; a central managed policy store is out of scope.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
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

#: Actions ``word_blocklist`` can produce on a hit.
_WORD_BLOCKLIST_ALLOWED_ACTIONS = frozenset(
    {GuardrailAction.BLOCK, GuardrailAction.WARN, GuardrailAction.MODIFY}
)

_DEFAULT_PLACEHOLDER = "[BLOCKED]"


def _compile_word_pattern(word: str, flags: int) -> re.Pattern[str]:
    r"""Compile a whole-word matcher for a plain term (``\b`` + escaped term + ``\b``)."""
    return re.compile(rf"\b{re.escape(word)}\b", flags)


def _compile_phrase_pattern(phrase: str, flags: int) -> re.Pattern[str]:
    r"""Compile a contiguous-phrase matcher (escaped tokens joined with ``\s+``)."""
    tokens = phrase.split()
    if not tokens:
        return re.compile(re.escape(phrase), flags)
    body = r"\s+".join(re.escape(token) for token in tokens)
    return re.compile(rf"\b{body}\b", flags)


# ---------------------------------------------------------------------------
# WordBlocklistConfig
# ---------------------------------------------------------------------------


@dataclass
class WordBlocklistConfig:
    """Resolved word/phrase blocklist config.

    Attributes:
        words: Plain single-token denylist (whole-word match). Default empty list.
        phrases: Plain multi-word denylist (contiguous phrase match). Default empty list.
        case_insensitive: Compile patterns with ``re.IGNORECASE``. Default ``True``.
        placeholder: Replacement text used on ``MODIFY``. Default ``[BLOCKED]``.
    """

    words: list[str] = field(default_factory=list)
    phrases: list[str] = field(default_factory=list)
    case_insensitive: bool = True
    placeholder: str = _DEFAULT_PLACEHOLDER

    @classmethod
    def from_dict(cls, config: dict[str, Any]) -> WordBlocklistConfig:
        """Build from config dict (words / phrases / case_insensitive / placeholder)."""
        return cls(
            words=[str(w) for w in config.get("words", []) if str(w).strip()],
            phrases=[str(p) for p in config.get("phrases", []) if str(p).strip()],
            case_insensitive=bool(config.get("case_insensitive", True)),
            placeholder=str(config.get("placeholder", _DEFAULT_PLACEHOLDER)),
        )


# ---------------------------------------------------------------------------
# WordBlocklistDetector (compile + scan)
# ---------------------------------------------------------------------------


class WordBlocklistDetector:
    """Compiles word + phrase patterns and finds / redacts matches."""

    def __init__(self, config: WordBlocklistConfig) -> None:
        self._config = config
        flags = re.UNICODE | (re.IGNORECASE if config.case_insensitive else 0)
        self._compiled: list[re.Pattern[str]] = [
            _compile_word_pattern(word, flags) for word in config.words
        ]
        self._compiled.extend(_compile_phrase_pattern(phrase, flags) for phrase in config.phrases)

    @property
    def pattern_count(self) -> int:
        """Number of compiled word + phrase patterns."""
        return len(self._compiled)

    def find_all(self, text: str) -> list[tuple[int, int]]:
        """Return de-overlapped match spans across all word + phrase patterns."""
        spans: list[tuple[int, int]] = []
        for compiled in self._compiled:
            for m in compiled.finditer(text):
                if m.start() != m.end():
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
# WordBlocklistGuard (dual-phase guardrail)
# ---------------------------------------------------------------------------


@GuardrailRegistry.register_input("word_blocklist")
@GuardrailRegistry.register_output("word_blocklist")
class WordBlocklistGuard(InputGuardrail, OutputGuardrail):
    r"""Blocks / redacts operator-defined words and phrases on input or output.

    Honours ``action_on_trigger`` (merged into config by the registry):
    ``block`` (default) rejects, ``warn`` logs, ``modify`` redacts matches with
    ``placeholder``. With no words and no phrases configured, always returns ``ALLOW``.

    Args:
        config: Optional config dict. Recognised keys: ``words`` (list[str],
            default ``[]``), ``phrases`` (list[str], default ``[]``),
            ``case_insensitive`` (bool, default ``True``), ``placeholder`` (str,
            default ``[BLOCKED]``), plus ``action_on_trigger`` / ``message``
            (merged by the registry).
    """

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        cfg = config or {}
        self._config = WordBlocklistConfig.from_dict(cfg)
        self._detector = WordBlocklistDetector(self._config)
        self._trigger_action: GuardrailAction = resolve_action(
            cfg.get("action_on_trigger"),
            default=GuardrailAction.BLOCK,
            allowed=_WORD_BLOCKLIST_ALLOWED_ACTIONS,
        )
        self._custom_message: str | None = cfg.get("message")

    @property
    def name(self) -> str:
        """Return the guardrail registry name."""
        return "word_blocklist"

    async def check(self, ctx: GuardrailContext) -> GuardrailResult:
        """Scan content against the word + phrase blocklist and act on matches."""
        if self._detector.pattern_count == 0:
            return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

        spans = self._detector.find_all(ctx.content)
        if not spans:
            return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

        total = len(spans)
        logger.info(
            "Blocklisted term detected",
            match_count=total,
            word_count=len(self._config.words),
            phrase_count=len(self._config.phrases),
            action=self._trigger_action.value,
            guardrail_type=ctx.guardrail_type,
            agent_id=ctx.agent_id,
            correlation_id=ctx.correlation_id,
        )
        details = {
            "match_count": total,
            "word_count": len(self._config.words),
            "phrase_count": len(self._config.phrases),
        }

        if self._trigger_action == GuardrailAction.WARN:
            return GuardrailResult(
                action=GuardrailAction.WARN,
                guardrail_name=self.name,
                message=self._custom_message
                or f"Detected {total} blocklisted term(s) (allowed with warning).",
                details=details,
            )

        if self._trigger_action == GuardrailAction.MODIFY:
            return GuardrailResult(
                action=GuardrailAction.MODIFY,
                guardrail_name=self.name,
                message=self._custom_message or f"Redacted {total} blocklisted term(s).",
                modified_content=self._detector.redact(ctx.content, spans),
                details=details,
            )

        return GuardrailResult(
            action=GuardrailAction.BLOCK,
            guardrail_name=self.name,
            message=self._custom_message
            or f"Blocked content containing {total} blocklisted term(s).",
            details=details,
        )
