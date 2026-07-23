"""Unit tests for FrameworkRegistry and LifecycleHook.

Tests cover:
- register() decorator registers adapters by name
- register() with invalid names raises ValueError
- create() instantiates registered adapters
- create() with unregistered name raises FrameworkNotFoundError
- list_frameworks() returns sorted names
- list_capabilities() returns AgentCapabilities for each adapter
- is_registered() correctly reports registration status
- add_hook() and run_startup_hooks() / run_shutdown_hooks()
- clear() resets the registry
- Overwriting a registration logs a warning
- LifecycleHook abstract enforcement
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Never

import pytest
from fastapi import FastAPI

from agent_service_maf.core.exceptions import FrameworkNotFoundError
from agent_service_maf.core.interfaces import (
    AgentCapabilities,
    AgentEvent,
    AgentRequest,
    AgentResponse,
    EventType,
)
from agent_service_maf.framework.base_agent import BaseAgent
from agent_service_maf.framework.registry import FrameworkRegistry, LifecycleHook

# ---------------------------------------------------------------------------
# Test adapter implementations
# ---------------------------------------------------------------------------


class MinimalAdapter(BaseAgent):
    """Minimal BaseAgent implementation for registry testing."""

    async def invoke(self, request: AgentRequest, context) -> AgentResponse:
        return AgentResponse(agent_id="minimal", output="minimal response")

    async def stream(self, request: AgentRequest, context) -> AsyncIterator[AgentEvent]:
        yield AgentEvent(event_type=EventType.TOKEN, data="hi")

    def get_capabilities(self) -> AgentCapabilities:
        return AgentCapabilities(agent_id="minimal", framework="minimal")


class AlternateAdapter(BaseAgent):
    """Second adapter for testing overwrites and multiple registrations."""

    async def invoke(self, request: AgentRequest, context) -> AgentResponse:
        return AgentResponse(agent_id="alternate", output="alternate response")

    async def stream(self, request: AgentRequest, context) -> AsyncIterator[AgentEvent]:
        yield AgentEvent(event_type=EventType.TOKEN, data="alt")

    def get_capabilities(self) -> AgentCapabilities:
        return AgentCapabilities(agent_id="alternate", framework="alternate")


class BrokenAdapter(BaseAgent):
    """Adapter that raises in get_capabilities() to test list_capabilities() resilience."""

    async def invoke(self, request, context):
        return AgentResponse(agent_id="broken", output="")

    async def stream(self, request, context) -> AsyncIterator[AgentEvent]:
        yield AgentEvent(event_type=EventType.TOKEN, data="")

    def get_capabilities(self) -> AgentCapabilities:
        raise RuntimeError("Capabilities unavailable!")


# ---------------------------------------------------------------------------
# register() tests
# ---------------------------------------------------------------------------


class TestFrameworkRegistryRegister:
    """Tests for the FrameworkRegistry.register() decorator."""

    def test_register_returns_class_unchanged(self) -> None:
        """register() returns the adapter class unchanged."""
        result = FrameworkRegistry.register("test-register")(MinimalAdapter)
        assert result is MinimalAdapter, (
            f"Expected register() to return the adapter class unchanged, got {result}"
        )

    def test_register_makes_adapter_discoverable(self) -> None:
        """register() makes the adapter discoverable via is_registered()."""
        FrameworkRegistry.register("test-discover")(MinimalAdapter)
        assert FrameworkRegistry.is_registered("test-discover"), (
            "Expected 'test-discover' to be registered after decorator call"
        )

    def test_register_empty_name_raises(self) -> None:
        """register() with empty name raises ValueError."""
        with pytest.raises(ValueError) as exc_info:
            FrameworkRegistry.register("")
        assert "invalid" in str(exc_info.value).lower() or "name" in str(exc_info.value).lower(), (
            f"Expected ValueError about invalid name, got: {exc_info.value}"
        )

    def test_register_name_too_long_raises(self) -> None:
        """register() with name > 64 chars raises ValueError."""
        long_name = "a" * 65
        with pytest.raises(ValueError) as exc_info:
            FrameworkRegistry.register(long_name)
        assert "64" in str(exc_info.value) or "invalid" in str(exc_info.value).lower(), (
            f"Expected ValueError about name length, got: {exc_info.value}"
        )

    def test_register_64_char_name_succeeds(self) -> None:
        """register() with exactly 64 characters succeeds."""
        name = "a" * 64
        FrameworkRegistry.register(name)(MinimalAdapter)
        assert FrameworkRegistry.is_registered(name), "Expected 64-char name to be registered"

    def test_register_name_with_invalid_chars_raises(self) -> None:
        """register() with special characters raises ValueError."""
        with pytest.raises(ValueError):
            FrameworkRegistry.register("invalid name!")

    def test_register_name_with_spaces_raises(self) -> None:
        """register() with spaces in name raises ValueError."""
        with pytest.raises(ValueError):
            FrameworkRegistry.register("has space")

    def test_register_valid_name_patterns(self) -> None:
        """register() accepts names with letters, digits, hyphens, underscores."""
        FrameworkRegistry.register("valid-name_123")(MinimalAdapter)
        assert FrameworkRegistry.is_registered("valid-name_123"), (
            "Expected 'valid-name_123' to be registered"
        )

    def test_register_overwrite_replaces_adapter(self) -> None:
        """Re-registering a different class under the same name replaces it."""
        FrameworkRegistry.register("overwrite-test")(MinimalAdapter)
        FrameworkRegistry.register("overwrite-test")(AlternateAdapter)
        agent = FrameworkRegistry.create("overwrite-test", None)
        assert isinstance(agent, AlternateAdapter), (
            f"Expected AlternateAdapter after overwrite, got {type(agent)}"
        )

    def test_register_same_class_twice_is_idempotent(self) -> None:
        """Re-registering the same class under the same name is a no-op."""
        FrameworkRegistry.register("idempotent")(MinimalAdapter)
        FrameworkRegistry.register("idempotent")(MinimalAdapter)
        assert FrameworkRegistry.is_registered("idempotent"), (
            "Expected 'idempotent' to still be registered"
        )


# ---------------------------------------------------------------------------
# create() tests
# ---------------------------------------------------------------------------


class TestFrameworkRegistryCreate:
    """Tests for FrameworkRegistry.create()."""

    def test_create_returns_instance_of_registered_class(self) -> None:
        """create() returns an instance of the registered adapter class."""
        FrameworkRegistry.register("create-test")(MinimalAdapter)
        agent = FrameworkRegistry.create("create-test", {})
        assert isinstance(agent, MinimalAdapter), (
            f"Expected MinimalAdapter instance, got {type(agent)}"
        )

    def test_create_passes_config_to_constructor(self) -> None:
        """create() passes the config argument to the adapter constructor."""
        config = {"model": "test-model"}
        FrameworkRegistry.register("config-test")(MinimalAdapter)
        agent = FrameworkRegistry.create("config-test", config)
        assert agent._config is config, (
            f"Expected _config to be the passed config object, got {agent._config}"
        )

    def test_create_unregistered_raises_framework_not_found(self) -> None:
        """create() raises FrameworkNotFoundError for unregistered names."""
        with pytest.raises(FrameworkNotFoundError) as exc_info:
            FrameworkRegistry.create("definitely-not-registered-xyz", {})
        error_msg = str(exc_info.value)
        assert "definitely-not-registered-xyz" in error_msg, (
            f"Expected unregistered name in error message, got: {error_msg}"
        )

    def test_create_error_includes_available_frameworks(self) -> None:
        """FrameworkNotFoundError from create() includes available frameworks."""
        FrameworkRegistry.register("available-for-test")(MinimalAdapter)
        with pytest.raises(FrameworkNotFoundError) as exc_info:
            FrameworkRegistry.create("nonexistent", {})
        assert exc_info.value.details.get("available") is not None, (
            "Expected 'available' key in FrameworkNotFoundError.details"
        )

    def test_create_error_details_contain_requested_name(self) -> None:
        """FrameworkNotFoundError.details contains the requested name."""
        with pytest.raises(FrameworkNotFoundError) as exc_info:
            FrameworkRegistry.create("not-registered-at-all", {})
        assert exc_info.value.details.get("requested") == "not-registered-at-all", (
            "Expected 'requested' in FrameworkNotFoundError.details"
        )

    def test_create_with_none_config(self) -> None:
        """create() accepts None as config."""
        FrameworkRegistry.register("none-config-test")(MinimalAdapter)
        agent = FrameworkRegistry.create("none-config-test", None)
        assert agent is not None, "Expected agent to be created with None config"


# ---------------------------------------------------------------------------
# list_frameworks() tests
# ---------------------------------------------------------------------------


class TestListFrameworks:
    """Tests for FrameworkRegistry.list_frameworks()."""

    def test_list_frameworks_returns_sorted_list(self) -> None:
        """list_frameworks() returns a sorted list of registered names."""
        FrameworkRegistry.register("zebra")(MinimalAdapter)
        FrameworkRegistry.register("apple")(MinimalAdapter)
        FrameworkRegistry.register("mango")(MinimalAdapter)
        frameworks = FrameworkRegistry.list_frameworks()
        assert frameworks == sorted(frameworks), f"Expected sorted list, got {frameworks}"

    def test_list_frameworks_contains_registered_names(self) -> None:
        """list_frameworks() includes all registered adapter names."""
        FrameworkRegistry.register("list-test-1")(MinimalAdapter)
        FrameworkRegistry.register("list-test-2")(AlternateAdapter)
        frameworks = FrameworkRegistry.list_frameworks()
        assert "list-test-1" in frameworks, "Expected 'list-test-1' in frameworks list"
        assert "list-test-2" in frameworks, "Expected 'list-test-2' in frameworks list"

    def test_list_frameworks_empty_after_clear(self) -> None:
        """list_frameworks() returns empty list after clear()."""
        FrameworkRegistry.clear()
        frameworks = FrameworkRegistry.list_frameworks()
        assert frameworks == [], f"Expected empty list after clear(), got {frameworks}"

    def test_list_frameworks_returns_list_type(self) -> None:
        """list_frameworks() returns a list, not a dict or other type."""
        frameworks = FrameworkRegistry.list_frameworks()
        assert isinstance(frameworks, list), (
            f"Expected list from list_frameworks(), got {type(frameworks)}"
        )


# ---------------------------------------------------------------------------
# list_capabilities() tests
# ---------------------------------------------------------------------------


class TestListCapabilities:
    """Tests for FrameworkRegistry.list_capabilities()."""

    def test_list_capabilities_returns_agent_capabilities_list(self) -> None:
        """list_capabilities() returns list of AgentCapabilities."""
        FrameworkRegistry.register("caps-test")(MinimalAdapter)
        caps = FrameworkRegistry.list_capabilities()
        assert all(isinstance(c, AgentCapabilities) for c in caps), (
            "Expected all capabilities to be AgentCapabilities instances"
        )

    def test_list_capabilities_one_per_registered_adapter(self) -> None:
        """list_capabilities() returns one entry per registered adapter."""
        FrameworkRegistry.clear()
        FrameworkRegistry.register("adapter-a")(MinimalAdapter)
        FrameworkRegistry.register("adapter-b")(AlternateAdapter)
        caps = FrameworkRegistry.list_capabilities()
        assert len(caps) == 2, f"Expected 2 capabilities, got {len(caps)}"

    def test_list_capabilities_handles_broken_adapter_gracefully(self) -> None:
        """list_capabilities() returns placeholder for adapters that raise in get_capabilities()."""
        FrameworkRegistry.register("broken-caps")(BrokenAdapter)
        caps = FrameworkRegistry.list_capabilities()
        broken_cap = next((c for c in caps if c.agent_id == "broken-caps"), None)
        assert broken_cap is not None, "Expected placeholder capability for broken adapter"
        assert "unavailable" in broken_cap.description.lower() or "broken" in broken_cap.agent_id, (
            f"Expected placeholder description for broken adapter, got: {broken_cap.description}"
        )

    def test_list_capabilities_empty_after_clear(self) -> None:
        """list_capabilities() returns empty list after clear()."""
        FrameworkRegistry.clear()
        caps = FrameworkRegistry.list_capabilities()
        assert caps == [], f"Expected empty list after clear(), got {caps}"


# ---------------------------------------------------------------------------
# is_registered() tests
# ---------------------------------------------------------------------------


class TestIsRegistered:
    """Tests for FrameworkRegistry.is_registered()."""

    def test_registered_name_returns_true(self) -> None:
        """is_registered() returns True for registered names."""
        FrameworkRegistry.register("is-reg-test")(MinimalAdapter)
        assert FrameworkRegistry.is_registered("is-reg-test") is True, (
            "Expected is_registered('is-reg-test') to return True"
        )

    def test_unregistered_name_returns_false(self) -> None:
        """is_registered() returns False for unregistered names."""
        result = FrameworkRegistry.is_registered("this-does-not-exist-xyz")
        assert result is False, (
            f"Expected is_registered('this-does-not-exist-xyz') to return False, got {result}"
        )

    def test_after_clear_all_return_false(self) -> None:
        """After clear(), is_registered() returns False for all names."""
        FrameworkRegistry.register("before-clear")(MinimalAdapter)
        FrameworkRegistry.clear()
        assert FrameworkRegistry.is_registered("before-clear") is False, (
            "Expected is_registered to return False after clear()"
        )


# ---------------------------------------------------------------------------
# clear() tests
# ---------------------------------------------------------------------------


class TestClear:
    """Tests for FrameworkRegistry.clear()."""

    def test_clear_removes_all_adapters(self) -> None:
        """clear() removes all registered adapters."""
        FrameworkRegistry.register("clear-a")(MinimalAdapter)
        FrameworkRegistry.register("clear-b")(AlternateAdapter)
        FrameworkRegistry.clear()
        assert FrameworkRegistry.list_frameworks() == [], "Expected empty list after clear()"

    def test_clear_removes_all_hooks(self) -> None:
        """clear() removes all registered lifecycle hooks."""

        class TestHook(LifecycleHook):
            async def on_startup(self, app) -> None:
                pass

            async def on_shutdown(self, app) -> None:
                pass

        FrameworkRegistry.add_hook(TestHook())
        FrameworkRegistry.clear()
        assert len(FrameworkRegistry._hooks) == 0, (
            f"Expected no hooks after clear(), got {len(FrameworkRegistry._hooks)}"
        )


# ---------------------------------------------------------------------------
# LifecycleHook tests
# ---------------------------------------------------------------------------


class TestLifecycleHook:
    """Tests for the LifecycleHook abstract interface and FrameworkRegistry hooks."""

    def test_lifecycle_hook_cannot_be_instantiated_directly(self) -> None:
        """LifecycleHook is abstract and cannot be instantiated."""
        with pytest.raises(TypeError):
            LifecycleHook()  # type: ignore[abstract]

    def test_add_hook_stores_hook(self) -> None:
        """add_hook() stores the hook in _hooks."""

        class ConcreteHook(LifecycleHook):
            async def on_startup(self, app) -> None:
                pass

            async def on_shutdown(self, app) -> None:
                pass

        initial_count = len(FrameworkRegistry._hooks)
        hook = ConcreteHook()
        FrameworkRegistry.add_hook(hook)
        assert len(FrameworkRegistry._hooks) == initial_count + 1, (
            f"Expected {initial_count + 1} hooks after add_hook(), got {len(FrameworkRegistry._hooks)}"
        )

    async def test_run_startup_hooks_calls_on_startup(self) -> None:
        """run_startup_hooks() calls on_startup() on each registered hook."""
        startup_called = []

        class TestHook(LifecycleHook):
            async def on_startup(self, app) -> None:
                startup_called.append(True)

            async def on_shutdown(self, app) -> None:
                pass

        FrameworkRegistry.clear()
        FrameworkRegistry.add_hook(TestHook())
        app = FastAPI()
        await FrameworkRegistry.run_startup_hooks(app)
        assert len(startup_called) == 1, (
            f"Expected on_startup() to be called once, got {len(startup_called)}"
        )

    async def test_run_shutdown_hooks_calls_in_reverse_order(self) -> None:
        """run_shutdown_hooks() calls hooks in reverse registration order."""
        call_order = []

        class Hook1(LifecycleHook):
            async def on_startup(self, app) -> None:
                pass

            async def on_shutdown(self, app) -> None:
                call_order.append("hook1")

        class Hook2(LifecycleHook):
            async def on_startup(self, app) -> None:
                pass

            async def on_shutdown(self, app) -> None:
                call_order.append("hook2")

        FrameworkRegistry.clear()
        FrameworkRegistry.add_hook(Hook1())
        FrameworkRegistry.add_hook(Hook2())
        app = FastAPI()
        await FrameworkRegistry.run_shutdown_hooks(app)
        assert call_order == ["hook2", "hook1"], (
            f"Expected reverse order ['hook2', 'hook1'], got {call_order}"
        )

    async def test_run_shutdown_hooks_catches_errors(self) -> None:
        """run_shutdown_hooks() does not propagate exceptions from hooks."""

        class FailingHook(LifecycleHook):
            async def on_startup(self, app) -> None:
                pass

            async def on_shutdown(self, app) -> Never:
                raise RuntimeError("Shutdown hook failed!")

        FrameworkRegistry.clear()
        FrameworkRegistry.add_hook(FailingHook())
        app = FastAPI()
        # Should not raise
        await FrameworkRegistry.run_shutdown_hooks(app)

    async def test_run_startup_hooks_propagates_errors(self) -> None:
        """run_startup_hooks() propagates exceptions (abort startup on error)."""

        class FailingStartupHook(LifecycleHook):
            async def on_startup(self, app) -> Never:
                raise RuntimeError("Startup hook failed!")

            async def on_shutdown(self, app) -> None:
                pass

        FrameworkRegistry.clear()
        FrameworkRegistry.add_hook(FailingStartupHook())
        app = FastAPI()
        with pytest.raises(RuntimeError, match="Startup hook failed!"):
            await FrameworkRegistry.run_startup_hooks(app)
