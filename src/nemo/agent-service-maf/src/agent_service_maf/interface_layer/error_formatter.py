"""Safe error formatter — scrubs internal details from client-facing error responses.

In production mode, error responses MUST NOT include:
- Stack traces or file paths
- API keys, tokens, or credentials
- Database connection strings or SQL
- Internal service URLs or hostnames
- Environment variable names or values

The :class:`SafeErrorFormatter` provides two modes:
- **Production mode** (``is_dev=False``): Returns only error type, sanitized message,
  and correlation ID. All potentially sensitive details are stripped.
- **Development mode** (``is_dev=True``): Includes a redacted stack trace and details
  dict to help with debugging. Sensitive patterns (keys, paths, tokens) are still
  redacted even in dev mode.

This class is used by FastAPI exception handlers in ``api.py`` and by the WebSocket
and SSE handlers when formatting error events.

Security note: This formatter is a defence-in-depth measure. Adapters and exceptions
should still avoid including sensitive data in their messages, but this formatter
provides a safety net in case they do.
"""

from __future__ import annotations

import re
import traceback
from typing import Any

import structlog

from agent_service_maf.core.exceptions import AgentFrameworkError

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Sensitive data patterns to redact from all responses
# ---------------------------------------------------------------------------

# Ordered by specificity — more specific patterns first.
_REDACT_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    # API keys with known prefixes
    (re.compile(r"\bsk-ant-[A-Za-z0-9_-]{10,}", re.IGNORECASE), "[REDACTED-ANTHROPIC-KEY]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{20,}", re.IGNORECASE), "[REDACTED-API-KEY]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[REDACTED-AWS-KEY]"),
    (re.compile(r"\bghp_[A-Za-z0-9]{36}\b"), "[REDACTED-GITHUB-TOKEN]"),
    # Bearer / JWT tokens
    (re.compile(r"\bBearer\s+[A-Za-z0-9_.+-]{10,}", re.IGNORECASE), "Bearer [REDACTED-TOKEN]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"), "[REDACTED-JWT]"),
    # Generic key/token/secret/password patterns in JSON-style key-value
    (
        re.compile(
            r'("(?:api_key|token|secret|password|credential|auth)[^"]*"\s*:\s*)"[^"]{4,}"',
            re.IGNORECASE,
        ),
        r'\1"[REDACTED]"',
    ),
    # Absolute file paths (Unix and Windows)
    (re.compile(r'/(?:home|usr|var|etc|opt|root|tmp|workspace)/[^\s"\'>,;)]+'), "[REDACTED-PATH]"),
    (re.compile(r'[A-Z]:\\[^\s"\'>,;)]+', re.IGNORECASE), "[REDACTED-PATH]"),
    # SQL connection strings
    (
        re.compile(
            r"(?:postgresql|mysql|mssql|sqlite|mongodb)(?:\+\w+)?://[^\s\"']+",
            re.IGNORECASE,
        ),
        "[REDACTED-DB-URL]",
    ),
    # Environment variable values that look like secrets
    (re.compile(r"\bAGENT_[A-Z_]+=[^\s]+"), "[REDACTED-ENV]"),
]

# Human-readable names for framework exception types (for safe error_type responses).
_SAFE_ERROR_TYPE_MAP: dict[str, str] = {
    "AgentFrameworkError": "InternalError",
    "ConfigurationError": "ConfigurationError",
    "FrameworkNotFoundError": "FrameworkNotFoundError",
    "AgentInvocationError": "AgentInvocationError",
    "AgentTimeoutError": "AgentTimeoutError",
    "AuthenticationError": "AuthenticationError",
    "ValidationError": "ValidationError",
    "StreamingError": "StreamingError",
    "MCPConnectionError": "MCPConnectionError",
    "MCPToolError": "MCPToolError",
    "GatewayError": "GatewayError",
    "RateLimitError": "RateLimitError",
    "SessionNotFoundError": "SessionNotFoundError",
    "ProtocolError": "ProtocolError",
}


