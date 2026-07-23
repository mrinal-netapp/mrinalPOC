"""Unit tests for Pydantic config validators.

Tests cover:
- AgentSection defaults and bounds
- InterfaceSection defaults, port bounds, auth and streaming sub-sections
- GatewaySection defaults
- GuardrailSection with rules
- MCPSection fields
- LoggingSection defaults
- AgentConfig() no-args is valid
- AgentConfig(**DEFAULTS) passes validation
- JSON roundtrip
- extra fields rejected (strict mode via extra="forbid")
- locked_fields list is correct
"""

from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from agent_service_maf.config.defaults import DEFAULTS
from agent_service_maf.config.validators import (
    AgentConfig,
    AgentGuardrailConfig,
    AgentSection,
    AuthSection,
    GatewaySection,
    GuardrailRule,
    GuardrailSection,
    InterfaceSection,
    LoggingSection,
    MCPSection,
    StreamingSection,
    ToolPolicy,
)

# ---------------------------------------------------------------------------
# AgentSection
# ---------------------------------------------------------------------------


class TestAgentSection:
    """Tests for AgentSection Pydantic model."""

    def test_agent_section_defaults_valid(self) -> None:
        """AgentSection() with no args should produce valid defaults."""
        section = AgentSection()
        assert section.framework == "maf", "Default framework should be 'maf'"
        assert section.model == "anthropic/claude-sonnet-4-20250514", (
            "Default model should be 'anthropic/claude-sonnet-4-20250514'"
        )
        assert section.temperature == 0.7, "Default temperature should be 0.7"
        assert section.max_tokens == 4096, "Default max_tokens should be 4096"
        assert section.timeout_seconds == 120, "Default timeout_seconds should be 120"

    def test_agent_section_temperature_at_min_bound(self) -> None:
        """Temperature of 0.0 (minimum bound) should be valid."""
        section = AgentSection(temperature=0.0)
        assert section.temperature == 0.0, "Temperature 0.0 at min bound should be accepted"

    def test_agent_section_temperature_at_max_bound(self) -> None:
        """Temperature of 2.0 (maximum bound) should be valid."""
        section = AgentSection(temperature=2.0)
        assert section.temperature == 2.0, "Temperature 2.0 at max bound should be accepted"

    def test_agent_section_temperature_above_max_raises_error(self) -> None:
        """Temperature > 2.0 should raise ValidationError."""
        with pytest.raises(ValidationError) as exc_info:
            AgentSection(temperature=2.1)
        assert "temperature" in str(exc_info.value).lower(), (
            "ValidationError should mention 'temperature' field"
        )

    def test_agent_section_temperature_below_min_raises_error(self) -> None:
        """Negative temperature should raise ValidationError."""
        with pytest.raises(ValidationError) as exc_info:
            AgentSection(temperature=-0.1)
        assert "temperature" in str(exc_info.value).lower(), (
            "ValidationError should mention 'temperature' field"
        )

    def test_agent_section_max_tokens_at_min_bound(self) -> None:
        """max_tokens of 1 (minimum bound) should be valid."""
        section = AgentSection(max_tokens=1)
        assert section.max_tokens == 1, "max_tokens=1 at min bound should be accepted"

    def test_agent_section_max_tokens_at_max_bound(self) -> None:
        """max_tokens of 200000 (maximum bound) should be valid."""
        section = AgentSection(max_tokens=200000)
        assert section.max_tokens == 200000, "max_tokens=200000 at max bound should be accepted"

    def test_agent_section_max_tokens_above_max_raises_error(self) -> None:
        """max_tokens > 200000 should raise ValidationError."""
        with pytest.raises(ValidationError) as exc_info:
            AgentSection(max_tokens=200001)
        assert "max_tokens" in str(exc_info.value).lower(), (
            "ValidationError should mention 'max_tokens' field"
        )

    def test_agent_section_max_tokens_zero_raises_error(self) -> None:
        """max_tokens of 0 (below minimum of 1) should raise ValidationError."""
        with pytest.raises(ValidationError) as exc_info:
            AgentSection(max_tokens=0)
        assert "max_tokens" in str(exc_info.value).lower(), (
            "ValidationError should mention 'max_tokens' field"
        )

    def test_agent_section_timeout_seconds_at_min_bound(self) -> None:
        """timeout_seconds of 1 should be valid."""
        section = AgentSection(timeout_seconds=1)
        assert section.timeout_seconds == 1, "timeout_seconds=1 should be accepted"

    def test_agent_section_timeout_seconds_at_max_bound(self) -> None:
        """timeout_seconds of 600 should be valid."""
        section = AgentSection(timeout_seconds=600)
        assert section.timeout_seconds == 600, "timeout_seconds=600 should be accepted"

    def test_agent_section_timeout_above_max_raises_error(self) -> None:
        """timeout_seconds > 600 should raise ValidationError."""
        with pytest.raises(ValidationError):
            AgentSection(timeout_seconds=601)

    def test_agent_section_is_frozen(self) -> None:
        """AgentSection should be frozen (immutable after construction)."""
        section = AgentSection()
        with (
            pytest.raises(Exception),
            "AgentSection should be frozen; assigning to a field should raise",
        ):
            section.framework = "echo"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# AuthSection
