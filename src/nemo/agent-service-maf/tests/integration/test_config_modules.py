"""Integration tests for Config ↔ All Modules boundary.

Validates that:
- Config changes propagate to guardrail behaviour (enabled/disabled, rules)
- Config changes propagate to gateway settings (URL, model, timeout)
- Config changes propagate to MCP settings (timeout, lazy_connect)
- The 3-tier config merge works correctly with all module configs
- Locked fields cannot be overridden through any tier
"""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from unittest.mock import patch

import pytest

from agent_service_maf.config.config_loader import ConfigLoader, deep_merge
from agent_service_maf.config.defaults import DEFAULTS
from agent_service_maf.config.validators import (
    AgentConfig,
    GatewaySection,
    MCPSection,
)
from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.exceptions import ConfigurationError
from agent_service_maf.gateway.llm_gateway import LLMGateway
from agent_service_maf.mcp.mcp_manager import MCPManager

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_context(config: AgentConfig) -> AgentExecutionContext:
    """Create an execution context with the given config."""
    return AgentExecutionContext(
        config=config,
        correlation_id=str(uuid.uuid4()),
    )


def _loader_with_env(env: dict[str, str], tmp_path: Path) -> ConfigLoader:
    """Create a ConfigLoader backed by a temp directory with env overrides applied."""
    with patch.dict(os.environ, env):
        return ConfigLoader(json_config_path=str(tmp_path / "config.json"))


# ---------------------------------------------------------------------------
# Tests: 3-tier config merge
# ---------------------------------------------------------------------------


def test_deep_merge_env_wins_over_defaults() -> None:
    """Environment tier values must override defaults in a 3-tier merge."""
    base = {"agent": {"framework": "maf", "model": "anthropic/claude-sonnet-4-20250514"}}
    override = {"agent": {"model": "openai/gpt-4o"}}

    merged = deep_merge(base, override)

    assert merged["agent"]["model"] == "openai/gpt-4o", (
        "deep_merge should let the override tier win when both sides have the same key"
    )
    assert merged["agent"]["framework"] == "maf", (
        "deep_merge must preserve keys present only in the base dict"
    )


def test_deep_merge_none_values_do_not_overwrite_base() -> None:
    """None override values must be skipped, leaving the base value intact."""
    base = {"gateway": {"url": "http://bifrost:4000"}}
    override = {"gateway": {"url": None}}

    merged = deep_merge(base, override)

    assert merged["gateway"]["url"] == "http://bifrost:4000", (
        "deep_merge must skip None override values — base value should be preserved"
    )


def test_deep_merge_list_values_are_replaced_not_appended() -> None:
    """Override list values should replace, not extend, the base list."""
    base = {"interface": {"cors_origins": ["https://a.example.com"]}}
    override = {"interface": {"cors_origins": ["https://b.example.com", "https://c.example.com"]}}

    merged = deep_merge(base, override)

    expected = ["https://b.example.com", "https://c.example.com"]
    assert merged["interface"]["cors_origins"] == expected, (
        "deep_merge must replace list values entirely rather than extending them"
    )


def test_config_loader_resolves_env_var_overrides(tmp_path: Path) -> None:
    """Environment variables with AGENT_ prefix should override defaults."""
    env = {"AGENT_AGENT__MODEL": "openai/gpt-4o-mini"}

    with patch.dict(os.environ, env, clear=False):
        loader = ConfigLoader(json_config_path=str(tmp_path / "nonexistent.json"))
        config = loader.resolve()

    assert config.agent.model == "openai/gpt-4o-mini", (
        "ConfigLoader should apply AGENT_AGENT__MODEL env var to config.agent.model"
    )


def test_config_loader_json_file_overrides_env(tmp_path: Path) -> None:
    """JSON config file tier should override environment variable tier."""
    json_config = {"gateway": {"url": "http://json-bifrost:5000"}}
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps(json_config))

    env = {"AGENT_GATEWAY__URL": "http://env-bifrost:4000"}
    with patch.dict(os.environ, env, clear=False):
        loader = ConfigLoader(json_config_path=str(config_path))
        config = loader.resolve()

    assert config.gateway.url == "http://json-bifrost:5000", (
        "JSON file tier must win over environment variable tier in 3-tier merge"
    )


