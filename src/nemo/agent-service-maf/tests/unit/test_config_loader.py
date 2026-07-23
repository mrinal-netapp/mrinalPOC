"""Unit tests for ConfigLoader — 3-tier configuration loading.

Tests cover:
- defaults-only resolution
- JSON overrides defaults
- env overrides defaults
- JSON overrides env (JSON > env)
- request overrides JSON (request > JSON > env > defaults)
- full three-tier merge
- env var parsing: boolean, integer, float, list, string
- env var double-underscore nesting (auth, streaming, etc.)
- invalid JSON raises ConfigurationError
- missing JSON file logs warning but doesn't crash
- validation failure (port=99999) raises ConfigurationError
- reload_json clears cache
- guardrails config merges correctly
- agent_overrides preserved in merge
- locked field in request_overrides raises ConfigurationError
- secret fields in JSON raise ConfigurationError
- empty secret fields in JSON are OK
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from agent_service_maf.config.config_loader import ConfigLoader
from agent_service_maf.config.validators import AgentConfig
from agent_service_maf.core.exceptions import ConfigurationError

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def clean_agent_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Remove all AGENT_* environment variables to prevent test pollution.

    This fixture runs before every test in this module.
    """
    import os

    agent_vars = [key for key in os.environ if key.startswith("AGENT_")]
    for var in agent_vars:
        monkeypatch.delenv(var, raising=False)


@pytest.fixture
def loader_no_json() -> ConfigLoader:
    """Return a ConfigLoader with no JSON config path."""
    return ConfigLoader()


@pytest.fixture
def json_config(tmp_path: Path) -> Path:
    """Return the path to a writable temp JSON config file (empty initially)."""
    return tmp_path / "agent_config.json"


def write_json(path: Path, data: dict[str, Any]) -> None:
    """Helper: write a dict as JSON to a path."""
    path.write_text(json.dumps(data))


# ---------------------------------------------------------------------------
# Defaults-only resolution
# ---------------------------------------------------------------------------


class TestConfigLoader_DefaultsOnly:
    """ConfigLoader.resolve() with no JSON file and no env vars uses only defaults."""

    def test_resolve_defaults_only_returns_agent_config(self, loader_no_json: ConfigLoader) -> None:
        """Resolve with no overrides should return a valid AgentConfig instance."""
        config = loader_no_json.resolve()
        assert isinstance(config, AgentConfig), (
            "resolve() with no overrides must return an AgentConfig instance"
        )

    def test_resolve_defaults_only_framework(self, loader_no_json: ConfigLoader) -> None:
        """Default framework should be 'maf'."""
        config = loader_no_json.resolve()
        assert config.agent.framework == "maf", "Default agent.framework should be 'maf'"

    def test_resolve_defaults_only_temperature(self, loader_no_json: ConfigLoader) -> None:
        """Default temperature should be 0.7."""
        config = loader_no_json.resolve()
        assert config.agent.temperature == 0.7, "Default agent.temperature should be 0.7"

    def test_resolve_defaults_only_gateway_url(self, loader_no_json: ConfigLoader) -> None:
        """Default gateway URL should be 'http://localhost:4000'."""
        config = loader_no_json.resolve()
        assert config.gateway.url == "http://localhost:4000", (
            "Default gateway.url should be 'http://localhost:4000'"
        )

    def test_resolve_defaults_only_guardrails_enabled(self, loader_no_json: ConfigLoader) -> None:
        """Default guardrails.enabled should be True."""
        config = loader_no_json.resolve()
        assert config.guardrails.enabled is True, "Default guardrails.enabled should be True"

    def test_resolve_defaults_only_auth_disabled(self, loader_no_json: ConfigLoader) -> None:
        """Default auth should be disabled."""
        config = loader_no_json.resolve()
        assert config.interface.auth.enabled is False, (
            "Default interface.auth.enabled should be False"
        )

    def test_resolve_defaults_only_no_request_overrides(self, loader_no_json: ConfigLoader) -> None:
        """Passing None as request_overrides should produce same result as no arg."""
        config_none = loader_no_json.resolve(None)
        config_no_arg = loader_no_json.resolve()
        assert config_none == config_no_arg, (
            "resolve(None) should produce same result as resolve() with no argument"
        )


