"""Secrets / credential leakage guardrail (Task 004 #1).

Dual-phase (input + output) guardrail powered by Yelp's
[`detect-secrets`](https://github.com/Yelp/detect-secrets) regex plugin pack
(**not ML**) plus a small standard-library supplement for database / broker
connection URIs that the plugins do not fully cover.

It is a **superset** of the legacy ``content_filter`` secret scanner:

- Vendor API keys (AWS, GitHub, Stripe, Slack, Azure, ...) -> ``[API_KEY_REDACTED]``
- Private keys (PEM / RSA)                                  -> ``[PRIVATE_KEY_REDACTED]``
- JSON Web Tokens                                          -> ``[JWT_REDACTED]``
- BasicAuth / secret keyword patterns                      -> ``[CREDENTIAL_REDACTED]``
- Connection strings (stdlib supplement)                   -> ``[CONNECTION_STRING_REDACTED]``

``detect-secrets`` is an **optional** dependency. It is imported lazily in
``__init__``; enabling this guardrail without the package installed raises
:class:`ConfigurationError`. High-entropy plugins (``Base64HighEntropyString``,
``HexHighEntropyString``) are **always disabled** and not team-configurable.

Do **not** modify ``content_filter``. Operator custom regex belongs in the
``custom_regex`` guardrail, not here.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import structlog

from agent_service_maf.core.exceptions import ConfigurationError
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

#: Actions ``secret_leakage`` can produce on a hit.
_SECRET_ALLOWED_ACTIONS = frozenset(
    {GuardrailAction.MODIFY, GuardrailAction.BLOCK, GuardrailAction.WARN}
)

#: Config toggle -> detect-secrets plugin class names enabled for that category.
_PLUGIN_MAP: dict[str, list[str]] = {
    "vendor_api_keys": [
        "AWSKeyDetector",
        "GitHubTokenDetector",
        "GitLabTokenDetector",
        "StripeDetector",
        "SlackDetector",
        "AzureStorageKeyDetector",
        "CloudantDetector",
        "IbmCloudIamDetector",
        "IbmCosHmacDetector",
        "SoftlayerDetector",
        "SquareOAuthDetector",
        "TelegramBotTokenDetector",
        "ArtifactoryDetector",
        "NpmDetector",
        "SendGridDetector",
        "DiscordBotTokenDetector",
        "MailchimpDetector",
        "TwilioKeyDetector",
        "PypiTokenDetector",
        "OpenAIDetector",
    ],
    "private_keys": ["PrivateKeyDetector"],
    "jwt": ["JwtTokenDetector"],
    "secret_patterns": ["KeywordDetector", "BasicAuthDetector"],
}

#: Entropy plugins are never enabled — not team-configurable.
_ENTROPY_PLUGINS = frozenset({"Base64HighEntropyString", "HexHighEntropyString"})

# Placeholders.
_API_KEY_PLACEHOLDER = "[API_KEY_REDACTED]"
_PRIVATE_KEY_PLACEHOLDER = "[PRIVATE_KEY_REDACTED]"
_JWT_PLACEHOLDER = "[JWT_REDACTED]"
_CREDENTIAL_PLACEHOLDER = "[CREDENTIAL_REDACTED]"
_CONNECTION_STRING_PLACEHOLDER = "[CONNECTION_STRING_REDACTED]"

# Stdlib connection-string supplement (gated by ``connection_strings``).
_CONNECTION_STRING_RES: list[re.Pattern[str]] = [
    re.compile(
        r"(?i)\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|jdbc):"
        r"//[^\s'\"]+"
    ),
    re.compile(r"(?i)Server=tcp:[^;]+;[^\n]*?Password=[^;\s]+"),
]


# ---------------------------------------------------------------------------
# Lazy detect-secrets loader
# ---------------------------------------------------------------------------


def _load_detect_secrets() -> Any:  # noqa: ANN401
    """Lazily import ``detect-secrets``.

    Returns:
        The imported ``detect_secrets`` module.

    Raises:
        ConfigurationError: If the optional ``detect-secrets`` dependency is missing.
    """
    try:
        import detect_secrets
    except ImportError as exc:
        raise ConfigurationError(
            "The 'secret_leakage' guardrail requires the optional 'detect-secrets' "
            "dependency. Install it with: pip install detect-secrets. "
            "Disable the 'secret_leakage' guardrail in team config if you do not need it.",
            details={"missing_package": "detect-secrets"},
        ) from exc
    return detect_secrets


def _placeholder_for(secret_type: str) -> str:
    """Map a detect-secrets ``secret_type`` display string to a placeholder."""
    st = secret_type.lower()
    if "private key" in st:
        return _PRIVATE_KEY_PLACEHOLDER
    if "json web token" in st or "jwt" in st:
        return _JWT_PLACEHOLDER
    if "basic auth" in st or "keyword" in st:
        return _CREDENTIAL_PLACEHOLDER
    return _API_KEY_PLACEHOLDER


# ---------------------------------------------------------------------------
# SecretLeakageConfig (per-category toggles)
# ---------------------------------------------------------------------------


@dataclass
class SecretLeakageConfig:
    """Per-category toggles controlling which secret detectors run.

    Attributes:
        vendor_api_keys: Enable detect-secrets vendor key plugins. Default ``True``.
        private_keys: Enable ``PrivateKeyDetector``. Default ``True``.
        jwt: Enable ``JwtTokenDetector``. Default ``True``.
        connection_strings: Enable the stdlib connection-URI supplement. Default ``True``.
        secret_patterns: Enable ``KeywordDetector`` / ``BasicAuthDetector``. Default ``True``.
    """

    vendor_api_keys: bool = True
    private_keys: bool = True
    jwt: bool = True
    connection_strings: bool = True
    secret_patterns: bool = True

    @classmethod
    def from_dict(cls, config: dict[str, Any]) -> SecretLeakageConfig:
        """Construct from a config dict (all toggles default ``True``)."""
        return cls(
            vendor_api_keys=bool(config.get("vendor_api_keys", True)),
            private_keys=bool(config.get("private_keys", True)),
            jwt=bool(config.get("jwt", True)),
            connection_strings=bool(config.get("connection_strings", True)),
            secret_patterns=bool(config.get("secret_patterns", True)),
        )


# ---------------------------------------------------------------------------
# SecretMatch (detected span)
# ---------------------------------------------------------------------------


@dataclass
class SecretMatch:
    """A single detected secret span.

    Attributes:
        type: Category / detector label (never the raw secret value).
        start: Start index of the span in the source text.
        end: End index (exclusive).
        placeholder: Replacement text used on ``MODIFY``.
    """

    type: str
    start: int
    end: int
    placeholder: str


# ---------------------------------------------------------------------------
# Settings builder + scanners
# ---------------------------------------------------------------------------


def _build_detect_secrets_settings(config: SecretLeakageConfig) -> dict[str, Any]:
    """Build a detect-secrets ``transient_settings`` dict from category toggles.

    Only the plugins for enabled categories are listed under ``plugins_used``;
    entropy plugins are never included (allowlist approach guarantees they are off).

    Args:
        config: The resolved :class:`SecretLeakageConfig`.

    Returns:
        A settings dict suitable for ``detect_secrets.settings.transient_settings``.
    """
    plugins: list[str] = []
    if config.vendor_api_keys:
        plugins.extend(_PLUGIN_MAP["vendor_api_keys"])
    if config.private_keys:
        plugins.extend(_PLUGIN_MAP["private_keys"])
    if config.jwt:
        plugins.extend(_PLUGIN_MAP["jwt"])
    if config.secret_patterns:
        plugins.extend(_PLUGIN_MAP["secret_patterns"])

    # Defensive: never let an entropy plugin slip into the enabled set.
    plugins = [p for p in plugins if p not in _ENTROPY_PLUGINS]
    return {"plugins_used": [{"name": name} for name in plugins]}


def _scan_with_detect_secrets(text: str, settings: dict[str, Any]) -> list[SecretMatch]:
    """Scan ``text`` with detect-secrets under ``settings`` and return spans.

    Best-effort span resolution: detect-secrets reports a secret value per line;
    the value is located within ``text`` to compute a redaction span.

    Args:
        text: The content to scan.
        settings: A ``transient_settings`` dict from :func:`_build_detect_secrets_settings`.

    Returns:
        A list of :class:`SecretMatch` for each located secret.
    """
    if not settings.get("plugins_used"):
        return []

    _load_detect_secrets()
    from detect_secrets.core import scan
    from detect_secrets.settings import transient_settings

    matches: list[SecretMatch] = []
    offset = 0
    with transient_settings(settings):
        for line in text.splitlines(keepends=True):
            bare = line.rstrip("\r\n")
            for secret in scan.scan_line(bare):
                value = getattr(secret, "secret_value", None)
                if not value:
                    continue
                col = bare.find(value)
                if col == -1:
                    continue
                start = offset + col
                matches.append(
                    SecretMatch(
                        type=str(getattr(secret, "type", "secret")),
                        start=start,
                        end=start + len(value),
                        placeholder=_placeholder_for(str(getattr(secret, "type", ""))),
                    )
                )
            offset += len(line)
    return matches


def _scan_connection_strings(text: str) -> list[SecretMatch]:
    """Find connection-string spans via the stdlib supplement."""
    matches: list[SecretMatch] = []
    for pattern in _CONNECTION_STRING_RES:
        for m in pattern.finditer(text):
            matches.append(
                SecretMatch(
                    type="Connection String",
                    start=m.start(),
                    end=m.end(),
                    placeholder=_CONNECTION_STRING_PLACEHOLDER,
                )
            )
    return matches


# ---------------------------------------------------------------------------
# SecretDetector (merge + dedupe)
# ---------------------------------------------------------------------------


class SecretDetector:
    """Merges detect-secrets and supplemental hits, removing overlaps."""

    def __init__(self, config: SecretLeakageConfig, settings: dict[str, Any]) -> None:
        self._config = config
        self._settings = settings

    def find_all(self, text: str) -> list[SecretMatch]:
        """Return de-overlapped secret matches for all enabled categories."""
        found: list[SecretMatch] = _scan_with_detect_secrets(text, self._settings)
        if self._config.connection_strings:
            found.extend(_scan_connection_strings(text))
        return self._dedupe(found)

    @staticmethod
    def _dedupe(matches: list[SecretMatch]) -> list[SecretMatch]:
        """De-overlap spans so redaction can be applied safely (end -> start)."""
        if not matches:
            return []

        ordered = sorted(matches, key=lambda m: (m.start, -(m.end - m.start)))
        kept: list[SecretMatch] = [ordered[0]]
        for match in ordered[1:]:
            last = kept[-1]
            if match.start >= last.end:
                kept.append(match)
                continue
            if match.end <= last.end:
                continue  # fully covered by the previous (same-start longest-first)
            # Partial overlap: clip to the uncovered tail to avoid overlapping replacements.
            clipped = SecretMatch(
                type=match.type,
                start=last.end,
                end=match.end,
                placeholder=match.placeholder,
            )
            if clipped.start < clipped.end:
                kept.append(clipped)
        return kept

    @staticmethod
    def redact(text: str, matches: list[SecretMatch]) -> str:
        """Replace matched spans with their placeholders, end -> start."""
        result = text
        for match in sorted(matches, key=lambda m: m.start, reverse=True):
            result = result[: match.start] + match.placeholder + result[match.end :]
        return result


# ---------------------------------------------------------------------------
# SecretLeakageGuard (dual-phase guardrail)
# ---------------------------------------------------------------------------


@GuardrailRegistry.register_input("secret_leakage")
@GuardrailRegistry.register_output("secret_leakage")
class SecretLeakageGuard(InputGuardrail, OutputGuardrail):
    r"""Detects and redacts leaked secrets / credentials on input or output.

    Honours ``action_on_trigger`` (merged into config by the registry):
    ``modify`` (default) redacts in place, ``block`` rejects, ``warn`` logs.
    Never returns raw secret substrings in ``details`` or logs.

    Args:
        config: Optional config dict. Recognised keys: ``vendor_api_keys``,
            ``private_keys``, ``jwt``, ``connection_strings``, ``secret_patterns``
            (bool, default ``True``), plus ``action_on_trigger`` / ``message``
            (merged by the registry).

    Raises:
        ConfigurationError: If ``detect-secrets`` is not installed.
    """

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        cfg = config or {}
        self._config = SecretLeakageConfig.from_dict(cfg)
        # Fail fast at pipeline build if the optional dependency is missing.
        _load_detect_secrets()
        self._settings = _build_detect_secrets_settings(self._config)
        self._detector = SecretDetector(self._config, self._settings)
        self._trigger_action: GuardrailAction = resolve_action(
            cfg.get("action_on_trigger"),
            default=GuardrailAction.MODIFY,
            allowed=_SECRET_ALLOWED_ACTIONS,
        )
        self._custom_message: str | None = cfg.get("message")

    @property
    def name(self) -> str:
        """Return the guardrail registry name."""
        return "secret_leakage"

    async def check(self, ctx: GuardrailContext) -> GuardrailResult:
        """Detect and act on leaked secrets in the content."""
        matches = self._detector.find_all(ctx.content)

        if not matches:
            return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

        match_types = sorted({m.type for m in matches})
        total = len(matches)
        logger.warning(
            "Secret leakage detected",
            secret_count=total,
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
                or f"Blocked content containing {total} leaked secret(s).",
                details=details,
            )

        if self._trigger_action == GuardrailAction.WARN:
            return GuardrailResult(
                action=GuardrailAction.WARN,
                guardrail_name=self.name,
                message=self._custom_message
                or f"Detected {total} leaked secret(s) (allowed with warning).",
                details=details,
            )

        return GuardrailResult(
            action=GuardrailAction.MODIFY,
            guardrail_name=self.name,
            message=self._custom_message or f"Redacted {total} leaked secret(s).",
            modified_content=self._detector.redact(ctx.content, matches),
            details=details,
        )
