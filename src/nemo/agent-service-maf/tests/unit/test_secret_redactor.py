"""Unit tests for SecretRedactor structlog processor.

Tests cover all secret pattern detection, nested structure traversal,
and the structlog processor interface.
"""

from __future__ import annotations

from agent_service_maf.gateway.secret_redactor import SecretRedactor, _redact_string, _redact_value

# ---------------------------------------------------------------------------
# _redact_string — pattern coverage
# ---------------------------------------------------------------------------


class TestRedactStringAnthropicKeys:
    """Tests for Anthropic sk-ant- key masking."""

    def test_redact_string_anthropic_key_masked(self) -> None:
        value = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcd"
        result = _redact_string(value)
        assert result == "sk-ant-***", (
            f"Expected Anthropic key to be masked to 'sk-ant-***', got '{result}'"
        )

    def test_redact_string_anthropic_key_in_sentence(self) -> None:
        value = "My key is sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcd, keep it safe"
        result = _redact_string(value)
        assert "sk-ant-***" in result, "Expected Anthropic key embedded in sentence to be masked"
        assert "sk-ant-api03-" not in result, (
            "Raw Anthropic key should not appear in redacted output"
        )

    def test_redact_string_anthropic_key_short_not_masked(self) -> None:
        # 19 chars after sk-ant- — below the 20-char minimum
        value = "sk-ant-SHORT1234567"
        result = _redact_string(value)
        assert result == value, (
            f"Short sk-ant- string (below 20 chars) should NOT be masked, got '{result}'"
        )

    def test_redact_string_anthropic_key_exactly_20_chars_masked(self) -> None:
        # Exactly 20 chars after the prefix "sk-ant-"
        value = "sk-ant-" + "A" * 20
        result = _redact_string(value)
        assert result == "sk-ant-***", (
            "Anthropic key with exactly 20 trailing chars should be masked"
        )


class TestRedactStringOpenAIKeys:
    """Tests for OpenAI-style sk- key masking."""

    def test_redact_string_openai_key_masked(self) -> None:
        value = "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"
        result = _redact_string(value)
        assert result == "sk-***", f"Expected OpenAI key to be masked to 'sk-***', got '{result}'"

    def test_redact_string_openai_key_short_not_masked(self) -> None:
        # Only 5 alphanumeric chars after sk-
        value = "sk-SHORT"
        result = _redact_string(value)
        assert result == value, (
            f"Short sk- string (below 20 chars) should NOT be masked, got '{result}'"
        )

    def test_redact_string_openai_key_exactly_20_chars_masked(self) -> None:
        value = "sk-" + "A" * 20
        result = _redact_string(value)
        assert result == "sk-***", "OpenAI key with exactly 20 trailing chars should be masked"

    def test_redact_string_openai_key_in_json_context(self) -> None:
        value = '{"api_key": "sk-abcdefghijklmnopqrstuvwxyz1234"}'
        result = _redact_string(value)
        assert "sk-***" in result, "OpenAI key embedded in JSON-like string should be masked"


class TestRedactStringAWSKeys:
    """Tests for AWS AKIA access key masking."""

    def test_redact_string_aws_key_masked(self) -> None:
        value = "AKIAIOSFODNN7EXAMPLE"  # exactly AKIA + 16 chars
        result = _redact_string(value)
        assert result == "AKIA***", (
            f"Expected AWS AKIA key to be masked to 'AKIA***', got '{result}'"
        )

    def test_redact_string_aws_key_short_not_masked(self) -> None:
        # Only 15 chars after AKIA — should not match
        value = "AKIA123456789AB"
        result = _redact_string(value)
        assert result == value, "AWS key with fewer than 16 trailing chars should NOT be masked"

    def test_redact_string_aws_key_lowercase_not_masked(self) -> None:
        # AWS keys are uppercase; lowercase should not match
        value = "akiaiosfodnn7example"
        result = _redact_string(value)
        assert result == value, (
            "Lowercase AWS-like pattern should NOT be masked (pattern is case-sensitive)"
        )

    def test_redact_string_aws_key_embedded_in_log(self) -> None:
        value = "aws_access_key=AKIAIOSFODNN7EXAMPLE is my key"
        result = _redact_string(value)
        assert "AKIA***" in result, "AWS key embedded in a log line should be masked"
        assert "AKIAIOSFODNN7EXAMPLE" not in result, (
            "Raw AWS key should not appear in redacted output"
        )


