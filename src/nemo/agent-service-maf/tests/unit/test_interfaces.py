"""Unit tests for core data models and abstract interfaces.

Tests cover:
- TokenUsage model construction, defaults, and JSON roundtrip
- AgentRequest model construction, defaults, and JSON roundtrip
- AgentResponse model construction, defaults, and JSON roundtrip
- EventType enum values
- EventTypeRegistry registration, validation, and listing
- AgentEvent model construction and auto-timestamp
- AgentCapabilities model construction and defaults
- Abstract interface enforcement (cannot instantiate abstract classes)
"""

from __future__ import annotations

from abc import ABC
from datetime import UTC, datetime

import pytest

from agent_service_maf.core.interfaces import (
    AgentCapabilities,
    AgentCapabilityProvider,
    AgentEvent,
    AgentInterface,
    AgentInvoker,
    AgentLifecycle,
    AgentRequest,
    AgentResponse,
    EventType,
    EventTypeRegistry,
    TokenUsage,
)

# ---------------------------------------------------------------------------
# TokenUsage tests
# ---------------------------------------------------------------------------


class TestTokenUsage:
    """Tests for the TokenUsage Pydantic model."""

    def test_default_values_are_zero(self) -> None:
        """TokenUsage defaults all token counts to zero."""
        usage = TokenUsage()
        assert usage.prompt_tokens == 0, "Expected default prompt_tokens to be 0"
        assert usage.completion_tokens == 0, "Expected default completion_tokens to be 0"
        assert usage.total_tokens == 0, "Expected default total_tokens to be 0"
        assert usage.estimated_cost_usd == 0.0, "Expected default estimated_cost_usd to be 0.0"

    def test_explicit_values_stored_correctly(self) -> None:
        """TokenUsage stores explicitly provided values."""
        usage = TokenUsage(
            prompt_tokens=100,
            completion_tokens=200,
            total_tokens=300,
            estimated_cost_usd=0.005,
        )
        assert usage.prompt_tokens == 100, "Expected prompt_tokens=100"
        assert usage.completion_tokens == 200, "Expected completion_tokens=200"
        assert usage.total_tokens == 300, "Expected total_tokens=300"
        assert usage.estimated_cost_usd == 0.005, "Expected estimated_cost_usd=0.005"

    def test_negative_tokens_raises_validation_error(self) -> None:
        """TokenUsage rejects negative token counts."""
        with pytest.raises(Exception) as exc_info:
            TokenUsage(prompt_tokens=-1)
        assert (
            "prompt_tokens" in str(exc_info.value).lower()
            or "greater" in str(exc_info.value).lower()
        ), f"Expected validation error mentioning prompt_tokens, got: {exc_info.value}"

    def test_negative_cost_raises_validation_error(self) -> None:
        """TokenUsage rejects negative cost values."""
        with pytest.raises(Exception):
            TokenUsage(estimated_cost_usd=-0.01)

    def test_json_roundtrip(self) -> None:
        """TokenUsage serializes and deserializes correctly."""
        original = TokenUsage(
            prompt_tokens=50,
            completion_tokens=100,
            total_tokens=150,
            estimated_cost_usd=0.002,
        )
        json_str = original.model_dump_json()
        restored = TokenUsage.model_validate_json(json_str)
        assert restored.prompt_tokens == 50, "Expected restored prompt_tokens=50"
        assert restored.completion_tokens == 100, "Expected restored completion_tokens=100"
        assert restored.total_tokens == 150, "Expected restored total_tokens=150"
        assert restored.estimated_cost_usd == 0.002, "Expected restored estimated_cost_usd=0.002"

    def test_model_dump_produces_dict(self) -> None:
        """TokenUsage.model_dump() returns a plain dict."""
        usage = TokenUsage(prompt_tokens=10, completion_tokens=20)
        d = usage.model_dump()
        assert isinstance(d, dict), f"Expected dict from model_dump(), got {type(d)}"
        assert "prompt_tokens" in d, "Expected 'prompt_tokens' key in dict"
        assert "estimated_cost_usd" in d, "Expected 'estimated_cost_usd' key in dict"


