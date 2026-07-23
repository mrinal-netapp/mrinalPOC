"""Unit tests for the language allowlist guardrail (Task 003 #4).

``py3langid`` is a light bundled dependency (no download), so these use the real
classifier with deterministic long-text samples.
"""

from __future__ import annotations

from agent_service_maf.guardrails.base import GuardrailAction, GuardrailContext
from agent_service_maf.guardrails.catalog.language import LanguageGuard

_EN = "Hello, how are you doing today? I would really like some help with my homework please."
_FR = "Bonjour, comment allez-vous aujourd'hui? J'aimerais vraiment de l'aide avec mes devoirs."


def _ctx(content: str) -> GuardrailContext:
    return GuardrailContext.for_input(content, "agent-1", "corr-1")


class TestLanguageGuard:
    def test_name(self) -> None:
        assert LanguageGuard().name == "language"

    def test_default_action_is_block(self) -> None:
        assert LanguageGuard()._trigger_action == GuardrailAction.BLOCK  # type: ignore[attr-defined]

    async def test_english_allowed(self) -> None:
        guard = LanguageGuard(config={"allowed_languages": ["en"]})
        result = await guard.check(_ctx(_EN))
        assert result.action == GuardrailAction.ALLOW

    async def test_french_blocked_when_only_en_allowed(self) -> None:
        guard = LanguageGuard(config={"allowed_languages": ["en"]})
        result = await guard.check(_ctx(_FR))
        assert result.action == GuardrailAction.BLOCK
        assert (result.details or {}).get("detected_language") == "fr"

    async def test_french_allowed_when_in_allowlist(self) -> None:
        guard = LanguageGuard(config={"allowed_languages": ["en", "fr"]})
        result = await guard.check(_ctx(_FR))
        assert result.action == GuardrailAction.ALLOW

    async def test_warn_action(self) -> None:
        guard = LanguageGuard(config={"allowed_languages": ["en"], "action_on_trigger": "warn"})
        result = await guard.check(_ctx(_FR))
        assert result.action == GuardrailAction.WARN

    async def test_short_input_allowed(self) -> None:
        guard = LanguageGuard(config={"allowed_languages": ["en"], "min_length": 20})
        result = await guard.check(_ctx("bonjour"))  # below min_length
        assert result.action == GuardrailAction.ALLOW

    async def test_low_confidence_allowed(self) -> None:
        # Impossible threshold → every detection is "below" → never blocks.
        guard = LanguageGuard(
            config={"allowed_languages": ["en"], "confidence_threshold": 1.1, "min_length": 1}
        )
        result = await guard.check(_ctx(_FR))
        assert result.action == GuardrailAction.ALLOW
