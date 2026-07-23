"""Unit tests for SafeErrorFormatter.

Tests cover:
- format_error() production mode returns generic message
- format_error() production mode omits stack traces
- format_error() dev mode returns redacted message
- format_error() dev mode includes traceback field
- format_error() includes correlation_id in output
- format_error() returns correct error_type mapping
- redact_sensitive_data() removes Anthropic API keys
- redact_sensitive_data() removes OpenAI API keys
- redact_sensitive_data() removes AWS keys
- redact_sensitive_data() removes GitHub tokens
- redact_sensitive_data() removes JWT tokens
- redact_sensitive_data() removes Bearer tokens
- redact_sensitive_data() removes Unix file paths
- redact_sensitive_data() removes Windows file paths
- redact_sensitive_data() removes SQL connection strings
- redact_sensitive_data() removes JSON key-value secret patterns
- redact_sensitive_data() leaves non-sensitive text unchanged
- _get_production_message() returns appropriate messages per exception type
- AuthenticationError, ValidationError, etc. use safe production messages
"""

from __future__ import annotations

from agent_service_maf.core.exceptions import (
    AgentFrameworkError,
    AgentInvocationError,
    AuthenticationError,
    FrameworkNotFoundError,
    RateLimitError,
    SessionNotFoundError,
    StreamingError,
    ValidationError,
)
from agent_service_maf.interface_layer.error_formatter import SafeErrorFormatter

# ---------------------------------------------------------------------------
# format_error() production mode
# ---------------------------------------------------------------------------


class TestFormatErrorProductionMode:
    """Tests for SafeErrorFormatter.format_error() in production mode (is_dev=False)."""

    def test_returns_dict_with_required_keys(self) -> None:
        """format_error() returns a dict with error, error_type, details, correlation_id."""
        exc = AgentFrameworkError("Test error")
        result = SafeErrorFormatter.format_error(exc, is_dev=False)
        for key in ("error", "error_type", "details", "correlation_id"):
            assert key in result, f"Expected '{key}' key in format_error() result"

    def test_production_mode_generic_message(self) -> None:
        """Production mode returns generic message, not internal details."""
        exc = AgentInvocationError("INTERNAL: API key sk-ant-key123 failed at /home/user/secret.py")
        result = SafeErrorFormatter.format_error(exc, is_dev=False)
        # Should not contain the original message
        assert "sk-ant-key123" not in result["error"], (
            "Expected API key to be scrubbed from production error"
        )
        assert "/home/user" not in result["error"], (
            "Expected file path to be scrubbed from production error"
        )

    def test_production_mode_empty_details(self) -> None:
        """Production mode returns empty details dict."""
        exc = AgentFrameworkError("Error", details={"secret_key": "sk-abc"})
        result = SafeErrorFormatter.format_error(exc, is_dev=False)
        assert result["details"] == {}, (
            f"Expected empty details in production mode, got {result['details']}"
        )

    def test_production_mode_no_traceback(self) -> None:
        """Production mode does not include traceback in any field."""
        exc = ValueError("Something went wrong")
        result = SafeErrorFormatter.format_error(exc, is_dev=False)
        result_str = str(result)
        assert "Traceback" not in result_str, "Expected no traceback in production mode"

    def test_correlation_id_included(self) -> None:
        """format_error() includes the provided correlation_id."""
        exc = AgentFrameworkError("Error")
        corr_id = "test-correlation-id"
        result = SafeErrorFormatter.format_error(exc, is_dev=False, correlation_id=corr_id)
        assert result["correlation_id"] == corr_id, (
            f"Expected correlation_id={corr_id!r}, got {result['correlation_id']!r}"
        )

    def test_empty_correlation_id_accepted(self) -> None:
        """format_error() accepts empty correlation_id."""
        exc = AgentFrameworkError("Error")
        result = SafeErrorFormatter.format_error(exc, is_dev=False, correlation_id="")
        assert result["correlation_id"] == "", (
            f"Expected empty correlation_id, got {result['correlation_id']!r}"
        )

    def test_error_type_mapping_internal_error(self) -> None:
        """AgentFrameworkError maps to 'InternalError' in production."""
        exc = AgentFrameworkError("Error")
        result = SafeErrorFormatter.format_error(exc, is_dev=False)
        assert result["error_type"] == "InternalError", (
            f"Expected error_type='InternalError', got {result['error_type']!r}"
        )

    def test_error_type_mapping_known_exception(self) -> None:
        """Known exception types map to their safe names."""
        exc = FrameworkNotFoundError("Not found")
        result = SafeErrorFormatter.format_error(exc, is_dev=False)
        assert result["error_type"] == "FrameworkNotFoundError", (
            f"Expected 'FrameworkNotFoundError', got {result['error_type']!r}"
        )

    def test_unknown_exception_type_maps_to_internal_error(self) -> None:
        """Unknown exception types map to 'InternalError'."""
        exc = RuntimeError("Unknown error")
        result = SafeErrorFormatter.format_error(exc, is_dev=False)
        assert result["error_type"] == "InternalError", (
            f"Expected 'InternalError' for unknown type, got {result['error_type']!r}"
        )


