"""PCI (payment card data) detection and masking guardrail (Task 004 #2).

Dual-phase (input + output) guardrail that catches **full PCI scope** payment
card data the generic ``pii_masker`` does not cover. ``pii_masker`` already
Luhn-validates a single 4x4 credit-card shape; ``pci_masker`` adds brand-aware
PANs, card details (CVV / expiry), and magstripe track data:

- Primary Account Number (PAN)         -> ``[PAN_REDACTED]`` (Luhn-validated, mandatory)
- CVV / CVC security code              -> ``[CVV_REDACTED]`` (keyword-anchored)
- Expiry date                          -> ``[EXPIRY_REDACTED]`` (keyword-anchored)
- Magstripe Track 1 / Track 2 data     -> ``[MAGSTRIPE_REDACTED]``

Pure standard-library regex + inline Luhn (no external dependency, no ML).
Mirrors the ``pii_masker`` / ``phi_masker`` structure: a :class:`PCIMaskingConfig`
(per-category toggles), a :class:`PCIDetector` (finds spans), and
:class:`PCIMasker` (the dual-phase guardrail that redacts matches and honours
``action_on_trigger``).

Do **not** modify ``pii_masker``. When both guardrails are enabled, set
``pii_masker.config.mask_cc: false`` to avoid ``[CC_REDACTED]`` + ``[PAN_REDACTED]``
overlap. Luhn validation for PANs is **mandatory** and not configurable.

Out of scope (use ``custom_regex`` instead): operator custom regex, messy
multi-field card parsing, test-card allowlists, online BIN verification.
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
    InputGuardrail,
    OutputGuardrail,
    resolve_action,
)
from agent_service_maf.guardrails.registry import GuardrailRegistry

logger = structlog.get_logger(__name__)

#: Actions ``pci_masker`` can produce on a hit. ``MODIFY`` redacts in place,
#: ``BLOCK`` rejects the request/response, ``WARN`` allows but logs.
_PCI_ALLOWED_ACTIONS = frozenset(
    {GuardrailAction.MODIFY, GuardrailAction.BLOCK, GuardrailAction.WARN}
)

# Placeholders per category.
_PAN_PLACEHOLDER = "[PAN_REDACTED]"
_CVV_PLACEHOLDER = "[CVV_REDACTED]"
_EXPIRY_PLACEHOLDER = "[EXPIRY_REDACTED]"
_MAGSTRIPE_PLACEHOLDER = "[MAGSTRIPE_REDACTED]"

# ---------------------------------------------------------------------------
# Compiled PCI patterns
# ---------------------------------------------------------------------------

# PAN candidate: 13-19 digits, optionally grouped by single spaces or dashes.
# Luhn validation (mandatory) filters out arbitrary digit runs downstream.
_PAN_RE = re.compile(r"\b(?:\d[ -]?){12,18}\d\b")

# Magstripe Track 1: %B<PAN>^<NAME>^... — sentinel-delimited swipe data.
_TRACK1_RE = re.compile(r"%B\d{13,19}\^[^\^]{2,}\^[^\?]*\??")

# Magstripe Track 2: ;<PAN>=<expiry><service code>... — sentinel-delimited.
_TRACK2_RE = re.compile(r";\d{13,19}=\d{4,}[^\?]*\??")

# CVV / CVC: keyword-anchored 3-4 digit security code.
_CVV_RE = re.compile(
    r"(?i)\b(?:cvv2?|cvc2?|cid|security\s*code)\b[:\s#=-]*\d{3,4}\b",
)

# Expiry: keyword-anchored MM/YY or MM/YYYY (also accepts '-').
_EXPIRY_RE = re.compile(
    r"(?i)\b(?:exp(?:iry|ires|iration)?(?:\s*date)?|valid\s*(?:thru|until|to))\b"
    r"[:\s#=-]*\d{1,2}[/-]\d{2,4}\b",
)


# ---------------------------------------------------------------------------
# Luhn checksum helper (mandatory for PAN; duplicated per one-file rule)
# ---------------------------------------------------------------------------


def _luhn_valid(number: str) -> bool:
    """Validate a candidate PAN string using the Luhn algorithm.

    Strips non-digit characters before checking. Returns ``False`` for strings
    that are not 13-19 digits after stripping. Same algorithm as
    ``pii_masker._luhn_valid`` — duplicated here per the one-file-per-guardrail
    rule (do not import from ``pii_masker``).

    Args:
        number: The candidate PAN (may contain spaces / hyphens).

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
    for i, ch in enumerate(reversed(digits)):
        n = int(ch)
        if i % 2 == 1:
            n *= 2
            if n > 9:
                n -= 9
        total += n
    return total % 10 == 0