# ---------------------------------------------------------------------------
# AgentRequest tests
# ---------------------------------------------------------------------------


class TestAgentRequest:
    """Tests for the AgentRequest Pydantic model."""

    def test_required_fields_agent_id_and_input(self) -> None:
        """AgentRequest requires agent_id and input."""
        req = AgentRequest(agent_id="test-agent", input="Hello!")
        assert req.agent_id == "test-agent", "Expected agent_id='test-agent'"
        assert req.input == "Hello!", "Expected input='Hello!'"

    def test_default_fields_are_empty(self) -> None:
        """AgentRequest defaults context, config_overrides, and metadata to empty dicts."""
        req = AgentRequest(agent_id="agent", input="hi")
        assert req.context == {}, f"Expected context={{}}, got {req.context}"
        assert req.config_overrides == {}, (
            f"Expected config_overrides={{}}, got {req.config_overrides}"
        )
        assert req.metadata == {}, f"Expected metadata={{}}, got {req.metadata}"
        assert req.session_id is None, f"Expected session_id=None, got {req.session_id}"

    def test_missing_agent_id_raises(self) -> None:
        """AgentRequest raises when agent_id is missing."""
        with pytest.raises(Exception):
            AgentRequest(input="hi")  # type: ignore[call-arg]

    def test_missing_input_raises(self) -> None:
        """AgentRequest raises when input is missing."""
        with pytest.raises(Exception):
            AgentRequest(agent_id="agent")  # type: ignore[call-arg]

    def test_context_accepts_arbitrary_keys(self) -> None:
        """AgentRequest accepts arbitrary context keys for forward-compatibility."""
        req = AgentRequest(
            agent_id="agent",
            input="hi",
            context={
                "backstory": "You are a helper.",
                "conversation_history": [{"role": "user", "content": "Hello"}],
                "unknown_future_key": 42,
            },
        )
        assert req.context["backstory"] == "You are a helper.", "Expected backstory in context"
        assert req.context["unknown_future_key"] == 42, "Expected arbitrary key in context"

    def test_session_id_is_optional(self) -> None:
        """AgentRequest accepts an explicit session_id."""
        req = AgentRequest(agent_id="agent", input="hi", session_id="sess-001")
        assert req.session_id == "sess-001", "Expected session_id='sess-001'"

    def test_json_roundtrip(self) -> None:
        """AgentRequest serializes and deserializes correctly."""
        original = AgentRequest(
            agent_id="echo",
            input="Hello, world!",
            context={"backstory": "Echo everything."},
            config_overrides={"agent": {"framework": "echo"}},
            session_id="sess-abc",
            metadata={"trace_id": "trace-123"},
        )
        json_str = original.model_dump_json()
        restored = AgentRequest.model_validate_json(json_str)
        assert restored.agent_id == original.agent_id, "Expected agent_id to match after roundtrip"
        assert restored.input == original.input, "Expected input to match after roundtrip"
        assert restored.context == original.context, "Expected context to match after roundtrip"
        assert restored.session_id == original.session_id, (
            "Expected session_id to match after roundtrip"
        )

    def test_empty_input_is_valid(self) -> None:
        """AgentRequest accepts empty string input (validation is done by adapters)."""
        req = AgentRequest(agent_id="agent", input="")
        assert req.input == "", "Expected empty string input to be stored as-is"


# ---------------------------------------------------------------------------
# AgentResponse tests
# ---------------------------------------------------------------------------