# ---------------------------------------------------------------------------
# format_error() development mode
# ---------------------------------------------------------------------------


class TestFormatErrorDevMode:
    """Tests for SafeErrorFormatter.format_error() in development mode (is_dev=True)."""

    def test_dev_mode_returns_dict_with_required_keys(self) -> None:
        """Dev mode format_error() returns dict with required keys."""
        exc = AgentFrameworkError("Dev error")
        result = SafeErrorFormatter.format_error(exc, is_dev=True)
        for key in ("error", "error_type", "details", "correlation_id"):
            assert key in result, f"Expected '{key}' key in dev mode format_error() result"

    def test_dev_mode_includes_traceback_in_details(self) -> None:
        """Dev mode includes 'traceback' key in details dict."""
        exc = ValueError("Test value error")
        result = SafeErrorFormatter.format_error(exc, is_dev=True)
        assert "traceback" in result["details"], (
            f"Expected 'traceback' in details in dev mode, got keys: {list(result['details'].keys())}"
        )

    def test_dev_mode_redacts_secrets_from_message(self) -> None:
        """Dev mode still redacts sensitive patterns from the error message."""
        exc = ValueError("Key: sk-ant-api123456789012345678")
        result = SafeErrorFormatter.format_error(exc, is_dev=True)
        assert "sk-ant-api123456789012345678" not in result["error"], (
            "Expected Anthropic key to be redacted in dev mode message"
        )

    def test_dev_mode_redacts_paths_from_traceback(self) -> None:
        """Dev mode redacts file paths from the traceback."""
        try:
            raise ValueError("Error from /home/user/secret/config.py")
        except ValueError as exc:
            result = SafeErrorFormatter.format_error(exc, is_dev=True)
        # Traceback may contain workspace path - that should be redacted
        # The error message path should be redacted
        assert "/home/user/secret/config.py" not in result["details"].get("traceback", ""), (
            "Expected file path to be redacted from traceback in dev mode"
        )

    def test_dev_mode_includes_framework_error_details(self) -> None:
        """Dev mode includes sanitized details from AgentFrameworkError.details."""
        exc = AgentInvocationError(
            "Invocation failed",
            details={"agent_id": "echo", "framework": "example"},
        )
        result = SafeErrorFormatter.format_error(exc, is_dev=True)
        assert "agent_id" in result["details"], (
            "Expected agent_id to be included in dev mode details"
        )

    def test_dev_mode_truncates_large_traceback(self) -> None:
        """Dev mode truncates stack traces longer than 4096 chars."""
        # Create an exception with a very large message to force a long traceback
        exc = ValueError("x" * 5000)
        result = SafeErrorFormatter.format_error(exc, is_dev=True)
        tb = result["details"].get("traceback", "")
        assert len(tb) <= 4096 + len("\n... [truncated]"), (
            f"Expected traceback <= 4096 + truncation marker, got {len(tb)} chars"
        )

    def test_dev_mode_message_is_not_generic(self) -> None:
        """Dev mode returns the actual (redacted) message, not the generic one."""
        exc = ValueError("Very specific error: field X is invalid")
        result = SafeErrorFormatter.format_error(exc, is_dev=True)
        assert (
            "specific error" in result["error"].lower() or "field x" in result["error"].lower()
        ), f"Expected specific message in dev mode, got {result['error']!r}"


# ---------------------------------------------------------------------------
# redact_sensitive_data() tests
# ---------------------------------------------------------------------------


