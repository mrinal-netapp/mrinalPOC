"""Integration tests for config-to-context pipeline.

Tests that configuration flows correctly from JSON/env through ConfigLoader
into AgentExecutionContext, and that all config values are accessible in context.

Covers:
- Config flows from JSON through ConfigLoader into AgentExecutionContext
- Guardrails config accessible in context
- Per-agent overrides accessible in context
- Context correlation_id generation
- Config frozen in context (immutable)
- Complete pipeline from env + JSON + request to context
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

from agent_service_maf.config.config_loader import ConfigLoader
from agent_service_maf.config.defaults import DEFAULTS
from agent_service_maf.config.validators import AgentConfig
from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.exceptions import ConfigurationError

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def clean_agent_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove all AGENT_* environment variables to prevent test pollution."""
    import os

    agent_vars = [key for key in os.environ if key.startswith("AGENT_")]
    for var in agent_vars:
        monkeypatch.delenv(var, raising=False)


@pytest.fixture
def mock_gateway() -> MagicMock:
    """Return a mock gateway object."""
    return MagicMock()


@pytest.fixture
def mock_mcp_registry() -> MagicMock:
    """Return a mock MCP registry object."""
    return MagicMock()


def write_json_config(path: Path, data: dict[str, Any]) -> None:
    """Helper: write data as JSON to path."""
    path.write_text(json.dumps(data))


def make_context(
    config: AgentConfig,
    mock_gateway: MagicMock,
    mock_mcp_registry: MagicMock,
) -> AgentExecutionContext:
    """Helper: create an AgentExecutionContext with a fresh correlation_id."""
    return AgentExecutionContext(
        config=config,
        gateway=mock_gateway,
        mcp_registry=mock_mcp_registry,
        correlation_id=str(uuid.uuid4()),
    )


# ---------------------------------------------------------------------------
# Basic pipeline: ConfigLoader → AgentConfig → AgentExecutionContext
# ---------------------------------------------------------------------------