class TestAgentResponse:
    """Tests for the AgentResponse Pydantic model."""

    def test_required_fields_agent_id_and_output(self) -> None:
        """AgentResponse requires agent_id and output."""
        resp = AgentResponse(agent_id="echo", output="Hello!")
        assert resp.agent_id == "echo", "Expected agent_id='echo'"
        assert resp.output == "Hello!", "Expected output='Hello!'"

    def test_default_fields(self) -> None:
        """AgentResponse defaults artifacts, metadata, usage to empty/zero/None."""
        resp = AgentResponse(agent_id="echo", output="hi")
        assert resp.artifacts == [], f"Expected artifacts=[], got {resp.artifacts}"
        assert resp.usage is None, f"Expected usage=None, got {resp.usage}"
        assert resp.metadata == {}, f"Expected metadata={{}}, got {resp.metadata}"
        assert resp.duration_ms == 0, f"Expected duration_ms=0, got {resp.duration_ms}"

    def test_usage_can_be_set(self) -> None:
        """AgentResponse can carry a TokenUsage instance."""
        usage = TokenUsage(prompt_tokens=10, completion_tokens=20, total_tokens=30)
        resp = AgentResponse(agent_id="echo", output="hi", usage=usage)
        assert resp.usage is not None, "Expected usage to be set"
        assert resp.usage.prompt_tokens == 10, "Expected prompt_tokens=10"

    def test_duration_ms_cannot_be_negative(self) -> None:
        """AgentResponse rejects negative duration_ms."""
        with pytest.raises(Exception):
            AgentResponse(agent_id="echo", output="hi", duration_ms=-1)

    def test_json_roundtrip_with_usage(self) -> None:
        """AgentResponse with TokenUsage serializes and deserializes correctly."""
        original = AgentResponse(
            agent_id="echo",
            output="Echo: hello",
            artifacts=[{"type": "text", "content": "raw"}],
            usage=TokenUsage(prompt_tokens=5, completion_tokens=10, total_tokens=15),
            metadata={"framework": "echo"},
            duration_ms=42,
        )
        json_str = original.model_dump_json()
        restored = AgentResponse.model_validate_json(json_str)
        assert restored.agent_id == original.agent_id, "Expected agent_id to match after roundtrip"
        assert restored.output == original.output, "Expected output to match after roundtrip"
        assert restored.duration_ms == 42, "Expected duration_ms=42 after roundtrip"
        assert restored.usage is not None, "Expected usage to be preserved"
        assert restored.usage.total_tokens == 15, "Expected total_tokens=15 after roundtrip"

    def test_json_roundtrip_without_usage(self) -> None:
        """AgentResponse without usage serializes and deserializes correctly."""
        original = AgentResponse(agent_id="echo", output="hi")
        json_str = original.model_dump_json()
        restored = AgentResponse.model_validate_json(json_str)
        assert restored.usage is None, "Expected usage=None after roundtrip"

    def test_model_dump_produces_dict(self) -> None:
        """AgentResponse.model_dump() returns a plain dict."""
        resp = AgentResponse(agent_id="echo", output="hi")
        d = resp.model_dump()
        assert isinstance(d, dict), f"Expected dict from model_dump(), got {type(d)}"
        assert "agent_id" in d, "Expected 'agent_id' key in dict"
        assert "output" in d, "Expected 'output' key in dict"


# ---------------------------------------------------------------------------
# EventType tests
# ---------------------------------------------------------------------------


class TestEventType:
    """Tests for the EventType StrEnum."""

    def test_all_expected_values_exist(self) -> None:
        """EventType contains all required streaming event types."""
        expected_values = {
            "started",
            "thinking",
            "token",
            "tool_call",
            "tool_result",
            "artifact",
            "error",
            "completed",
            "agent_started",
            "agent_completed",
        }
        actual_values = {e.value for e in EventType}
        assert expected_values == actual_values, (
            f"Expected EventType values {expected_values}, got {actual_values}"
        )

    def test_event_type_is_str(self) -> None:
        """EventType values are strings (StrEnum)."""
        for et in EventType:
            assert isinstance(et, str), f"Expected EventType.{et.name} to be str, got {type(et)}"

    def test_specific_values(self) -> None:
        """EventType enum has correct string values."""
        assert EventType.STARTED == "started", (
            f"Expected STARTED='started', got {EventType.STARTED!r}"
        )
        assert EventType.TOKEN == "token", f"Expected TOKEN='token', got {EventType.TOKEN!r}"
        assert EventType.COMPLETED == "completed", (
            f"Expected COMPLETED='completed', got {EventType.COMPLETED!r}"
        )
        assert EventType.ERROR == "error", f"Expected ERROR='error', got {EventType.ERROR!r}"


