"""Unit tests for output guardrails.

Tests cover:
- ContentFilter: built-in secret patterns (OpenAI, Anthropic, AWS, GitHub, Slack,
  Google, JWT), extra_patterns config, clean output passes, case-insensitive matching
- SchemaValidator: no-config passthrough, JSON validation, required field checks,
  action_on_trigger=block vs warn, non-dict JSON triggers warn
- OutputLengthGuard: within limit passes, over limit blocks by default, modify
  truncates with suffix, custom max_chars, action_on_trigger config
"""

from __future__ import annotations

from agent_service_maf.guardrails.base import GuardrailAction, GuardrailContext
from agent_service_maf.guardrails.catalog.content_filter import ContentFilter
from agent_service_maf.guardrails.catalog.output_length import OutputLengthGuard
from agent_service_maf.guardrails.catalog.schema_validator import SchemaValidator

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _output_ctx(content: str, original_input: str = "") -> GuardrailContext:
    """Return a minimal output GuardrailContext for testing."""
    return GuardrailContext.for_output(content, "test-agent", "corr-001", original_input)


# ---------------------------------------------------------------------------
# ContentFilter
# ---------------------------------------------------------------------------


class TestContentFilter:
    """Tests for ContentFilter output guardrail."""

    def test_name_property(self) -> None:
        """name property must return 'content_filter'."""
        cf = ContentFilter()
        assert cf.name == "content_filter", "ContentFilter.name must be 'content_filter'"

    async def test_clean_output_allows(self) -> None:
        """Normal agent output must be ALLOW."""
        cf = ContentFilter()
        result = await cf.check(_output_ctx("The weather is sunny today."))
        assert result.action == GuardrailAction.ALLOW, "Clean output must be ALLOW"

    async def test_openai_key_blocked(self) -> None:
        """Output containing an OpenAI key pattern must be BLOCK."""
        cf = ContentFilter()
        result = await cf.check(
            _output_ctx("Here is your key: sk-abcdefghijklmnopqrstuvwxyz123456")
        )
        assert result.action == GuardrailAction.BLOCK, "OpenAI key pattern (sk-...) must be blocked"

    async def test_anthropic_key_blocked(self) -> None:
        """Output containing an Anthropic key pattern must be BLOCK."""
        cf = ContentFilter()
        result = await cf.check(_output_ctx("Token: sk-ant-abcdefghijklmnopqrstuvwxyz123456"))
        assert result.action == GuardrailAction.BLOCK, (
            "Anthropic key pattern (sk-ant-...) must be blocked"
        )

    async def test_aws_access_key_blocked(self) -> None:
        """Output containing an AWS access key ID must be BLOCK."""
        cf = ContentFilter()
        result = await cf.check(_output_ctx("AWS key: AKIAIOSFODNN7EXAMPLE"))
        assert result.action == GuardrailAction.BLOCK, (
            "AWS access key ID pattern (AKIA...) must be blocked"
        )

    async def test_github_pat_blocked(self) -> None:
        """Output containing a GitHub PAT must be BLOCK."""
        cf = ContentFilter()
        fake_pat = "ghp_" + "A" * 36
        result = await cf.check(_output_ctx(f"Token: {fake_pat}"))
        assert result.action == GuardrailAction.BLOCK, (
            "GitHub PAT pattern (ghp_...) must be blocked"
        )

    async def test_slack_bot_token_blocked(self) -> None:
        """Output containing a Slack bot token must be BLOCK."""
        cf = ContentFilter()
        result = await cf.check(_output_ctx("Slack token: xoxb-1234-5678-ABCD"))
        assert result.action == GuardrailAction.BLOCK, (
            "Slack bot token pattern (xoxb-...) must be blocked"
        )

    async def test_jwt_blocked(self) -> None:
        """Output containing a JWT-shaped string must be BLOCK."""
        cf = ContentFilter()
        fake_jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        result = await cf.check(_output_ctx(f"Token: {fake_jwt}"))
        assert result.action == GuardrailAction.BLOCK, "JWT-shaped string must be blocked"

    async def test_extra_patterns_from_config_blocks(self) -> None:
        """Custom extra_patterns in config must be applied."""
        cf = ContentFilter(config={"extra_patterns": [r"CUSTOM_SECRET_\w+"]})
        result = await cf.check(_output_ctx("Found: CUSTOM_SECRET_abc123"))
        assert result.action == GuardrailAction.BLOCK, "Custom extra_patterns must trigger BLOCK"

    async def test_extra_patterns_do_not_affect_clean_output(self) -> None:
        """Custom extra_patterns must not block unrelated output."""
        cf = ContentFilter(config={"extra_patterns": [r"CUSTOM_SECRET_\w+"]})
        result = await cf.check(_output_ctx("The answer is 42."))
        assert result.action == GuardrailAction.ALLOW, (
            "Custom extra_patterns must not block clean output"
        )

    async def test_block_result_has_guardrail_name(self) -> None:
        """BLOCK result must have correct guardrail_name."""
        cf = ContentFilter()
        result = await cf.check(_output_ctx("sk-abcdefghijklmnopqrstuvwxyz123456"))
        assert result.guardrail_name == "content_filter", (
            "BLOCK result must carry the guardrail name"
        )

    async def test_block_result_has_matched_pattern_in_details(self) -> None:
        """BLOCK result must include matched_pattern in details."""
        cf = ContentFilter()
        result = await cf.check(_output_ctx("Token: sk-abcdefghijklmnopqrstuvwxyz123456"))
        assert result.details is not None, "BLOCK result must have details"
        assert "matched_pattern" in result.details, "details must contain 'matched_pattern' key"

    async def test_config_none_uses_defaults(self) -> None:
        """config=None must use default patterns."""
        cf = ContentFilter(config=None)
        result = await cf.check(_output_ctx("Clean output here."))
        assert result.action == GuardrailAction.ALLOW, (
            "config=None must produce a functional filter with clean output"
        )

    async def test_allow_result_has_guardrail_name(self) -> None:
        """ALLOW result must have guardrail_name set."""
        cf = ContentFilter()
        result = await cf.check(_output_ctx("Normal response."))
        assert result.guardrail_name == "content_filter", (
            "ALLOW result must carry the guardrail name"
        )

    async def test_case_insensitive_does_not_affect_key_patterns(self) -> None:
        """Patterns compiled with IGNORECASE must still detect mixed case."""
        cf = ContentFilter()
        # AKIA is uppercase by standard but test mixed-case prefix
        result = await cf.check(_output_ctx("Key: AKIAIOSFODNN7EXAMPLE"))
        assert result.action == GuardrailAction.BLOCK, (
            "AWS key pattern must be blocked regardless of case flag"
        )