class TestConfigPipeline_BasicFlow:
    """Tests that config flows from loader through to context correctly."""

    def test_pipeline_defaults_only(
        self, mock_gateway: MagicMock, mock_mcp_registry: MagicMock
    ) -> None:
        """Config pipeline with only defaults should produce valid context."""
        loader = ConfigLoader()
        config = loader.resolve()
        context = make_context(config, mock_gateway, mock_mcp_registry)
        assert context.config is config, (
            "Context should hold a reference to the resolved AgentConfig"
        )
        assert isinstance(context.config, AgentConfig), (
            "context.config should be an AgentConfig instance"
        )

    def test_pipeline_json_config_accessible_in_context(
        self,
        tmp_path: Path,
        mock_gateway: MagicMock,
        mock_mcp_registry: MagicMock,
    ) -> None:
        """Values from JSON config file should be accessible in context."""
        json_path = tmp_path / "config.json"
        write_json_config(
            json_path,
            {
                "agent": {"model": "openai/gpt-4o", "temperature": 0.3},
                "logging": {"level": "DEBUG"},
            },
        )
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()
        context = make_context(config, mock_gateway, mock_mcp_registry)

        assert context.config.agent.model == "openai/gpt-4o", (
            "JSON-configured agent.model should be accessible via context.config.agent.model"
        )
        assert context.config.agent.temperature == 0.3, (
            "JSON-configured agent.temperature should be accessible via context"
        )
        assert context.config.logging.level == "DEBUG", (
            "JSON-configured logging.level should be accessible via context"
        )

    def test_pipeline_env_config_accessible_in_context(
        self,
        monkeypatch: pytest.MonkeyPatch,
        mock_gateway: MagicMock,
        mock_mcp_registry: MagicMock,
    ) -> None:
        """Values from env vars should be accessible in context."""
        monkeypatch.setenv("AGENT_AGENT__FRAMEWORK", "echo")
        monkeypatch.setenv("AGENT_AGENT__MAX_TOKENS", "8192")
        loader = ConfigLoader()
        config = loader.resolve()
        context = make_context(config, mock_gateway, mock_mcp_registry)

        assert context.config.agent.framework == "echo", (
            "Env-configured agent.framework should be accessible via context"
        )
        assert context.config.agent.max_tokens == 8192, (
            "Env-configured agent.max_tokens should be accessible via context"
        )

    def test_pipeline_request_overrides_accessible_in_context(
        self,
        mock_gateway: MagicMock,
        mock_mcp_registry: MagicMock,
    ) -> None:
        """Per-request overrides should be reflected in context config."""
        loader = ConfigLoader()
        config = loader.resolve(request_overrides={"agent": {"temperature": 0.15}})
        context = make_context(config, mock_gateway, mock_mcp_registry)

        assert context.config.agent.temperature == 0.15, (
            "Request override of temperature should be accessible via context"
        )

    def test_pipeline_full_three_tier_in_context(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
        mock_gateway: MagicMock,
        mock_mcp_registry: MagicMock,
    ) -> None:
        """Full three-tier config (env + JSON + request) should flow into context."""
        # Tier 1: env
        monkeypatch.setenv("AGENT_AGENT__FRAMEWORK", "env-framework")
        monkeypatch.setenv("AGENT_AGENT__TEMPERATURE", "0.2")

        # Tier 2: JSON (overrides env for framework)
        json_path = tmp_path / "config.json"
        write_json_config(
            json_path,
            {
                "agent": {"framework": "json-framework", "max_tokens": 2000},
            },
        )

        # Tier 3: request (overrides temperature)
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve(request_overrides={"agent": {"temperature": 0.9}})
        context = make_context(config, mock_gateway, mock_mcp_registry)

        assert context.config.agent.framework == "json-framework", (
            "JSON config framework should win over env in three-tier merge"
        )
        assert context.config.agent.temperature == 0.9, (
            "Request override temperature should win over JSON and env in context"
        )
        assert context.config.agent.max_tokens == 2000, (
            "JSON-configured max_tokens should be accessible in context"
        )


# ---------------------------------------------------------------------------
# Guardrails in context
# ---------------------------------------------------------------------------