# ---------------------------------------------------------------------------


class TestAuthSection:
    """Tests for AuthSection Pydantic sub-model."""

    def test_auth_section_defaults_valid(self) -> None:
        """AuthSection() with no args should produce valid defaults."""
        auth = AuthSection()
        assert auth.enabled is False, "Default auth.enabled should be False"
        assert auth.scheme == "api_key", "Default auth.scheme should be 'api_key'"
        assert auth.api_key_header == "X-API-Key", (
            "Default auth.api_key_header should be 'X-API-Key'"
        )
        assert auth.api_keys == [], "Default auth.api_keys should be empty list"
        assert auth.oauth2_issuer == "", "Default auth.oauth2_issuer should be empty string"
        assert auth.oauth2_audience == "", "Default auth.oauth2_audience should be empty string"

    def test_auth_section_enabled_true(self) -> None:
        """AuthSection with enabled=True should be valid."""
        auth = AuthSection(enabled=True)
        assert auth.enabled is True, "auth.enabled=True should be accepted"

    def test_auth_section_api_keys_list(self) -> None:
        """AuthSection with multiple api_keys should be valid."""
        auth = AuthSection(api_keys=["sk-abc", "sk-def"])
        assert auth.api_keys == ["sk-abc", "sk-def"], (
            "auth.api_keys should accept a list of string keys"
        )

    def test_auth_section_is_frozen(self) -> None:
        """AuthSection should be frozen (immutable)."""
        auth = AuthSection()
        with pytest.raises(Exception):
            auth.enabled = True  # type: ignore[misc]


# ---------------------------------------------------------------------------
# StreamingSection
# ---------------------------------------------------------------------------


class TestStreamingSection:
    """Tests for StreamingSection Pydantic sub-model."""

    def test_streaming_section_defaults_valid(self) -> None:
        """StreamingSection() with no args should produce valid defaults."""
        streaming = StreamingSection()
        assert streaming.max_duration_seconds == 300, (
            "Default streaming.max_duration_seconds should be 300"
        )
        assert streaming.max_events == 10000, "Default streaming.max_events should be 10000"
        assert streaming.idle_timeout_seconds == 60, (
            "Default streaming.idle_timeout_seconds should be 60"
        )

    def test_streaming_max_duration_at_min_bound(self) -> None:
        """max_duration_seconds of 1 (minimum) should be valid."""
        streaming = StreamingSection(max_duration_seconds=1)
        assert streaming.max_duration_seconds == 1, "max_duration_seconds=1 should be accepted"

    def test_streaming_max_duration_zero_raises_error(self) -> None:
        """max_duration_seconds of 0 (below minimum of 1) should raise ValidationError."""
        with pytest.raises(ValidationError):
            StreamingSection(max_duration_seconds=0)

    def test_streaming_max_events_at_min_bound(self) -> None:
        """max_events of 1 (minimum) should be valid."""
        streaming = StreamingSection(max_events=1)
        assert streaming.max_events == 1, "max_events=1 should be accepted"

    def test_streaming_idle_timeout_at_min_bound(self) -> None:
        """idle_timeout_seconds of 1 (minimum) should be valid."""
        streaming = StreamingSection(idle_timeout_seconds=1)
        assert streaming.idle_timeout_seconds == 1, "idle_timeout_seconds=1 should be accepted"

    def test_streaming_section_is_frozen(self) -> None:
        """StreamingSection should be frozen (immutable)."""
        streaming = StreamingSection()
        with pytest.raises(Exception):
            streaming.max_events = 999  # type: ignore[misc]


# ---------------------------------------------------------------------------
# InterfaceSection
# ---------------------------------------------------------------------------


class TestInterfaceSection:
    """Tests for InterfaceSection Pydantic model."""

    def test_interface_section_defaults_valid(self) -> None:
        """InterfaceSection() with no args should produce valid defaults."""
        section = InterfaceSection()
        assert section.cors_origins == ["*"], "Default cors_origins should be ['*']"
        assert section.request_timeout_seconds == 300, (
            "Default request_timeout_seconds should be 300"
        )
        assert section.max_concurrent_requests == 50, "Default max_concurrent_requests should be 50"

    def test_interface_section_no_longer_carries_host_or_port(self) -> None:
        """``host`` and ``port`` were intentionally removed in 2026-05-30:
        the uvicorn launcher's CLI flags drive the actual bind, not the
        config layer. Legacy payloads still carrying them land in the
        ``extra="allow"`` overflow and don't break — but the public
        attribute access is gone."""
        section = InterfaceSection()
        assert not hasattr(section, "host") or "host" not in section.model_fields
        assert not hasattr(section, "port") or "port" not in section.model_fields

    def test_interface_section_auth_sub_section_is_auth_section(self) -> None:
        """InterfaceSection.auth should be an AuthSection instance."""
        section = InterfaceSection()
        assert isinstance(section.auth, AuthSection), (
            "interface.auth should be an AuthSection instance"
        )

    def test_interface_section_streaming_sub_section_is_streaming_section(self) -> None:
        """InterfaceSection.streaming should be a StreamingSection instance."""
        section = InterfaceSection()
        assert isinstance(section.streaming, StreamingSection), (
            "interface.streaming should be a StreamingSection instance"
        )

    # Port range validation tests removed 2026-05-30 — InterfaceSection
    # no longer has a ``port`` field (uvicorn CLI drives the bind).

    def test_interface_request_timeout_at_min_bound(self) -> None:
        """request_timeout_seconds=1 should be valid."""
        section = InterfaceSection(request_timeout_seconds=1)
        assert section.request_timeout_seconds == 1, "request_timeout_seconds=1 should be accepted"

    def test_interface_section_is_frozen(self) -> None:
        """InterfaceSection should be frozen (immutable)."""
        section = InterfaceSection()
        with pytest.raises(Exception):
            section.max_concurrent_requests = 99  # type: ignore[misc]


