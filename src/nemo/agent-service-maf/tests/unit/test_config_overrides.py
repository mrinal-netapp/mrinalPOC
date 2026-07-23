"""Unit tests for §A3 / §B6 / §B7 typed ``ConfigOverrides`` plumbing.

Coverage:

- Loose validation: unknown fields silently dropped (``extra="ignore"``).
- Range validation on known fields (``temperature`` 0..2, ``max_tokens`` 1..200_000).
- Camel and snake input both validate.
- ``agentOverrides`` map carries typed :class:`AgentConfigOverride` entries.
- :func:`apply_per_agent_overrides` precedence:
  * Single-agent invoke: top-level overrides write onto the lone
    ``SKAgentDefinition``; ``agentOverrides`` is **ignored**.
  * Team invoke: ``agentOverrides[name]`` writes onto the matching
    member; unknown names are silently dropped.
- :func:`config_overrides_to_request_dict` produces only the keys
  present on the override (loader merge friendliness).
- :func:`config_overrides_to_agent_request_dict` produces an
  ``AgentRequest``-friendly snake-case dict that omits ``None`` values.
- :class:`NoopModelCatalog` accepts any non-empty model id and returns
  ``None`` for empty input.
- :func:`validate_overrides_against_catalog` calls the catalog for the
  top-level model and each per-agent model exactly once.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent_service_maf.config._override_applier import (
    apply_per_agent_overrides,
    config_overrides_to_agent_request_dict,
    config_overrides_to_request_dict,
    validate_overrides_against_catalog,
)
from agent_service_maf.config.model_catalog import ModelInfo, NoopModelCatalog
from agent_service_maf.interface_layer.models import (
    AgentConfigOverride,
    ConfigOverrides,
)

# ---------------------------------------------------------------------------
# ConfigOverrides (Pydantic) validation
# ---------------------------------------------------------------------------


class TestConfigOverridesValidation:
    def test_empty_construction(self) -> None:
        o = ConfigOverrides()
        assert o.model is None
        assert o.temperature is None
        assert o.max_tokens is None
        assert o.agent_overrides is None

    def test_all_fields_set(self) -> None:
        o = ConfigOverrides(
            model="claude-sonnet",
            temperature=0.5,
            max_tokens=4000,
            agent_overrides={
                "specialist": AgentConfigOverride(model="claude-opus"),
            },
        )
        assert o.model == "claude-sonnet"
        assert o.temperature == 0.5
        assert o.max_tokens == 4000
        assert o.agent_overrides is not None
        assert o.agent_overrides["specialist"].model == "claude-opus"

    def test_unknown_field_silently_ignored(self) -> None:
        """Loose validation per §5.1.1 -- unknown keys never raise."""
        o = ConfigOverrides.model_validate({"model": "x", "foo": "bar"})
        assert o.model == "x"
        assert not hasattr(o, "foo")

    def test_temperature_out_of_range_rejects(self) -> None:
        with pytest.raises(Exception):
            ConfigOverrides(temperature=3.5)
        with pytest.raises(Exception):
            ConfigOverrides(temperature=-0.1)

    def test_max_tokens_out_of_range_rejects(self) -> None:
        with pytest.raises(Exception):
            ConfigOverrides(max_tokens=0)
        with pytest.raises(Exception):
            ConfigOverrides(max_tokens=200_001)

    def test_camel_input_accepted(self) -> None:
        o = ConfigOverrides.model_validate(
            {"maxTokens": 100, "agentOverrides": {"a": {"maxTokens": 50}}}
        )
        assert o.max_tokens == 100
        assert o.agent_overrides is not None
        assert o.agent_overrides["a"].max_tokens == 50

    def test_agent_override_unknown_field_dropped(self) -> None:
        o = AgentConfigOverride.model_validate({"model": "x", "junk": True})
        assert o.model == "x"


# ---------------------------------------------------------------------------
# Translation helpers
# ---------------------------------------------------------------------------


class TestRequestDictTranslation:
    def test_none_yields_empty_dict(self) -> None:
        assert config_overrides_to_request_dict(None) == {}

    def test_only_set_fields_appear(self) -> None:
        o = ConfigOverrides(model="claude-sonnet", temperature=0.5)
        d = config_overrides_to_request_dict(o)
        assert d == {"agent": {"model": "claude-sonnet", "temperature": 0.5}}

    def test_empty_overrides_yield_empty_dict(self) -> None:
        d = config_overrides_to_request_dict(ConfigOverrides())
        assert d == {}

    def test_max_tokens_translates(self) -> None:
        d = config_overrides_to_request_dict(ConfigOverrides(max_tokens=4000))
        assert d == {"agent": {"max_tokens": 4000}}

    def test_agent_overrides_not_in_loader_dict(self) -> None:
        """Per-agent overrides are applied separately, not via the loader."""
        o = ConfigOverrides(
            model="x",
            agent_overrides={"a1": AgentConfigOverride(model="y")},
        )
        d = config_overrides_to_request_dict(o)
        assert "agentOverrides" not in d
        assert "agent_overrides" not in d


class TestAgentRequestDictTranslation:
    def test_none_yields_empty_dict(self) -> None:
        assert config_overrides_to_agent_request_dict(None) == {}

    def test_snake_case_and_excludes_none(self) -> None:
        o = ConfigOverrides(model="claude-sonnet", temperature=0.5)
        d = config_overrides_to_agent_request_dict(o)
        assert d == {"model": "claude-sonnet", "temperature": 0.5}
        assert "max_tokens" not in d, "None values excluded"

    def test_includes_agent_overrides(self) -> None:
        o = ConfigOverrides(
            model="x",
            agent_overrides={"specialist": AgentConfigOverride(model="y", temperature=0.1)},
        )
        d = config_overrides_to_agent_request_dict(o)
        assert d["model"] == "x"
        assert d["agent_overrides"] == {"specialist": {"model": "y", "temperature": 0.1}}


# ---------------------------------------------------------------------------
# apply_per_agent_overrides — single-agent vs team invoke
# ---------------------------------------------------------------------------


def _make_config_with_agents(
    agent_names: list[str],
    orchestration_type: str = "single",
) -> Any:
    """Build a minimal AgentConfig containing the requested SK agents.

    Uses the conftest ``make_config`` helper indirectly via the default
    config + nested override pattern. Returns a frozen AgentConfig.
    """
    from agent_service_maf.config.config_loader import deep_merge
    from agent_service_maf.config.defaults import DEFAULTS
    from agent_service_maf.config.validators import AgentConfig

    agents = [
        {"name": name, "instructions": f"I am {name}.", "model": "default-model"}
        for name in agent_names
    ]
    orchestration: dict[str, Any] = {"type": orchestration_type}
    if orchestration_type == "group_chat":
        orchestration.update({"manager_model": "manager-default", "manager_temperature": 0.5})
    overrides = {
        "semantic_kernel": {"agents": agents, "orchestration": orchestration},
    }
    merged = deep_merge(DEFAULTS, overrides)
    return AgentConfig(**merged)


class TestApplyOverridesSingleAgent:
    def test_top_level_writes_to_lone_member(self) -> None:
        config = _make_config_with_agents(["solo"])
        overrides = ConfigOverrides(model="claude-opus", temperature=0.2, max_tokens=2000)
        out = apply_per_agent_overrides(config, overrides, is_team_invoke=False)
        member = out.semantic_kernel.agents[0]
        assert member.model == "claude-opus"
        assert member.temperature == 0.2
        assert member.max_tokens == 2000

    def test_agent_overrides_ignored_in_single_agent(self) -> None:
        config = _make_config_with_agents(["solo"])
        overrides = ConfigOverrides(
            agent_overrides={
                "solo": AgentConfigOverride(model="other-model"),
            },
        )
        out = apply_per_agent_overrides(config, overrides, is_team_invoke=False)
        # agentOverrides silently dropped in single-agent mode.
        assert out.semantic_kernel.agents[0].model == "default-model"

    def test_none_overrides_returns_same_config(self) -> None:
        config = _make_config_with_agents(["solo"])
        out = apply_per_agent_overrides(config, None, is_team_invoke=False)
        assert out is config


class TestApplyOverridesTeam:
    def test_per_agent_writes_to_matching_member_only(self) -> None:
        config = _make_config_with_agents(["a1", "a2", "a3"])
        overrides = ConfigOverrides(
            agent_overrides={
                "a2": AgentConfigOverride(model="opus", temperature=0.1),
            },
        )
        out = apply_per_agent_overrides(config, overrides, is_team_invoke=True)
        agents = out.semantic_kernel.agents
        assert agents[0].model == "default-model", "a1 untouched"
        assert agents[1].model == "opus", "a2 overridden"
        assert agents[1].temperature == 0.1
        assert agents[2].model == "default-model", "a3 untouched"

    def test_unknown_agent_name_silently_dropped(self) -> None:
        config = _make_config_with_agents(["a1"])
        overrides = ConfigOverrides(
            agent_overrides={
                "unknown": AgentConfigOverride(model="opus"),
            },
        )
        out = apply_per_agent_overrides(config, overrides, is_team_invoke=True)
        assert out.semantic_kernel.agents[0].model == "default-model"

    def test_group_chat_manager_overridden(self) -> None:
        config = _make_config_with_agents(["a1"], orchestration_type="group_chat")
        overrides = ConfigOverrides(model="opus", temperature=0.7)
        out = apply_per_agent_overrides(config, overrides, is_team_invoke=True)
        orch = out.semantic_kernel.orchestration
        assert orch.manager_model == "opus"
        assert orch.manager_temperature == 0.7


# ---------------------------------------------------------------------------
# Model catalog stub
# ---------------------------------------------------------------------------


class TestNoopModelCatalog:
    @pytest.mark.asyncio
    async def test_returns_none_on_empty_id(self) -> None:
        cat = NoopModelCatalog()
        assert await cat.resolve_model_info("p1", "") is None

    @pytest.mark.asyncio
    async def test_accepts_any_non_empty_id(self) -> None:
        cat = NoopModelCatalog()
        info = await cat.resolve_model_info("p1", "anything-goes")
        assert isinstance(info, ModelInfo)
        assert info.model_id == "anything-goes"
        assert info.allowed is True
        assert info.is_embedding is False


class TestValidateOverridesAgainstCatalog:
    @pytest.mark.asyncio
    async def test_none_overrides_skips_catalog(self) -> None:
        cat = MagicMock()
        cat.resolve_model_info = AsyncMock()
        await validate_overrides_against_catalog(None, cat, "p1")
        assert cat.resolve_model_info.await_count == 0

    @pytest.mark.asyncio
    async def test_top_level_model_resolved(self) -> None:
        cat = MagicMock()
        cat.resolve_model_info = AsyncMock(
            return_value=ModelInfo(model_id="x", is_embedding=False, allowed=True)
        )
        overrides = ConfigOverrides(model="x")
        await validate_overrides_against_catalog(overrides, cat, "proj-1")
        cat.resolve_model_info.assert_awaited_once_with("proj-1", "x")

    @pytest.mark.asyncio
    async def test_per_agent_models_each_resolved(self) -> None:
        cat = MagicMock()
        cat.resolve_model_info = AsyncMock(
            return_value=ModelInfo(model_id="?", is_embedding=False, allowed=True)
        )
        overrides = ConfigOverrides(
            model="top-model",
            agent_overrides={
                "a1": AgentConfigOverride(model="m1"),
                "a2": AgentConfigOverride(model="m2"),
                "a3": AgentConfigOverride(temperature=0.5),  # no model => no catalog call
            },
        )
        await validate_overrides_against_catalog(overrides, cat, "proj-1")
        # 1 top-level + 2 per-agent (a3 has no model)
        assert cat.resolve_model_info.await_count == 3
        called_models = [call.args[1] for call in cat.resolve_model_info.await_args_list]
        assert sorted(called_models) == ["m1", "m2", "top-model"]