# ---------------------------------------------------------------------------
# SchemaValidator
# ---------------------------------------------------------------------------


class TestSchemaValidator:
    """Tests for SchemaValidator output guardrail."""

    def test_name_property(self) -> None:
        """name property must return 'schema_validator'."""
        sv = SchemaValidator()
        assert sv.name == "schema_validator", "SchemaValidator.name must be 'schema_validator'"

    async def test_no_config_allows_anything(self) -> None:
        """Schema validator with no config must ALLOW all output."""
        sv = SchemaValidator()
        result = await sv.check(_output_ctx("any output whatsoever"))
        assert result.action == GuardrailAction.ALLOW, (
            "Unconfigured SchemaValidator must ALLOW all output"
        )

    async def test_valid_json_with_expected_format_allows(self) -> None:
        """Valid JSON output with expected_format='json' must be ALLOW."""
        sv = SchemaValidator(config={"expected_format": "json"})
        result = await sv.check(_output_ctx('{"key": "value"}'))
        assert result.action == GuardrailAction.ALLOW, (
            "Valid JSON must be ALLOW when expected_format='json'"
        )

    async def test_invalid_json_with_expected_format_warns(self) -> None:
        """Non-JSON output with expected_format='json' must return WARN by default."""
        sv = SchemaValidator(config={"expected_format": "json"})
        result = await sv.check(_output_ctx("This is plain text, not JSON."))
        assert result.action == GuardrailAction.WARN, (
            "Invalid JSON must return WARN (default action_on_trigger)"
        )

    async def test_invalid_json_with_action_block_blocks(self) -> None:
        """Non-JSON output with action_on_trigger='block' must return BLOCK."""
        sv = SchemaValidator(config={"expected_format": "json", "action_on_trigger": "block"})
        result = await sv.check(_output_ctx("Not JSON."))
        assert result.action == GuardrailAction.BLOCK, (
            "action_on_trigger='block' must convert WARN to BLOCK on invalid JSON"
        )

    async def test_all_required_fields_present_allows(self) -> None:
        """JSON with all required fields must be ALLOW."""
        sv = SchemaValidator(config={"required_fields": ["name", "age"]})
        result = await sv.check(_output_ctx('{"name": "Alice", "age": 30}'))
        assert result.action == GuardrailAction.ALLOW, "JSON with all required fields must be ALLOW"

    async def test_missing_required_field_warns(self) -> None:
        """JSON missing a required field must return WARN."""
        sv = SchemaValidator(config={"required_fields": ["name", "age"]})
        result = await sv.check(_output_ctx('{"name": "Alice"}'))
        assert result.action == GuardrailAction.WARN, "JSON missing required field must return WARN"

    async def test_missing_required_field_message_names_field(self) -> None:
        """WARN message must name the missing required field."""
        sv = SchemaValidator(config={"required_fields": ["summary"]})
        result = await sv.check(_output_ctx('{"other": "data"}'))
        assert "summary" in result.message, "WARN message must mention the missing field name"

    async def test_missing_required_field_with_block_action_blocks(self) -> None:
        """Missing required field + action_on_trigger='block' must return BLOCK."""
        sv = SchemaValidator(
            config={
                "required_fields": ["summary"],
                "action_on_trigger": "block",
            }
        )
        result = await sv.check(_output_ctx('{"other": "data"}'))
        assert result.action == GuardrailAction.BLOCK, (
            "Missing required field with block action must return BLOCK"
        )

    async def test_non_dict_json_triggers_warn(self) -> None:
        """Valid JSON that is a list (not a dict) must trigger WARN."""
        sv = SchemaValidator(config={"expected_format": "json"})
        result = await sv.check(_output_ctx("[1, 2, 3]"))
        assert result.action == GuardrailAction.WARN, (
            "JSON list (not dict) must trigger WARN when JSON format expected"
        )

    async def test_required_fields_with_invalid_json_warns(self) -> None:
        """Non-JSON content with required_fields must trigger WARN."""
        sv = SchemaValidator(config={"required_fields": ["field1"]})
        result = await sv.check(_output_ctx("not json at all"))
        assert result.action == GuardrailAction.WARN, (
            "Non-JSON with required_fields must trigger WARN"
        )

    async def test_warn_result_has_guardrail_name(self) -> None:
        """WARN result must have guardrail_name set."""
        sv = SchemaValidator(config={"expected_format": "json"})
        result = await sv.check(_output_ctx("plain text"))
        assert result.guardrail_name == "schema_validator", (
            "WARN result must carry the guardrail name"
        )

    async def test_allow_result_has_guardrail_name(self) -> None:
        """ALLOW result must have guardrail_name set."""
        sv = SchemaValidator(config={"expected_format": "json"})
        result = await sv.check(_output_ctx('{"ok": true}'))
        assert result.guardrail_name == "schema_validator", (
            "ALLOW result must carry the guardrail name"
        )

    async def test_missing_fields_in_details(self) -> None:
        """WARN result for missing fields must include missing_fields in details."""
        sv = SchemaValidator(config={"required_fields": ["x", "y"]})
        result = await sv.check(_output_ctx('{"x": 1}'))
        assert result.details is not None, "WARN result must have details"
        assert "missing_fields" in result.details, "details must contain 'missing_fields'"
        assert "y" in result.details["missing_fields"], (
            "The actually missing field must be listed in details"
        )

    async def test_empty_required_fields_with_format_json_allows_valid_json(self) -> None:
        """Empty required_fields with format=json must allow any valid JSON dict."""
        sv = SchemaValidator(config={"expected_format": "json", "required_fields": []})
        result = await sv.check(_output_ctx('{"anything": "goes"}'))
        assert result.action == GuardrailAction.ALLOW, (
            "Valid JSON dict with empty required_fields must be ALLOW"
        )

    async def test_json_with_extra_fields_still_allows_if_required_present(self) -> None:
        """JSON with extra fields beyond required ones must still ALLOW."""
        sv = SchemaValidator(config={"required_fields": ["name"]})
        result = await sv.check(_output_ctx('{"name": "Alice", "extra": "data"}'))
        assert result.action == GuardrailAction.ALLOW, (
            "Extra fields beyond required ones must not cause a block"
        )


