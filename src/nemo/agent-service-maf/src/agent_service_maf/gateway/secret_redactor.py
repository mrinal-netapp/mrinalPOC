"""SecretRedactor — structlog processor that masks secrets in all log output.

This module provides a structlog processor that automatically detects and masks
known secret patterns (API keys, Bearer tokens, JWTs) before any log entry is
written. Apply it as the first processor in the structlog pipeline to ensure no
credential ever leaks to stdout or external log aggregators.

Example::

    import structlog
    from agent_service_maf.gateway.secret_redactor import SecretRedactor

    structlog.configure(
        processors=[
            SecretRedactor(),
            structlog.processors.JSONRenderer(),
        ],
    )
"""

from __future__ import annotations

import re
from typing import Any

# ---------------------------------------------------------------------------
# Compiled pattern table: (compiled_regex, replacement_string)
# ---------------------------------------------------------------------------

_RAW_PATTERNS: list[tuple[str, str]] = [
    # Anthropic API keys  sk-ant-api03-<20+ chars>
    (r"sk-ant-[A-Za-z0-9\-_]{20,}", "sk-ant-***"),
    # OpenAI-style API keys  sk-<20+ chars>
    (r"sk-[A-Za-z0-9]{20,}", "sk-***"),
    # AWS access key IDs  AKIA<16 uppercase alphanumeric>
    (r"AKIA[0-9A-Z]{16}", "AKIA***"),
    # GitHub personal access tokens  ghp_<20+ chars>
    (r"ghp_[A-Za-z0-9]{20,}", "ghp_***"),
    # Bearer tokens  "Bearer <token>"
    (r"Bearer\s+[A-Za-z0-9.\-_+/=]{10,}", "Bearer ***"),
    # JWT tokens  <header>.<payload>.<signature> (base64url segments, 10+ chars each)
    (
        r"[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}",
        "JWT-***",
    ),
]

_COMPILED_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(pattern), replacement) for pattern, replacement in _RAW_PATTERNS
]


# §H1 — explicit field-name redactions for the two-token model.
#
# Any structlog event-dict key whose lowercased name appears here is
# replaced wholesale with ``[REDACTED]``. Narrower than the
# "sensitive field names" lists elsewhere in the codebase (which are
# best-effort logging hygiene) -- this set is the **typed identity
# carriers** for the plan's two-token model. Wholesale redaction
# matters here because opaque / short tokens may not match the
# pattern-based regex above (and we'd rather over-redact a
# user_token field than under-redact and leak a JWT).
#
# The pre-existing redactor behaviour for generic fields like
# ``api_key`` / ``authorization`` / ``token`` is intentionally
# preserved: those still rely on the regex catch-alls so the
# specific prefix ("sk-ant-***", "Bearer ***") survives for
# operator pattern recognition.
_SENSITIVE_FIELD_NAMES: frozenset[str] = frozenset(
    {
        # The inbound user JWT (lives on IdentityContext.user_token).
        "user_token",
        "usertoken",
        "x-user-token",
        # Per-downstream service-account tokens (env-only secrets).
        "mcp_service_token",
        "kb_service_token",
        # The Pydantic field literal on IdentityContext.
        "userToken",
    }
)

_REDACTED_FIELD_PLACEHOLDER = "[REDACTED]"


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _redact_string(value: str) -> str:
    """Apply all secret patterns to a single string value.

    Args:
        value: The string to scan and redact.

    Returns:
        The string with all matched secret patterns replaced.
    """
    for pattern, replacement in _COMPILED_PATTERNS:
        value = pattern.sub(replacement, value)
    return value


def _is_sensitive_field(key: object) -> bool:
    """Return ``True`` when *key* matches a §H1 sensitive field name.

    Comparison is case-insensitive on the lowercased string form of
    the key, so ``"X-User-Token"``, ``"x-user-token"``, and
    ``"X_USER_TOKEN"`` all redact.
    """
    if not isinstance(key, str):
        return False
    return key.lower() in _SENSITIVE_FIELD_NAMES


def _redact_value(value: object) -> object:
    """Recursively redact secrets from a log value.

    Handles strings, dicts, lists, and tuples. Other types are returned
    unchanged. Dict keys matching :data:`_SENSITIVE_FIELD_NAMES` have
    their values replaced wholesale with ``[REDACTED]`` regardless of
    string-pattern matches.

    Args:
        value: The log value to redact.

    Returns:
        The value with secrets masked.
    """
    if isinstance(value, str):
        return _redact_string(value)
    if isinstance(value, dict):
        result: dict[Any, Any] = {}
        for k, v in value.items():
            if _is_sensitive_field(k):
                result[k] = _REDACTED_FIELD_PLACEHOLDER
            else:
                result[k] = _redact_value(v)
        return result
    if isinstance(value, list):
        return [_redact_value(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_redact_value(item) for item in value)
    return value


# ---------------------------------------------------------------------------
# Public processor class
# ---------------------------------------------------------------------------


class SecretRedactor:
    """Structlog processor that masks secret patterns in all log entries.

    Scans every string value in the structlog event dict (including nested
    dicts and lists) and replaces known secret patterns with masked
    placeholders. Applied as a structlog processor before the renderer.

    Detected patterns:
        - ``sk-ant-*`` — Anthropic API keys
        - ``sk-*`` — OpenAI-style API keys
        - ``AKIA*`` — AWS access key IDs
        - ``ghp_*`` — GitHub personal access tokens
        - ``Bearer <token>`` — HTTP Bearer authorization header values
        - ``<header>.<payload>.<sig>`` — JWT tokens

    Example::

        structlog.configure(
            processors=[SecretRedactor(), structlog.processors.JSONRenderer()],
        )
    """

    def __call__(
        self,
        logger: object,
        method_name: str,
        event_dict: dict[str, Any],
    ) -> dict[str, Any]:
        """Structlog processor hook — redacts secrets from the event dict.

        Args:
            logger: The structlog logger instance (unused).
            method_name: The log method name, e.g. ``"info"`` (unused).
            event_dict: Mutable dict of all key-value pairs for this log entry.

        Returns:
            The same ``event_dict`` with all secret values masked in-place.
        """
        for key in list(event_dict.keys()):
            raw = event_dict[key]
            # §H1 — wholesale-redact the value when the structlog
            # event-dict key itself is sensitive (``user_token``,
            # ``mcp_service_token``, etc.). Avoids relying on the
            # regex catch-alls for opaque / short tokens that may
            # not match a pattern.
            if _is_sensitive_field(key):
                event_dict[key] = _REDACTED_FIELD_PLACEHOLDER
                continue
            event_dict[key] = _redact_value(raw)
        return event_dict