class TestRedactSensitiveData:
    """Tests for SafeErrorFormatter.redact_sensitive_data()."""

    def test_anthropic_key_redacted(self) -> None:
        """Anthropic API keys (sk-ant-...) are redacted."""
        text = "Key is sk-ant-api03-abcdefghij1234567890"
        result = SafeErrorFormatter.redact_sensitive_data(text)
        assert "sk-ant-api03-abcdefghij1234567890" not in result, (
            "Expected Anthropic key to be redacted"
        )
        assert "[REDACTED" in result, f"Expected redaction marker in result: {result!r}"

    def test_openai_key_redacted(self) -> None:
        """OpenAI API keys (sk-...) are redacted."""
        text = "API key: sk-abcdefghij1234567890abcdefgh"
        result = SafeErrorFormatter.redact_sensitive_data(text)
        assert "sk-abcdefghij1234567890abcdefgh" not in result, "Expected OpenAI key to be redacted"

    def test_aws_access_key_redacted(self) -> None:
        """AWS access keys (AKIA + exactly 16 uppercase alphanumeric) are redacted."""
        # AWS access key format: AKIA + 16 uppercase alphanumeric chars (word boundary required)
        aws_key = "AKIAABCDEFGH12345678"  # AKIA + 16 chars = valid pattern
        text = f"AWS key: {aws_key}"
        result = SafeErrorFormatter.redact_sensitive_data(text)
        assert aws_key not in result, (
            f"Expected AWS key '{aws_key}' to be redacted, got: {result!r}"
        )

    def test_github_token_redacted(self) -> None:
        """GitHub personal access tokens (ghp_ + exactly 36 alphanumeric) are redacted."""
        # GitHub PAT format: ghp_ + 36 alphanumeric characters
        ghp_token = "ghp_" + "A" * 36  # ghp_ + exactly 36 chars
        text = f"Token: {ghp_token}"
        result = SafeErrorFormatter.redact_sensitive_data(text)
        assert ghp_token not in result, f"Expected GitHub token to be redacted, got: {result!r}"

    def test_bearer_token_redacted(self) -> None:
        """Bearer tokens are redacted."""
        text = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
        result = SafeErrorFormatter.redact_sensitive_data(text)
        assert "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" not in result, (
            "Expected Bearer token to be redacted"
        )

    def test_jwt_token_redacted(self) -> None:
        """JWT tokens (three dot-separated base64url parts, starting with eyJ) are redacted."""
        # Realistic JWT format: eyJ<header>.<payload>.<signature> (all base64url)
        # Pattern: \beyJ + 20+ base64url chars, then a dot, then more base64url, then a dot
        jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        text = f"Token: {jwt}"
        result = SafeErrorFormatter.redact_sensitive_data(text)
        assert jwt not in result, f"Expected JWT to be redacted, got: {result!r}"

    def test_unix_path_redacted(self) -> None:
        """Unix absolute file paths are redacted."""
        text = "Config at /home/user/project/config.py"
        result = SafeErrorFormatter.redact_sensitive_data(text)
        assert "/home/user/project/config.py" not in result, "Expected Unix path to be redacted"

    def test_var_path_redacted(self) -> None:
        """Unix /var paths are redacted."""
        text = "Log at /var/log/agent/error.log"
        result = SafeErrorFormatter.redact_sensitive_data(text)
        assert "/var/log/agent/error.log" not in result, "Expected /var path to be redacted"

    def test_workspace_path_redacted(self) -> None:
        """Unix /workspace paths are redacted."""
        text = "File: /workspace/src/agent_service_maf/config.py"
        result = SafeErrorFormatter.redact_sensitive_data(text)
        assert "/workspace/src" not in result, "Expected /workspace path to be redacted"

    def test_windows_path_redacted(self) -> None:
        """Windows absolute file paths are redacted."""
        text = r"Config at C:\Users\user\project\config.py"
        result = SafeErrorFormatter.redact_sensitive_data(text)
        assert r"C:\Users\user\project\config.py" not in result, (
            "Expected Windows path to be redacted"
        )

    def test_postgresql_connection_string_redacted(self) -> None:
        """PostgreSQL connection strings are redacted."""
        text = "DB: postgresql://user:password@localhost:5432/mydb"
        result = SafeErrorFormatter.redact_sensitive_data(text)
        assert "postgresql://user:password" not in result, (
            "Expected PostgreSQL connection string to be redacted"
        )

    def test_mysql_connection_string_redacted(self) -> None:
        """MySQL connection strings are redacted."""
        text = "DB: mysql://user:pass@host/db"
        result = SafeErrorFormatter.redact_sensitive_data(text)
        assert "mysql://user:pass" not in result, "Expected MySQL connection string to be redacted"

    def test_json_api_key_field_redacted(self) -> None:
        """JSON-style api_key fields are redacted."""
        text = '{"api_key": "my-secret-key-here"}'
        result = SafeErrorFormatter.redact_sensitive_data(text)
        assert "my-secret-key-here" not in result, "Expected api_key value to be redacted"

    def test_json_password_field_redacted(self) -> None:
        """JSON-style password fields are redacted."""
        text = '{"password": "supersecret123"}'
        result = SafeErrorFormatter.redact_sensitive_data(text)
        assert "supersecret123" not in result, "Expected password value to be redacted"

    def test_non_sensitive_text_unchanged(self) -> None:
        """Non-sensitive text is returned unchanged."""
        text = "Agent 'echo' returned output: Hello, world!"
        result = SafeErrorFormatter.redact_sensitive_data(text)
        assert result == text, f"Expected non-sensitive text unchanged, got {result!r}"

    def test_empty_string_unchanged(self) -> None:
        """Empty string is returned unchanged."""
        result = SafeErrorFormatter.redact_sensitive_data("")
        assert result == "", f"Expected empty string unchanged, got {result!r}"

    def test_multiple_patterns_in_same_string(self) -> None:
        """Multiple sensitive patterns in the same string are all redacted."""
        text = "Key sk-abcdefghijklmnopqrstuvwxyz at /home/user/app.py"
        result = SafeErrorFormatter.redact_sensitive_data(text)
        assert "sk-abcdefghijklmnopqrstuvwxyz" not in result, "Expected API key to be redacted"
        assert "/home/user/app.py" not in result, "Expected path to be redacted"