def test_config_loader_rejects_secrets_in_json_file(tmp_path: Path) -> None:
    """ConfigLoader must reject JSON config files that contain secret values."""
    json_config = {"gateway": {"api_key": "sk-secret-key-in-json"}}
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps(json_config))

    with pytest.raises(ConfigurationError) as exc_info:
        ConfigLoader(json_config_path=str(config_path)).resolve()

    assert "api_key" in str(exc_info.value).lower() or "secret" in str(exc_info.value).lower(), (
        "ConfigurationError should mention the field name or the word 'secret'"
    )


def test_config_loader_blocks_locked_field_override(tmp_path: Path) -> None:
    """Per-request overrides for locked fields must raise ConfigurationError."""
    loader = ConfigLoader(json_config_path=str(tmp_path / "nonexistent.json"))

    with pytest.raises(ConfigurationError) as exc_info:
        loader.resolve(
            request_overrides={"agent": {"framework": "malicious_framework"}},
        )

    assert "framework" in str(exc_info.value).lower(), (
        "ConfigurationError should identify 'framework' as a locked field"
    )


def test_config_loader_allows_non_locked_field_override(tmp_path: Path) -> None:
    """Per-request overrides for non-locked fields must be applied."""
    loader = ConfigLoader(json_config_path=str(tmp_path / "nonexistent.json"))

    updated_config = loader.resolve(
        request_overrides={"agent": {"temperature": 0.1}},
    )

    assert updated_config.agent.temperature == 0.1, (
        "resolve(request_overrides=...) must apply non-locked field overrides successfully"
    )


# ---------------------------------------------------------------------------
# Tests: Config changes propagate to guardrail behaviour
# ---------------------------------------------------------------------------


def test_guardrail_section_enabled_flag_controls_pipeline_creation() -> None:
    """When guardrails.enabled=False, the section should carry that setting."""
    config = AgentConfig.model_validate(
        {
            **DEFAULTS,
            "guardrails": {**DEFAULTS.get("guardrails", {}), "enabled": False},
        }
    )

    assert config.guardrails.enabled is False, (
        "AgentConfig should reflect guardrails.enabled=False from the merged config"
    )


def test_guardrail_section_fail_open_flag_is_accessible() -> None:
    """guardrails.fail_open config should be accessible on the GuardrailSection."""
    config = AgentConfig.model_validate(
        {
            **DEFAULTS,
            "guardrails": {**DEFAULTS.get("guardrails", {}), "fail_open": True},
        }
    )

    assert config.guardrails.fail_open is True, (
        "AgentConfig should expose guardrails.fail_open=True when configured"
    )


def test_guardrail_section_tool_guardrails_propagates() -> None:
    """Tool policy from config should be accessible through the guardrails section."""
    policy_config = {"mode": "denylist", "tools": ["dangerous_tool"], "max_calls_per_request": 5}
    config = AgentConfig.model_validate(
        {
            **DEFAULTS,
            "guardrails": {
                **DEFAULTS.get("guardrails", {}),
                "tool_guardrails": policy_config,
            },
        }
    )

    policy = config.guardrails.tool_guardrails
    assert policy.mode == "denylist", (
        "Config tool_policy.mode should propagate to config.guardrails.tool_guardrails.mode"
    )
    assert "dangerous_tool" in policy.tools, (
        "Config tool_policy.tools list should propagate correctly"
    )
    assert policy.max_calls_per_request == 5, (
        "Config max_calls_per_request should propagate to the tool policy"
    )


def test_context_get_tool_policy_falls_back_to_default() -> None:
    """AgentExecutionContext.get_tool_policy() returns the default policy for unknown agents."""
    policy_config = {"mode": "allowlist", "tools": ["safe_tool"], "max_calls_per_request": 3}
    config = AgentConfig.model_validate(
        {
            **DEFAULTS,
            "guardrails": {
                **DEFAULTS.get("guardrails", {}),
                "tool_guardrails": policy_config,
            },
        }
    )
    context = _make_context(config)
    # No agent_id in request_metadata → should fall back to default policy

    policy = context.get_tool_policy()

    assert policy.mode == "allowlist", (
        "get_tool_policy() should return the tool_guardrails when no agent override exists"
    )
    assert "safe_tool" in policy.tools, (
        "Default tool policy tools list should be available via get_tool_policy()"
    )