# ---------------------------------------------------------------------------
# EventTypeRegistry tests
# ---------------------------------------------------------------------------


class TestEventTypeRegistry:
    """Tests for EventTypeRegistry — runtime event type registration."""

    def setup_method(self) -> None:
        """Record initial state to clean up custom registrations between tests."""
        self._initial_types = set(EventTypeRegistry._types)

    def teardown_method(self) -> None:
        """Restore registry to initial state after each test."""
        EventTypeRegistry._types = self._initial_types

    def test_built_in_types_are_pre_registered(self) -> None:
        """Built-in EventType values are pre-registered in the registry."""
        for et in EventType:
            assert EventTypeRegistry.validate(et.value), (
                f"Expected built-in event type '{et.value}' to be pre-registered"
            )

    def test_register_custom_type_succeeds(self) -> None:
        """Custom event types can be registered."""
        EventTypeRegistry.register("custom_event")
        assert EventTypeRegistry.validate("custom_event"), (
            "Expected 'custom_event' to be valid after registration"
        )

    def test_register_empty_string_raises(self) -> None:
        """Registering an empty string raises ValueError."""
        with pytest.raises(ValueError) as exc_info:
            EventTypeRegistry.register("")
        assert "non-empty" in str(exc_info.value) or "empty" in str(exc_info.value), (
            f"Expected error message about empty string, got: {exc_info.value}"
        )

    def test_validate_unregistered_type_returns_false(self) -> None:
        """Validating an unregistered type returns False."""
        result = EventTypeRegistry.validate("definitely_not_registered_xyz123")
        assert result is False, f"Expected False for unregistered type, got {result}"

    def test_validate_registered_type_returns_true(self) -> None:
        """Validating a registered type returns True."""
        result = EventTypeRegistry.validate("token")
        assert result is True, f"Expected True for built-in type 'token', got {result}"

    def test_list_types_returns_sorted_list(self) -> None:
        """list_types() returns a sorted list of all registered types."""
        types = EventTypeRegistry.list_types()
        assert isinstance(types, list), f"Expected list from list_types(), got {type(types)}"
        assert types == sorted(types), "Expected list_types() to be sorted alphabetically"

    def test_list_types_includes_built_ins(self) -> None:
        """list_types() includes all built-in event types."""
        types = EventTypeRegistry.list_types()
        for et in EventType:
            assert et.value in types, f"Expected built-in type '{et.value}' in list_types()"

    def test_register_custom_type_appears_in_list(self) -> None:
        """Custom type registered appears in list_types()."""
        EventTypeRegistry.register("my_custom_type")
        types = EventTypeRegistry.list_types()
        assert "my_custom_type" in types, "Expected 'my_custom_type' to appear in list_types()"

    def test_re_register_same_type_is_idempotent(self) -> None:
        """Re-registering an existing type does not cause errors."""
        EventTypeRegistry.register("file_written")
        EventTypeRegistry.register("file_written")  # Should not raise
        assert EventTypeRegistry.validate("file_written"), (
            "Expected 'file_written' to remain valid after re-registration"
        )


# ---------------------------------------------------------------------------
# AgentEvent tests
# ---------------------------------------------------------------------------


