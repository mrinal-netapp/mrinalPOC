"""Unit tests for GuardrailRegistry.

Tests cover:
- @register_input / @register_output / @register_tool decorators
- Registered classes retrievable via internal dicts
- Duplicate name overwrites silently
- Empty name raises ValueError for all three decorators
- list_input_guardrails / list_output_guardrails / list_tool_guardrails
- build_pipeline with disabled guardrails (passthrough)
- build_pipeline with enabled guardrails and known names
- build_pipeline raises ConfigurationError for unknown names
- build_pipeline with disabled rules skips them silently
- per-agent overrides respected by build_pipeline
- fail_open propagated to pipeline
"""

from __future__ import annotations

from typing import Any

import pytest

from agent_service_maf.config.validators import (
    AgentGuardrailConfig,
    GuardrailRule,
    GuardrailSection,
)
from agent_service_maf.core.exceptions import ConfigurationError
from agent_service_maf.guardrails.base import (
    GuardrailAction,
    GuardrailContext,
    GuardrailResult,
    InputGuardrail,
    OutputGuardrail,
    ToolGuardrail,
)
from agent_service_maf.guardrails.pipeline import GuardrailPipeline
from agent_service_maf.guardrails.registry import GuardrailRegistry

# ---------------------------------------------------------------------------
# Helpers — minimal concrete guardrail classes (not registered globally)
# ---------------------------------------------------------------------------


def _make_input_class(name: str) -> type[InputGuardrail]:
    """Create a minimal InputGuardrail subclass with the given name."""

    class _Guard(InputGuardrail):
        @property
        def name(self) -> str:
            return name

        async def check(self, ctx: GuardrailContext) -> GuardrailResult:
            return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

    _Guard.__name__ = f"InputGuard_{name}"
    return _Guard


def _make_output_class(name: str) -> type[OutputGuardrail]:
    """Create a minimal OutputGuardrail subclass with the given name."""

    class _Guard(OutputGuardrail):
        @property
        def name(self) -> str:
            return name

        async def check(self, ctx: GuardrailContext) -> GuardrailResult:
            return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

    _Guard.__name__ = f"OutputGuard_{name}"
    return _Guard


def _make_tool_class(name: str) -> type[ToolGuardrail]:
    """Create a minimal ToolGuardrail subclass with the given name."""

    class _Guard(ToolGuardrail):
        def __init__(self, config: dict[str, Any] | None = None, **kwargs: Any) -> None:
            pass

        @property
        def name(self) -> str:
            return name

        async def check(self, ctx: GuardrailContext) -> GuardrailResult:
            return GuardrailResult(action=GuardrailAction.ALLOW, guardrail_name=self.name)

    _Guard.__name__ = f"ToolGuard_{name}"
    return _Guard


# ---------------------------------------------------------------------------
# Fixtures — isolated registry state
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def isolated_registry() -> None:
    """Snapshot and restore registry state around each test.

    Prevents test pollution from cross-test decorator registrations.
    """
    saved_input = dict(GuardrailRegistry._input_guardrails)
    saved_output = dict(GuardrailRegistry._output_guardrails)
    saved_tool = dict(GuardrailRegistry._tool_guardrails)
    yield
    GuardrailRegistry._input_guardrails = saved_input
    GuardrailRegistry._output_guardrails = saved_output
    GuardrailRegistry._tool_guardrails = saved_tool


# ---------------------------------------------------------------------------
# Decorator registration
# ---------------------------------------------------------------------------


class TestRegisterInputDecorator:
    """Tests for GuardrailRegistry.register_input."""

    def test_registers_class_under_given_name(self) -> None:
        """Decorated class must appear in _input_guardrails under the given key."""
        klass = _make_input_class("reg_input_test")
        GuardrailRegistry.register_input("reg_input_test")(klass)
        assert "reg_input_test" in GuardrailRegistry._input_guardrails, (
            "Registered class must be in _input_guardrails"
        )
        assert GuardrailRegistry._input_guardrails["reg_input_test"] is klass, (
            "Registered class must be the exact class passed to the decorator"
        )

    def test_returns_class_unchanged(self) -> None:
        """Decorator must return the class itself for decorator chaining."""
        klass = _make_input_class("ret_input")
        returned = GuardrailRegistry.register_input("ret_input")(klass)
        assert returned is klass, "Decorator must return the original class"

    def test_empty_name_raises_value_error(self) -> None:
        """Empty string name must raise ValueError."""
        with pytest.raises(ValueError, match="non-empty"):
            GuardrailRegistry.register_input("")

    def test_duplicate_name_overwrites(self) -> None:
        """Registering the same name twice must overwrite without error."""
        k1 = _make_input_class("dup_input")
        k2 = _make_input_class("dup_input")
        GuardrailRegistry.register_input("dup_input")(k1)
        GuardrailRegistry.register_input("dup_input")(k2)
        assert GuardrailRegistry._input_guardrails["dup_input"] is k2, (
            "Second registration must overwrite the first"
        )