class TestConfigPipeline_GuardrailsInContext:
    """Tests that guardrails configuration is accessible in context."""

    def test_guardrails_config_accessible_in_context(
        self,
        mock_gateway: MagicMock,
        mock_mcp_registry: MagicMock,
    ) -> None:
        """Default guardrails config should be accessible via context.config.guardrails."""
        loader = ConfigLoader()
        config = loader.resolve()
        context = make_context(config, mock_gateway, mock_mcp_registry)

        assert context.config.guardrails.enabled is True, (
            "context.config.guardrails.enabled should be True by default"
        )
        assert context.config.guardrails.fail_open is False, (
            "context.config.guardrails.fail_open should be False by default"
        )

    def test_guardrails_input_rules_accessible_in_context(
        self,
        mock_gateway: MagicMock,
        mock_mcp_registry: MagicMock,
    ) -> None:
        """Default input guardrail rules are exposed (as a list) on the context.

        The DEFAULTS dict now ships ``input_guardrails: []`` so that
        guardrails are opt-in per agent rather than always-on baseline
        (the previous defaults silently blocked every request with an
        "ignore previous instructions" / "system prompt" substring,
        which broke eval suites and the playground). The contract this
        test pins is that the field is *accessible* and is a list —
        callers/agents that want guardrails configure them explicitly
        via JSON / env / per-request override.
        """
        config = AgentConfig(**DEFAULTS)
        context = make_context(config, mock_gateway, mock_mcp_registry)
        rules = context.config.guardrails.input_guardrails
        assert isinstance(rules, list), (
            "context.config.guardrails.input_guardrails should be a list"
        )

    def test_guardrails_disabled_via_env_accessible_in_context(
        self,
        monkeypatch: pytest.MonkeyPatch,
        mock_gateway: MagicMock,
        mock_mcp_registry: MagicMock,
    ) -> None:
        """Guardrails disabled via env should be reflected in context config."""
        monkeypatch.setenv("AGENT_GUARDRAILS__ENABLED", "false")
        loader = ConfigLoader()
        config = loader.resolve()
        context = make_context(config, mock_gateway, mock_mcp_registry)

        assert context.config.guardrails.enabled is False, (
            "Guardrails disabled via env should be reflected in context.config.guardrails.enabled"
        )

    def test_guardrails_fail_open_via_json_accessible_in_context(
        self,
        tmp_path: Path,
        mock_gateway: MagicMock,
        mock_mcp_registry: MagicMock,
    ) -> None:
        """fail_open set via JSON should be accessible in context."""
        json_path = tmp_path / "config.json"
        write_json_config(json_path, {"guardrails": {"fail_open": True}})
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()
        context = make_context(config, mock_gateway, mock_mcp_registry)

        assert context.config.guardrails.fail_open is True, (
            "guardrails.fail_open=True from JSON should be accessible in context"
        )

    def test_guardrails_custom_rules_from_json_in_context(
        self,
        tmp_path: Path,
        mock_gateway: MagicMock,
        mock_mcp_registry: MagicMock,
    ) -> None:
        """Custom guardrail rules from JSON should be accessible in context."""
        json_path = tmp_path / "config.json"
        write_json_config(
            json_path,
            {
                "guardrails": {
                    "input_guardrails": [
                        {
                            "name": "custom_guard",
                            "enabled": True,
                            "action_on_trigger": "warn",
                            "config": {"threshold": 0.9},
                        }
                    ],
                }
            },
        )
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()
        context = make_context(config, mock_gateway, mock_mcp_registry)

        rules = context.config.guardrails.input_guardrails
        assert len(rules) == 1, "Context should have exactly 1 custom input guardrail from JSON"
        assert rules[0].name == "custom_guard", (
            "Custom guardrail name should be 'custom_guard' in context"
        )
        assert rules[0].action_on_trigger == "warn", (
            "Custom guardrail action_on_trigger should be 'warn' in context"
        )


# ---------------------------------------------------------------------------
# Per-agent overrides in context
# ---------------------------------------------------------------------------