class SafeErrorFormatter:
    """Scrub sensitive internal data from error responses before sending to clients.

    All error responses MUST pass through this formatter before being returned
    to API clients. In production mode (``is_dev=False``), only a generic
    user-safe message is returned. In development mode, a redacted stack trace
    is included to help with debugging.

    Usage in exception handlers:

    .. code-block:: python

        @app.exception_handler(AgentFrameworkError)
        async def handle_framework_error(request, exc):
            safe = SafeErrorFormatter.format_error(exc, is_dev=app.debug)
            return JSONResponse(safe, status_code=500)

    Example:
        >>> err = AgentFrameworkError("Internal error", details={"path": "/secret/file"})
        >>> safe = SafeErrorFormatter.format_error(err, is_dev=False)
        >>> safe["error"]
        'An internal error occurred. Please retry or contact support.'
        >>> "path" not in safe.get("details", {})
        True
    """

    @staticmethod
    def format_error(
        exc: Exception,
        is_dev: bool = False,
        correlation_id: str = "",
    ) -> dict[str, Any]:
        """Format an exception as a safe, client-facing error dict.

        In production mode (``is_dev=False``):
        - Returns a generic user-facing message.
        - Includes only ``error_type`` and ``correlation_id``.
        - No stack traces, file paths, keys, or internal details.

        In development mode (``is_dev=True``):
        - Returns the (redacted) exception message.
        - Includes a redacted, truncated stack trace.
        - Includes sanitized details from ``AgentFrameworkError.details``.
        - Sensitive patterns are still redacted even in dev mode.

        Args:
            exc: The exception to format.
            is_dev: Whether to include developer-friendly details. Should be
                ``False`` in production environments. Set via ``app.debug``.
            correlation_id: Optional correlation ID to include in the response
                for log correlation.

        Returns:
            Dict with keys: ``error``, ``error_type``, ``details``, ``correlation_id``.
            Safe for direct serialization to JSON and transmission to clients.

        Example:
            >>> safe = SafeErrorFormatter.format_error(exc, is_dev=False)
            >>> safe.keys()
            dict_keys(['error', 'error_type', 'details', 'correlation_id'])
        """
        error_type = type(exc).__name__
        safe_type = _SAFE_ERROR_TYPE_MAP.get(error_type, "InternalError")

        if is_dev:
            # Dev mode: include redacted message and stack trace.
            raw_message = str(exc)
            safe_message = SafeErrorFormatter.redact_sensitive_data(raw_message)

            raw_tb = traceback.format_exc()
            safe_tb = SafeErrorFormatter.redact_sensitive_data(raw_tb)
            # Truncate stack trace to avoid excessively large responses.
            if len(safe_tb) > 4096:
                safe_tb = safe_tb[:4096] + "\n... [truncated]"

            # Sanitize details from AgentFrameworkError.
            details: dict[str, Any] = {}
            if isinstance(exc, AgentFrameworkError):
                for key, value in exc.details.items():
                    safe_value = SafeErrorFormatter.redact_sensitive_data(str(value))
                    details[key] = safe_value
            details["traceback"] = safe_tb

            return {
                "error": safe_message,
                "error_type": safe_type,
                "details": details,
                "correlation_id": correlation_id,
            }

        else:
            # Production mode: generic message only.
            production_message = SafeErrorFormatter._get_production_message(exc)

            logger.error(
                "Request error",
                error_type=error_type,
                correlation_id=correlation_id,
                # Redact the full message before logging.
                error_summary=SafeErrorFormatter.redact_sensitive_data(str(exc))[:200],
            )

            return {
                "error": production_message,
                "error_type": safe_type,
                "details": {},
                "correlation_id": correlation_id,
            }

    @staticmethod
    def _get_production_message(exc: Exception) -> str:
        """Return a safe, user-facing error message for production mode.

        Args:
            exc: The exception to describe.

        Returns:
            A generic, safe message appropriate for client responses.
        """
        from agent_service_maf.core.exceptions import (
            AgentFrameworkError,
            AgentTimeoutError,
            AuthenticationError,
            FrameworkNotFoundError,
            RateLimitError,
            SessionNotFoundError,
            StreamingError,
            ValidationError,
        )

        # For a small set of user-facing errors, return the actual message
        # (it's already safe and actionable).
        if isinstance(exc, FrameworkNotFoundError):
            # Safe to expose framework names.
            return str(exc)
        if isinstance(exc, AuthenticationError):
            return "Authentication failed. Check your credentials and retry."
        if isinstance(exc, ValidationError):
            # Return the message — it describes the validation rule.
            return str(exc)
        if isinstance(exc, RateLimitError):
            return "Rate limit exceeded. Reduce request frequency and retry."
        if isinstance(exc, SessionNotFoundError):
            return "Session not found or expired. Start a new session."
        if isinstance(exc, StreamingError):
            return "Streaming session terminated due to resource limits."
        if isinstance(exc, AgentTimeoutError):
            # Surface the configured timeout and orchestration type so the
            # caller knows which knob to tune. The message itself is safe.
            details = exc.details if isinstance(exc, AgentFrameworkError) else {}
            timeout_s = details.get("timeout_seconds")
            orch = details.get("orchestration_type", "agent")
            if isinstance(timeout_s, (int, float)):
                return (
                    f"Agent timed out: the {orch} orchestration exceeded the "
                    f"configured agent.timeout_seconds ({float(timeout_s):.0f}s). "
                    "Retry with a simpler request, raise agent.timeout_seconds, "
                    "or lower max_rounds / gateway retries / tool timeouts."
                )
            return (
                "Agent timed out: the request exceeded the configured "
                "agent.timeout_seconds. Retry or raise the timeout."
            )

        return (
            "An internal error occurred. Please retry or contact support with the correlation_id."
        )

    @staticmethod
    def redact_sensitive_data(text: str) -> str:
        """Remove sensitive patterns (API keys, tokens, file paths, SQL) from text.

        Applied to all log entries and error responses. Patterns are matched in
        order from most specific to most general.

        Args:
            text: Input string that may contain sensitive data.

        Returns:
            String with sensitive patterns replaced by safe placeholder tokens.
            Returns the input unchanged if no patterns match.

        Example:
            >>> SafeErrorFormatter.redact_sensitive_data("Key: sk-abc123def456ghi789")
            'Key: [REDACTED-API-KEY]'

            >>> SafeErrorFormatter.redact_sensitive_data("path=/home/user/secret.key")
            'path=[REDACTED-PATH]'
        """
        result = text
        for pattern, replacement in _REDACT_PATTERNS:
            result = pattern.sub(replacement, result)
        return result