# ---------------------------------------------------------------------------
# GatewaySection
# ---------------------------------------------------------------------------


class TestGatewaySection:
    """Tests for GatewaySection Pydantic model."""

    def test_gateway_section_defaults_valid(self) -> None:
        """GatewaySection() with no args should produce valid defaults."""
        section = GatewaySection()
        assert section.url == "http://localhost:4000", (
            "Default gateway.url should be 'http://localhost:4000'"
        )
        assert section.api_key == "", "Default gateway.api_key should be empty string"
        assert section.default_model == "anthropic/claude-sonnet-4-20250514", (
            "Default gateway.default_model should be 'anthropic/claude-sonnet-4-20250514'"
        )
        assert section.request_timeout_seconds == 120, (
            "Default gateway.request_timeout_seconds should be 120"
        )
        assert section.retry_on_timeout is True, "Default gateway.retry_on_timeout should be True"
        assert section.max_retries == 2, "Default gateway.max_retries should be 2"

    def test_gateway_request_timeout_at_min_bound(self) -> None:
        """request_timeout_seconds=1 should be valid."""
        section = GatewaySection(request_timeout_seconds=1)
        assert section.request_timeout_seconds == 1, "request_timeout_seconds=1 should be accepted"

    def test_gateway_request_timeout_at_max_bound(self) -> None:
        """request_timeout_seconds=600 should be valid."""
        section = GatewaySection(request_timeout_seconds=600)
        assert section.request_timeout_seconds == 600, (
            "request_timeout_seconds=600 at max bound should be accepted"
        )

    def test_gateway_request_timeout_above_max_raises_error(self) -> None:
        """request_timeout_seconds > 600 should raise ValidationError."""
        with pytest.raises(ValidationError):
            GatewaySection(request_timeout_seconds=601)

    def test_gateway_max_retries_at_min_bound(self) -> None:
        """max_retries=0 (minimum) should be valid."""
        section = GatewaySection(max_retries=0)
        assert section.max_retries == 0, "max_retries=0 should be accepted"

    def test_gateway_max_retries_at_max_bound(self) -> None:
        """max_retries=5 (maximum) should be valid."""
        section = GatewaySection(max_retries=5)
        assert section.max_retries == 5, "max_retries=5 should be accepted"

    def test_gateway_max_retries_above_max_raises_error(self) -> None:
        """max_retries > 5 should raise ValidationError."""
        with pytest.raises(ValidationError):
            GatewaySection(max_retries=6)

    def test_gateway_section_is_frozen(self) -> None:
        """GatewaySection should be frozen."""
        section = GatewaySection()
        with pytest.raises(Exception):
            section.url = "http://other"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# GuardrailRule and ToolPolicy
# ---------------------------------------------------------------------------


class TestGuardrailRule:
    """Tests for GuardrailRule Pydantic model."""

    def test_guardrail_rule_defaults(self) -> None:
        """GuardrailRule with only name should use correct defaults."""
        rule = GuardrailRule(name="pii_masker")
        assert rule.name == "pii_masker", "GuardrailRule name should be 'pii_masker'"
        assert rule.enabled is True, "Default GuardrailRule.enabled should be True"
        assert rule.action_on_trigger == "block", (
            "Default GuardrailRule.action_on_trigger should be 'block'"
        )
        assert rule.config == {}, "Default GuardrailRule.config should be empty dict"

    def test_guardrail_rule_with_config(self) -> None:
        """GuardrailRule with custom config dict should be valid."""
        rule = GuardrailRule(
            name="input_validator",
            enabled=True,
            action_on_trigger="modify",
            config={"max_length": 5000},
        )
        assert rule.config["max_length"] == 5000, (
            "GuardrailRule.config should contain 'max_length' key with value 5000"
        )

    def test_guardrail_rule_name_required(self) -> None:
        """GuardrailRule without name should raise ValidationError."""
        with pytest.raises(ValidationError) as exc_info:
            GuardrailRule()  # type: ignore[call-arg]
        assert "name" in str(exc_info.value).lower(), (
            "ValidationError should indicate that 'name' is required"
        )