# ---------------------------------------------------------------------------
# JSON overrides defaults
# ---------------------------------------------------------------------------


class TestConfigLoader_JsonOverridesDefaults:
    """JSON config file values override defaults."""

    def test_json_overrides_agent_framework(self, tmp_path: Path) -> None:
        """JSON agent.framework override should be used in resolved config."""
        json_path = tmp_path / "config.json"
        write_json(json_path, {"agent": {"framework": "echo"}})
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()
        assert config.agent.framework == "echo", "JSON override of agent.framework should be 'echo'"

    def test_json_overrides_temperature(self, tmp_path: Path) -> None:
        """JSON agent.temperature override should be used."""
        json_path = tmp_path / "config.json"
        write_json(json_path, {"agent": {"temperature": 0.2}})
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()
        assert config.agent.temperature == 0.2, "JSON override of agent.temperature should be 0.2"

    def test_json_override_preserves_unmentioned_defaults(self, tmp_path: Path) -> None:
        """Fields not mentioned in JSON should retain default values."""
        json_path = tmp_path / "config.json"
        write_json(json_path, {"agent": {"temperature": 0.5}})
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()
        assert config.agent.max_tokens == 4096, (
            "Unmentioned agent.max_tokens should retain default value of 4096"
        )
        assert config.agent.framework == "maf", (
            "Unmentioned agent.framework should retain default value of 'maf'"
        )

    def test_json_overrides_nested_auth(self, tmp_path: Path) -> None:
        """JSON can override nested auth sub-section fields."""
        json_path = tmp_path / "config.json"
        write_json(json_path, {"interface": {"auth": {"enabled": True}}})
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()
        assert config.interface.auth.enabled is True, (
            "JSON override of interface.auth.enabled should be True"
        )

    def test_json_overrides_gateway_url(self, tmp_path: Path) -> None:
        """JSON can override gateway URL."""
        json_path = tmp_path / "config.json"
        write_json(json_path, {"gateway": {"url": "http://custom-gateway:5000"}})
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()
        assert config.gateway.url == "http://custom-gateway:5000", (
            "JSON override of gateway.url should be 'http://custom-gateway:5000'"
        )

    def test_json_overrides_multiple_sections(self, tmp_path: Path) -> None:
        """JSON can override fields across multiple sections simultaneously."""
        json_path = tmp_path / "config.json"
        write_json(
            json_path,
            {
                "agent": {"model": "openai/gpt-4o"},
                "interface": {"request_timeout_seconds": 600},
                "logging": {"level": "DEBUG"},
            },
        )
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()
        assert config.agent.model == "openai/gpt-4o", (
            "JSON override of agent.model should be 'openai/gpt-4o'"
        )
        assert config.interface.request_timeout_seconds == 600, (
            "JSON override of interface.request_timeout_seconds should be 600"
        )
        assert config.logging.level == "DEBUG", "JSON override of logging.level should be 'DEBUG'"


# ---------------------------------------------------------------------------
# Env overrides defaults
# ---------------------------------------------------------------------------