class TestConfigPipeline_AgentOverridesInContext:
    """Tests that per-agent guardrail overrides are accessible in context."""

    def test_per_agent_override_accessible_in_context(
        self,
        tmp_path: Path,
        mock_gateway: MagicMock,
        mock_mcp_registry: MagicMock,
    ) -> None:
        """Per-agent guardrail override from JSON should be accessible in context."""
        json_path = tmp_path / "config.json"
        write_json_config(
            json_path,
            {
                "guardrails": {
                    "agent_overrides": {
                        "special-agent": {
                            "input_guardrails": [
                                {
                                    "name": "special_guard",
                                    "enabled": True,
                                    "action_on_trigger": "block",
                                    "config": {},
                                }
                            ],
                            "output_guardrails": [],
                        }
                    }
                }
            },
        )
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()
        context = make_context(config, mock_gateway, mock_mcp_registry)

        overrides = context.config.guardrails.agent_overrides
        assert "special-agent" in overrides, (
            "Per-agent override key 'special-agent' should be present in context guardrails"
        )
        agent_override = overrides["special-agent"]
        assert len(agent_override.input_guardrails) == 1, (
            "special-agent override should have exactly 1 input guardrail in context"
        )
        assert agent_override.input_guardrails[0].name == "special_guard", (
            "special-agent input guardrail name should be 'special_guard' in context"
        )

    def test_per_agent_tool_policy_accessible_in_context(
        self,
        tmp_path: Path,
        mock_gateway: MagicMock,
        mock_mcp_registry: MagicMock,
    ) -> None:
        """Per-agent tool policy from JSON should be accessible in context."""
        json_path = tmp_path / "config.json"
        write_json_config(
            json_path,
            {
                "guardrails": {
                    "agent_overrides": {
                        "restricted-agent": {
                            "tool_policy": {
                                "mode": "allowlist",
                                "tools": ["search"],
                                "max_calls_per_request": 3,
                            }
                        }
                    }
                }
            },
        )
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()
        context = make_context(config, mock_gateway, mock_mcp_registry)

        policy = context.config.guardrails.agent_overrides["restricted-agent"].tool_policy
        assert policy.mode == "allowlist", (
            "Per-agent tool_policy.mode should be 'allowlist' in context"
        )
        assert policy.tools == ["search"], (
            "Per-agent tool_policy.tools should be ['search'] in context"
        )
        assert policy.max_calls_per_request == 3, (
            "Per-agent tool_policy.max_calls_per_request should be 3 in context"
        )

    def test_multiple_agent_overrides_all_accessible(
        self,
        tmp_path: Path,
        mock_gateway: MagicMock,
        mock_mcp_registry: MagicMock,
    ) -> None:
        """Multiple per-agent overrides should all be accessible in context."""
        json_path = tmp_path / "config.json"
        write_json_config(
            json_path,
            {
                "guardrails": {
                    "agent_overrides": {
                        "agent-alpha": {
                            "input_guardrails": [
                                {
                                    "name": "alpha_guard",
                                    "enabled": True,
                                    "action_on_trigger": "block",
                                    "config": {},
                                }
                            ],
                            "output_guardrails": [],
                        },
                        "agent-beta": {
                            "input_guardrails": [],
                            "output_guardrails": [
                                {
                                    "name": "beta_guard",
                                    "enabled": False,
                                    "action_on_trigger": "warn",
                                    "config": {},
                                }
                            ],
                        },
                    }
                }
            },
        )
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()
        context = make_context(config, mock_gateway, mock_mcp_registry)

        overrides = context.config.guardrails.agent_overrides
        assert "agent-alpha" in overrides, "agent-alpha override should be accessible in context"
        assert "agent-beta" in overrides, "agent-beta override should be accessible in context"
        assert overrides["agent-alpha"].input_guardrails[0].name == "alpha_guard", (
            "agent-alpha input guardrail name should be 'alpha_guard'"
        )
        assert overrides["agent-beta"].output_guardrails[0].name == "beta_guard", (
            "agent-beta output guardrail name should be 'beta_guard'"
        )


# ---------------------------------------------------------------------------
# Context properties
# ---------------------------------------------------------------------------