class TestToolPolicy:
    """Tests for ToolPolicy Pydantic model."""

    def test_tool_policy_defaults(self) -> None:
        """ToolPolicy() with no args should produce valid defaults."""
        policy = ToolPolicy()
        assert policy.mode == "allowlist", "Default ToolPolicy.mode should be 'allowlist'"
        assert policy.tools == [], "Default ToolPolicy.tools should be empty list"
        assert policy.max_calls_per_request == 20, (
            "Default ToolPolicy.max_calls_per_request should be 20"
        )

    def test_tool_policy_max_calls_at_min_bound(self) -> None:
        """max_calls_per_request=1 (minimum) should be valid."""
        policy = ToolPolicy(max_calls_per_request=1)
        assert policy.max_calls_per_request == 1, "max_calls_per_request=1 should be accepted"

    def test_tool_policy_max_calls_at_max_bound(self) -> None:
        """max_calls_per_request=100 (maximum) should be valid."""
        policy = ToolPolicy(max_calls_per_request=100)
        assert policy.max_calls_per_request == 100, (
            "max_calls_per_request=100 at max bound should be accepted"
        )

    def test_tool_policy_max_calls_above_max_raises_error(self) -> None:
        """max_calls_per_request > 100 should raise ValidationError."""
        with pytest.raises(ValidationError):
            ToolPolicy(max_calls_per_request=101)

    def test_tool_policy_max_calls_zero_raises_error(self) -> None:
        """max_calls_per_request=0 (below minimum of 1) should raise ValidationError."""
        with pytest.raises(ValidationError):
            ToolPolicy(max_calls_per_request=0)


# ---------------------------------------------------------------------------
# GuardrailSection
# ---------------------------------------------------------------------------


class TestGuardrailSection:
    """Tests for GuardrailSection Pydantic model."""

    def test_guardrail_section_defaults(self) -> None:
        """GuardrailSection() with no args should produce valid defaults."""
        section = GuardrailSection()
        assert section.enabled is True, "Default guardrails.enabled should be True"
        assert section.fail_open is False, "Default guardrails.fail_open should be False"
        assert section.log_blocked_requests is True, (
            "Default guardrails.log_blocked_requests should be True"
        )
        assert section.input_guardrails == [], (
            "Default guardrails.input_guardrails should be empty list"
        )
        assert section.output_guardrails == [], (
            "Default guardrails.output_guardrails should be empty list"
        )
        assert isinstance(section.tool_guardrails, ToolPolicy), (
            "Default guardrails.tool_guardrails should be a ToolPolicy instance"
        )
        assert section.agent_overrides == {}, (
            "Default guardrails.agent_overrides should be empty dict"
        )

    def test_guardrail_section_with_input_rules(self) -> None:
        """GuardrailSection with input rules list should be valid."""
        section = GuardrailSection(
            input_guardrails=[
                GuardrailRule(name="pii_masker", action_on_trigger="modify"),
            ]
        )
        assert len(section.input_guardrails) == 1, (
            "GuardrailSection should have 1 input guardrail rule"
        )
        assert section.input_guardrails[0].name == "pii_masker", (
            "Input guardrail rule name should be 'pii_masker'"
        )

    def test_guardrail_section_with_agent_overrides(self) -> None:
        """GuardrailSection with agent_overrides dict should be valid."""
        override = AgentGuardrailConfig(
            input_guardrails=[GuardrailRule(name="custom")],
        )
        section = GuardrailSection(agent_overrides={"agent-1": override})
        assert "agent-1" in section.agent_overrides, "agent_overrides should contain 'agent-1' key"
        assert section.agent_overrides["agent-1"].input_guardrails[0].name == "custom", (
            "agent-1 override should have input guardrail named 'custom'"
        )


# ---------------------------------------------------------------------------
# MCPSection
# ---------------------------------------------------------------------------