def test_context_get_tool_policy_uses_agent_override_when_present() -> None:
    """AgentExecutionContext.get_tool_policy() should use per-agent overrides."""
    agent_override = {
        "tool_policy": {"mode": "denylist", "tools": ["forbidden"], "max_calls_per_request": 2}
    }
    config = AgentConfig.model_validate(
        {
            **DEFAULTS,
            "guardrails": {
                **DEFAULTS.get("guardrails", {}),
                "agent_overrides": {"special-agent": agent_override},
            },
        }
    )
    context = AgentExecutionContext(
        config=config,
        request_metadata={"agent_id": "special-agent"},
        correlation_id=str(uuid.uuid4()),
    )

    policy = context.get_tool_policy()

    assert policy.mode == "denylist", (
        "get_tool_policy() should return the per-agent override when agent_id matches"
    )
    assert "forbidden" in policy.tools, "Per-agent override tool list should be returned correctly"
    assert policy.max_calls_per_request == 2, (
        "Per-agent override max_calls_per_request should override the default"
    )


# ---------------------------------------------------------------------------
# Tests: Config changes propagate to gateway settings
# ---------------------------------------------------------------------------


def test_gateway_section_url_from_config() -> None:
    """GatewaySection.url should be set from config and available to LLMGateway."""
    gateway_config = GatewaySection(
        url="http://custom-bifrost:9000",
        default_model="openai/gpt-4o",
    )

    gateway = LLMGateway(config=gateway_config)

    assert gateway.config.url == "http://custom-bifrost:9000", (
        "LLMGateway.config.url must reflect the GatewaySection.url from the configuration"
    )


def test_gateway_section_default_model_from_config() -> None:
    """LLMGateway should use config.default_model when no model is passed per-call."""
    gateway_config = GatewaySection(
        url="http://bifrost:4000",
        default_model="anthropic/claude-haiku-4",
    )
    gateway = LLMGateway(config=gateway_config)

    assert gateway.config.default_model == "anthropic/claude-haiku-4", (
        "LLMGateway.config.default_model must reflect the configured default model"
    )


def test_gateway_section_timeout_from_config() -> None:
    """GatewaySection request_timeout_seconds should be passed through to LLMGateway."""
    gateway_config = GatewaySection(
        url="http://bifrost:4000",
        default_model="openai/gpt-4o",
        request_timeout_seconds=300,
    )
    gateway = LLMGateway(config=gateway_config)

    assert gateway.config.request_timeout_seconds == 300, (
        "LLMGateway.config.request_timeout_seconds must reflect the configured timeout"
    )


def test_gateway_config_from_agent_config_propagates() -> None:
    """config.gateway values from AgentConfig should be usable to construct LLMGateway."""
    config = AgentConfig.model_validate(
        {
            **DEFAULTS,
            "gateway": {
                "url": "http://test-gateway:4000",
                "default_model": "openai/gpt-3.5-turbo",
                "request_timeout_seconds": 60,
                "max_retries": 1,
            },
        }
    )

    gateway = LLMGateway(config=config.gateway)

    assert gateway.config.url == "http://test-gateway:4000", (
        "LLMGateway constructed from AgentConfig.gateway must use the configured URL"
    )
    assert gateway.config.default_model == "openai/gpt-3.5-turbo", (
        "LLMGateway constructed from AgentConfig.gateway must use the configured model"
    )
    assert gateway.config.max_retries == 1, (
        "LLMGateway must respect max_retries from AgentConfig.gateway"
    )


def test_gateway_retry_on_timeout_false_disables_retries() -> None:
    """retry_on_timeout=False should result in max_retries effectively being 0."""
    config = GatewaySection(
        url="http://bifrost:4000",
        default_model="openai/gpt-4o",
        retry_on_timeout=False,
        max_retries=3,  # should be ignored when retry_on_timeout=False
    )
    gateway = LLMGateway(config=config)

    # When retry_on_timeout is False, the effective retries = 0 regardless of max_retries
    assert gateway.config.retry_on_timeout is False, (
        "LLMGateway.config.retry_on_timeout must be False when configured as such"
    )


# ---------------------------------------------------------------------------
# Tests: Config changes propagate to MCP settings
# ---------------------------------------------------------------------------


