"""PHI (Protected Health Information) detection and masking guardrail.

Output-phase guardrail that catches **structured health identifiers** the
generic ``pii_masker`` (email / phone / SSN / credit card) does not cover:

- Medical Record Number (MRN)            → ``[MRN_REDACTED]``
- National Provider Identifier (NPI)     → ``[NPI_REDACTED]`` (10-digit, Luhn-checked)
- ICD-10 / CPT diagnosis & procedure codes → ``[ICD_REDACTED]``
- Health-plan / insurance member & policy IDs → ``[INSURANCE_REDACTED]``

Pure standard-library regex (no external dependency, no ML). Mirrors the
``pii_masker`` structure: a :class:`PHIMaskingConfig` (per-type toggles), a
:class:`PHIDetector` (finds spans), and :class:`PHIMasker` (the output guardrail
that replaces matches and honours ``action_on_trigger``).

Out of scope: contextual / free-text PHI (diagnoses described in prose), which
needs NER/ML — deferred to a future task.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
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

#: Actions ``phi_masker`` can produce on a hit. ``MODIFY`` redacts in place,
#: ``BLOCK`` rejects the response, ``WARN`` allows but logs.
_PHI_ALLOWED_ACTIONS = frozenset(
    {GuardrailAction.MODIFY, GuardrailAction.BLOCK, GuardrailAction.WARN}
)

# ---------------------------------------------------------------------------
# Compiled PHI patterns
# ---------------------------------------------------------------------------

# MRN: keyword-anchored ("MRN: 1234567", "medical record number 123456").
_MRN_RE = re.compile(
    r"\b(?:MRN|medical\s+record\s+(?:no\.?|number|#))[:#\s]*([A-Za-z0-9-]{4,})\b",
    re.IGNORECASE,
)

# NPI: any 10-digit run; validated with the NPI Luhn checksum to suppress
# false positives (see :func:`_npi_luhn_valid`).
_NPI_RE = re.compile(r"\b\d{10}\b")

# ICD-10: a letter (excluding U) + two digits, optional ``.`` sub-classification.
# Case-sensitive leading letter so ordinary lowercase words do not match.
_ICD_RE = re.compile(r"\b[A-TV-Z]\d{2}(?:\.\d{1,4})?\b")

# CPT: keyword-anchored 5-digit procedure code (bare 5-digit numbers are too
# false-positive-prone to match unanchored).
_CPT_RE = re.compile(r"\bCPT[:#\s]*(\d{5})\b", re.IGNORECASE)

# Insurance: keyword-anchored member / policy / subscriber identifiers.
_INSURANCE_RE = re.compile(
    r"\b(?:member\s*id|policy\s*(?:no\.?|number|#)|insurance\s*id|subscriber\s*id)"
    r"[:#\s]*([A-Za-z0-9-]{4,})\b",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# NPI Luhn checksum helper
# ---------------------------------------------------------------------------


def _npi_luhn_valid(npi: str) -> bool:
    """Validate a 10-digit NPI using the ISO 7812 (Luhn) check with the ``80840`` prefix.

    The NPI check digit is computed by prefixing ``80840`` to the first nine
    digits and applying the Luhn algorithm; the result must equal the tenth
    digit. This rejects arbitrary 10-digit numbers.

    Args:
        npi: Candidate NPI string (may contain separators).

    Returns:
        ``True`` if the number is a Luhn-valid NPI, ``False`` otherwise.

    Example:
        >>> _npi_luhn_valid("1234567893")
        True
        >>> _npi_luhn_valid("1234567890")
        False
    """
    digits = re.sub(r"\D", "", npi)
    if len(digits) != 10:
        return False
    base = "80840" + digits[:9]
    total = 0
    for i, ch in enumerate(reversed(base)):
        n = int(ch)
        if i % 2 == 0:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    check = (10 - (total % 10)) % 10
    return check == int(digits[9])


# ---------------------------------------------------------------------------
# PHIMaskingConfig (per-type toggles)
# ---------------------------------------------------------------------------


@dataclass
class PHIMaskingConfig:
    """Per-type toggles controlling which PHI identifiers are masked.

    Attributes:
        mrn: Mask Medical Record Numbers. Default ``True``.
        npi: Mask National Provider Identifiers. Default ``True``.
        icd: Mask ICD-10 / CPT codes. Default ``True``.
        insurance: Mask health-plan / insurance identifiers. Default ``True``.
    """

    mrn: bool = True
    npi: bool = True
    icd: bool = True
    insurance: bool = True

    @classmethod
    def from_dict(cls, config: dict[str, Any]) -> PHIMaskingConfig:
        """Construct from a config dict (keys ``mrn`` / ``npi`` / ``icd`` / ``insurance``)."""
        return cls(
            mrn=bool(config.get("mrn", True)),
            npi=bool(config.get("npi", True)),
            icd=bool(config.get("icd", True)),
            insurance=bool(config.get("insurance", True)),
        )


# ---------------------------------------------------------------------------
# PHIDetector (detection + masking helpers)
# ---------------------------------------------------------------------------


class PHIDetector:
    """Finds and masks structured PHI spans according to a :class:`PHIMaskingConfig`."""

    def __init__(self, config: PHIMaskingConfig) -> None:
        self._config = config

    def mask(self, text: str) -> tuple[str, int]:
        """Mask all enabled PHI identifiers in ``text``.

        Args:
            text: The text to scan and redact.

        Returns:
            Tuple of (masked text, number of redactions made).
        """
        masked = text
        count = 0

        if self._config.mrn:
            masked, n = self._mask_keyword(masked, _MRN_RE, "[MRN_REDACTED]")
            count += n

        if self._config.npi:
            masked, n = self._mask_npi(masked)
            count += n

        if self._config.icd:
            masked, n = _ICD_RE.subn("[ICD_REDACTED]", masked)
            count += n
            masked, n = self._mask_keyword(masked, _CPT_RE, "[ICD_REDACTED]")
            count += n

        if self._config.insurance:
            masked, n = self._mask_keyword(masked, _INSURANCE_RE, "[INSURANCE_REDACTED]")
            count += n

        return masked, count

    @staticmethod
    def _mask_keyword(text: str, pattern: re.Pattern[str], placeholder: str) -> tuple[str, int]:
        """Replace whole keyword-anchored matches with ``placeholder``."""
        return pattern.subn(placeholder, text)

    @staticmethod
    def _mask_npi(text: str) -> tuple[str, int]:
        """Mask only Luhn-valid 10-digit NPI numbers."""
        count = [0]

        def _replace(match: re.Match[str]) -> str:
            candidate = match.group(0)
            if _npi_luhn_valid(candidate):
                count[0] += 1
                return "[NPI_REDACTED]"
            return candidate

        result = _NPI_RE.sub(_replace, text)
        return result, count[0]


# ---------------------------------------------------------------------------
# PHIMasker (output guardrail)
# ---------------------------------------------------------------------------


@GuardrailRegistry.register_output("phi_masker")
class PHIMasker(OutputGuardrail):
    r"""Detects and masks structured PHI in agent output.

    Honours ``action_on_trigger`` (merged into config by the registry):
    ``modify`` (default) redacts in place, ``block`` rejects the response,
    ``warn`` allows but logs.

    Args:
        config: Optional config dict. Recognised keys: ``mrn``, ``npi``, ``icd``,
            ``insurance`` (bool, default ``True``), plus ``action_on_trigger`` and
            ``message`` (merged in by the registry).

    Example:
        >>> masker = PHIMasker(config={"npi": True})
        >>> ctx = GuardrailContext.for_output("Provider NPI 1234567893.", "a", "c")
        >>> result = await masker.check(ctx)
        >>> result.action
        <GuardrailAction.MODIFY: 'modify'>
    """

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        cfg = config or {}
        self._masking_config = PHIMaskingConfig.from_dict(cfg)
        self._detector = PHIDetector(self._masking_config)
        self._trigger_action: GuardrailAction = resolve_action(
            cfg.get("action_on_trigger"),
            default=GuardrailAction.MODIFY,
            allowed=_PHI_ALLOWED_ACTIONS,
        )
        self._custom_message: str | None = cfg.get("message")

    @property
    def name(self) -> str:
        """Return the guardrail registry name."""
        return "phi_masker"

    async def check(self, ctx: GuardrailContext) -> GuardrailResult:
        """Detect and act on structured PHI in the output content."""
        masked_text, total = self._detector.mask(ctx.content)

        if total == 0:
            return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

        logger.info(
            "PHI detected",
            phi_count=total,
            action=self._trigger_action.value,
            guardrail_type=ctx.guardrail_type,
            agent_id=ctx.agent_id,
            correlation_id=ctx.correlation_id,
        )
        details = {"phi_count": total}

        if self._trigger_action == GuardrailAction.BLOCK:
            return GuardrailResult(
                action=GuardrailAction.BLOCK,
                guardrail_name=self.name,
                message=self._custom_message
                or f"Blocked response containing {total} PHI identifier(s).",
                details=details,
            )

        if self._trigger_action == GuardrailAction.WARN:
            return GuardrailResult(
                action=GuardrailAction.WARN,
                guardrail_name=self.name,
                message=self._custom_message
                or f"Detected {total} PHI identifier(s) (allowed with warning).",
                details=details,
            )

        return GuardrailResult(
            action=GuardrailAction.MODIFY,
            guardrail_name=self.name,
            message=self._custom_message or f"Masked {total} PHI identifier(s).",
            modified_content=masked_text,
            details=details,
        )