class TestRegisterOutputDecorator:
    """Tests for GuardrailRegistry.register_output."""

    def test_registers_class_under_given_name(self) -> None:
        """Decorated class must appear in _output_guardrails under the given key."""
        klass = _make_output_class("reg_output_test")
        GuardrailRegistry.register_output("reg_output_test")(klass)
        assert "reg_output_test" in GuardrailRegistry._output_guardrails, (
            "Registered class must be in _output_guardrails"
        )

    def test_returns_class_unchanged(self) -> None:
        """Decorator must return the class itself."""
        klass = _make_output_class("ret_output")
        returned = GuardrailRegistry.register_output("ret_output")(klass)
        assert returned is klass, "Output decorator must return the original class"

    def test_empty_name_raises_value_error(self) -> None:
        """Empty string name must raise ValueError."""
        with pytest.raises(ValueError, match="non-empty"):
            GuardrailRegistry.register_output("")

    def test_duplicate_name_overwrites(self) -> None:
        """Registering same name twice must silently overwrite."""
        k1 = _make_output_class("dup_out")
        k2 = _make_output_class("dup_out")
        GuardrailRegistry.register_output("dup_out")(k1)
        GuardrailRegistry.register_output("dup_out")(k2)
        assert GuardrailRegistry._output_guardrails["dup_out"] is k2, (
            "Second registration must be the active one"
        )


class TestRegisterToolDecorator:
    """Tests for GuardrailRegistry.register_tool."""

    def test_registers_class_under_given_name(self) -> None:
        """Decorated class must appear in _tool_guardrails under the given key."""
        klass = _make_tool_class("reg_tool_test")
        GuardrailRegistry.register_tool("reg_tool_test")(klass)
        assert "reg_tool_test" in GuardrailRegistry._tool_guardrails, (
            "Registered class must be in _tool_guardrails"
        )

    def test_returns_class_unchanged(self) -> None:
        """Decorator must return the class itself."""
        klass = _make_tool_class("ret_tool")
        returned = GuardrailRegistry.register_tool("ret_tool")(klass)
        assert returned is klass, "Tool decorator must return the original class"

    def test_empty_name_raises_value_error(self) -> None:
        """Empty string name must raise ValueError."""
        with pytest.raises(ValueError, match="non-empty"):
            GuardrailRegistry.register_tool("")

    def test_duplicate_name_overwrites(self) -> None:
        """Registering same name twice must silently overwrite."""
        k1 = _make_tool_class("dup_tool")
        k2 = _make_tool_class("dup_tool")
        GuardrailRegistry.register_tool("dup_tool")(k1)
        GuardrailRegistry.register_tool("dup_tool")(k2)
        assert GuardrailRegistry._tool_guardrails["dup_tool"] is k2, (
            "Second tool registration must be the active one"
        )


# ---------------------------------------------------------------------------
# Introspection — list_* methods
# ---------------------------------------------------------------------------


class TestListMethods:
    """Tests for registry introspection methods."""

    def test_list_input_guardrails_returns_sorted(self) -> None:
        """list_input_guardrails must return a sorted list."""
        GuardrailRegistry.register_input("zzz_input")(_make_input_class("zzz_input"))
        GuardrailRegistry.register_input("aaa_input")(_make_input_class("aaa_input"))
        names = GuardrailRegistry.list_input_guardrails()
        assert names == sorted(names), "list_input_guardrails must return a sorted list"
        assert "zzz_input" in names, "Registered name must appear in list"
        assert "aaa_input" in names, "Registered name must appear in list"

    def test_list_output_guardrails_returns_sorted(self) -> None:
        """list_output_guardrails must return a sorted list."""
        GuardrailRegistry.register_output("zzz_out")(_make_output_class("zzz_out"))
        GuardrailRegistry.register_output("aaa_out")(_make_output_class("aaa_out"))
        names = GuardrailRegistry.list_output_guardrails()
        assert names == sorted(names), "list_output_guardrails must return a sorted list"

    def test_list_tool_guardrails_returns_sorted(self) -> None:
        """list_tool_guardrails must return a sorted list."""
        GuardrailRegistry.register_tool("zzz_tool")(_make_tool_class("zzz_tool"))
        GuardrailRegistry.register_tool("aaa_tool")(_make_tool_class("aaa_tool"))
        names = GuardrailRegistry.list_tool_guardrails()
        assert names == sorted(names), "list_tool_guardrails must return a sorted list"


# ---------------------------------------------------------------------------
# build_pipeline
# ---------------------------------------------------------------------------