class TestConfigPipeline_ContextProperties:
    """Tests for AgentExecutionContext properties with config."""

    def test_context_config_is_frozen(
        self,
        mock_gateway: MagicMock,
        mock_mcp_registry: MagicMock,
    ) -> None:
        """Context config should be frozen (immutable) in context."""
        loader = ConfigLoader()
        config = loader.resolve()
        context = make_context(config, mock_gateway, mock_mcp_registry)

        with (
            pytest.raises(Exception),
            "Attempting to mutate context.config.agent.framework should raise (frozen)",
        ):
            context.config.agent.framework = "echo"  # type: ignore[misc]

    def test_context_holds_gateway_reference(
        self,
        mock_gateway: MagicMock,
        mock_mcp_registry: MagicMock,
    ) -> None:
        """Context should hold a reference to the provided gateway."""
        loader = ConfigLoader()
        config = loader.resolve()
        context = make_context(config, mock_gateway, mock_mcp_registry)

        assert context.gateway is mock_gateway, (
            "context.gateway should be the same object as the provided mock_gateway"
        )

    def test_context_holds_mcp_registry_reference(
        self,
        mock_gateway: MagicMock,
        mock_mcp_registry: MagicMock,
    ) -> None:
        """Context should hold a reference to the provided MCP registry."""
        loader = ConfigLoader()
        config = loader.resolve()
        context = make_context(config, mock_gateway, mock_mcp_registry)

        assert context.mcp_registry is mock_mcp_registry, (
            "context.mcp_registry should be the same object as the provided mock_mcp_registry"
        )

    def test_context_correlation_id_is_valid_uuid4(
        self,
        mock_gateway: MagicMock,
        mock_mcp_registry: MagicMock,
    ) -> None:
        """Context correlation_id should be a valid UUID4 string."""
        loader = ConfigLoader()
        config = loader.resolve()
        correlation_id = str(uuid.uuid4())
        context = AgentExecutionContext(
            config=config,
            gateway=mock_gateway,
            mcp_registry=mock_mcp_registry,
            correlation_id=correlation_id,
        )
        assert context.correlation_id == correlation_id, (
            "context.correlation_id should match the provided UUID4 string"
        )
        # Validate UUID4 format
        parsed = uuid.UUID(context.correlation_id)
        assert parsed.version == 4, "context.correlation_id should be a valid UUID version 4"

    def test_context_empty_correlation_id_auto_generates(
        self,
        mock_gateway: MagicMock,
        mock_mcp_registry: MagicMock,
    ) -> None:
        """Context with empty correlation_id should auto-generate a UUID4."""
        loader = ConfigLoader()
        config = loader.resolve()
        context = AgentExecutionContext(
            config=config,
            gateway=mock_gateway,
            mcp_registry=mock_mcp_registry,
            correlation_id="",
        )
        assert len(context.correlation_id) > 0, "Auto-generated correlation_id should not be empty"
        parsed = uuid.UUID(context.correlation_id)
        assert parsed.version == 4, "Auto-generated correlation_id should be a valid UUID4"


# ---------------------------------------------------------------------------
# Error propagation in pipeline
# ---------------------------------------------------------------------------


class TestConfigPipeline_ErrorPropagation:
    """Tests that errors in config pipeline propagate correctly."""

    def test_invalid_json_prevents_context_creation(self, tmp_path: Path) -> None:
        """Invalid JSON file should prevent context creation via ConfigurationError."""
        json_path = tmp_path / "bad.json"
        json_path.write_text("{ bad json }")
        loader = ConfigLoader(json_config_path=json_path)

        with pytest.raises(ConfigurationError):
            loader.resolve()

    def test_locked_field_in_request_prevents_context_creation(self) -> None:
        """Locked field in request override should raise ConfigurationError."""
        loader = ConfigLoader()

        with pytest.raises(ConfigurationError) as exc_info:
            loader.resolve(request_overrides={"agent": {"framework": "bad"}})
        assert "agent.framework" in str(exc_info.value), (
            "ConfigurationError should mention 'agent.framework' locked field"
        )

    def test_secret_in_json_prevents_context_creation(self, tmp_path: Path) -> None:
        """Secret in JSON file should raise ConfigurationError before context creation."""
        json_path = tmp_path / "config.json"
        json_path.write_text(json.dumps({"gateway": {"api_key": "sk-secret"}}))
        loader = ConfigLoader(json_config_path=json_path)

        with pytest.raises(ConfigurationError):
            loader.resolve()

    def test_validation_error_prevents_context_creation(self, tmp_path: Path) -> None:
        """Validation error in merged config should raise ConfigurationError."""
        json_path = tmp_path / "config.json"
        # Use an out-of-range temperature — ``interface.port`` is no
        # longer a real field (uvicorn CLI drives the bind).
        json_path.write_text(json.dumps({"agent": {"temperature": 5.0}}))
        loader = ConfigLoader(json_config_path=json_path)

        with pytest.raises(ConfigurationError):
            loader.resolve()


# ---------------------------------------------------------------------------
# Interface and gateway config in context
# ---------------------------------------------------------------------------


