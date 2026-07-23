"""PII detection and masking guardrail.

Implements the Single Responsibility Principle by splitting responsibilities:

- :class:`PIIDetector`: Finds PII spans in text using compiled regex patterns.
  Includes Luhn checksum validation for credit card numbers to reduce false
  positives.
- :class:`MaskingConfig`: Carries per-type toggle flags and the safe-domain
  allowlist.
- :class:`PIIMasker`: Input and output guardrail that uses ``PIIDetector`` +
  ``MaskingConfig`` to produce masked text.

PII types supported:
    - Email addresses → ``[EMAIL_REDACTED]``
    - US phone numbers → ``[PHONE_REDACTED]``
    - US Social Security Numbers → ``[SSN_REDACTED]``
    - Credit card numbers (Luhn-validated) → ``[CC_REDACTED]``
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

#: Actions ``pii_masker`` can produce on a PII hit. ``MODIFY`` masks in place,
#: ``BLOCK`` rejects the request/response, ``WARN`` allows but logs.
_PII_ALLOWED_ACTIONS = frozenset(
    {GuardrailAction.MODIFY, GuardrailAction.BLOCK, GuardrailAction.WARN}
)

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Compiled PII regex patterns
# ---------------------------------------------------------------------------

_EMAIL_RE = re.compile(
    r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b",
    re.IGNORECASE,
)

_PHONE_RE = re.compile(
    r"\b(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b",
)

# SSN: 3-2-4 digits, optionally hyphen-separated (NNN-NN-NNNN or NNNNNNNNN)
_SSN_RE = re.compile(
    r"\b(?!000|666|9\d{2})\d{3}[-\s]?(?!00)\d{2}[-\s]?(?!0000)\d{4}\b",
)

# Credit card: 4 groups of 4 digits, separated by spaces or hyphens (or nothing)
_CC_RE = re.compile(
    r"\b(\d{4})[\s\-]?(\d{4})[\s\-]?(\d{4})[\s\-]?(\d{4})\b",
)


# ---------------------------------------------------------------------------
# Luhn checksum helper
# ---------------------------------------------------------------------------


def _luhn_valid(number: str) -> bool:
    """Validate a credit card number string using the Luhn algorithm.

    Strips non-digit characters before checking. Returns ``False`` for strings
    that are not exactly 13–19 digits after stripping.

    Args:
        number: The candidate credit card number (may contain spaces/hyphens).

    Returns:
        ``True`` if the number passes the Luhn checksum, ``False`` otherwise.

    Example:
        >>> _luhn_valid("4532015112830366")  # Valid Visa test number
        True
        >>> _luhn_valid("1234567890123456")  # Invalid
        False
    """
    digits = re.sub(r"\D", "", number)
    if not 13 <= len(digits) <= 19:
        return False

    total = 0
    reverse = digits[::-1]
    for i, ch in enumerate(reverse):
        n = int(ch)
        if i % 2 == 1:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


# ---------------------------------------------------------------------------
# MaskingConfig dataclass (SRP: carries toggle flags and safe domains)
# ---------------------------------------------------------------------------


@dataclass
class MaskingConfig:
    """Configuration flags controlling which PII types are masked.

    Attributes:
        mask_email: Whether to mask email addresses. Default ``True``.
        mask_phone: Whether to mask phone numbers. Default ``True``.
        mask_ssn: Whether to mask Social Security Numbers. Default ``True``.
        mask_cc: Whether to mask credit card numbers. Default ``True``.
        safe_email_domains: Email addresses whose domain is in this list are
            **not** masked. Useful for internal domains (e.g., ``example.com``)
            where masking would reduce conversation quality. Comparison is
            case-insensitive. Default: empty list (mask all emails).

    Example:
        >>> cfg = MaskingConfig(mask_email=False, safe_email_domains=["example.com"])
    """

    mask_email: bool = True
    mask_phone: bool = True
    mask_ssn: bool = True
    mask_cc: bool = True
    safe_email_domains: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, config: dict[str, Any]) -> MaskingConfig:
        """Construct a :class:`MaskingConfig` from a config dict.

        Args:
            config: Dict with optional keys ``mask_email``, ``mask_phone``,
                ``mask_ssn``, ``mask_cc``, ``safe_email_domains``.

        Returns:
            A populated :class:`MaskingConfig` instance.
        """
        return cls(
            mask_email=bool(config.get("mask_email", True)),
            mask_phone=bool(config.get("mask_phone", True)),
            mask_ssn=bool(config.get("mask_ssn", True)),
            mask_cc=bool(config.get("mask_cc", True)),
            safe_email_domains=[d.lower() for d in config.get("safe_email_domains", [])],
        )


# ---------------------------------------------------------------------------
# PIIDetector (SRP: detection only, no masking)
# ---------------------------------------------------------------------------


class PIIDetector:
    """Finds PII spans in text without performing replacements.

    This class is responsible solely for detection — it does not modify the
    input string. :class:`PIIMasker` owns the replacement logic.

    Args:
        config: The :class:`MaskingConfig` controlling which PII types to detect.

    Example:
        >>> detector = PIIDetector(MaskingConfig())
        >>> found = detector.find_all("Call me at 555-123-4567 or john@example.com")
        >>> {k: len(v) for k, v in found.items()}
        {'phone': 1, 'email': 1}
    """

    def __init__(self, config: MaskingConfig) -> None:
        self._config = config

    def find_all(self, text: str) -> dict[str, list[str]]:
        """Find all PII occurrences in text, grouped by type.

        Args:
            text: The text to scan for PII.

        Returns:
            Dict mapping PII type (``"email"``, ``"phone"``, ``"ssn"``, ``"cc"``)
            to a list of matched strings. Empty list for types not found or disabled.
        """
        found: dict[str, list[str]] = {}

        if self._config.mask_email:
            emails = _EMAIL_RE.findall(text)
            safe_domains = self._config.safe_email_domains
            if safe_domains:
                emails = [e for e in emails if e.split("@")[-1].lower() not in safe_domains]
            if emails:
                found["email"] = emails

        if self._config.mask_phone:
            phones = _PHONE_RE.findall(text)
            # findall returns tuples for groups — flatten
            flat_phones = [m[0] if isinstance(m, tuple) else m for m in phones]
            if flat_phones:
                found["phone"] = flat_phones

        if self._config.mask_ssn:
            ssns = _SSN_RE.findall(text)
            if ssns:
                found["ssn"] = ssns

        if self._config.mask_cc:
            cc_matches = _CC_RE.finditer(text)
            valid_ccs: list[str] = [m.group(0) for m in cc_matches if _luhn_valid(m.group(0))]
            if valid_ccs:
                found["cc"] = valid_ccs

        return found

    def has_pii(self, text: str) -> bool:
        """Return ``True`` if any PII is found in the text.

        Args:
            text: The text to scan.

        Returns:
            ``True`` if at least one PII instance is detected, ``False`` otherwise.
        """
        return bool(self.find_all(text))


# ---------------------------------------------------------------------------
# PIIMasker (SRP: masking + input/output guardrail interface)
# ---------------------------------------------------------------------------


@GuardrailRegistry.register_input("pii_masker")
@GuardrailRegistry.register_output("pii_masker")
class PIIMasker(InputGuardrail, OutputGuardrail):
    """Detects and masks PII in user input or agent output.

    Returns ``MODIFY`` with masked content if PII is found, or ``ALLOW`` if
    the input is clean. Never returns ``BLOCK`` — PII masking is a sanitisation
    step, not a rejection step.

    Uses :class:`PIIDetector` for detection and applies compiled-regex substitutions.
    Credit card detection requires Luhn checksum validation to minimise false
    positives.

    Args:
        config: Optional configuration dict. Recognised keys:
            - ``mask_email`` (bool): Mask email addresses. Default ``True``.
            - ``mask_phone`` (bool): Mask phone numbers. Default ``True``.
            - ``mask_ssn`` (bool): Mask SSNs. Default ``True``.
            - ``mask_cc`` (bool): Mask credit card numbers. Default ``True``.
            - ``safe_email_domains`` (list[str]): Domains exempt from masking.
              Default ``[]``.

    Example:
        >>> masker = PIIMasker(config={"mask_email": True, "safe_email_domains": ["example.com"]})
        >>> ctx = GuardrailContext.for_input(
        ...     "Email me at alice@gmail.com or support@example.com",
        ...     "agent", "corr-1",
        ... )
        >>> result = await masker.check(ctx)
        >>> result.action
        <GuardrailAction.MODIFY: 'modify'>
        >>> result.modified_content
        'Email me at [EMAIL_REDACTED] or support@example.com'
    """

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        cfg = config or {}
        self._masking_config = MaskingConfig.from_dict(cfg)
        self._detector = PIIDetector(self._masking_config)
        # action_on_trigger merged in by GuardrailRegistry.build_pipeline.
        # Default ``modify`` preserves historical masking behaviour.
        self._trigger_action: GuardrailAction = resolve_action(
            cfg.get("action_on_trigger"),
            default=GuardrailAction.MODIFY,
            allowed=_PII_ALLOWED_ACTIONS,
        )
        self._custom_message: str | None = cfg.get("message")

    @property
    def name(self) -> str:
        """Return the guardrail registry name.

        Returns:
            ``"pii_masker"``
        """
        return "pii_masker"

    async def check(self, ctx: GuardrailContext) -> GuardrailResult:
        """Detect and mask PII in the content.

        Args:
            ctx: Guardrail context. ``ctx.content`` is the text to process.

        Returns:
            ``MODIFY`` with masked ``modified_content`` if PII is found.
            ``ALLOW`` if no enabled PII type is detected.

        Example:
            >>> result = await masker.check(ctx)
            >>> result.action in (GuardrailAction.ALLOW, GuardrailAction.MODIFY)
            True
        """
        text = ctx.content
        masked_text = text
        total_masked = 0

        if self._masking_config.mask_email:
            masked_text, count = self._mask_emails(masked_text)
            total_masked += count

        if self._masking_config.mask_phone:
            masked_text, count = self._mask_phones(masked_text)
            total_masked += count

        if self._masking_config.mask_ssn:
            masked_text, count = self._mask_ssns(masked_text)
            total_masked += count

        if self._masking_config.mask_cc:
            masked_text, count = self._mask_credit_cards(masked_text)
            total_masked += count

        if total_masked > 0:
            logger.info(
                "PII detected",
                pii_count=total_masked,
                action=self._trigger_action.value,
                guardrail_type=ctx.guardrail_type,
                agent_id=ctx.agent_id,
                correlation_id=ctx.correlation_id,
            )
            details = {"pii_count": total_masked}

            if self._trigger_action == GuardrailAction.BLOCK:
                return GuardrailResult(
                    action=GuardrailAction.BLOCK,
                    guardrail_name=self.name,
                    message=self._custom_message
                    or f"Blocked content containing {total_masked} PII instance(s).",
                    details=details,
                )

            if self._trigger_action == GuardrailAction.WARN:
                return GuardrailResult(
                    action=GuardrailAction.WARN,
                    guardrail_name=self.name,
                    message=self._custom_message
                    or f"Detected {total_masked} PII instance(s) (allowed with warning).",
                    details=details,
                )

            # Default: MODIFY — return masked content.
            return GuardrailResult(
                action=GuardrailAction.MODIFY,
                guardrail_name=self.name,
                message=self._custom_message or f"Masked {total_masked} PII instance(s).",
                modified_content=masked_text,
                details=details,
            )

        return GuardrailResult(
            action=GuardrailAction.ALLOW,
            guardrail_name=self.name,
        )

    # ------------------------------------------------------------------
    # Private masking helpers
    # ------------------------------------------------------------------

    def _mask_emails(self, text: str) -> tuple[str, int]:
        """Mask email addresses, respecting the safe domain allowlist.

        Args:
            text: Input text to process.

        Returns:
            Tuple of (masked text, number of replacements made).
        """
        safe_domains = self._masking_config.safe_email_domains
        count = 0

        def _replace_email(match: re.Match[str]) -> str:
            nonlocal count
            email = match.group(0)
            domain = email.split("@")[-1].lower()
            if domain in safe_domains:
                return email
            count += 1
            return "[EMAIL_REDACTED]"

        result = _EMAIL_RE.sub(_replace_email, text)
        return result, count

    def _mask_phones(self, text: str) -> tuple[str, int]:
        """Mask phone numbers.

        Args:
            text: Input text to process.

        Returns:
            Tuple of (masked text, number of replacements made).
        """
        count = [0]

        def _replace_phone(match: re.Match[str]) -> str:
            count[0] += 1
            return "[PHONE_REDACTED]"

        result = _PHONE_RE.sub(_replace_phone, text)
        return result, count[0]

    def _mask_ssns(self, text: str) -> tuple[str, int]:
        """Mask Social Security Numbers.

        Args:
            text: Input text to process.

        Returns:
            Tuple of (masked text, number of replacements made).
        """
        count = [0]

        def _replace_ssn(match: re.Match[str]) -> str:
            count[0] += 1
            return "[SSN_REDACTED]"

        result = _SSN_RE.sub(_replace_ssn, text)
        return result, count[0]

    def _mask_credit_cards(self, text: str) -> tuple[str, int]:
        """Mask Luhn-valid credit card numbers.

        Only masks numbers that pass the Luhn checksum to reduce false positives
        on arbitrary 16-digit sequences.

        Args:
            text: Input text to process.

        Returns:
            Tuple of (masked text, number of replacements made).
        """
        count = [0]

        def _replace_cc(match: re.Match[str]) -> str:
            candidate = match.group(0)
            if _luhn_valid(candidate):
                count[0] += 1
                return "[CC_REDACTED]"
            return candidate

        result = _CC_RE.sub(_replace_cc, text)
        return result, count[0]
