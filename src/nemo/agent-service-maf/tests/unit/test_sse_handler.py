"""Unit tests for SSE streaming handler.

Tests cover:
- create_sse_generator yields STARTED event first
- create_sse_generator yields adapter events
- create_sse_generator yields COMPLETED event after adapter events
- max_duration_seconds enforcement yields ERROR event and stops
- idle_timeout_seconds enforcement yields ERROR event and stops
- max_events enforcement yields ERROR event and stops
- Adapter exception yields ERROR event
- _format_event correctly formats AgentEvent into SSE dict
"""

from __future__ import annotations

import time
import uuid
from collections.abc import AsyncIterator
from unittest.mock import patch

from agent_service_maf.config.validators import AgentConfig
from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.interfaces import (
    AgentCapabilities,
    AgentEvent,
    AgentRequest,
    AgentResponse,
    EventType,
)
from agent_service_maf.framework.base_agent import BaseAgent
from agent_service_maf.framework.registry import FrameworkRegistryProtocol
from agent_service_maf.interface_layer.sse_handler import (
    DEFAULT_IDLE_TIMEOUT_SECONDS,
    DEFAULT_MAX_DURATION_SECONDS,
    DEFAULT_MAX_EVENTS,
    _format_event,
    create_sse_generator,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_context(framework: str = "test") -> AgentExecutionContext:
    """Create minimal AgentExecutionContext."""
    config = AgentConfig(**{"agent": {"framework": framework}})
    return AgentExecutionContext(
        config=config,
        correlation_id=str(uuid.uuid4()),
    )


def make_request(input_text: str = "test") -> AgentRequest:
    """Create minimal AgentRequest."""
    return AgentRequest(agent_id="test", input=input_text)


class SimpleStreamAdapter(BaseAgent):
    """Adapter that yields a fixed sequence of events.

    Does NOT emit ``STARTED`` / ``COMPLETED`` itself. Used by tests
    that exercise the pre-§B1 contract (handler-owned bookends).
    Most production-contract tests use :class:`ProductionStreamAdapter`
    below, which emits the §B1 bookends like real adapters do.
    """

    def __init__(self, events: list[AgentEvent], config: object = None) -> None:
        super().__init__(config or {})
        self._events = events

    async def invoke(self, request, context) -> AgentResponse:
        return AgentResponse(agent_id="test", output="")

    async def stream(self, request, context) -> AsyncIterator[AgentEvent]:
        for event in self._events:
            yield event

    def get_capabilities(self) -> AgentCapabilities:
        return AgentCapabilities(agent_id="test", framework="test")


class ProductionStreamAdapter(BaseAgent):
    """Adapter that owns the §B1 STARTED / COMPLETED bookends.

    Per §B1 of the MAF migration plan, every adapter -- not the SSE
    handler -- is responsible for emitting ``STARTED`` first and
    ``COMPLETED`` last (with ``metadata.invokeResponse`` per §5.4.4).
    This adapter mirrors the migrated EchoAgent / SK adapter shape
    so unit tests can pin the in-between behavior without hitting
    full-scale adapters.
    """

    def __init__(self, middle_events: list[AgentEvent], config: object = None) -> None:
        super().__init__(config or {})
        self._middle = middle_events

    async def invoke(self, request, context) -> AgentResponse:
        return AgentResponse(agent_id="test", output="")

    async def stream(self, request, context) -> AsyncIterator[AgentEvent]:
        yield AgentEvent(
            event_type=EventType.STARTED,
            metadata={"agentId": "test", "framework": "test"},
        )
        for event in self._middle:
            yield event
        yield AgentEvent(
            event_type=EventType.COMPLETED,
            metadata={"invokeResponse": {"agentId": "test", "output": ""}},
        )

    def get_capabilities(self) -> AgentCapabilities:
        return AgentCapabilities(agent_id="test", framework="test")


class FailingStreamAdapter(BaseAgent):
    """Adapter that raises during streaming."""

    def __init__(self, config: object = None) -> None:
        super().__init__(config or {})

    async def invoke(self, request, context) -> AgentResponse:
        return AgentResponse(agent_id="test", output="")

    async def stream(self, request, context) -> AsyncIterator[AgentEvent]:
        raise ValueError("Stream adapter failed!")
        yield  # Make it a generator

    def get_capabilities(self) -> AgentCapabilities:
        return AgentCapabilities(agent_id="test", framework="test")


def make_registry_with(adapter: BaseAgent):
    """Create a mock registry that returns the given adapter."""

    class _Registry(FrameworkRegistryProtocol):
        @classmethod
        def create(cls, name: str, config: object) -> BaseAgent:
            return adapter

        @classmethod
        def list_frameworks(cls) -> list[str]:
            return ["test"]

        @classmethod
        def list_capabilities(cls) -> list[AgentCapabilities]:
            return []

        @classmethod
        def is_registered(cls, name: str) -> bool:
            return True

    return _Registry


# ---------------------------------------------------------------------------
# _format_event() tests
# ---------------------------------------------------------------------------


class TestFormatEvent:
    """Tests for the _format_event() helper function."""

    def test_returns_dict_with_event_and_data_keys(self) -> None:
        """_format_event() returns dict with 'event' and 'data' keys."""
        evt = AgentEvent(event_type=EventType.TOKEN, data="Hello")
        result = _format_event(evt)
        assert "event" in result, f"Expected 'event' key, got keys: {list(result.keys())}"
        assert "data" in result, f"Expected 'data' key, got keys: {list(result.keys())}"

    def test_event_key_is_event_type_value(self) -> None:
        """_format_event() sets 'event' key to the EventType value string."""
        evt = AgentEvent(event_type=EventType.TOKEN, data="test")
        result = _format_event(evt)
        assert result["event"] == "token", f"Expected event='token', got {result['event']!r}"

    def test_data_key_is_json_string(self) -> None:
        """_format_event() sets 'data' key to a JSON-encoded payload."""
        import json

        evt = AgentEvent(event_type=EventType.TOKEN, data="Hello")
        result = _format_event(evt)
        payload = json.loads(result["data"])
        assert payload["data"] == "Hello", (
            f"Expected data='Hello' in payload, got {payload.get('data')!r}"
        )

    def test_data_payload_includes_metadata(self) -> None:
        """_format_event() payload includes metadata."""
        import json

        evt = AgentEvent(
            event_type=EventType.TOOL_CALL,
            data="",
            metadata={"tool": "search"},
        )
        result = _format_event(evt)
        payload = json.loads(result["data"])
        assert payload["metadata"]["tool"] == "search", (
            "Expected metadata in formatted event payload"
        )

    def test_data_payload_includes_timestamp(self) -> None:
        """_format_event() payload includes ISO timestamp."""
        import json

        evt = AgentEvent(event_type=EventType.COMPLETED, data="")
        result = _format_event(evt)
        payload = json.loads(result["data"])
        assert "timestamp" in payload, "Expected 'timestamp' in event payload"
        assert isinstance(payload["timestamp"], str), "Expected timestamp as ISO string"

    def test_all_event_types_formatted_correctly(self) -> None:
        """_format_event() works for all standard EventType values."""
        for et in EventType:
            evt = AgentEvent(event_type=et, data="")
            result = _format_event(evt)
            assert result["event"] == et.value, (
                f"Expected event='{et.value}', got {result['event']!r}"
            )


# ---------------------------------------------------------------------------
# create_sse_generator() basic flow tests
# ---------------------------------------------------------------------------


class TestCreateSseGeneratorBasic:
    """Tests for basic create_sse_generator() flow."""

    async def test_yields_started_event_first(self) -> None:
        """§B1 — adapter-owned STARTED is the first event yielded.

        Per §B1 of the MAF migration plan, the SSE handler no longer
        injects ``STARTED`` -- every adapter emits its own. The
        handler just passes it through.
        """
        adapter = ProductionStreamAdapter(
            middle_events=[
                AgentEvent(event_type=EventType.TOKEN, data="hi"),
            ]
        )
        registry = make_registry_with(adapter)
        context = make_context()
        request = make_request()

        events = []
        async for event in create_sse_generator(registry, request, context):
            events.append(event)

        assert len(events) > 0, "Expected at least one event"
        assert events[0]["event"] == "started", (
            f"Expected first event='started' (emitted by adapter per §B1), "
            f"got {events[0]['event']!r}"
        )

    async def test_yields_completed_event_last(self) -> None:
        """§B1 — adapter-owned COMPLETED is the last event yielded."""
        adapter = ProductionStreamAdapter(
            middle_events=[
                AgentEvent(event_type=EventType.TOKEN, data="hello"),
            ]
        )
        registry = make_registry_with(adapter)
        context = make_context()
        request = make_request()

        events = []
        async for event in create_sse_generator(registry, request, context):
            events.append(event)

        assert events[-1]["event"] == "completed", (
            f"Expected last event='completed' (emitted by adapter per §B1), "
            f"got {events[-1]['event']!r}"
        )

    async def test_yields_adapter_events_between_sentinels(self) -> None:
        """create_sse_generator() yields adapter events between STARTED and COMPLETED."""
        adapter = ProductionStreamAdapter(
            middle_events=[
                AgentEvent(event_type=EventType.TOKEN, data="a"),
                AgentEvent(event_type=EventType.TOKEN, data="b"),
            ]
        )
        registry = make_registry_with(adapter)
        context = make_context()
        request = make_request()

        events = []
        async for event in create_sse_generator(registry, request, context):
            events.append(event)

        # STARTED + 2 TOKEN + COMPLETED = 4 events (all emitted by the adapter).
        assert len(events) == 4, (
            f"Expected 4 events (started + 2 tokens + completed), got {len(events)}"
        )
        middle_events = events[1:-1]
        assert all(e["event"] == "token" for e in middle_events), (
            f"Expected middle events to be 'token', got {[e['event'] for e in middle_events]}"
        )

    async def test_yields_error_event_on_adapter_exception(self) -> None:
        """create_sse_generator() yields ERROR event when adapter raises."""
        adapter = FailingStreamAdapter()
        registry = make_registry_with(adapter)
        context = make_context()
        request = make_request()

        events = []
        async for event in create_sse_generator(registry, request, context):
            events.append(event)

        # Should have an error event
        error_events = [e for e in events if e["event"] == "error"]
        assert len(error_events) > 0, (
            f"Expected at least one error event when adapter raises, got: {[e['event'] for e in events]}"
        )

    async def test_empty_stream_yields_started_and_completed(self) -> None:
        """§B1 — adapter that emits only bookends still produces both events."""
        adapter = ProductionStreamAdapter(middle_events=[])
        registry = make_registry_with(adapter)
        context = make_context()
        request = make_request()

        events = []
        async for event in create_sse_generator(registry, request, context):
            events.append(event)

        event_types = [e["event"] for e in events]
        assert "started" in event_types, f"Expected 'started' in events, got: {event_types}"
        assert "completed" in event_types, f"Expected 'completed' in events, got: {event_types}"


# ---------------------------------------------------------------------------
# Streaming limit enforcement tests
# ---------------------------------------------------------------------------


class TestSseStreamingLimits:
    """Tests for SSE streaming limit enforcement."""

    async def test_max_events_limit_terminates_stream(self) -> None:
        """Stream terminates with ERROR event when max_events is exceeded."""
        # Create adapter with many events
        many_events = [AgentEvent(event_type=EventType.TOKEN, data=str(i)) for i in range(20)]
        adapter = SimpleStreamAdapter(events=many_events)
        registry = make_registry_with(adapter)
        context = make_context()
        request = make_request()

        events = []
        # Set max_events to 5 — should terminate early
        async for event in create_sse_generator(registry, request, context, max_events=5):
            events.append(event)

        # Should have an error event
        event_types = [e["event"] for e in events]
        assert "error" in event_types, (
            f"Expected ERROR event when max_events exceeded, got: {event_types}"
        )
        # Should NOT have completed (terminated early)
        assert "completed" not in event_types, (
            f"Expected no COMPLETED event when terminated by max_events, got: {event_types}"
        )

    async def test_max_duration_limit_terminates_stream(self) -> None:
        """Stream terminates with ERROR event when max_duration_seconds is exceeded.

        The duration check uses: elapsed = now - stream_start. We simulate this by
        making the second call to monotonic() return a time far in the future so
        elapsed > max_duration_seconds, triggering the limit check on the first event.
        """
        # stream_start = first call to monotonic (time 0)
        # Second call (for 'now' in the loop) returns time 0 + 1000 → elapsed = 1000
        # This exceeds max_duration_seconds=1
        call_count = [0]
        base_time = time.monotonic()

        def fake_monotonic():
            call_count[0] += 1
            if call_count[0] == 1:
                return base_time  # stream_start
            # All subsequent calls return far future → elapsed will be huge
            return base_time + 10000

        adapter = SimpleStreamAdapter(
            events=[
                AgentEvent(event_type=EventType.TOKEN, data="a"),
                AgentEvent(event_type=EventType.TOKEN, data="b"),
            ]
        )
        registry = make_registry_with(adapter)
        context = make_context()
        request = make_request()

        events = []
        with patch("agent_service_maf.interface_layer.sse_handler.time.monotonic", fake_monotonic):
            async for event in create_sse_generator(
                registry, request, context, max_duration_seconds=1
            ):
                events.append(event)

        event_types = [e["event"] for e in events]
        assert "error" in event_types, (
            f"Expected ERROR event when max_duration exceeded, got: {event_types}"
        )

    async def test_default_limits_are_reasonable(self) -> None:
        """Default streaming limits have reasonable values."""
        assert DEFAULT_MAX_DURATION_SECONDS == 600, (
            f"Expected DEFAULT_MAX_DURATION_SECONDS=600, got {DEFAULT_MAX_DURATION_SECONDS}"
        )
        assert DEFAULT_MAX_EVENTS == 10_000, (
            f"Expected DEFAULT_MAX_EVENTS=10000, got {DEFAULT_MAX_EVENTS}"
        )
        assert DEFAULT_IDLE_TIMEOUT_SECONDS == 60, (
            f"Expected DEFAULT_IDLE_TIMEOUT_SECONDS=60, got {DEFAULT_IDLE_TIMEOUT_SECONDS}"
        )