class TestRedactStringGitHubTokens:
    """Tests for GitHub personal access token masking."""

    def test_redact_string_github_token_masked(self) -> None:
        value = "ghp_abcdefghijklmnopqrstuvwxyz1234"
        result = _redact_string(value)
        assert result == "ghp_***", (
            f"Expected GitHub token to be masked to 'ghp_***', got '{result}'"
        )

    def test_redact_string_github_token_short_not_masked(self) -> None:
        value = "ghp_SHORT"
        result = _redact_string(value)
        assert result == value, "Short ghp_ token (below 20 chars) should NOT be masked"

    def test_redact_string_github_token_exactly_20_chars_masked(self) -> None:
        value = "ghp_" + "a" * 20
        result = _redact_string(value)
        assert result == "ghp_***", "GitHub token with exactly 20 trailing chars should be masked"


class TestRedactStringBearerTokens:
    """Tests for HTTP Bearer token masking."""

    def test_redact_string_bearer_token_masked(self) -> None:
        value = "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
        result = _redact_string(value)
        assert result == "Bearer ***", (
            f"Expected Bearer token to be masked to 'Bearer ***', got '{result}'"
        )

    def test_redact_string_bearer_with_multiple_spaces_masked(self) -> None:
        # Pattern allows \s+ (one or more whitespace)
        value = "Bearer  eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
        result = _redact_string(value)
        assert result == "Bearer ***", "Bearer token with multiple spaces should still be masked"

    def test_redact_string_bearer_short_not_masked(self) -> None:
        # Token must be at least 10 chars
        value = "Bearer abc"
        result = _redact_string(value)
        assert result == value, "Bearer token shorter than 10 chars should NOT be masked"

    def test_redact_string_bearer_in_header(self) -> None:
        value = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
        result = _redact_string(value)
        assert "Bearer ***" in result, (
            "Bearer token in Authorization header string should be masked"
        )


class TestRedactStringJWTTokens:
    """Tests for JWT token masking (three dot-separated base64url segments)."""

    def test_redact_string_jwt_masked(self) -> None:
        # Valid JWT-like with each segment >= 10 chars
        value = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        result = _redact_string(value)
        assert result == "JWT-***", f"Expected JWT to be masked to 'JWT-***', got '{result}'"

    def test_redact_string_jwt_short_segment_not_masked(self) -> None:
        # One segment with fewer than 10 chars — should not match JWT pattern
        value = "short.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf"
        result = _redact_string(value)
        # "short" is only 5 chars, so the JWT pattern won't match this specific structure
        # but the middle and last segments might still be long enough - check pattern strictly
        assert "short." in result or result == value, (
            "JWT with a very short first segment should not be fully masked as JWT-***"
        )

    def test_redact_string_jwt_in_auth_header(self) -> None:
        jwt = (
            "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fw"
        )
        value = f"token={jwt}"
        result = _redact_string(value)
        assert "JWT-***" in result, "JWT token in a key=value context should be masked"


class TestRedactStringNonSecrets:
    """Tests that non-secret strings are not modified."""

    def test_redact_string_plain_text_unchanged(self) -> None:
        value = "This is a normal log message with no secrets"
        result = _redact_string(value)
        assert result == value, "Plain text without secrets should be returned unchanged"

    def test_redact_string_empty_string(self) -> None:
        result = _redact_string("")
        assert result == "", "Empty string should be returned unchanged"

    def test_redact_string_url_unchanged(self) -> None:
        value = "http://gateway.internal:4000/health"
        result = _redact_string(value)
        assert result == value, "Plain URL without secrets should be returned unchanged"

    def test_redact_string_model_name_unchanged(self) -> None:
        value = "anthropic/claude-sonnet-4-20250514"
        result = _redact_string(value)
        assert result == value, "Model name string should not be mistakenly redacted"

    def test_redact_string_numeric_unchanged(self) -> None:
        value = "42"
        result = _redact_string(value)
        assert result == value, "Numeric string should be returned unchanged"