class TestBuildPipeline:
    """Tests for GuardrailRegistry.build_pipeline."""

    def test_disabled_guardrails_returns_passthrough_pipeline(self) -> None:
        """When config.enabled=False, build_pipeline must return an empty pipeline."""
        config = GuardrailSection(enabled=False)
        pipeline = GuardrailRegistry.build_pipeline(config, agent_id="any-agent")
        assert isinstance(pipeline, GuardrailPipeline), (
            "build_pipeline must always return a GuardrailPipeline"
        )

    def test_disabled_guardrails_pipeline_has_no_guardrails(self) -> None:
        """Passthrough pipeline must have no input, output, or tool guardrails."""
        config = GuardrailSection(enabled=False)
        pipeline = GuardrailRegistry.build_pipeline(config, agent_id="")
        # Pipeline must pass content through without modification. Use
        # ``asyncio.run`` instead of ``get_event_loop().run_until_complete``
        # so the test does not depend on a pre-existing event loop --
        # earlier suites in the same process can close the default loop
        # and trigger ``RuntimeError: There is no current event loop``.
        import asyncio

        result = asyncio.run(pipeline.check_input("test", "agent"))
        assert result == "test", "Passthrough pipeline must return input unchanged"

    def test_enabled_with_known_input_guardrail(self) -> None:
        """build_pipeline must instantiate a registered input guardrail by name."""
        klass = _make_input_class("known_input_guard")
        GuardrailRegistry.register_input("known_input_guard")(klass)
        config = GuardrailSection(
            enabled=True,
            input_guardrails=[GuardrailRule(name="known_input_guard")],
        )
        pipeline = GuardrailRegistry.build_pipeline(config)
        assert isinstance(pipeline, GuardrailPipeline), (
            "build_pipeline must return a GuardrailPipeline for enabled config"
        )

    def test_unknown_input_guardrail_raises_configuration_error(self) -> None:
        """Unknown input guardrail name must raise ConfigurationError."""
        config = GuardrailSection(
            enabled=True,
            input_guardrails=[GuardrailRule(name="nonexistent_guardrail_xyz")],
        )
        with pytest.raises(ConfigurationError, match="nonexistent_guardrail_xyz"):
            GuardrailRegistry.build_pipeline(config)

    def test_unknown_output_guardrail_raises_configuration_error(self) -> None:
        """Unknown output guardrail name must raise ConfigurationError."""
        config = GuardrailSection(
            enabled=True,
            output_guardrails=[GuardrailRule(name="nonexistent_output_xyz")],
        )
        with pytest.raises(ConfigurationError, match="nonexistent_output_xyz"):
            GuardrailRegistry.build_pipeline(config)

    def test_disabled_rule_is_skipped(self) -> None:
        """A GuardrailRule with enabled=False must be silently skipped."""
        klass = _make_input_class("skipped_guard")
        GuardrailRegistry.register_input("skipped_guard")(klass)
        config = GuardrailSection(
            enabled=True,
            input_guardrails=[GuardrailRule(name="skipped_guard", enabled=False)],
        )
        # Must not raise even though the rule exists but is disabled
        pipeline = GuardrailRegistry.build_pipeline(config)
        assert isinstance(pipeline, GuardrailPipeline), "Disabled rules must be silently skipped"

    def test_fail_open_propagated_to_pipeline(self) -> None:
        """fail_open=True in config must be passed to the pipeline."""
        config = GuardrailSection(enabled=False, fail_open=True)
        pipeline = GuardrailRegistry.build_pipeline(config)
        assert pipeline._fail_open is True, "fail_open must be propagated from config to pipeline"

    def test_per_agent_override_replaces_defaults(self) -> None:
        """Per-agent override input_guardrails must replace global defaults."""
        default_klass = _make_input_class("default_guard")
        override_klass = _make_input_class("override_guard")
        GuardrailRegistry.register_input("default_guard")(default_klass)
        GuardrailRegistry.register_input("override_guard")(override_klass)
        config = GuardrailSection(
            enabled=True,
            input_guardrails=[GuardrailRule(name="default_guard")],
            agent_overrides={
                "special-agent": AgentGuardrailConfig(
                    input_guardrails=[GuardrailRule(name="override_guard")]
                )
            },
        )
        pipeline = GuardrailRegistry.build_pipeline(config, agent_id="special-agent")
        assert isinstance(pipeline, GuardrailPipeline), (
            "build_pipeline with agent override must succeed"
        )

    def test_agent_without_override_uses_defaults(self) -> None:
        """Agent not in agent_overrides must use default guardrails."""
        klass = _make_input_class("default_only_guard")
        GuardrailRegistry.register_input("default_only_guard")(klass)
        config = GuardrailSection(
            enabled=True,
            input_guardrails=[GuardrailRule(name="default_only_guard")],
            agent_overrides={},
        )
        pipeline = GuardrailRegistry.build_pipeline(config, agent_id="no-override-agent")
        assert isinstance(pipeline, GuardrailPipeline), (
            "Agent without override must use default guardrails"
        )

    def test_enabled_config_with_no_rules_returns_empty_pipeline(self) -> None:
        """Enabled config with zero rules must produce a pipeline with no guardrails."""
        config = GuardrailSection(
            enabled=True,
            input_guardrails=[],
            output_guardrails=[],
        )
        pipeline = GuardrailRegistry.build_pipeline(config)
        assert isinstance(pipeline, GuardrailPipeline), (
            "Empty rules must still produce a valid pipeline"
        )