class TestMCPSection:
    """Tests for MCPSection Pydantic model (Phase 5 extended fields)."""

    def test_mcp_section_defaults_valid(self) -> None:
        """MCPSection() with no args should produce valid defaults.

        Note: ``config_path`` was removed from the schema when MCP servers
        moved inline into each team's config (v2.0.0). Do not assert on it.
        """
        section = MCPSection()
        assert section.connection_timeout_seconds == 30, (
            "Default mcp.connection_timeout_seconds should be 30"
        )
        assert section.lazy_connect is True, "Default mcp.lazy_connect should be True"
        assert section.tool_call_timeout_seconds == 60, (
            "Default mcp.tool_call_timeout_seconds should be 60"
        )
        assert section.max_tool_retries == 1, "Default mcp.max_tool_retries should be 1"
        assert section.retry_on_timeout is True, "Default mcp.retry_on_timeout should be True"
        assert section.discovery_on_connect is True, (
            "Default mcp.discovery_on_connect should be True"
        )
        assert section.tool_name_format == "qualified", (
            "Default mcp.tool_name_format should be 'qualified'"
        )
        assert section.max_concurrent_tool_calls == 5, (
            "Default mcp.max_concurrent_tool_calls should be 5"
        )

    def test_mcp_connection_timeout_at_min_bound(self) -> None:
        """connection_timeout_seconds=1 (minimum) should be valid."""
        section = MCPSection(connection_timeout_seconds=1)
        assert section.connection_timeout_seconds == 1, (
            "connection_timeout_seconds=1 should be accepted"
        )

    def test_mcp_connection_timeout_at_max_bound(self) -> None:
        """connection_timeout_seconds=300 (maximum) should be valid."""
        section = MCPSection(connection_timeout_seconds=300)
        assert section.connection_timeout_seconds == 300, (
            "connection_timeout_seconds=300 at max bound should be accepted"
        )

    def test_mcp_connection_timeout_above_max_raises_error(self) -> None:
        """connection_timeout_seconds > 300 should raise ValidationError."""
        with pytest.raises(ValidationError):
            MCPSection(connection_timeout_seconds=301)

    def test_mcp_max_tool_retries_at_min_bound(self) -> None:
        """max_tool_retries=0 (minimum) should be valid."""
        section = MCPSection(max_tool_retries=0)
        assert section.max_tool_retries == 0, "max_tool_retries=0 should be accepted"

    def test_mcp_max_tool_retries_at_max_bound(self) -> None:
        """max_tool_retries=3 (maximum) should be valid."""
        section = MCPSection(max_tool_retries=3)
        assert section.max_tool_retries == 3, "max_tool_retries=3 should be accepted"

    def test_mcp_max_tool_retries_above_max_raises_error(self) -> None:
        """max_tool_retries > 3 should raise ValidationError."""
        with pytest.raises(ValidationError):
            MCPSection(max_tool_retries=4)

    def test_mcp_max_concurrent_tool_calls_at_min_bound(self) -> None:
        """max_concurrent_tool_calls=1 (minimum) should be valid."""
        section = MCPSection(max_concurrent_tool_calls=1)
        assert section.max_concurrent_tool_calls == 1, (
            "max_concurrent_tool_calls=1 should be accepted"
        )

    def test_mcp_max_concurrent_tool_calls_at_max_bound(self) -> None:
        """max_concurrent_tool_calls=20 (maximum) should be valid."""
        section = MCPSection(max_concurrent_tool_calls=20)
        assert section.max_concurrent_tool_calls == 20, (
            "max_concurrent_tool_calls=20 at max bound should be accepted"
        )

    def test_mcp_max_concurrent_tool_calls_above_max_raises_error(self) -> None:
        """max_concurrent_tool_calls > 20 should raise ValidationError."""
        with pytest.raises(ValidationError):
            MCPSection(max_concurrent_tool_calls=21)

    def test_mcp_tool_call_timeout_at_max_bound(self) -> None:
        """tool_call_timeout_seconds=600 (maximum) should be valid."""
        section = MCPSection(tool_call_timeout_seconds=600)
        assert section.tool_call_timeout_seconds == 600, (
            "tool_call_timeout_seconds=600 at max bound should be accepted"
        )

    def test_mcp_section_is_frozen(self) -> None:
        """MCPSection should be frozen (immutable)."""
        section = MCPSection()
        with pytest.raises(Exception):
            section.lazy_connect = False  # type: ignore[misc]


# ---------------------------------------------------------------------------
# LoggingSection
# ---------------------------------------------------------------------------


class TestLoggingSection:
    """Tests for LoggingSection Pydantic model."""

    def test_logging_section_defaults_valid(self) -> None:
        """LoggingSection() with no args should produce valid defaults."""
        section = LoggingSection()
        assert section.level == "INFO", "Default logging.level should be 'INFO'"
        assert section.format == "json", "Default logging.format should be 'json'"
        assert section.include_timestamp is True, "Default logging.include_timestamp should be True"

    def test_logging_section_debug_level(self) -> None:
        """LoggingSection with level='DEBUG' should be valid."""
        section = LoggingSection(level="DEBUG")
        assert section.level == "DEBUG", "logging.level='DEBUG' should be accepted"

    def test_logging_section_text_format(self) -> None:
        """LoggingSection with format='text' should be valid."""
        section = LoggingSection(format="text")
        assert section.format == "text", "logging.format='text' should be accepted"

    def test_logging_section_is_frozen(self) -> None:
        """LoggingSection should be frozen (immutable)."""
        section = LoggingSection()
        with pytest.raises(Exception):
            section.level = "DEBUG"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# AgentConfig (root model)
# ---------------------------------------------------------------------------