class TestConfigLoader_EnvOverridesDefaults:
    """Environment variables override defaults."""

    def test_env_overrides_agent_framework(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """AGENT_AGENT__FRAMEWORK env var should override default framework."""
        monkeypatch.setenv("AGENT_AGENT__FRAMEWORK", "echo")
        loader = ConfigLoader()
        config = loader.resolve()
        assert config.agent.framework == "echo", (
            "AGENT_AGENT__FRAMEWORK env var should override default 'semantic_kernel'"
        )

    def test_env_overrides_temperature_as_float(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """AGENT_AGENT__TEMPERATURE should be parsed as a float."""
        monkeypatch.setenv("AGENT_AGENT__TEMPERATURE", "0.3")
        loader = ConfigLoader()
        config = loader.resolve()
        assert config.agent.temperature == 0.3, (
            "AGENT_AGENT__TEMPERATURE env var should be parsed as float 0.3"
        )

    def test_env_overrides_request_timeout_seconds_as_int(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """AGENT_INTERFACE__REQUEST_TIMEOUT_SECONDS should be parsed as an integer."""
        monkeypatch.setenv("AGENT_INTERFACE__REQUEST_TIMEOUT_SECONDS", "600")
        loader = ConfigLoader()
        config = loader.resolve()
        assert config.interface.request_timeout_seconds == 600, (
            "AGENT_INTERFACE__REQUEST_TIMEOUT_SECONDS env var should be parsed as int 600"
        )

    def test_env_boolean_true_lowercase(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Env var 'true' should be parsed as Python True."""
        monkeypatch.setenv("AGENT_INTERFACE__AUTH__ENABLED", "true")
        loader = ConfigLoader()
        config = loader.resolve()
        assert config.interface.auth.enabled is True, (
            "AGENT_INTERFACE__AUTH__ENABLED=true should be parsed as Python True"
        )

    def test_env_boolean_false_lowercase(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Env var 'false' should be parsed as Python False."""
        monkeypatch.setenv("AGENT_GUARDRAILS__ENABLED", "false")
        loader = ConfigLoader()
        config = loader.resolve()
        assert config.guardrails.enabled is False, (
            "AGENT_GUARDRAILS__ENABLED=false should be parsed as Python False"
        )

    def test_env_list_parsed_as_list(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Env var with JSON list syntax should be parsed as a Python list."""
        monkeypatch.setenv("AGENT_INTERFACE__AUTH__API_KEYS", '["sk-abc","sk-def"]')
        loader = ConfigLoader()
        config = loader.resolve()
        assert config.interface.auth.api_keys == ["sk-abc", "sk-def"], (
            "AGENT_INTERFACE__AUTH__API_KEYS should be parsed as list ['sk-abc', 'sk-def']"
        )

    def test_env_string_value_preserved(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Plain string env var (not valid JSON) should be used as-is."""
        monkeypatch.setenv("AGENT_AGENT__MODEL", "anthropic/claude-haiku-3")
        loader = ConfigLoader()
        config = loader.resolve()
        assert config.agent.model == "anthropic/claude-haiku-3", (
            "AGENT_AGENT__MODEL plain string should be preserved as-is"
        )

    def test_env_double_underscore_nesting_two_levels(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Double underscore nesting should work for two-level paths like agent.model."""
        monkeypatch.setenv("AGENT_GATEWAY__URL", "http://my-gateway:4000")
        loader = ConfigLoader()
        config = loader.resolve()
        assert config.gateway.url == "http://my-gateway:4000", (
            "AGENT_GATEWAY__URL double-underscore nesting should set gateway.url"
        )

    def test_env_double_underscore_nesting_three_levels(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Double underscore nesting should work for three-level paths like interface.auth.scheme."""
        monkeypatch.setenv("AGENT_INTERFACE__AUTH__SCHEME", "oauth2")
        loader = ConfigLoader()
        config = loader.resolve()
        assert config.interface.auth.scheme == "oauth2", (
            "AGENT_INTERFACE__AUTH__SCHEME should set interface.auth.scheme to 'oauth2'"
        )

    def test_env_double_underscore_nesting_streaming(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Double underscore nesting should work for streaming sub-section."""
        monkeypatch.setenv("AGENT_INTERFACE__STREAMING__MAX_DURATION_SECONDS", "600")
        loader = ConfigLoader()
        config = loader.resolve()
        assert config.interface.streaming.max_duration_seconds == 600, (
            "AGENT_INTERFACE__STREAMING__MAX_DURATION_SECONDS should set streaming.max_duration_seconds to 600"
        )

    def test_env_without_double_underscore_ignored(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """AGENT_ vars without __ separator should be silently ignored."""
        monkeypatch.setenv("AGENT_SOMEVAR", "should-be-ignored")
        loader = ConfigLoader()
        config = loader.resolve()
        # We just verify it doesn't crash and produces a valid config
        assert isinstance(config, AgentConfig), (
            "Env vars without __ separator should be silently ignored without error"
        )

    def test_env_with_unknown_section_ignored(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """AGENT_ vars with unknown top-level section should be silently ignored."""
        monkeypatch.setenv("AGENT_UNKNOWN__FIELD", "ignored")
        loader = ConfigLoader()
        config = loader.resolve()
        assert isinstance(config, AgentConfig), (
            "Env vars with unknown top-level section should be silently ignored"
        )

    def test_env_mcp_tool_call_timeout(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """AGENT_MCP__TOOL_CALL_TIMEOUT_SECONDS should set mcp.tool_call_timeout_seconds."""
        monkeypatch.setenv("AGENT_MCP__TOOL_CALL_TIMEOUT_SECONDS", "120")
        loader = ConfigLoader()
        config = loader.resolve()
        assert config.mcp.tool_call_timeout_seconds == 120, (
            "AGENT_MCP__TOOL_CALL_TIMEOUT_SECONDS should set mcp.tool_call_timeout_seconds to 120"
        )


# ---------------------------------------------------------------------------
# Priority chain: JSON > env > defaults, request > JSON > env > defaults
# ---------------------------------------------------------------------------


class TestConfigLoader_PriorityChain:
    """Tests for the full 3-tier (+ defaults) priority chain."""

    def test_json_overrides_env(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """JSON config should override environment variables (JSON > env)."""
        monkeypatch.setenv("AGENT_AGENT__TEMPERATURE", "0.1")
        json_path = tmp_path / "config.json"
        write_json(json_path, {"agent": {"temperature": 0.9}})
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()
        assert config.agent.temperature == 0.9, (
            "JSON value should override env var value (JSON > env priority)"
        )

    def test_request_overrides_json(self, tmp_path: Path) -> None:
        """Request overrides should take priority over JSON config."""
        json_path = tmp_path / "config.json"
        write_json(json_path, {"agent": {"temperature": 0.5, "framework": "echo"}})
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve(request_overrides={"agent": {"temperature": 0.9}})
        assert config.agent.framework == "echo", (
            "agent.framework from JSON should be preserved (not overridden by request)"
        )
        assert config.agent.temperature == 0.9, (
            "Request override of agent.temperature should win over JSON value"
        )

    def test_request_overrides_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Request overrides should take priority over environment variables."""
        monkeypatch.setenv("AGENT_AGENT__TEMPERATURE", "0.5")
        loader = ConfigLoader()
        config = loader.resolve(request_overrides={"agent": {"temperature": 0.1}})
        assert config.agent.temperature == 0.1, (
            "Request override of agent.temperature should win over env var value"
        )

    def test_full_three_tier_merge(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """Full priority chain: request > JSON > env > defaults."""
        # Env sets framework (overrides default)
        monkeypatch.setenv("AGENT_AGENT__FRAMEWORK", "env-framework")
        monkeypatch.setenv("AGENT_AGENT__TEMPERATURE", "0.3")

        # JSON overrides framework (JSON > env), and sets max_tokens
        json_path = tmp_path / "config.json"
        write_json(
            json_path,
            {"agent": {"framework": "json-framework", "temperature": 0.6, "max_tokens": 2048}},
        )

        # Request overrides temperature only (request > JSON > env)
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve(request_overrides={"agent": {"temperature": 0.99}})

        assert config.agent.framework == "json-framework", (
            "JSON override of framework should win over env (JSON > env priority)"
        )
        assert config.agent.temperature == 0.99, (
            "Request override of temperature should win over JSON and env"
        )
        assert config.agent.max_tokens == 2048, (
            "JSON max_tokens should be used (not overridden by request)"
        )
        assert config.agent.timeout_seconds == 120, (
            "Default timeout_seconds should be preserved when not overridden at any tier"
        )

    def test_empty_request_overrides_does_not_change_resolved(self, tmp_path: Path) -> None:
        """Empty request_overrides dict should have no effect on resolved config."""
        json_path = tmp_path / "config.json"
        write_json(json_path, {"agent": {"temperature": 0.5}})
        loader = ConfigLoader(json_config_path=json_path)
        config_no_req = loader.resolve()
        config_empty_req = loader.resolve(request_overrides={})
        assert config_no_req == config_empty_req, (
            "Empty request_overrides dict should produce same result as no request overrides"
        )


# ---------------------------------------------------------------------------
# JSON file handling
# ---------------------------------------------------------------------------


class TestConfigLoader_JsonFileHandling:
    """Tests for JSON file loading edge cases."""

    def test_missing_json_file_does_not_crash(self, tmp_path: Path) -> None:
        """A missing JSON file should log a warning and return defaults."""
        loader = ConfigLoader(json_config_path=tmp_path / "nonexistent.json")
        config = loader.resolve()
        assert isinstance(config, AgentConfig), (
            "Missing JSON file should not crash; should return valid config with defaults"
        )
        assert config.agent.framework == "maf", (
            "Missing JSON file should fall back to default framework 'maf'"
        )

    def test_none_json_path_uses_only_defaults_and_env(self) -> None:
        """ConfigLoader with json_config_path=None should skip JSON tier entirely."""
        loader = ConfigLoader(json_config_path=None)
        config = loader.resolve()
        assert isinstance(config, AgentConfig), (
            "ConfigLoader with None json_config_path should produce valid AgentConfig"
        )

    def test_update_json_data_none_falls_back_to_file_path(self, tmp_path: Path) -> None:
        """``update_json_data(None)`` drops the in-memory override; the
        loader then falls back to ``json_config_path`` if one was set
        at construction. Regression test — historically the path was
        nulled in ``__init__`` whenever ``json_config_data`` was
        supplied, making this fallback impossible.
        """
        json_path = tmp_path / "config.json"
        write_json(
            json_path,
            {"agent": {"model": "from-file/model-a", "temperature": 0.42}},
        )
        # Construct with BOTH path and data — the override wins initially.
        loader = ConfigLoader(
            json_config_path=json_path,
            json_config_data={"agent": {"model": "from-memory/model-b"}},
        )
        cfg = loader.resolve()
        assert cfg.agent.model == "from-memory/model-b", "override should win"
        # Path must still be preserved for the fallback to work.
        assert loader.json_config_path == json_path

        # Drop the override → loader falls back to the file.
        loader.update_json_data(None)
        cfg = loader.resolve()
        assert cfg.agent.model == "from-file/model-a", (
            "update_json_data(None) should fall back to json_config_path"
        )
        assert cfg.agent.temperature == pytest.approx(0.42)

    def test_invalid_json_raises_configuration_error(self, tmp_path: Path) -> None:
        """A JSON file with invalid JSON syntax should raise ConfigurationError."""
        json_path = tmp_path / "bad.json"
        json_path.write_text("{ not valid json !!!}")
        loader = ConfigLoader(json_config_path=json_path)
        with pytest.raises(ConfigurationError) as exc_info:
            loader.resolve()
        assert "Invalid JSON" in str(exc_info.value) or "json" in str(exc_info.value).lower(), (
            "ConfigurationError message should mention invalid JSON"
        )

    def test_truncated_json_raises_configuration_error(self, tmp_path: Path) -> None:
        """A truncated/incomplete JSON file should raise ConfigurationError."""
        json_path = tmp_path / "truncated.json"
        json_path.write_text('{"agent": {"framework": "echo"')  # missing closing braces
        loader = ConfigLoader(json_config_path=json_path)
        with pytest.raises(ConfigurationError):
            loader.resolve()

    def test_json_cached_on_second_resolve(self, tmp_path: Path) -> None:
        """Second call to resolve() should use cached JSON without re-reading file."""
        json_path = tmp_path / "config.json"
        write_json(json_path, {"agent": {"temperature": 0.42}})
        loader = ConfigLoader(json_config_path=json_path)
        config1 = loader.resolve()
        # Now overwrite the file
        write_json(json_path, {"agent": {"temperature": 0.99}})
        config2 = loader.resolve()
        assert config1.agent.temperature == config2.agent.temperature, (
            "Second resolve() should use cached JSON; file changes should not affect it"
        )

    def test_reload_json_clears_cache(self, tmp_path: Path) -> None:
        """reload_json() should clear the cache so next resolve() re-reads the file."""
        json_path = tmp_path / "config.json"
        write_json(json_path, {"agent": {"temperature": 0.42}})
        loader = ConfigLoader(json_config_path=json_path)
        config1 = loader.resolve()
        assert config1.agent.temperature == 0.42, (
            "First resolve() should use temperature 0.42 from JSON file"
        )
        # Overwrite and clear cache
        write_json(json_path, {"agent": {"temperature": 0.77}})
        loader.reload_json()
        config2 = loader.resolve()
        assert config2.agent.temperature == 0.77, (
            "After reload_json(), resolve() should use new temperature 0.77 from re-read file"
        )

    def test_reload_json_sets_cache_to_none(self, tmp_path: Path) -> None:
        """reload_json() should set _json_cache to None."""
        json_path = tmp_path / "config.json"
        write_json(json_path, {"agent": {"temperature": 0.5}})
        loader = ConfigLoader(json_config_path=json_path)
        loader.resolve()  # populate cache
        assert loader._json_cache is not None, "_json_cache should be populated after resolve()"
        loader.reload_json()
        assert loader._json_cache is None, "_json_cache should be None after reload_json()"


# ---------------------------------------------------------------------------
# Secret rejection in JSON files
# ---------------------------------------------------------------------------


class TestConfigLoader_SecretRejection:
    """Tests for security: secrets in JSON files should raise ConfigurationError."""

    def test_json_with_nonempty_api_key_raises_error(self, tmp_path: Path) -> None:
        """A JSON file with non-empty api_key should raise ConfigurationError."""
        json_path = tmp_path / "config.json"
        write_json(json_path, {"gateway": {"api_key": "sk-secret-key-here"}})
        loader = ConfigLoader(json_config_path=json_path)
        with pytest.raises(ConfigurationError) as exc_info:
            loader.resolve()
        assert (
            "api_key" in str(exc_info.value).lower() or "secret" in str(exc_info.value).lower()
        ), "ConfigurationError should mention the secret field or 'secret'"

    def test_json_with_nonempty_secret_field_raises_error(self, tmp_path: Path) -> None:
        """A JSON file with a field ending in _secret containing a value raises error."""
        json_path = tmp_path / "config.json"
        write_json(json_path, {"some_section": {"client_secret": "my-secret-value"}})
        loader = ConfigLoader(json_config_path=json_path)
        with pytest.raises(ConfigurationError) as exc_info:
            loader.resolve()
        error_msg = str(exc_info.value)
        assert "client_secret" in error_msg or "secret" in error_msg.lower(), (
            "ConfigurationError should mention the secret field name"
        )

    def test_json_with_nonempty_token_field_raises_error(self, tmp_path: Path) -> None:
        """A JSON file with a field ending in _token containing a value raises error."""
        json_path = tmp_path / "config.json"
        write_json(json_path, {"auth": {"access_token": "bearer-token-value"}})
        loader = ConfigLoader(json_config_path=json_path)
        with pytest.raises(ConfigurationError) as exc_info:
            loader.resolve()
        error_msg = str(exc_info.value)
        assert "access_token" in error_msg or "token" in error_msg.lower(), (
            "ConfigurationError should mention the token field name"
        )

    def test_json_with_empty_api_key_is_ok(self, tmp_path: Path) -> None:
        """A JSON file with empty string api_key should NOT raise ConfigurationError."""
        json_path = tmp_path / "config.json"
        write_json(json_path, {"gateway": {"api_key": ""}})
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()  # should not raise
        assert config.gateway.api_key == "", (
            "JSON with empty api_key should be accepted (empty string is allowed)"
        )

    def test_json_with_null_api_key_is_ok(self, tmp_path: Path) -> None:
        """A JSON file with null api_key should NOT raise ConfigurationError."""
        json_path = tmp_path / "config.json"
        write_json(json_path, {"gateway": {"api_key": None}})
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()  # should not raise
        assert isinstance(config, AgentConfig), (
            "JSON with null api_key should be accepted without error"
        )

    def test_secret_from_env_var_is_ok(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Secrets provided via env var should be accepted without error."""
        monkeypatch.setenv("AGENT_GATEWAY__API_KEY", "sk-env-secret-key")
        loader = ConfigLoader()
        config = loader.resolve()  # should not raise
        assert config.gateway.api_key == "sk-env-secret-key", (
            "Secret provided via env var should be accepted and accessible in config"
        )

    def test_secret_error_message_includes_field_path(self, tmp_path: Path) -> None:
        """ConfigurationError for secrets should include the dotted field path."""
        json_path = tmp_path / "config.json"
        write_json(json_path, {"gateway": {"api_key": "not-empty"}})
        loader = ConfigLoader(json_config_path=json_path)
        with pytest.raises(ConfigurationError) as exc_info:
            loader.resolve()
        error_msg = str(exc_info.value)
        # Error should reference the field and provide actionable guidance
        assert "gateway" in error_msg or "api_key" in error_msg, (
            "ConfigurationError message should reference the 'gateway.api_key' field path"
        )


# ---------------------------------------------------------------------------
# Locked field enforcement
# ---------------------------------------------------------------------------


class TestConfigLoader_LockedFields:
    """Tests that locked fields cannot be overridden per-request."""

    def test_locked_agent_framework_raises_error(self, loader_no_json: ConfigLoader) -> None:
        """Passing agent.framework in request_overrides should raise ConfigurationError."""
        with pytest.raises(ConfigurationError) as exc_info:
            loader_no_json.resolve(request_overrides={"agent": {"framework": "echo"}})
        error_msg = str(exc_info.value)
        assert "agent.framework" in error_msg, (
            "ConfigurationError message should mention the locked field 'agent.framework'"
        )

    def test_interface_host_override_is_silently_absorbed_into_extras(
        self, loader_no_json: ConfigLoader
    ) -> None:
        """``interface.host`` was removed from ``InterfaceSection`` in
        2026-05-30 because the bind is driven by uvicorn's CLI flag.
        A legacy payload that still sets it should not raise — it lands
        in ``__pydantic_extra__`` (the section has ``extra="allow"``)
        and is silently ignored at runtime.
        """
        config = loader_no_json.resolve(request_overrides={"interface": {"host": "192.168.1.1"}})
        assert (
            not hasattr(config.interface, "host")
            or "host" not in type(config.interface).model_fields
        )
        # No error raised — that's the contract.

    def test_interface_port_override_is_silently_absorbed_into_extras(
        self, loader_no_json: ConfigLoader
    ) -> None:
        """Symmetric with the host test — ``interface.port`` is no longer
        a real field. Setting it must not raise."""
        config = loader_no_json.resolve(request_overrides={"interface": {"port": 9090}})
        assert "port" not in type(config.interface).model_fields

    def test_non_locked_field_can_be_overridden(self, loader_no_json: ConfigLoader) -> None:
        """Non-locked fields should be overridable via request_overrides."""
        config = loader_no_json.resolve(request_overrides={"agent": {"temperature": 0.1}})
        assert config.agent.temperature == 0.1, (
            "Non-locked field agent.temperature should be overridable per-request"
        )

    def test_locked_error_message_includes_field_name(self, loader_no_json: ConfigLoader) -> None:
        """ConfigurationError for locked field should include the field name."""
        with pytest.raises(ConfigurationError) as exc_info:
            loader_no_json.resolve(request_overrides={"agent": {"framework": "echo"}})
        error_msg = str(exc_info.value)
        assert "locked" in error_msg.lower() or "agent.framework" in error_msg, (
            "Error message should mention that the field is locked"
        )

    def test_locked_field_in_nested_request_override(self, loader_no_json: ConfigLoader) -> None:
        """Locked field detected even when nested inside a larger override dict."""
        with pytest.raises(ConfigurationError):
            loader_no_json.resolve(
                request_overrides={
                    "agent": {
                        "framework": "echo",
                        "temperature": 0.5,
                    }
                }
            )

    def test_multiple_non_locked_overrides_all_applied(self, loader_no_json: ConfigLoader) -> None:
        """Multiple non-locked overrides should all be applied."""
        config = loader_no_json.resolve(
            request_overrides={
                "agent": {"temperature": 0.3, "max_tokens": 1000},
                "logging": {"level": "DEBUG"},
            }
        )
        assert config.agent.temperature == 0.3, "temperature should be overridden to 0.3"
        assert config.agent.max_tokens == 1000, "max_tokens should be overridden to 1000"
        assert config.logging.level == "DEBUG", "logging.level should be overridden to DEBUG"


# ---------------------------------------------------------------------------
# Validation failure in merged config
# ---------------------------------------------------------------------------


class TestConfigLoader_ValidationFailures:
    """Tests that invalid merged config raises ConfigurationError."""

    # Port out-of-range tests removed 2026-05-30 — InterfaceSection has
    # no ``port`` field anymore (uvicorn CLI drives the bind).

    def test_temperature_out_of_range_raises_error(self, tmp_path: Path) -> None:
        """Temperature > 2.0 in JSON should raise ConfigurationError after merge."""
        json_path = tmp_path / "config.json"
        write_json(json_path, {"agent": {"temperature": 3.0}})
        loader = ConfigLoader(json_config_path=json_path)
        with pytest.raises(ConfigurationError):
            loader.resolve()

    def test_negative_temperature_raises_error(self, tmp_path: Path) -> None:
        """Negative temperature in JSON should raise ConfigurationError after merge."""
        json_path = tmp_path / "config.json"
        write_json(json_path, {"agent": {"temperature": -0.5}})
        loader = ConfigLoader(json_config_path=json_path)
        with pytest.raises(ConfigurationError):
            loader.resolve()


# ---------------------------------------------------------------------------
# Guardrails config merging
# ---------------------------------------------------------------------------


class TestConfigLoader_GuardrailsMerge:
    """Tests for guardrails configuration merging."""

    def test_guardrails_enabled_can_be_set_false_via_json(self, tmp_path: Path) -> None:
        """Guardrails can be disabled via JSON config."""
        json_path = tmp_path / "config.json"
        write_json(json_path, {"guardrails": {"enabled": False}})
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()
        assert config.guardrails.enabled is False, (
            "guardrails.enabled should be False when set in JSON config"
        )

    def test_guardrails_fail_open_can_be_set_via_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """guardrails.fail_open can be set via env var."""
        monkeypatch.setenv("AGENT_GUARDRAILS__FAIL_OPEN", "true")
        loader = ConfigLoader()
        config = loader.resolve()
        assert config.guardrails.fail_open is True, (
            "AGENT_GUARDRAILS__FAIL_OPEN=true should set guardrails.fail_open to True"
        )

    def test_guardrails_tool_guardrails_mode_set_via_json(self, tmp_path: Path) -> None:
        """tool_guardrails.mode can be set via JSON config."""
        json_path = tmp_path / "config.json"
        write_json(
            json_path,
            {
                "guardrails": {
                    "tool_guardrails": {
                        "mode": "allowlist",
                        "tools": ["search", "calculator"],
                        "max_calls_per_request": 5,
                    }
                }
            },
        )
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()
        assert config.guardrails.tool_guardrails.mode == "allowlist", (
            "tool_guardrails.mode should be 'allowlist' from JSON"
        )
        assert config.guardrails.tool_guardrails.tools == ["search", "calculator"], (
            "tool_guardrails.tools should match JSON list"
        )

    def test_guardrails_agent_overrides_preserved_in_json(self, tmp_path: Path) -> None:
        """Per-agent guardrail overrides in JSON config are preserved in resolved config."""
        json_path = tmp_path / "config.json"
        write_json(
            json_path,
            {
                "guardrails": {
                    "agent_overrides": {
                        "my-agent": {
                            "input_guardrails": [
                                {
                                    "name": "custom_input",
                                    "enabled": True,
                                    "action_on_trigger": "warn",
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
        assert "my-agent" in config.guardrails.agent_overrides, (
            "Per-agent override key 'my-agent' should be present in resolved guardrails.agent_overrides"
        )
        override = config.guardrails.agent_overrides["my-agent"]
        assert len(override.input_guardrails) == 1, (
            "my-agent override should have exactly 1 input guardrail"
        )
        assert override.input_guardrails[0].name == "custom_input", (
            "my-agent override input guardrail name should be 'custom_input'"
        )

    def test_guardrails_input_rules_replaced_by_json_list(self, tmp_path: Path) -> None:
        """JSON list for input_guardrails replaces defaults (list replacement rule)."""
        json_path = tmp_path / "config.json"
        custom_rules = [
            {
                "name": "only_rule",
                "enabled": True,
                "action_on_trigger": "block",
                "config": {},
            }
        ]
        write_json(json_path, {"guardrails": {"input_guardrails": custom_rules}})
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()
        assert len(config.guardrails.input_guardrails) == 1, (
            "JSON list for input_guardrails should replace (not append to) defaults"
        )
        assert config.guardrails.input_guardrails[0].name == "only_rule", (
            "The single input guardrail should be 'only_rule' from JSON"
        )
