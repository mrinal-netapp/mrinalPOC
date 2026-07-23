"""Unit tests for the 3-tier configuration system."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_service_maf.config.config_loader import ConfigLoader, deep_merge
from agent_service_maf.config.validators import AgentConfig
from agent_service_maf.core.exceptions import ConfigurationError


class TestDeepMerge:
    """Tests for the deep_merge utility."""

    def test_flat_merge(self) -> None:
        base = {"a": 1, "b": 2}
        override = {"b": 3, "c": 4}
        result = deep_merge(base, override)
        assert result == {"a": 1, "b": 3, "c": 4}

    def test_nested_merge(self) -> None:
        base = {"a": {"x": 1, "y": 2}, "b": 3}
        override = {"a": {"y": 99, "z": 100}}
        result = deep_merge(base, override)
        assert result == {"a": {"x": 1, "y": 99, "z": 100}, "b": 3}

    def test_none_values_skipped(self) -> None:
        base = {"a": 1, "b": 2}
        override = {"a": None, "b": 3}
        result = deep_merge(base, override)
        assert result == {"a": 1, "b": 3}

    def test_list_replaced_not_appended(self) -> None:
        base = {"a": [1, 2, 3]}
        override = {"a": [4, 5]}
        result = deep_merge(base, override)
        assert result == {"a": [4, 5]}

    def test_does_not_mutate_inputs(self) -> None:
        base = {"a": {"x": 1}}
        override = {"a": {"y": 2}}
        deep_merge(base, override)
        assert base == {"a": {"x": 1}}
        assert override == {"a": {"y": 2}}


class TestConfigLoader:
    """Tests for the ConfigLoader 3-tier merge."""

    def test_defaults_only(self) -> None:
        """With no overrides, defaults should be used."""
        loader = ConfigLoader()
        config = loader.resolve()
        assert isinstance(config, AgentConfig)
        assert config.agent.framework == "maf"
        assert config.agent.temperature == 0.7

    def test_json_overrides_defaults(self, tmp_path: Path) -> None:
        """JSON config should override defaults."""
        json_path = tmp_path / "config.json"
        json_path.write_text(json.dumps({"agent": {"framework": "echo", "temperature": 0.5}}))
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve()
        assert config.agent.framework == "echo"
        assert config.agent.temperature == 0.5
        # Non-overridden values use defaults
        assert config.agent.max_tokens == 4096

    def test_env_overrides_defaults(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Environment variables should override defaults."""
        monkeypatch.setenv("AGENT_AGENT__FRAMEWORK", "echo")
        monkeypatch.setenv("AGENT_AGENT__TEMPERATURE", "0.3")
        loader = ConfigLoader()
        config = loader.resolve()
        assert config.agent.framework == "echo"
        assert config.agent.temperature == 0.3

    def test_request_overrides_json(self, tmp_path: Path) -> None:
        """Request overrides should take highest priority over JSON."""
        json_path = tmp_path / "config.json"
        json_path.write_text(json.dumps({"agent": {"framework": "echo", "temperature": 0.5}}))
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve(request_overrides={"agent": {"temperature": 0.9}})
        assert config.agent.framework == "echo"  # from JSON
        assert config.agent.temperature == 0.9  # from request

    def test_full_priority_chain(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """Request > JSON > env > defaults — full chain test."""
        # Env sets framework
        monkeypatch.setenv("AGENT_AGENT__FRAMEWORK", "from-env")
        # JSON overrides framework, sets temperature
        json_path = tmp_path / "config.json"
        json_path.write_text(json.dumps({"agent": {"framework": "from-json", "temperature": 0.5}}))
        # Request overrides temperature
        loader = ConfigLoader(json_config_path=json_path)
        config = loader.resolve(request_overrides={"agent": {"temperature": 0.1}})
        assert config.agent.framework == "from-json"  # JSON > env
        assert config.agent.temperature == 0.1  # request > JSON

    def test_invalid_json_raises_error(self, tmp_path: Path) -> None:
        """Invalid JSON should raise ConfigurationError."""
        json_path = tmp_path / "bad.json"
        json_path.write_text("{ invalid json }")
        loader = ConfigLoader(json_config_path=json_path)
        with pytest.raises(ConfigurationError):
            loader.resolve()

    def test_missing_json_uses_defaults(self) -> None:
        """Missing JSON file should fall back to defaults."""
        loader = ConfigLoader(json_config_path="/nonexistent/path.json")
        config = loader.resolve()
        assert config.agent.framework == "maf"  # default


class TestAgentConfigValidation:
    """Tests for Pydantic config validation."""

    def test_temperature_bounds(self) -> None:
        with pytest.raises(Exception):
            AgentConfig(agent={"temperature": -1.0})

    # ``port`` bounds test removed 2026-05-30 — InterfaceSection has no
    # ``port`` field anymore (uvicorn CLI drives the bind).

    def test_valid_config(self) -> None:
        config = AgentConfig(agent={"framework": "maf", "temperature": 1.0, "max_tokens": 2048})
        assert config.agent.temperature == 1.0
        assert config.agent.max_tokens == 2048