class TestAgentConfig:
    """Tests for the root AgentConfig Pydantic model."""

    def test_agent_config_no_args_valid(self) -> None:
        """AgentConfig() with no arguments should produce a valid config."""
        config = AgentConfig()
        assert isinstance(config, AgentConfig), (
            "AgentConfig() with no args should produce an AgentConfig instance"
        )

    def test_agent_config_no_args_has_correct_sections(self) -> None:
        """AgentConfig() should have all section sub-models."""
        config = AgentConfig()
        assert isinstance(config.agent, AgentSection), (
            "config.agent should be an AgentSection instance"
        )
        assert isinstance(config.interface, InterfaceSection), (
            "config.interface should be an InterfaceSection instance"
        )
        assert isinstance(config.gateway, GatewaySection), (
            "config.gateway should be a GatewaySection instance"
        )
        assert isinstance(config.guardrails, GuardrailSection), (
            "config.guardrails should be a GuardrailSection instance"
        )
        assert isinstance(config.mcp, MCPSection), "config.mcp should be an MCPSection instance"
        assert isinstance(config.logging, LoggingSection), (
            "config.logging should be a LoggingSection instance"
        )

    def test_agent_config_locked_fields_list(self) -> None:
        """AgentConfig.locked_fields should contain the expected locked fields.

        project_id is locked because team-vs-project membership is decided at
        startup; allowing per-request override would let a caller spoof their
        way into another project's resources.

        ``interface.host`` / ``interface.port`` are not in this list
        because the fields were removed from ``InterfaceSection``
        entirely (the uvicorn launcher's CLI flags drive the bind, not
        the config layer). Locking them was theatre.
        """
        config = AgentConfig()
        expected_locked = {
            "agent.framework",
            "project_id",
        }
        actual_locked = set(config.locked_fields)
        assert expected_locked == actual_locked, (
            f"locked_fields should be {expected_locked}, got {actual_locked}"
        )

    def test_agent_config_extra_fields_allowed(self) -> None:
        """AgentConfig uses ``extra="allow"`` so unknown top-level keys are tolerated.

        Rationale: configs carry documentation keys like ``_schema_version``,
        ``_description``, ``_team_id``, ``_team_name`` that aren't strict model
        fields. Forbidding them would force every doc annotation to have a Pydantic
        field, which is more noise than value.
        """
        cfg = AgentConfig(unknown_extra_field="bad")  # type: ignore[call-arg]
        assert isinstance(cfg, AgentConfig)
        # Extras are preserved on the model
        assert getattr(cfg, "unknown_extra_field", None) == "bad"

    def test_agent_config_is_frozen(self) -> None:
        """AgentConfig should be frozen (immutable after construction)."""
        config = AgentConfig()
        with (
            pytest.raises(Exception),
            "AgentConfig should be frozen; assigning to a field should raise",
        ):
            config.agent = AgentSection(framework="echo")  # type: ignore[misc]

    def test_agent_config_with_defaults_dict_valid(self) -> None:
        """AgentConfig(**DEFAULTS) should pass Pydantic validation without errors."""
        config = AgentConfig(**DEFAULTS)
        assert isinstance(config, AgentConfig), (
            "AgentConfig(**DEFAULTS) must produce a valid AgentConfig instance without errors"
        )

    def test_agent_config_defaults_dict_matches_sections(self) -> None:
        """AgentConfig(**DEFAULTS) should have all expected section models."""
        config = AgentConfig(**DEFAULTS)
        assert isinstance(config.agent, AgentSection), (
            "AgentConfig(**DEFAULTS).agent should be an AgentSection"
        )
        assert isinstance(config.interface, InterfaceSection), (
            "AgentConfig(**DEFAULTS).interface should be an InterfaceSection"
        )
        assert isinstance(config.guardrails, GuardrailSection), (
            "AgentConfig(**DEFAULTS).guardrails should be a GuardrailSection"
        )

    def test_agent_config_defaults_guardrail_rules_are_opt_in(self) -> None:
        """Content guardrails are intentionally empty by default — operators
        opt in per team/agent (see ``_build_defaults`` in defaults.py).

        Only the tool policy carries a non-default override (permissive
        ``denylist`` instead of the schema's restrictive ``allowlist``) so
        agents don't have every tool call blocked out of the box.
        """
        config = AgentConfig(**DEFAULTS)
        assert config.guardrails.input_guardrails == [], (
            "AgentConfig(**DEFAULTS).guardrails.input_guardrails must default to "
            "empty (opt-in policy)"
        )
        assert config.guardrails.output_guardrails == [], (
            "AgentConfig(**DEFAULTS).guardrails.output_guardrails must default to "
            "empty (opt-in policy)"
        )
        assert config.guardrails.tool_guardrails.mode == "denylist", (
            "tool policy must default to permissive denylist so tool calls "
            "aren't blocked out of the box"
        )

    def test_agent_config_json_roundtrip(self) -> None:
        """AgentConfig should survive a JSON serialization/deserialization roundtrip."""
        config = AgentConfig()
        json_str = config.model_dump_json()
        data = json.loads(json_str)
        config_restored = AgentConfig(**data)
        assert config == config_restored, (
            "AgentConfig should be equal after JSON serialization/deserialization roundtrip"
        )

    def test_agent_config_with_defaults_json_roundtrip(self) -> None:
        """AgentConfig(**DEFAULTS) should survive a JSON roundtrip."""
        config = AgentConfig(**DEFAULTS)
        json_str = config.model_dump_json()
        data = json.loads(json_str)
        config_restored = AgentConfig(**data)
        assert config == config_restored, (
            "AgentConfig(**DEFAULTS) should survive a JSON serialization/deserialization roundtrip"
        )

    # Port-bounds test removed 2026-05-30 — InterfaceSection has no
    # ``port`` field anymore.

    def test_agent_config_temperature_bounds_enforced(self) -> None:
        """AgentConfig with out-of-range temperature should raise ValidationError."""
        with pytest.raises((ValidationError, Exception)):
            AgentConfig(agent={"temperature": -1.0})

    def test_agent_config_auth_accessible_nested(self) -> None:
        """Nested auth sub-section should be accessible via config.interface.auth."""
        config = AgentConfig()
        assert config.interface.auth.enabled is False, (
            "config.interface.auth.enabled should be accessible and False by default"
        )
        assert config.interface.auth.scheme == "api_key", (
            "config.interface.auth.scheme should be accessible and 'api_key' by default"
        )

    def test_agent_config_streaming_accessible_nested(self) -> None:
        """Nested streaming sub-section should be accessible via config.interface.streaming."""
        config = AgentConfig()
        assert config.interface.streaming.max_duration_seconds == 300, (
            "config.interface.streaming.max_duration_seconds should be 300 by default"
        )