# ---------------------------------------------------------------------------
# _get_production_message() tests
# ---------------------------------------------------------------------------


class TestGetProductionMessage:
    """Tests for SafeErrorFormatter._get_production_message()."""

    def test_authentication_error_message(self) -> None:
        """AuthenticationError returns safe authentication message."""
        exc = AuthenticationError("Invalid key sk-secret-1234567890")
        result = SafeErrorFormatter.format_error(exc, is_dev=False)
        assert (
            "authentication" in result["error"].lower() or "credential" in result["error"].lower()
        ), f"Expected auth-related message, got: {result['error']!r}"
        assert "sk-secret-1234567890" not in result["error"], (
            "Expected API key to be scrubbed from auth error"
        )

    def test_validation_error_uses_original_message(self) -> None:
        """ValidationError returns the actual (safe) validation message."""
        exc = ValidationError("Input exceeds maximum length of 10000 characters.")
        result = SafeErrorFormatter.format_error(exc, is_dev=False)
        # ValidationError messages are safe to expose
        assert (
            "10000" in result["error"]
            or "exceed" in result["error"].lower()
            or "length" in result["error"].lower()
        ), f"Expected validation message to be preserved, got: {result['error']!r}"

    def test_rate_limit_error_message(self) -> None:
        """RateLimitError returns safe rate limit message."""
        exc = RateLimitError("Rate limit exceeded at 100 RPM")
        result = SafeErrorFormatter.format_error(exc, is_dev=False)
        assert "rate limit" in result["error"].lower(), (
            f"Expected 'rate limit' in message, got: {result['error']!r}"
        )

    def test_session_not_found_error_message(self) -> None:
        """SessionNotFoundError returns safe session message."""
        exc = SessionNotFoundError("Session xyz not found")
        result = SafeErrorFormatter.format_error(exc, is_dev=False)
        assert "session" in result["error"].lower(), (
            f"Expected 'session' in message, got: {result['error']!r}"
        )

    def test_streaming_error_message(self) -> None:
        """StreamingError returns safe streaming message."""
        exc = StreamingError("Stream exceeded max duration")
        result = SafeErrorFormatter.format_error(exc, is_dev=False)
        assert "stream" in result["error"].lower(), (
            f"Expected 'stream' in message, got: {result['error']!r}"
        )

    def test_generic_error_uses_safe_message(self) -> None:
        """Generic exceptions return a safe, generic message."""
        exc = RuntimeError("Internal database connection failed at /etc/db/config")
        result = SafeErrorFormatter.format_error(exc, is_dev=False)
        assert "internal error" in result["error"].lower() or "retry" in result["error"].lower(), (
            f"Expected generic safe message, got: {result['error']!r}"
        )

    def test_framework_not_found_exposes_names(self) -> None:
        """FrameworkNotFoundError message (with framework names) is safe to expose."""
        exc = FrameworkNotFoundError(
            "Framework 'unknown' not registered. Available: ['echo', 'semantic_kernel'].",
            details={"requested": "unknown", "available": ["echo", "semantic_kernel"]},
        )
        result = SafeErrorFormatter.format_error(exc, is_dev=False)
        # Framework names are safe to expose
        assert "unknown" in result["error"] or "registered" in result["error"].lower(), (
            f"Expected framework info in message, got: {result['error']!r}"
        )
