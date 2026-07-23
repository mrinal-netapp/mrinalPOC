"""Unit tests for the PCI masker guardrail (Task 004 #2).

Covers Luhn-validated PAN detection, keyword-anchored card details (CVV /
expiry), magstripe track data, per-category toggles, mandatory Luhn filtering,
and ``action_on_trigger`` handling.
"""

from __future__ import annotations

from agent_service_maf.guardrails.base import GuardrailAction, GuardrailContext
from agent_service_maf.guardrails.catalog.pci_masker import (
    PCIMasker,
    _luhn_valid,
)

# Known Luhn-valid test PANs.
_VISA_16 = "4532015112830366"
_AMEX_15 = "378282246310005"
_MC_16 = "5425233430109903"
# 16 digits that fail the Luhn checksum.
_BAD_PAN = "1234567812345678"


def _ctx(content: str) -> GuardrailContext:
    return GuardrailContext.for_output(content, "agent-1", "corr-1")


class TestLuhnValid:
    def test_valid_visa(self) -> None:
        assert _luhn_valid(_VISA_16) is True

    def test_valid_amex(self) -> None:
        assert _luhn_valid(_AMEX_15) is True

    def test_invalid_number(self) -> None:
        assert _luhn_valid(_BAD_PAN) is False

    def test_strips_separators(self) -> None:
        assert _luhn_valid("4532 0151 1283 0366") is True
        assert _luhn_valid("4532-0151-1283-0366") is True

    def test_too_short(self) -> None:
        assert _luhn_valid("123456789012") is False


class TestPCIMasker:
    def test_name(self) -> None:
        assert PCIMasker().name == "pci_masker"

    def test_default_action_is_modify(self) -> None:
        m = PCIMasker()
        assert m._trigger_action == GuardrailAction.MODIFY  # type: ignore[attr-defined]

    async def test_visa_pan_masked(self) -> None:
        m = PCIMasker()
        result = await m.check(_ctx(f"Charge card {_VISA_16} today."))
        assert result.action == GuardrailAction.MODIFY
        assert _VISA_16 not in (result.modified_content or "")
        assert "[PAN_REDACTED]" in (result.modified_content or "")

    async def test_amex_pan_masked(self) -> None:
        m = PCIMasker()
        result = await m.check(_ctx(f"Amex {_AMEX_15} on file."))
        assert result.action == GuardrailAction.MODIFY
        assert _AMEX_15 not in (result.modified_content or "")
        assert "[PAN_REDACTED]" in (result.modified_content or "")

    async def test_spaced_pan_masked(self) -> None:
        m = PCIMasker()
        result = await m.check(_ctx("Card 4532 0151 1283 0366 charged."))
        assert result.action == GuardrailAction.MODIFY
        assert "[PAN_REDACTED]" in (result.modified_content or "")

    async def test_non_luhn_number_not_masked(self) -> None:
        m = PCIMasker()
        result = await m.check(_ctx(f"Order reference {_BAD_PAN} only."))
        assert result.action == GuardrailAction.ALLOW

    async def test_cvv_masked(self) -> None:
        m = PCIMasker()
        result = await m.check(_ctx("The CVV: 123 is on the back."))
        assert result.action == GuardrailAction.MODIFY
        assert "[CVV_REDACTED]" in (result.modified_content or "")

    async def test_expiry_masked(self) -> None:
        m = PCIMasker()
        result = await m.check(_ctx("Exp 12/28 printed on card."))
        assert result.action == GuardrailAction.MODIFY
        assert "[EXPIRY_REDACTED]" in (result.modified_content or "")

    async def test_magstripe_track2_masked(self) -> None:
        m = PCIMasker()
        track2 = f";{_VISA_16}=2812101000000000000?"
        result = await m.check(_ctx(f"Swipe data {track2} captured."))
        assert result.action == GuardrailAction.MODIFY
        assert "[MAGSTRIPE_REDACTED]" in (result.modified_content or "")
        assert _VISA_16 not in (result.modified_content or "")

    async def test_magstripe_track1_masked(self) -> None:
        m = PCIMasker()
        track1 = f"%B{_VISA_16}^DOE/JOHN^28121010000000000000000?"
        result = await m.check(_ctx(f"Raw {track1} read."))
        assert result.action == GuardrailAction.MODIFY
        assert "[MAGSTRIPE_REDACTED]" in (result.modified_content or "")

    async def test_clean_text_allows(self) -> None:
        m = PCIMasker()
        result = await m.check(_ctx("The weather is sunny today."))
        assert result.action == GuardrailAction.ALLOW

    async def test_phone_number_not_flagged_as_cvv(self) -> None:
        m = PCIMasker()
        result = await m.check(_ctx("Call me at 555 123 4567 tomorrow."))
        assert result.action == GuardrailAction.ALLOW

    async def test_bare_three_digit_number_not_cvv(self) -> None:
        m = PCIMasker()
        result = await m.check(_ctx("There are 123 apples in the basket."))
        assert result.action == GuardrailAction.ALLOW

    async def test_pan_toggle_off(self) -> None:
        m = PCIMasker(config={"pan": False})
        result = await m.check(_ctx(f"Card {_VISA_16} charged."))
        assert result.action == GuardrailAction.ALLOW

    async def test_card_details_toggle_off(self) -> None:
        m = PCIMasker(config={"card_details": False})
        result = await m.check(_ctx("CVV: 123 and exp 12/28."))
        assert result.action == GuardrailAction.ALLOW

    async def test_magstripe_toggle_off(self) -> None:
        m = PCIMasker(config={"magstripe_data": False, "pan": False})
        track2 = f";{_VISA_16}=2812101000000000000?"
        result = await m.check(_ctx(f"Data {track2} read."))
        assert result.action == GuardrailAction.ALLOW

    async def test_block_action(self) -> None:
        m = PCIMasker(config={"action_on_trigger": "block"})
        result = await m.check(_ctx(f"Card {_VISA_16}."))
        assert result.action == GuardrailAction.BLOCK
        assert result.modified_content is None

    async def test_warn_action(self) -> None:
        m = PCIMasker(config={"action_on_trigger": "warn"})
        result = await m.check(_ctx(f"Card {_VISA_16}."))
        assert result.action == GuardrailAction.WARN
        assert result.modified_content is None

    async def test_custom_message(self) -> None:
        m = PCIMasker(config={"action_on_trigger": "block", "message": "no cards"})
        result = await m.check(_ctx(f"Card {_VISA_16}."))
        assert result.message == "no cards"

    async def test_details_never_contain_raw_pan(self) -> None:
        m = PCIMasker()
        result = await m.check(_ctx(f"Card {_VISA_16} and CVV: 123."))
        assert result.details is not None
        assert _VISA_16 not in str(result.details)
        assert result.details["match_count"] >= 2
        assert "pan" in result.details["match_types"]

    async def test_multiple_categories_masked(self) -> None:
        m = PCIMasker()
        result = await m.check(_ctx(f"PAN {_MC_16}, CVV: 4567, exp 01/27."))
        assert result.action == GuardrailAction.MODIFY
        content = result.modified_content or ""
        assert "[PAN_REDACTED]" in content
        assert "[CVV_REDACTED]" in content
        assert "[EXPIRY_REDACTED]" in content