def test_mcp_section_lazy_connect_from_config() -> None:
    """MCPSection.lazy_connect should be reflected in MCPManager config."""
    config = MCPSection(lazy_connect=False)
    manager = MCPManager(config=config)

    assert manager._config.lazy_connect is False, (
        "MCPManager._config.lazy_connect must reflect the configured MCPSection value"
    )


def test_mcp_section_connection_timeout_from_config() -> None:
    """MCPSection.connection_timeout_seconds should be accessible on MCPManager."""
    config = MCPSection(connection_timeout_seconds=15)
    manager = MCPManager(config=config)

    assert manager._config.connection_timeout_seconds == 15, (
        "MCPManager._config.connection_timeout_seconds must match the configured timeout"
    )


def test_mcp_section_tool_call_timeout_from_config() -> None:
    """MCPSection.tool_call_timeout_seconds should propagate to MCPToolInvoker."""
    config = MCPSection(tool_call_timeout_seconds=120)
    manager = MCPManager(config=config)

    assert manager._invoker._config.tool_call_timeout_seconds == 120, (
        "MCPToolInvoker must use the tool_call_timeout_seconds from MCPSection config"
    )


def test_mcp_section_discovery_on_connect_propagates() -> None:
    """MCPSection.discovery_on_connect should be accessible on MCPManager config."""
    config = MCPSection(discovery_on_connect=False)
    manager = MCPManager(config=config)

    assert manager._config.discovery_on_connect is False, (
        "MCPManager._config.discovery_on_connect must reflect the configured value"
    )


def test_mcp_config_from_agent_config_propagates() -> None:
    """config.mcp values from AgentConfig should be usable to construct MCPManager."""
    config = AgentConfig.model_validate(
        {
            **DEFAULTS,
            "mcp": {
                "connection_timeout_seconds": 45,
                "lazy_connect": False,
                "tool_call_timeout_seconds": 90,
            },
        }
    )

    manager = MCPManager(config=config.mcp)

    assert manager._config.connection_timeout_seconds == 45, (
        "MCPManager constructed from AgentConfig.mcp must use the configured connection timeout"
    )
    assert manager._config.lazy_connect is False, (
        "MCPManager constructed from AgentConfig.mcp must use the configured lazy_connect=False"
    )
    assert manager._config.tool_call_timeout_seconds == 90, (
        "MCPManager constructed from AgentConfig.mcp must use the configured tool call timeout"
    )


# ---------------------------------------------------------------------------
# Tests: Full 3-tier merge with all module configs
# ---------------------------------------------------------------------------


def test_three_tier_merge_all_sections(tmp_path: Path) -> None:
    """All config sections should be correctly merged across env → json → default tiers."""
    json_config = {
        "gateway": {"url": "http://json-bifrost:4000"},
        "mcp": {"connection_timeout_seconds": 20},
        "guardrails": {"fail_open": True},
    }
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps(json_config))

    env = {
        "AGENT_AGENT__TEMPERATURE": "0.2",
        "AGENT_LOGGING__LEVEL": "DEBUG",
    }
    with patch.dict(os.environ, env, clear=False):
        loader = ConfigLoader(json_config_path=str(config_path))
        config = loader.resolve()

    assert config.gateway.url == "http://json-bifrost:4000", (
        "JSON file tier must set gateway.url in the merged config"
    )
    assert config.mcp.connection_timeout_seconds == 20, (
        "JSON file tier must set mcp.connection_timeout_seconds in the merged config"
    )
    assert config.guardrails.fail_open is True, (
        "JSON file tier must set guardrails.fail_open=True in the merged config"
    )
    assert config.agent.temperature == pytest.approx(0.2), (
        "Env var tier must set agent.temperature=0.2 in the merged config"
    )
    assert config.logging.level == "DEBUG", (
        "Env var tier must set logging.level=DEBUG in the merged config"
    )


def test_defaults_are_applied_when_no_overrides(tmp_path: Path) -> None:
    """All default values should be present in a config resolved with no overrides."""
    loader = ConfigLoader(json_config_path=str(tmp_path / "nonexistent.json"))
    config = loader.resolve()

    assert config.agent.framework == DEFAULTS["agent"]["framework"], (
        "Default agent.framework must be applied when no override is present"
    )
    assert (
        config.interface.request_timeout_seconds == DEFAULTS["interface"]["request_timeout_seconds"]
    ), "Default interface.request_timeout_seconds must be applied when no override is present"
    assert config.gateway.url == DEFAULTS["gateway"]["url"], (
        "Default gateway.url must be applied when no override is present"
    )