class TestAgentEvent:
    """Tests for the AgentEvent Pydantic model."""

    def test_event_type_is_required(self) -> None:
        """AgentEvent requires event_type."""
        with pytest.raises(Exception):
            AgentEvent()  # type: ignore[call-arg]

    def test_timestamp_is_auto_generated(self) -> None:
        """AgentEvent auto-generates a UTC timestamp."""
        before = datetime.now(tz=UTC)
        evt = AgentEvent(event_type=EventType.TOKEN, data="hello")
        after = datetime.now(tz=UTC)
        assert evt.timestamp >= before, "Expected timestamp to be >= test start time"
        assert evt.timestamp <= after, "Expected timestamp to be <= test end time"

    def test_data_defaults_to_empty_string(self) -> None:
        """AgentEvent data defaults to empty string."""
        evt = AgentEvent(event_type=EventType.STARTED)
        assert evt.data == "", f"Expected data='', got {evt.data!r}"

    def test_metadata_defaults_to_empty_dict(self) -> None:
        """AgentEvent metadata defaults to empty dict."""
        evt = AgentEvent(event_type=EventType.COMPLETED)
        assert evt.metadata == {}, f"Expected metadata={{}}, got {evt.metadata}"

    def test_explicit_values_stored_correctly(self) -> None:
        """AgentEvent stores all explicitly provided values."""
        ts = datetime.now(tz=UTC)
        evt = AgentEvent(
            event_type=EventType.TOKEN,
            data="hello world",
            metadata={"chunk_index": 0},
            timestamp=ts,
        )
        assert evt.event_type == EventType.TOKEN, f"Expected event_type=TOKEN, got {evt.event_type}"
        assert evt.data == "hello world", f"Expected data='hello world', got {evt.data!r}"
        assert evt.metadata["chunk_index"] == 0, "Expected chunk_index=0 in metadata"
        assert evt.timestamp == ts, "Expected explicit timestamp to be stored"

    def test_json_roundtrip(self) -> None:
        """AgentEvent serializes and deserializes correctly."""
        original = AgentEvent(
            event_type=EventType.TOKEN,
            data="Hello",
            metadata={"index": 1},
        )
        json_str = original.model_dump_json()
        restored = AgentEvent.model_validate_json(json_str)
        assert restored.event_type == EventType.TOKEN, (
            "Expected event_type to match after roundtrip"
        )
        assert restored.data == "Hello", "Expected data to match after roundtrip"
        assert restored.metadata == {"index": 1}, "Expected metadata to match after roundtrip"


# ---------------------------------------------------------------------------
# AgentCapabilities tests
# ---------------------------------------------------------------------------


class TestAgentCapabilities:
    """Tests for the AgentCapabilities Pydantic model."""

    def test_required_fields_agent_id_and_framework(self) -> None:
        """AgentCapabilities requires agent_id and framework."""
        caps = AgentCapabilities(agent_id="echo", framework="example")
        assert caps.agent_id == "echo", "Expected agent_id='echo'"
        assert caps.framework == "example", "Expected framework='example'"

    def test_default_protocols(self) -> None:
        """AgentCapabilities defaults to rest, sse, websocket protocols."""
        caps = AgentCapabilities(agent_id="echo", framework="example")
        expected = ["rest", "sse", "websocket"]
        assert caps.supported_protocols == expected, (
            f"Expected protocols={expected}, got {caps.supported_protocols}"
        )

    def test_default_supports_streaming_true(self) -> None:
        """AgentCapabilities defaults supports_streaming to True."""
        caps = AgentCapabilities(agent_id="echo", framework="example")
        assert caps.supports_streaming is True, "Expected supports_streaming=True by default"

    def test_default_version(self) -> None:
        """AgentCapabilities defaults version to '1.0.0'."""
        caps = AgentCapabilities(agent_id="echo", framework="example")
        assert caps.version == "1.0.0", f"Expected version='1.0.0', got {caps.version!r}"

    def test_default_description_empty(self) -> None:
        """AgentCapabilities defaults description to empty string."""
        caps = AgentCapabilities(agent_id="echo", framework="example")
        assert caps.description == "", f"Expected description='', got {caps.description!r}"

    def test_default_available_tools_empty(self) -> None:
        """AgentCapabilities defaults available_tools to empty list."""
        caps = AgentCapabilities(agent_id="echo", framework="example")
        assert caps.available_tools == [], (
            f"Expected available_tools=[], got {caps.available_tools}"
        )

    def test_custom_capabilities_stored(self) -> None:
        """AgentCapabilities stores all custom values."""
        caps = AgentCapabilities(
            agent_id="my-agent",
            framework="maf",
            supports_streaming=False,
            supported_protocols=["rest"],
            available_tools=["web_search", "calculator"],
            description="My custom agent",
            version="2.0.0",
        )
        assert caps.supports_streaming is False, "Expected supports_streaming=False"
        assert "rest" in caps.supported_protocols, "Expected 'rest' in protocols"
        assert "web_search" in caps.available_tools, "Expected 'web_search' in tools"
        assert caps.version == "2.0.0", "Expected version='2.0.0'"

    def test_json_roundtrip(self) -> None:
        """AgentCapabilities serializes and deserializes correctly."""
        original = AgentCapabilities(
            agent_id="echo",
            framework="example",
            description="Test agent",
        )
        json_str = original.model_dump_json()
        restored = AgentCapabilities.model_validate_json(json_str)
        assert restored.agent_id == original.agent_id, "Expected agent_id to match after roundtrip"
        assert restored.framework == original.framework, (
            "Expected framework to match after roundtrip"
        )