# ---------------------------------------------------------------------------
# DEFAULTS dict tests
# ---------------------------------------------------------------------------


class TestDefaultsDict:
    """Tests for the DEFAULTS dict exported from defaults.py."""

    def test_defaults_is_dict(self) -> None:
        """DEFAULTS should be a dict."""
        assert isinstance(DEFAULTS, dict), "DEFAULTS should be a dict"

    def test_defaults_has_all_top_level_sections(self) -> None:
        """DEFAULTS should have keys for all top-level sections."""
        expected_sections = {"agent", "interface", "gateway", "guardrails", "mcp", "logging"}
        for section in expected_sections:
            assert section in DEFAULTS, f"DEFAULTS should contain top-level key '{section}'"

    def test_defaults_agent_section_has_expected_keys(self) -> None:
        """DEFAULTS['agent'] should have the expected keys."""
        agent = DEFAULTS["agent"]
        for key in ("framework", "model", "temperature", "max_tokens", "timeout_seconds"):
            assert key in agent, f"DEFAULTS['agent'] should have key '{key}'"

    def test_defaults_interface_section_has_auth_sub_dict(self) -> None:
        """DEFAULTS['interface'] should have an 'auth' sub-dict."""
        assert "auth" in DEFAULTS["interface"], (
            "DEFAULTS['interface'] should have 'auth' sub-section"
        )
        assert isinstance(DEFAULTS["interface"]["auth"], dict), (
            "DEFAULTS['interface']['auth'] should be a dict"
        )

    def test_defaults_interface_section_has_streaming_sub_dict(self) -> None:
        """DEFAULTS['interface'] should have a 'streaming' sub-dict."""
        assert "streaming" in DEFAULTS["interface"], (
            "DEFAULTS['interface'] should have 'streaming' sub-section"
        )
        assert isinstance(DEFAULTS["interface"]["streaming"], dict), (
            "DEFAULTS['interface']['streaming'] should be a dict"
        )

    def test_defaults_guardrails_input_rules_are_empty_opt_in_list(self) -> None:
        """DEFAULTS keeps content guardrails empty by design — operators opt
        in per team/agent. The field must still be present (and a list) so
        ``AgentConfig(**DEFAULTS)`` validates without errors."""
        rules = DEFAULTS["guardrails"]["input_guardrails"]
        assert isinstance(rules, list), (
            "DEFAULTS['guardrails']['input_guardrails'] should be a list"
        )
        assert rules == [], "DEFAULTS guardrail input rules must default to empty (opt-in policy)"

    def test_defaults_guardrails_output_rules_are_empty_opt_in_list(self) -> None:
        """Same opt-in policy on the output side — empty by default, populated
        by team/agent config when an operator explicitly enables a rule."""
        rules = DEFAULTS["guardrails"]["output_guardrails"]
        assert isinstance(rules, list), (
            "DEFAULTS['guardrails']['output_guardrails'] should be a list"
        )
        assert rules == [], "DEFAULTS guardrail output rules must default to empty (opt-in policy)"

    def test_agent_config_with_defaults_passes_validation(self) -> None:
        """The DEFAULTS dict must produce a valid AgentConfig without errors."""
        try:
            config = AgentConfig(**DEFAULTS)
        except Exception as e:
            pytest.fail(
                f"AgentConfig(**DEFAULTS) must pass Pydantic validation without errors. Got: {e}"
            )
        assert isinstance(config, AgentConfig), (
            "AgentConfig(**DEFAULTS) must return an AgentConfig instance"
        )


# ---------------------------------------------------------------------------
# ENH-003: New config field tests (C.7)
# ---------------------------------------------------------------------------


class TestTerminationKeywordsField:
    """Tests for keywords field on TerminationStrategyConfig."""

    def test_termination_keyword_with_keywords_list(self) -> None:
        """Keywords field should parse a list of stop words correctly."""
        from agent_service_maf.config.validators import TerminationStrategyConfig

        cfg = TerminationStrategyConfig(
            type="keyword",
            keywords=["DONE", "FINAL ANSWER"],
        )
        assert cfg.keywords == ["DONE", "FINAL ANSWER"], (
            "keywords field should store the provided list of stop words"
        )

    def test_termination_keyword_empty_list_default(self) -> None:
        """Keywords field should default to an empty list."""
        from agent_service_maf.config.validators import TerminationStrategyConfig

        cfg = TerminationStrategyConfig()
        assert cfg.keywords == [], "keywords field should default to an empty list"