# ---------------------------------------------------------------------------
# PCIMaskingConfig (per-category toggles)
# ---------------------------------------------------------------------------


@dataclass
class PCIMaskingConfig:
    """Per-category toggles controlling which PCI elements are redacted.

    Luhn validation for PANs is always applied when ``pan`` is enabled — it is
    mandatory and intentionally not exposed as a config key.

    Attributes:
        pan: Redact primary account numbers (Luhn-validated). Default ``True``.
        card_details: Redact CVV / CVC and expiry dates. Default ``True``.
        magstripe_data: Redact magstripe Track 1 / Track 2 data. Default ``True``.
    """

    pan: bool = True
    card_details: bool = True
    magstripe_data: bool = True

    @classmethod
    def from_dict(cls, config: dict[str, Any]) -> PCIMaskingConfig:
        """Construct from a config dict (keys ``pan`` / ``card_details`` / ``magstripe_data``)."""
        return cls(
            pan=bool(config.get("pan", True)),
            card_details=bool(config.get("card_details", True)),
            magstripe_data=bool(config.get("magstripe_data", True)),
        )


# ---------------------------------------------------------------------------
# PCIMatch (detected span)
# ---------------------------------------------------------------------------


@dataclass
class PCIMatch:
    """A single detected PCI span.

    Attributes:
        type: Category label (``"pan"`` / ``"cvv"`` / ``"expiry"`` / ``"magstripe"``).
        start: Start index of the span in the source text.
        end: End index (exclusive) of the span in the source text.
        placeholder: Replacement text used on ``MODIFY``.
    """

    type: str
    start: int
    end: int
    placeholder: str


# ---------------------------------------------------------------------------
# Detection helpers (one per category)
# ---------------------------------------------------------------------------


def _scan_pan(text: str) -> list[PCIMatch]:
    """Find Luhn-valid PAN spans. Luhn filtering is mandatory."""
    matches: list[PCIMatch] = []
    for m in _PAN_RE.finditer(text):
        if _luhn_valid(m.group(0)):
            matches.append(PCIMatch("pan", m.start(), m.end(), _PAN_PLACEHOLDER))
    return matches


def _scan_card_details(text: str) -> list[PCIMatch]:
    """Find keyword-anchored CVV / CVC and expiry spans."""
    matches: list[PCIMatch] = []
    for m in _CVV_RE.finditer(text):
        matches.append(PCIMatch("cvv", m.start(), m.end(), _CVV_PLACEHOLDER))
    for m in _EXPIRY_RE.finditer(text):
        matches.append(PCIMatch("expiry", m.start(), m.end(), _EXPIRY_PLACEHOLDER))
    return matches


def _scan_magstripe_data(text: str) -> list[PCIMatch]:
    """Find magstripe Track 1 / Track 2 spans."""
    matches: list[PCIMatch] = []
    for m in _TRACK1_RE.finditer(text):
        matches.append(PCIMatch("magstripe", m.start(), m.end(), _MAGSTRIPE_PLACEHOLDER))
    for m in _TRACK2_RE.finditer(text):
        matches.append(PCIMatch("magstripe", m.start(), m.end(), _MAGSTRIPE_PLACEHOLDER))
    return matches


# ---------------------------------------------------------------------------
# PCIDetector (merge + dedupe)
# ---------------------------------------------------------------------------