# ---------------------------------------------------------------------------
# Abstract interface enforcement tests
# ---------------------------------------------------------------------------


class TestAbstractInterfaces:
    """Tests verifying ABC enforcement for all interface classes."""

    def test_agent_invoker_cannot_be_instantiated(self) -> None:
        """AgentInvoker is abstract and cannot be instantiated directly."""
        assert issubclass(AgentInvoker, ABC), "Expected AgentInvoker to be an ABC"
        with pytest.raises(TypeError) as exc_info:
            AgentInvoker()  # type: ignore[abstract]
        assert "abstract" in str(exc_info.value).lower(), (
            f"Expected TypeError about abstract method, got: {exc_info.value}"
        )

    def test_agent_lifecycle_cannot_be_instantiated(self) -> None:
        """AgentLifecycle is abstract and cannot be instantiated directly."""
        assert issubclass(AgentLifecycle, ABC), "Expected AgentLifecycle to be an ABC"
        with pytest.raises(TypeError):
            AgentLifecycle()  # type: ignore[abstract]

    def test_agent_capability_provider_cannot_be_instantiated(self) -> None:
        """AgentCapabilityProvider is abstract and cannot be instantiated directly."""
        assert issubclass(AgentCapabilityProvider, ABC), (
            "Expected AgentCapabilityProvider to be an ABC"
        )
        with pytest.raises(TypeError):
            AgentCapabilityProvider()  # type: ignore[abstract]

    def test_agent_interface_cannot_be_instantiated(self) -> None:
        """AgentInterface is abstract and cannot be instantiated directly."""
        assert issubclass(AgentInterface, ABC), "Expected AgentInterface to be an ABC"
        with pytest.raises(TypeError):
            AgentInterface()  # type: ignore[abstract]

    def test_concrete_class_must_implement_all_methods(self) -> None:
        """A class that only partially implements AgentInterface raises TypeError."""

        class PartialAgent(AgentInterface):
            async def invoke(self, request, context):
                return AgentResponse(agent_id="test", output="hi")

            # Missing: stream(), initialize(), shutdown(), get_capabilities()

        with pytest.raises(TypeError):
            PartialAgent()  # type: ignore[abstract]

    def test_full_concrete_implementation_can_be_instantiated(self) -> None:
        """A class that implements all abstract methods can be instantiated."""
        from collections.abc import AsyncIterator as AI

        class ConcreteAgent(AgentInterface):
            async def invoke(self, request, context):
                return AgentResponse(agent_id="test", output="hi")

            async def stream(self, request, context) -> AI[AgentEvent]:
                yield AgentEvent(event_type=EventType.TOKEN, data="hi")

            async def initialize(self, context) -> None:
                pass

            async def shutdown(self) -> None:
                pass

            def get_capabilities(self) -> AgentCapabilities:
                return AgentCapabilities(agent_id="test", framework="test")

        # Should not raise
        agent = ConcreteAgent()
        assert agent is not None, "Expected ConcreteAgent to be instantiatable"