class TestTerminationTimeoutField:
    """Tests for timeout_seconds field on TerminationStrategyConfig."""

    def test_termination_timeout_seconds_valid_range(self) -> None:
        """Timeout_seconds should accept values in [1.0, 3600.0]."""
        from agent_service_maf.config.validators import TerminationStrategyConfig

        cfg = TerminationStrategyConfig(type="timeout", timeout_seconds=30.0)
        assert cfg.timeout_seconds == 30.0, (
            "timeout_seconds should accept a valid value within range"
        )

    def test_termination_timeout_seconds_none_default(self) -> None:
        """Timeout_seconds should default to None."""
        from agent_service_maf.config.validators import TerminationStrategyConfig

        cfg = TerminationStrategyConfig()
        assert cfg.timeout_seconds is None, "timeout_seconds should default to None"

    def test_termination_timeout_seconds_below_minimum_rejected(self) -> None:
        """Timeout_seconds below 1.0 should be rejected."""
        from agent_service_maf.config.validators import TerminationStrategyConfig

        with pytest.raises((ValidationError, Exception)):
            TerminationStrategyConfig(type="timeout", timeout_seconds=0.5)

    def test_termination_timeout_seconds_above_maximum_rejected(self) -> None:
        """Timeout_seconds above 3600.0 should be rejected."""
        from agent_service_maf.config.validators import TerminationStrategyConfig

        with pytest.raises((ValidationError, Exception)):
            TerminationStrategyConfig(type="timeout", timeout_seconds=4000.0)


class TestSelectionCandidateAgentsField:
    """Tests for candidate_agents field on SelectionStrategyConfig."""

    def test_selection_candidate_agents_field(self) -> None:
        """Candidate_agents should parse a list of agent names."""
        from agent_service_maf.config.validators import SelectionStrategyConfig

        cfg = SelectionStrategyConfig(
            type="kernel_function",
            candidate_agents=["agent_a", "agent_b"],
        )
        assert cfg.candidate_agents == ["agent_a", "agent_b"], (
            "candidate_agents should store the provided list of agent names"
        )

    def test_selection_candidate_agents_empty_default(self) -> None:
        """Candidate_agents should default to an empty list."""
        from agent_service_maf.config.validators import SelectionStrategyConfig

        cfg = SelectionStrategyConfig()
        assert cfg.candidate_agents == [], "candidate_agents should default to an empty list"


class TestOrchestrationAgentOrderField:
    """Tests for agent_order field on OrchestrationConfig."""

    def test_orchestration_agent_order_field(self) -> None:
        """Agent_order should parse a list of agent names."""
        from agent_service_maf.config.validators import OrchestrationConfig

        cfg = OrchestrationConfig(
            type="sequential",
            agent_order=["writer", "reviewer"],
        )
        assert cfg.agent_order == ["writer", "reviewer"], (
            "agent_order should store the provided list of agent names"
        )

    def test_orchestration_agent_order_empty_default(self) -> None:
        """Agent_order should default to an empty list."""
        from agent_service_maf.config.validators import OrchestrationConfig

        cfg = OrchestrationConfig()
        assert cfg.agent_order == [], "agent_order should default to an empty list"


class TestGraphEdgeModel:
    """Tests for GraphEdge model and edges field on OrchestrationConfig."""

    def test_graph_edge_model_validation(self) -> None:
        """GraphEdge should require source and target fields."""
        from agent_service_maf.config.validators import GraphEdge

        edge = GraphEdge(source="start", target="end")
        assert edge.source == "start", "GraphEdge.source should be 'start'"
        assert edge.target == "end", "GraphEdge.target should be 'end'"
        assert edge.condition == "", "GraphEdge.condition should default to empty string"

    def test_graph_edge_missing_source_rejected(self) -> None:
        """GraphEdge without source should be rejected."""
        from agent_service_maf.config.validators import GraphEdge

        with pytest.raises((ValidationError, Exception)):
            GraphEdge(target="end")  # type: ignore[call-arg]

    def test_graph_edge_missing_target_rejected(self) -> None:
        """GraphEdge without target should be rejected."""
        from agent_service_maf.config.validators import GraphEdge

        with pytest.raises((ValidationError, Exception)):
            GraphEdge(source="start")  # type: ignore[call-arg]

    def test_graph_edge_with_condition(self) -> None:
        """GraphEdge should accept an optional condition."""
        from agent_service_maf.config.validators import GraphEdge

        edge = GraphEdge(source="a", target="b", condition="if approved")
        assert edge.condition == "if approved", (
            "GraphEdge.condition should store the provided condition"
        )

    def test_orchestration_edges_field(self) -> None:
        """Edges field on OrchestrationConfig should parse a list of GraphEdge."""
        from agent_service_maf.config.validators import GraphEdge, OrchestrationConfig

        cfg = OrchestrationConfig(
            type="graph",
            edges=[
                GraphEdge(source="a", target="b"),
                GraphEdge(source="b", target="c", condition="success"),
            ],
        )
        assert len(cfg.edges) == 2, "edges should contain 2 GraphEdge instances"
        assert cfg.edges[0].source == "a", "First edge source should be 'a'"
        assert cfg.edges[1].condition == "success", "Second edge condition should be 'success'"

    def test_orchestration_edges_empty_default(self) -> None:
        """Edges field should default to an empty list."""
        from agent_service_maf.config.validators import OrchestrationConfig

        cfg = OrchestrationConfig()
        assert cfg.edges == [], "edges should default to an empty list"
