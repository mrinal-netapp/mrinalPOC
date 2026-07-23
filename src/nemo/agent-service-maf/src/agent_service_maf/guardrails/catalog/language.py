"""Language allowlist guardrail (Task 003 #4).

Input-phase guardrail that detects the language of the user prompt with
``py3langid`` (a bundled Naive Bayes byte-n-gram classifier — no model download,
no torch) and blocks/warns when the detected language is not in the configured
``allowed_languages``.

The identifier is built with ``norm_probs=True`` so ``classify()`` returns a
**normalized 0–1 confidence**. Two false-positive suppressors run first:
``min_length`` (skip very short inputs) and ``confidence_threshold`` (skip
low-confidence detections) — important because the action defaults to ``block``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import structlog

from agent_service_maf.core.exceptions import ConfigurationError
from agent_service_maf.guardrails.base import (
    GuardrailAction,
    GuardrailContext,
    GuardrailResult,
    InputGuardrail,
    resolve_action,
)
from agent_service_maf.guardrails.registry import GuardrailRegistry

logger = structlog.get_logger(__name__)

_LANGUAGE_ALLOWED_ACTIONS = frozenset({GuardrailAction.BLOCK, GuardrailAction.WARN})

_DEFAULT_CONFIDENCE = 0.9
_DEFAULT_MIN_LENGTH = 20


def _build_identifier() -> Any:  # noqa: ANN401
    """Build a ``py3langid`` identifier with normalized (0–1) probabilities.

    Raises:
        ConfigurationError: If ``py3langid`` is not installed.
    """
    try:
        from py3langid.langid import MODEL_FILE, LanguageIdentifier
    except ImportError as exc:
        raise ConfigurationError(
            "The 'language' guardrail requires the 'py3langid' dependency. "
            "Install it with: pip install py3langid. "
            "Disable the 'language' guardrail in team config if you do not need it.",
            details={"missing_package": "py3langid"},
        ) from exc
    return LanguageIdentifier.from_pickled_model(MODEL_FILE, norm_probs=True)


@dataclass
class LanguageConfig:
    """Resolved language-allowlist configuration."""

    allowed_languages: set[str] = field(default_factory=lambda: {"en"})
    confidence_threshold: float = _DEFAULT_CONFIDENCE
    min_length: int = _DEFAULT_MIN_LENGTH

    @classmethod
    def from_dict(cls, config: dict[str, Any]) -> LanguageConfig:
        """Build from a config dict."""
        allowed = config.get("allowed_languages", ["en"])
        return cls(
            allowed_languages={str(c).lower() for c in allowed},
            confidence_threshold=float(config.get("confidence_threshold", _DEFAULT_CONFIDENCE)),
            min_length=int(config.get("min_length", _DEFAULT_MIN_LENGTH)),
        )


@GuardrailRegistry.register_input("language")
class LanguageGuard(InputGuardrail):
    r"""Blocks/warns when the input language is not in the allowlist.

    Args:
        config: Optional config dict. Recognised keys: ``allowed_languages``
            (list of ISO 639-1 codes, default ``["en"]``), ``confidence_threshold``
            (float 0–1, default ``0.9``), ``min_length`` (int, default ``20``);
            plus ``action_on_trigger`` / ``message`` (merged by registry).

    Raises:
        ConfigurationError: If ``py3langid`` is not installed.
    """

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        cfg = config or {}
        self._config = LanguageConfig.from_dict(cfg)
        self._identifier = _build_identifier()
        self._trigger_action: GuardrailAction = resolve_action(
            cfg.get("action_on_trigger"),
            default=GuardrailAction.BLOCK,
            allowed=_LANGUAGE_ALLOWED_ACTIONS,
        )
        self._custom_message: str | None = cfg.get("message")

    @property
    def name(self) -> str:
        """Return the guardrail registry name."""
        return "language"

    async def check(self, ctx: GuardrailContext) -> GuardrailResult:
        """Detect language; block/warn if not allowed (with FP suppression)."""
        text = ctx.content.strip()

        # False-positive suppressors first.
        if len(text) < self._config.min_length:
            return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

        lang, confidence = self._identifier.classify(text)
        confidence = float(confidence)

        if confidence < self._config.confidence_threshold:
            return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

        if lang in self._config.allowed_languages:
            return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

        logger.info(
            "Disallowed language detected",
            detected_language=lang,
            confidence=round(confidence, 4),
            allowed_languages=sorted(self._config.allowed_languages),
            action=self._trigger_action.value,
            agent_id=ctx.agent_id,
            correlation_id=ctx.correlation_id,
        )
        details = {
            "detected_language": lang,
            "allowed_languages": sorted(self._config.allowed_languages),
        }

        if self._trigger_action == GuardrailAction.WARN:
            return GuardrailResult(
                action=GuardrailAction.WARN,
                guardrail_name=self.name,
                message=self._custom_message
                or f"Detected language '{lang}' not in allowlist (allowed with warning).",
                details=details,
            )

        return GuardrailResult(
            action=GuardrailAction.BLOCK,
            guardrail_name=self.name,
            message=self._custom_message or f"Input language '{lang}' is not permitted.",
            details=details,
        )