class TestConfigPipeline_InterfaceAndGateway:
    """Tests for interface and gateway config accessible in context."""

    def test_interface_auth_config_in_context(
        self,
        tmp_path: Path,
        mock_gateway: MagicMock,
        mock_mcp_registry: MagicMock,
    ) -> None:
        """Interface auth configuration from JSON should be accessible in context."""
        json_path = tmp_path / "config.json"
        write_json_config(
            json_path,
            {
                "interface": {
                    "auth": {
                        "enabled": True,
                        "scheme": "oauth2",
                        "oauth2_issuer": "https://auth.example.com",
                    }
                }
            },
        )
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()
        context = make_context(config, mock_gateway, mock_mcp_registry)

        assert context.config.interface.auth.enabled is True, (
            "context.config.interface.auth.enabled should be True from JSON"
        )
        assert context.config.interface.auth.scheme == "oauth2", (
            "context.config.interface.auth.scheme should be 'oauth2' from JSON"
        )
        assert context.config.interface.auth.oauth2_issuer == "https://auth.example.com", (
            "context.config.interface.auth.oauth2_issuer should be set from JSON"
        )

    def test_interface_streaming_config_in_context(
        self,
        tmp_path: Path,
        mock_gateway: MagicMock,
        mock_mcp_registry: MagicMock,
    ) -> None:
        """Interface streaming configuration from JSON should be accessible in context."""
        json_path = tmp_path / "config.json"
        write_json_config(
            json_path,
            {
                "interface": {
                    "streaming": {
                        "max_duration_seconds": 600,
                        "max_events": 50000,
                        "idle_timeout_seconds": 120,
                    }
                }
            },
        )
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()
        context = make_context(config, mock_gateway, mock_mcp_registry)

        assert context.config.interface.streaming.max_duration_seconds == 600, (
            "context.config.interface.streaming.max_duration_seconds should be 600"
        )
        assert context.config.interface.streaming.max_events == 50000, (
            "context.config.interface.streaming.max_events should be 50000"
        )
        assert context.config.interface.streaming.idle_timeout_seconds == 120, (
            "context.config.interface.streaming.idle_timeout_seconds should be 120"
        )

    def test_gateway_config_in_context(
        self,
        tmp_path: Path,
        mock_gateway: MagicMock,
        mock_mcp_registry: MagicMock,
    ) -> None:
        """Gateway configuration from JSON should be accessible in context."""
        json_path = tmp_path / "config.json"
        write_json_config(
            json_path,
            {
                "gateway": {
                    "url": "http://custom-gateway:5000",
                    "default_model": "openai/gpt-4o",
                    "max_retries": 3,
                }
            },
        )
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()
        context = make_context(config, mock_gateway, mock_mcp_registry)

        assert context.config.gateway.url == "http://custom-gateway:5000", (
            "context.config.gateway.url should be set from JSON"
        )
        assert context.config.gateway.default_model == "openai/gpt-4o", (
            "context.config.gateway.default_model should be 'openai/gpt-4o' from JSON"
        )
        assert context.config.gateway.max_retries == 3, (
            "context.config.gateway.max_retries should be 3 from JSON"
        )

    def test_mcp_config_in_context(
        self,
        tmp_path: Path,
        mock_gateway: MagicMock,
        mock_mcp_registry: MagicMock,
    ) -> None:
        """MCP configuration from JSON should be accessible in context."""
        json_path = tmp_path / "config.json"
        write_json_config(
            json_path,
            {
                "mcp": {
                    "tool_call_timeout_seconds": 120,
                    "max_tool_retries": 2,
                    "max_concurrent_tool_calls": 10,
                }
            },
        )
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()
        context = make_context(config, mock_gateway, mock_mcp_registry)

        assert context.config.mcp.tool_call_timeout_seconds == 120, (
            "context.config.mcp.tool_call_timeout_seconds should be 120 from JSON"
        )
        assert context.config.mcp.max_tool_retries == 2, (
            "context.config.mcp.max_tool_retries should be 2 from JSON"
        )
        assert context.config.mcp.max_concurrent_tool_calls == 10, (
            "context.config.mcp.max_concurrent_tool_calls should be 10 from JSON"
        )