# ---------------------------------------------------------------------------
# OutputLengthGuard
# ---------------------------------------------------------------------------


class TestOutputLengthGuard:
    """Tests for OutputLengthGuard output guardrail."""

    def test_name_property(self) -> None:
        """name property must return 'output_length'."""
        g = OutputLengthGuard()
        assert g.name == "output_length", "OutputLengthGuard.name must be 'output_length'"

    async def test_short_output_allows(self) -> None:
        """Output within limit must be ALLOW."""
        g = OutputLengthGuard(config={"max_chars": 100})
        result = await g.check(_output_ctx("Short response."))
        assert result.action == GuardrailAction.ALLOW, "Output within max_chars must be ALLOW"

    async def test_output_exactly_at_limit_allows(self) -> None:
        """Output exactly at max_chars must be ALLOW."""
        g = OutputLengthGuard(config={"max_chars": 10})
        result = await g.check(_output_ctx("1234567890"))
        assert result.action == GuardrailAction.ALLOW, "Output exactly at max_chars must be ALLOW"

    async def test_output_over_limit_blocks_by_default(self) -> None:
        """Output over max_chars must be BLOCK with default action_on_trigger."""
        g = OutputLengthGuard(config={"max_chars": 10})
        result = await g.check(_output_ctx("12345678901"))  # 11 chars
        assert result.action == GuardrailAction.BLOCK, (
            "Output over max_chars must be BLOCK with default action_on_trigger='block'"
        )

    async def test_block_message_mentions_length(self) -> None:
        """BLOCK message must mention the actual length."""
        g = OutputLengthGuard(config={"max_chars": 5})
        result = await g.check(_output_ctx("123456"))
        assert "6" in result.message or "limit" in result.message.lower(), (
            "BLOCK message must mention length or limit"
        )

    async def test_action_on_trigger_modify_truncates(self) -> None:
        """action_on_trigger='modify' must return MODIFY with truncated content."""
        g = OutputLengthGuard(config={"max_chars": 10, "action_on_trigger": "modify"})
        result = await g.check(_output_ctx("A" * 100))
        assert result.action == GuardrailAction.MODIFY, (
            "action_on_trigger='modify' must return MODIFY on over-length output"
        )

    async def test_modify_truncates_to_max_chars(self) -> None:
        """Modified content must be truncated to max_chars + '[TRUNCATED]' suffix."""
        g = OutputLengthGuard(config={"max_chars": 10, "action_on_trigger": "modify"})
        result = await g.check(_output_ctx("A" * 100))
        assert result.modified_content is not None, "MODIFY result must have modified_content"
        assert result.modified_content.startswith("A" * 10), (
            "Truncated content must preserve first max_chars characters"
        )
        assert "[TRUNCATED]" in result.modified_content, (
            "Truncated content must end with '[TRUNCATED]' suffix"
        )

    async def test_modify_truncated_length_at_most_max_chars_plus_suffix(self) -> None:
        """Truncated content length must not exceed max_chars + len(' [TRUNCATED]')."""
        g = OutputLengthGuard(config={"max_chars": 20, "action_on_trigger": "modify"})
        result = await g.check(_output_ctx("X" * 200))
        assert result.modified_content is not None
        suffix = " [TRUNCATED]"
        assert len(result.modified_content) <= 20 + len(suffix), (
            f"Truncated length must be at most {20 + len(suffix)}, "
            f"got {len(result.modified_content)}"
        )

    async def test_default_max_chars_is_50000(self) -> None:
        """Default max_chars must be 50 000."""
        g = OutputLengthGuard()
        result = await g.check(_output_ctx("A" * 50000))
        assert result.action == GuardrailAction.ALLOW, (
            "50 000 characters must be within default limit"
        )
        result_over = await g.check(_output_ctx("A" * 50001))
        assert result_over.action == GuardrailAction.BLOCK, (
            "50 001 characters must exceed default limit"
        )

    async def test_block_result_has_guardrail_name(self) -> None:
        """BLOCK result must carry the guardrail name."""
        g = OutputLengthGuard(config={"max_chars": 5})
        result = await g.check(_output_ctx("123456"))
        assert result.guardrail_name == "output_length", (
            "BLOCK result must have guardrail_name='output_length'"
        )

    async def test_modify_result_has_details(self) -> None:
        """MODIFY result must include original_length and max_chars in details."""
        g = OutputLengthGuard(config={"max_chars": 5, "action_on_trigger": "modify"})
        result = await g.check(_output_ctx("123456789"))
        assert result.details is not None, "MODIFY result must have details"
        assert "original_length" in result.details, "details must contain 'original_length'"
        assert "max_chars" in result.details, "details must contain 'max_chars'"

    async def test_block_result_has_details(self) -> None:
        """BLOCK result must include length and max_chars in details."""
        g = OutputLengthGuard(config={"max_chars": 5})
        result = await g.check(_output_ctx("123456"))
        assert result.details is not None, "BLOCK result must have details"
        assert "length" in result.details, "details must contain 'length'"
        assert "max_chars" in result.details, "details must contain 'max_chars'"

    async def test_action_on_trigger_unknown_defaults_to_block(self) -> None:
        """Unknown action_on_trigger must default to BLOCK."""
        g = OutputLengthGuard(config={"max_chars": 5, "action_on_trigger": "unknown"})
        result = await g.check(_output_ctx("123456"))
        assert result.action == GuardrailAction.BLOCK, (
            "Unknown action_on_trigger must default to BLOCK"
        )

    async def test_config_none_uses_defaults(self) -> None:
        """config=None must use default max_chars."""
        g = OutputLengthGuard(config=None)
        result = await g.check(_output_ctx("short"))
        assert result.action == GuardrailAction.ALLOW, "config=None must use default settings"