class PCIDetector:
    """Finds and redacts PCI spans according to a :class:`PCIMaskingConfig`."""

    def __init__(self, config: PCIMaskingConfig) -> None:
        self._config = config

    def detect(self, text: str) -> list[PCIMatch]:
        """Return de-overlapped PCI matches for all enabled categories.

        Magstripe is scanned first so that, on overlap with a bare PAN match,
        the longer magstripe span is preferred.

        Args:
            text: The text to scan.

        Returns:
            Matches sorted by start index with overlaps removed (longest span wins).
        """
        found: list[PCIMatch] = []
        if self._config.magstripe_data:
            found.extend(_scan_magstripe_data(text))
        if self._config.pan:
            found.extend(_scan_pan(text))
        if self._config.card_details:
            found.extend(_scan_card_details(text))
        return self._dedupe(found)

    @staticmethod
    def _dedupe(matches: list[PCIMatch]) -> list[PCIMatch]:
        """De-overlap spans so redaction can be applied safely (end -> start)."""
        if not matches:
            return []

        ordered = sorted(matches, key=lambda m: (m.start, -(m.end - m.start)))
        kept: list[PCIMatch] = [ordered[0]]
        for match in ordered[1:]:
            last = kept[-1]
            if match.start >= last.end:
                kept.append(match)
                continue
            if match.end <= last.end:
                continue  # fully covered by the previous (same-start longest-first)
            clipped = PCIMatch(
                type=match.type,
                start=last.end,
                end=match.end,
                placeholder=match.placeholder,
            )
            if clipped.start < clipped.end:
                kept.append(clipped)
        return kept

    def redact(self, text: str, matches: list[PCIMatch]) -> str:
        """Replace matched spans with their placeholders, end -> start."""
        result = text
        for match in sorted(matches, key=lambda m: m.start, reverse=True):
            result = result[: match.start] + match.placeholder + result[match.end :]
        return result


# ---------------------------------------------------------------------------
# PCIMasker (dual-phase guardrail)
# ---------------------------------------------------------------------------


@GuardrailRegistry.register_input("pci_masker")
@GuardrailRegistry.register_output("pci_masker")
class PCIMasker(InputGuardrail, OutputGuardrail):
    r"""Detects and redacts payment card data on input or output.

    Honours ``action_on_trigger`` (merged into config by the registry):
    ``modify`` (default) redacts in place, ``block`` rejects the request /
    response, ``warn`` allows but logs. Never returns the raw card data in
    ``details`` or logs.

    Args:
        config: Optional config dict. Recognised keys: ``pan``, ``card_details``,
            ``magstripe_data`` (bool, default ``True``), plus ``action_on_trigger``
            and ``message`` (merged in by the registry). Luhn validation for PANs
            is mandatory and not configurable.

    Example:
        >>> masker = PCIMasker(config={"pan": True})
        >>> ctx = GuardrailContext.for_output("Card 4532015112830366 charged.", "a", "c")
        >>> result = await masker.check(ctx)
        >>> result.action
        <GuardrailAction.MODIFY: 'modify'>
    """

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        cfg = config or {}
        self._masking_config = PCIMaskingConfig.from_dict(cfg)
        self._detector = PCIDetector(self._masking_config)
        self._trigger_action: GuardrailAction = resolve_action(
            cfg.get("action_on_trigger"),
            default=GuardrailAction.MODIFY,
            allowed=_PCI_ALLOWED_ACTIONS,
        )
        self._custom_message: str | None = cfg.get("message")

    @property
    def name(self) -> str:
        """Return the guardrail registry name."""
        return "pci_masker"

    async def check(self, ctx: GuardrailContext) -> GuardrailResult:
        """Detect and act on payment card data in the content."""
        matches = self._detector.detect(ctx.content)

        if not matches:
            return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

        match_types = sorted({m.type for m in matches})
        total = len(matches)
        logger.info(
            "PCI data detected",
            pci_count=total,
            match_types=match_types,
            action=self._trigger_action.value,
            guardrail_type=ctx.guardrail_type,
            agent_id=ctx.agent_id,
            correlation_id=ctx.correlation_id,
        )
        details = {"match_types": match_types, "match_count": total}

        if self._trigger_action == GuardrailAction.BLOCK:
            return GuardrailResult(
                action=GuardrailAction.BLOCK,
                guardrail_name=self.name,
                message=self._custom_message
                or f"Blocked content containing {total} payment card data item(s).",
                details=details,
            )

        if self._trigger_action == GuardrailAction.WARN:
            return GuardrailResult(
                action=GuardrailAction.WARN,
                guardrail_name=self.name,
                message=self._custom_message
                or f"Detected {total} payment card data item(s) (allowed with warning).",
                details=details,
            )

        return GuardrailResult(
            action=GuardrailAction.MODIFY,
            guardrail_name=self.name,
            message=self._custom_message or f"Redacted {total} payment card data item(s).",
            modified_content=self._detector.redact(ctx.content, matches),
            details=details,
        )
