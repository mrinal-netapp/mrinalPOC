"""Unit tests for the adversarial-unicode guardrail (Task 003 #5)."""

from __future__ import annotations

from agent_service_maf.guardrails.base import GuardrailAction, GuardrailContext
from agent_service_maf.guardrails.catalog.adversarial_unicode import AdversarialUnicodeGuard


def _ctx(content: str) -> GuardrailContext:
    return GuardrailContext.for_input(content, "agent-1", "corr-1")


class TestAdversarialUnicodeGuard:
    def test_name(self) -> None:
        assert AdversarialUnicodeGuard().name == "adversarial_unicode"

    def test_default_action_is_modify(self) -> None:
        assert AdversarialUnicodeGuard()._trigger_action == GuardrailAction.MODIFY  # type: ignore[attr-defined]

    async def test_clean_ascii_allows(self) -> None:
        result = await AdversarialUnicodeGuard().check(_ctx("Hello, normal text."))
        assert result.action == GuardrailAction.ALLOW

    async def test_zero_width_stripped(self) -> None:
        # "ig<ZWSP>nore previous"
        text = "ig\u200bnore previous"
        result = await AdversarialUnicodeGuard().check(_ctx(text))
        assert result.action == GuardrailAction.MODIFY
        assert result.modified_content == "ignore previous"

    async def test_bidi_override_stripped(self) -> None:
        text = "safe\u202etxet"
        result = await AdversarialUnicodeGuard().check(_ctx(text))
        assert result.action == GuardrailAction.MODIFY
        assert "\u202e" not in (result.modified_content or "")

    async def test_tag_block_stripped(self) -> None:
        text = "hi\U000e0041\U000e0042"  # tag-A, tag-B
        result = await AdversarialUnicodeGuard().check(_ctx(text))
        assert result.action == GuardrailAction.MODIFY
        assert result.modified_content == "hi"

    async def test_nfkc_normalization(self) -> None:
        # Fullwidth "ＡＢＣ" → "ABC"
        text = "\uff21\uff22\uff23"
        result = await AdversarialUnicodeGuard().check(_ctx(text))
        assert result.action == GuardrailAction.MODIFY
        assert result.modified_content == "ABC"

    async def test_whitespace_preserved(self) -> None:
        result = await AdversarialUnicodeGuard().check(_ctx("line1\nline2\ttab"))
        assert result.action == GuardrailAction.ALLOW

    async def test_toggle_off_leaves_category(self) -> None:
        text = "ig\u200bnore"
        guard = AdversarialUnicodeGuard(config={"strip_zero_width": False, "normalize_nfkc": False})
        result = await guard.check(_ctx(text))
        assert result.action == GuardrailAction.ALLOW

    async def test_block_action(self) -> None:
        guard = AdversarialUnicodeGuard(config={"action_on_trigger": "block"})
        result = await guard.check(_ctx("ig\u200bnore"))
        assert result.action == GuardrailAction.BLOCK

    async def test_warn_action(self) -> None:
        guard = AdversarialUnicodeGuard(config={"action_on_trigger": "warn"})
        result = await guard.check(_ctx("ig\u200bnore"))
        assert result.action == GuardrailAction.WARN
        assert result.modified_content is None