# ---------------------------------------------------------------------------
# _redact_value — recursive structure traversal
# ---------------------------------------------------------------------------


class TestRedactValueRecursion:
    """Tests for recursive redaction of nested data structures."""

    def test_redact_value_string(self) -> None:
        result = _redact_value("sk-ant-api03-" + "A" * 20)
        assert result == "sk-ant-***", "String value with Anthropic key should be redacted"

    def test_redact_value_dict_shallow(self) -> None:
        data = {"api_key": "sk-ant-api03-" + "A" * 20, "model": "anthropic/claude"}
        result = _redact_value(data)
        assert isinstance(result, dict), "Result should be a dict"
        assert result["api_key"] == "sk-ant-***", (
            "Dict value containing Anthropic key should be redacted"
        )
        assert result["model"] == "anthropic/claude", "Non-secret dict values should be unchanged"

    def test_redact_value_dict_nested(self) -> None:
        data = {"config": {"auth": {"token": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"}}}
        result = _redact_value(data)
        assert isinstance(result, dict), "Result should be a dict"
        token = result["config"]["auth"]["token"]  # type: ignore[index]
        assert token == "Bearer ***", (
            f"Deeply nested Bearer token should be redacted, got '{token}'"
        )

    def test_redact_value_list(self) -> None:
        data = ["sk-" + "A" * 20, "safe text", "AKIAIOSFODNN7EXAMPLE"]
        result = _redact_value(data)
        assert isinstance(result, list), "Result should be a list"
        assert result[0] == "sk-***", "OpenAI key in list should be redacted"
        assert result[1] == "safe text", "Non-secret list item should be unchanged"
        assert result[2] == "AKIA***", "AWS key in list should be redacted"

    def test_redact_value_tuple(self) -> None:
        data = ("ghp_" + "a" * 20, "safe")
        result = _redact_value(data)
        assert isinstance(result, tuple), "Result should be a tuple"
        assert result[0] == "ghp_***", "GitHub token in tuple should be redacted"
        assert result[1] == "safe", "Non-secret tuple item should be unchanged"

    def test_redact_value_list_of_dicts(self) -> None:
        data = [
            {"key": "sk-ant-api03-" + "A" * 20},
            {"msg": "hello"},
        ]
        result = _redact_value(data)
        assert isinstance(result, list), "Result should be a list"
        assert result[0]["key"] == "sk-ant-***", (  # type: ignore[index]
            "Anthropic key inside list-of-dicts should be redacted"
        )
        assert result[1]["msg"] == "hello", (  # type: ignore[index]
            "Non-secret value inside list-of-dicts should be unchanged"
        )

    def test_redact_value_integer_unchanged(self) -> None:
        result = _redact_value(42)
        assert result == 42, "Integer should be returned unchanged"

    def test_redact_value_none_unchanged(self) -> None:
        result = _redact_value(None)
        assert result is None, "None should be returned unchanged"

    def test_redact_value_float_unchanged(self) -> None:
        result = _redact_value(3.14)
        assert result == 3.14, "Float should be returned unchanged"

    def test_redact_value_bool_unchanged(self) -> None:
        result = _redact_value(True)
        assert result is True, "Bool should be returned unchanged"


# ---------------------------------------------------------------------------
# SecretRedactor — structlog processor interface
# ---------------------------------------------------------------------------


class TestSecretRedactorProcessor:
    """Tests for the SecretRedactor structlog processor callable interface."""

    def _call(self, event_dict: dict) -> dict:
        processor = SecretRedactor()
        return processor(logger=None, method_name="info", event_dict=event_dict)

    def test_processor_returns_event_dict(self) -> None:
        event_dict = {"event": "hello"}
        result = self._call(event_dict)
        assert isinstance(result, dict), "Processor should return a dict"
        assert result["event"] == "hello", "Non-secret event value should be unchanged"

    def test_processor_masks_anthropic_key_in_event(self) -> None:
        event_dict = {
            "event": "api_call",
            "api_key": "sk-ant-api03-" + "X" * 20,
        }
        result = self._call(event_dict)
        assert result["api_key"] == "sk-ant-***", (
            "Anthropic key in structlog event dict should be masked"
        )

    def test_processor_masks_openai_key_in_event(self) -> None:
        event_dict = {
            "event": "request",
            "key": "sk-" + "B" * 20,
        }
        result = self._call(event_dict)
        assert result["key"] == "sk-***", "OpenAI key in structlog event dict should be masked"

    def test_processor_masks_aws_key_in_event(self) -> None:
        event_dict = {"event": "aws", "access": "AKIAIOSFODNN7EXAMPLE"}
        result = self._call(event_dict)
        assert result["access"] == "AKIA***", "AWS key in structlog event dict should be masked"

    def test_processor_masks_github_token_in_event(self) -> None:
        event_dict = {"event": "gh", "token": "ghp_" + "c" * 20}
        result = self._call(event_dict)
        assert result["token"] == "ghp_***", "GitHub token in structlog event dict should be masked"

    def test_processor_masks_bearer_in_event(self) -> None:
        event_dict = {
            "event": "auth",
            "header": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
        }
        result = self._call(event_dict)
        assert result["header"] == "Bearer ***", (
            "Bearer token in structlog event dict should be masked"
        )

    def test_processor_masks_nested_dict_value(self) -> None:
        event_dict = {
            "event": "nested",
            "config": {"auth": {"key": "sk-ant-api03-" + "Y" * 20}},
        }
        result = self._call(event_dict)
        assert result["config"]["auth"]["key"] == "sk-ant-***", (  # type: ignore[index]
            "Anthropic key in nested structlog event dict should be masked"
        )

    def test_processor_masks_list_value(self) -> None:
        event_dict = {
            "event": "multi",
            "keys": ["sk-ant-api03-" + "Z" * 20, "safe-value"],
        }
        result = self._call(event_dict)
        assert result["keys"][0] == "sk-ant-***", (  # type: ignore[index]
            "Anthropic key in list within event dict should be masked"
        )
        assert result["keys"][1] == "safe-value", (  # type: ignore[index]
            "Non-secret value in list within event dict should be unchanged"
        )

    def test_processor_preserves_non_string_types(self) -> None:
        event_dict = {
            "event": "types",
            "count": 5,
            "flag": True,
            "ratio": 0.75,
            "nothing": None,
        }
        result = self._call(event_dict)
        assert result["count"] == 5, "Integer should be preserved"
        assert result["flag"] is True, "Bool should be preserved"
        assert result["ratio"] == 0.75, "Float should be preserved"
        assert result["nothing"] is None, "None should be preserved"

    def test_processor_mutates_event_dict_in_place(self) -> None:
        event_dict = {"event": "mutate", "key": "sk-ant-api03-" + "W" * 20}
        result = self._call(event_dict)
        # The processor modifies event_dict in-place and returns the same object
        assert result is event_dict, (
            "Processor should return the same event_dict object (modified in-place)"
        )

    def test_processor_logger_and_method_ignored(self) -> None:
        """Processor accepts arbitrary logger/method_name without error."""
        processor = SecretRedactor()
        event_dict = {"event": "test"}
        # Should not raise regardless of logger/method_name values
        result = processor(logger="fake-logger", method_name="debug", event_dict=event_dict)
        assert result["event"] == "test", (
            "Processor should work regardless of logger or method_name values"
        )

    def test_processor_multiple_secrets_in_one_dict(self) -> None:
        event_dict = {
            "event": "multi-secret",
            "anthropic_key": "sk-ant-api03-" + "A" * 20,
            "openai_key": "sk-" + "B" * 20,
            "github_token": "ghp_" + "c" * 20,
            "aws_key": "AKIAIOSFODNN7EXAMPLE",
        }
        result = self._call(event_dict)
        assert result["anthropic_key"] == "sk-ant-***", (
            "Anthropic key should be masked among multiple secrets"
        )
        assert result["openai_key"] == "sk-***", (
            "OpenAI key should be masked among multiple secrets"
        )
        assert result["github_token"] == "ghp_***", (
            "GitHub token should be masked among multiple secrets"
        )
        assert result["aws_key"] == "AKIA***", "AWS key should be masked among multiple secrets"
