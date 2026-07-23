"""Unit tests for the PHI masker guardrail (Task 003 #1).

Covers detection of structured health identifiers (MRN, NPI w/ Luhn, ICD/CPT,
insurance), per-type toggles, and ``action_on_trigger`` handling.
"""

from __future__ import annotations

from agent_service_maf.guardrails.base import GuardrailAction, GuardrailContext
from agent_service_maf.guardrails.catalog.phi_masker import (
    PHIMasker,
    _npi_luhn_valid,
)


def _ctx(content: str) -> GuardrailContext:
    return GuardrailContext.for_output(content, "agent-1", "corr-1")


class TestNPILuhn:
    def test_valid_npi(self) -> None:
        assert _npi_luhn_valid("1234567893") is True

    def test_invalid_npi(self) -> None:
        assert _npi_luhn_valid("1234567890") is False

    def test_wrong_length(self) -> None:
        assert _npi_luhn_valid("12345") is False


class TestPHIMasker:
    def test_name(self) -> None:
        assert PHIMasker().name == "phi_masker"

    def test_default_action_is_modify(self) -> None:
        m = PHIMasker()
        assert m._trigger_action == GuardrailAction.MODIFY  # type: ignore[attr-defined]

    async def test_mrn_masked(self) -> None:
        m = PHIMasker()
        result = await m.check(_ctx("Patient MRN: 5567231 admitted today."))
        assert result.action == GuardrailAction.MODIFY
        assert "5567231" not in (result.modified_content or "")
        assert "[MRN_REDACTED]" in (result.modified_content or "")

    async def test_npi_masked_when_luhn_valid(self) -> None:
        m = PHIMasker()
        result = await m.check(_ctx("Provider NPI 1234567893 signed off."))
        assert result.action == GuardrailAction.MODIFY
        assert "1234567893" not in (result.modified_content or "")
        assert "[NPI_REDACTED]" in (result.modified_content or "")

    async def test_invalid_npi_not_masked(self) -> None:
        m = PHIMasker()
        # 10-digit but not a valid NPI checksum → left alone
        result = await m.check(_ctx("Reference number 1234567890 only."))
        assert result.action == GuardrailAction.ALLOW

    async def test_icd_code_masked(self) -> None:
        m = PHIMasker()
        result = await m.check(_ctx("Diagnosis E11.9 recorded."))
        assert result.action == GuardrailAction.MODIFY
        assert "E11.9" not in (result.modified_content or "")
        assert "[ICD_REDACTED]" in (result.modified_content or "")

    async def test_cpt_code_masked(self) -> None:
        m = PHIMasker()
        result = await m.check(_ctx("Procedure CPT 99213 billed."))
        assert result.action == GuardrailAction.MODIFY
        assert "99213" not in (result.modified_content or "")

    async def test_insurance_id_masked(self) -> None:
        m = PHIMasker()
        result = await m.check(_ctx("Member ID: ABC123456 on file."))
        assert result.action == GuardrailAction.MODIFY
        assert "ABC123456" not in (result.modified_content or "")
        assert "[INSURANCE_REDACTED]" in (result.modified_content or "")

    async def test_clean_text_allows(self) -> None:
        m = PHIMasker()
        result = await m.check(_ctx("The weather is sunny today."))
        assert result.action == GuardrailAction.ALLOW

    async def test_toggle_off_disables_detection(self) -> None:
        m = PHIMasker(config={"mrn": False, "npi": False, "icd": False, "insurance": False})
        result = await m.check(_ctx("MRN: 5567231 and NPI 1234567893."))
        assert result.action == GuardrailAction.ALLOW

    async def test_block_action(self) -> None:
        m = PHIMasker(config={"action_on_trigger": "block"})
        result = await m.check(_ctx("Patient MRN: 5567231."))
        assert result.action == GuardrailAction.BLOCK
        assert result.modified_content is None

    async def test_warn_action(self) -> None:
        m = PHIMasker(config={"action_on_trigger": "warn"})
        result = await m.check(_ctx("Patient MRN: 5567231."))
        assert result.action == GuardrailAction.WARN

    async def test_custom_message(self) -> None:
        m = PHIMasker(config={"action_on_trigger": "block", "message": "no PHI"})
        result = await m.check(_ctx("Patient MRN: 5567231."))
        assert result.message == "no PHI"
