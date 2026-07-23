"""Adversarial Unicode / invisible-text guardrail (Task 003 #5).

Input-phase **normalizer / evasion-breaker** using only the standard library
(``unicodedata``). It strips or normalizes Unicode tricks attackers use to hide
or disguise text so it bypasses regex filters (``prompt_injection`` /
``content_filter``) while the LLM still reads it:

- zero-width / format chars (category ``Cf``: ``U+200B``, ``U+FEFF``, ``U+2060`` …)
- control chars (category ``Cc``, excluding common whitespace)
- bidirectional overrides / isolates (``U+202A–202E``, ``U+2066–2069``)
- Unicode tag block (``U+E0000–U+E007F`` — hidden-instruction smuggling)
- NFKC normalization (collapse compatibility / fullwidth forms)

Each category is independently toggleable. Default action ``modify`` returns the
cleaned text. **Must run before** ``prompt_injection`` / ``content_filter`` in
the input list so those regex checks scan the cleaned text.
"""

from __future__ import annotations

import unicodedata
from dataclasses import dataclass
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

_UNICODE_ALLOWED_ACTIONS = frozenset(
    {GuardrailAction.MODIFY, GuardrailAction.BLOCK, GuardrailAction.WARN}
)

#: Bidirectional control characters (overrides + isolates) — Trojan Source.
_BIDI_CHARS = frozenset("\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069")

#: Whitespace control chars that are legitimate and must NOT be stripped.
_ALLOWED_CONTROL = frozenset("\t\n\r")


def _in_tag_block(ch: str) -> bool:
    """Return ``True`` if ``ch`` is in the Unicode tag block (U+E0000–U+E007F)."""
    return 0xE0000 <= ord(ch) <= 0xE007F


@dataclass
class UnicodeConfig:
    """Per-category toggles for the adversarial-unicode guardrail."""

    strip_zero_width: bool = True
    strip_control: bool = True
    strip_bidi: bool = True
    strip_tag_chars: bool = True
    normalize_nfkc: bool = True

    @classmethod
    def from_dict(cls, config: dict[str, Any]) -> UnicodeConfig:
        """Build from a config dict (all toggles default ``True``)."""
        return cls(
            strip_zero_width=bool(config.get("strip_zero_width", True)),
            strip_control=bool(config.get("strip_control", True)),
            strip_bidi=bool(config.get("strip_bidi", True)),
            strip_tag_chars=bool(config.get("strip_tag_chars", True)),
            normalize_nfkc=bool(config.get("normalize_nfkc", True)),
        )


def _sanitize(text: str, cfg: UnicodeConfig) -> tuple[str, int]:
    """Strip/normalize adversarial Unicode; return (cleaned text, chars removed/changed)."""
    removed = 0
    chars: list[str] = []
    for ch in text:
        category = unicodedata.category(ch)
        if cfg.strip_bidi and ch in _BIDI_CHARS:
            removed += 1
            continue
        if cfg.strip_tag_chars and _in_tag_block(ch):
            removed += 1
            continue
        if cfg.strip_zero_width and category == "Cf":
            removed += 1
            continue
        if cfg.strip_control and category == "Cc" and ch not in _ALLOWED_CONTROL:
            removed += 1
            continue
        chars.append(ch)

    cleaned = "".join(chars)

    if cfg.normalize_nfkc:
        normalized = unicodedata.normalize("NFKC", cleaned)
        if normalized != cleaned:
            # Count normalization as at least one change so the action fires.
            removed += 1
            cleaned = normalized

    return cleaned, removed


@GuardrailRegistry.register_input("adversarial_unicode")
class AdversarialUnicodeGuard(InputGuardrail):
    r"""Strips/normalizes adversarial Unicode in user input.

    Args:
        config: Optional config dict. Recognised keys: ``strip_zero_width``,
            ``strip_control``, ``strip_bidi``, ``strip_tag_chars``,
            ``normalize_nfkc`` (bool, default ``True``); plus ``action_on_trigger``
            / ``message`` (merged by registry).
    """

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        cfg = config or {}
        self._config = UnicodeConfig.from_dict(cfg)
        self._trigger_action: GuardrailAction = resolve_action(
            cfg.get("action_on_trigger"),
            default=GuardrailAction.MODIFY,
            allowed=_UNICODE_ALLOWED_ACTIONS,
        )
        self._custom_message: str | None = cfg.get("message")

    @property
    def name(self) -> str:
        """Return the guardrail registry name."""
        return "adversarial_unicode"

    async def check(self, ctx: GuardrailContext) -> GuardrailResult:
        """Detect/clean adversarial Unicode and act per ``action_on_trigger``."""
        cleaned, removed = _sanitize(ctx.content, self._config)

        if removed == 0:
            return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

        logger.info(
            "Adversarial Unicode detected",
            removed_count=removed,
            action=self._trigger_action.value,
            guardrail_type=ctx.guardrail_type,
            agent_id=ctx.agent_id,
            correlation_id=ctx.correlation_id,
        )
        details = {"removed_count": removed}

        if self._trigger_action == GuardrailAction.BLOCK:
            return GuardrailResult(
                action=GuardrailAction.BLOCK,
                guardrail_name=self.name,
                message=self._custom_message
                or "Input blocked: contains obfuscated / invisible Unicode.",
                details=details,
            )

        if self._trigger_action == GuardrailAction.WARN:
            return GuardrailResult(
                action=GuardrailAction.WARN,
                guardrail_name=self.name,
                message=self._custom_message
                or "Input contains obfuscated Unicode (allowed with warning).",
                details=details,
            )

        return GuardrailResult(
            action=GuardrailAction.MODIFY,
            guardrail_name=self.name,
            message=self._custom_message
            or f"Normalized input: removed/changed {removed} adversarial character(s).",
            modified_content=cleaned,
            details=details,
        )