def test_request_override_tier_wins_over_json_and_env(tmp_path: Path) -> None:
    """Request overrides (tier 3) should take precedence over JSON and env var tiers."""
    json_config = {"agent": {"temperature": 0.3}}
    config_path = tmp_path / "config.json"
    config_path.write_text(json.dumps(json_config))

    env = {"AGENT_AGENT__TEMPERATURE": "0.5"}
    with patch.dict(os.environ, env, clear=False):
        loader = ConfigLoader(json_config_path=str(config_path))
        base_config = loader.resolve()

    assert base_config.agent.temperature == pytest.approx(0.3), (
        "JSON file tier should override env var tier for the same field"
    )

    # Re-resolve with a request override — env must not re-apply during this resolve
    # so use a fresh loader without the env var active.
    loader2 = ConfigLoader(json_config_path=str(config_path))
    final_config = loader2.resolve(request_overrides={"agent": {"temperature": 0.9}})

    assert final_config.agent.temperature == pytest.approx(0.9), (
        "Request override tier must win over JSON tier for the same field"
    )


def test_interface_host_and_port_no_longer_exist(tmp_path: Path) -> None:
    """``host`` and ``port`` were removed from ``InterfaceSection`` in
    2026-05-30 because the service bind is driven by uvicorn's CLI
    flags, not the config layer. A legacy payload that still carries
    them must not raise — ``extra="allow"`` absorbs the unknown keys
    silently.
    """
    loader = ConfigLoader(json_config_path=str(tmp_path / "nonexistent.json"))
    config = loader.resolve(request_overrides={"interface": {"host": "10.0.0.5", "port": 9999}})
    assert "host" not in type(config.interface).model_fields
    assert "port" not in type(config.interface).model_fields


def test_agent_config_frozen_after_construction() -> None:
    """AgentConfig must be immutable after creation (frozen Pydantic model)."""
    from pydantic import ValidationError as PydanticValidationError

    config = AgentConfig()

    with pytest.raises((PydanticValidationError, TypeError)):
        config.agent = config.agent  # type: ignore[misc]  # noqa: B010


def test_config_sections_are_frozen_after_construction() -> None:
    """Sub-section models must also be immutable after AgentConfig is created."""
    from pydantic import ValidationError as PydanticValidationError

    config = AgentConfig()

    with pytest.raises((PydanticValidationError, TypeError)):
        config.gateway.url = "http://mutated"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Tests: Config integration with execution context
# ---------------------------------------------------------------------------


def test_execution_context_carries_full_agent_config() -> None:
    """AgentExecutionContext should expose the full AgentConfig to adapters."""
    json_section = {"agent": {"temperature": 0.42}}
    config = AgentConfig.model_validate({**DEFAULTS, **json_section})
    context = _make_context(config)

    assert context.config is config, (
        "AgentExecutionContext.config must be the exact AgentConfig instance passed in"
    )
    assert context.config.agent.temperature == pytest.approx(0.42), (
        "AgentExecutionContext.config.agent.temperature must reflect the configured value"
    )


def test_execution_context_correlation_id_is_uuid4() -> None:
    """AgentExecutionContext must auto-generate a valid UUID4 correlation_id."""
    config = AgentConfig()
    context = AgentExecutionContext(config=config)

    import re

    uuid4_pattern = re.compile(
        r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
        re.IGNORECASE,
    )
    assert uuid4_pattern.match(context.correlation_id), (
        "AgentExecutionContext must auto-generate a valid UUID4 correlation_id"
    )


def test_execution_context_rejects_invalid_correlation_id() -> None:
    """AgentExecutionContext must reject non-UUID4 correlation IDs."""
    config = AgentConfig()

    with pytest.raises(ValueError) as exc_info:
        AgentExecutionContext(config=config, correlation_id="not-a-uuid")

    assert "correlation_id" in str(exc_info.value), (
        "ValueError message should mention correlation_id when an invalid value is provided"
    )
