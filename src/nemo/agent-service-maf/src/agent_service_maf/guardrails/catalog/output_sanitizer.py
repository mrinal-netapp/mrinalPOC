"""Output sanitization guardrail — HTML escaping + unsafe-URL detection (Task 003 #3).

Output-phase guardrail using **only the standard library**:

- HTML: :func:`html.escape` neutralizes markup (XSS) when ``sanitize_html`` is on.
- URLs: :mod:`urllib.parse` + :mod:`ipaddress` flag URLs with a disallowed scheme
  (e.g. ``javascript:``, ``data:``, ``file:``) or an SSRF target (private /
  loopback / link-local host, including cloud-metadata ``169.254.169.254``).

No external dependencies, no ML. Domain allowlisting and URL reachability are out
of scope. Action ``modify`` (default ``warn``) escapes HTML and replaces unsafe
URLs with ``[URL_REMOVED]``.
"""

from __future__ import annotations

import html
import ipaddress
import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

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

_SANITIZER_ALLOWED_ACTIONS = frozenset(
    {GuardrailAction.WARN, GuardrailAction.MODIFY, GuardrailAction.BLOCK}
)

_URL_PLACEHOLDER = "[URL_REMOVED]"
_DEFAULT_SCHEMES = ["http", "https", "mailto"]

#: Detects HTML special characters / tags.
_HTML_RE = re.compile(r"[<>]|&[a-zA-Z#0-9]+;")

#: Extracts URL-ish tokens (scheme://... or scheme:...) plus bare-scheme payloads.
_URL_RE = re.compile(r"\b[a-zA-Z][a-zA-Z0-9+.\-]*:(?://)?[^\s<>\"')]+", re.IGNORECASE)


@dataclass
class SanitizerConfig:
    """Resolved output-sanitizer configuration."""

    sanitize_html: bool = True
    check_urls: bool = True
    allowed_schemes: list[str] = field(default_factory=lambda: list(_DEFAULT_SCHEMES))
    block_private_ips: bool = True

    @classmethod
    def from_dict(cls, config: dict[str, Any]) -> SanitizerConfig:
        """Build from a config dict."""
        schemes = config.get("allowed_schemes", _DEFAULT_SCHEMES)
        return cls(
            sanitize_html=bool(config.get("sanitize_html", True)),
            check_urls=bool(config.get("check_urls", True)),
            allowed_schemes=[str(s).lower() for s in schemes],
            block_private_ips=bool(config.get("block_private_ips", True)),
        )


def _is_unsafe_url(url: str, allowed_schemes: list[str], block_private_ips: bool) -> bool:
    """Return ``True`` if a URL has a disallowed scheme or an SSRF/private host."""
    try:
        parsed = urlparse(url)
    except ValueError:
        return True
    scheme = (parsed.scheme or "").lower()
    if scheme and scheme not in allowed_schemes:
        return True

    if block_private_ips:
        host = (parsed.hostname or "").lower()
        if host in {"localhost", "ip6-localhost"}:
            return True
        try:
            ip = ipaddress.ip_address(host)
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                return True
        except ValueError:
            # Not a literal IP — hostname allowlisting is out of scope, so allow.
            pass
    return False


@GuardrailRegistry.register_output("output_sanitizer")
class OutputSanitizer(OutputGuardrail):
    r"""Escapes unsafe HTML and flags/neutralizes unsafe URLs in agent output.

    Args:
        config: Optional config dict. Recognised keys: ``sanitize_html`` (bool,
            default ``True``), ``check_urls`` (bool, default ``True``),
            ``allowed_schemes`` (list, default ``["http","https","mailto"]``),
            ``block_private_ips`` (bool, default ``True``); plus
            ``action_on_trigger`` / ``message`` (merged by registry).
    """

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        cfg = config or {}
        self._config = SanitizerConfig.from_dict(cfg)
        self._trigger_action: GuardrailAction = resolve_action(
            cfg.get("action_on_trigger"),
            default=GuardrailAction.WARN,
            allowed=_SANITIZER_ALLOWED_ACTIONS,
        )
        self._custom_message: str | None = cfg.get("message")

    @property
    def name(self) -> str:
        """Return the guardrail registry name."""
        return "output_sanitizer"

    async def check(self, ctx: GuardrailContext) -> GuardrailResult:
        """Detect unsafe HTML/URLs and act per ``action_on_trigger``."""
        content = ctx.content
        html_found = bool(self._config.sanitize_html and _HTML_RE.search(content))

        unsafe_urls: list[str] = []
        if self._config.check_urls:
            unsafe_urls = [
                m.group(0)
                for m in _URL_RE.finditer(content)
                if _is_unsafe_url(
                    m.group(0), self._config.allowed_schemes, self._config.block_private_ips
                )
            ]

        if not html_found and not unsafe_urls:
            return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

        logger.warning(
            "Output sanitization triggered",
            html_found=html_found,
            unsafe_url_count=len(unsafe_urls),
            action=self._trigger_action.value,
            guardrail_type=ctx.guardrail_type,
            agent_id=ctx.agent_id,
            correlation_id=ctx.correlation_id,
        )
        details = {"html_found": html_found, "unsafe_url_count": len(unsafe_urls)}

        if self._trigger_action == GuardrailAction.WARN:
            return GuardrailResult(
                action=GuardrailAction.WARN,
                guardrail_name=self.name,
                message=self._custom_message
                or "Output contains unsafe HTML or URLs (allowed with warning).",
                details=details,
            )

        if self._trigger_action == GuardrailAction.MODIFY:
            sanitized = content
            for url in unsafe_urls:
                sanitized = sanitized.replace(url, _URL_PLACEHOLDER)
            if self._config.sanitize_html:
                sanitized = html.escape(sanitized)
            return GuardrailResult(
                action=GuardrailAction.MODIFY,
                guardrail_name=self.name,
                message=self._custom_message or "Sanitized unsafe HTML / URLs in output.",
                modified_content=sanitized,
                details=details,
            )

        return GuardrailResult(
            action=GuardrailAction.BLOCK,
            guardrail_name=self.name,
            message=self._custom_message or "Output blocked: contains unsafe HTML or URLs.",
            details=details,
        )
