"""Unit tests for EchoAgent.

Tests cover:
- EchoAgent is registered in FrameworkRegistry as "echo"
- get_capabilities() returns correct AgentCapabilities (before initialize)
- invoke() returns "Echo: {input}" as output
- invoke() sets correct agent_id in response
- invoke() sets correlation_id in response metadata
- invoke() returns None usage
- stream() yields THINKING event first
- stream() yields TOKEN events for each character
- stream() yields correct data for each character
- EchoAgent can be initialized and shut down correctly
- Full lifecycle: create → initialize → invoke → shutdown
"""

from __future__ import annotations

import uuid

from agent_service_maf.config.validators import AgentConfig
from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.interfaces import (
    AgentRequest,
    AgentResponse,
    EventType,
)
from agent_service_maf.examples.echo_agent import EchoAgent
from agent_service_maf.framework.registry import FrameworkRegistry

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def make_context() -> AgentExecutionContext:
    """Create a minimal AgentExecutionContext for testing."""
    return AgentExecutionContext(
        config=AgentConfig(),
        correlation_id=str(uuid.uuid4()),
    )


def make_request(input_text: str = "Hello, world!") -> AgentRequest:
    """Create a minimal AgentRequest for testing."""
    return AgentRequest(agent_id="echo", input=input_text)


# ---------------------------------------------------------------------------
# Registration tests
# ---------------------------------------------------------------------------


class TestEchoAgentRegistration:
    """Tests for EchoAgent's FrameworkRegistry registration."""

    def test_echo_registered_after_import(self) -> None:
        """EchoAgent is registered as 'echo' when the module is imported."""
        # Re-register since conftest clears registry
        from agent_service_maf.examples.echo_agent import EchoAgent as _EchoAgent

        FrameworkRegistry.register("echo")(_EchoAgent)
        assert FrameworkRegistry.is_registered("echo"), (
            "Expected 'echo' to be registered after importing echo_agent module"
        )

    def test_create_echo_via_registry(self) -> None:
        """EchoAgent can be created via FrameworkRegistry.create()."""
        from agent_service_maf.examples.echo_agent import EchoAgent as _EchoAgent

        FrameworkRegistry.register("echo")(_EchoAgent)
        agent = FrameworkRegistry.create("echo", AgentConfig())
        assert isinstance(agent, EchoAgent), f"Expected EchoAgent instance, got {type(agent)}"


# ---------------------------------------------------------------------------
# get_capabilities() tests
# ---------------------------------------------------------------------------


class TestEchoAgentCapabilities:
    """Tests for EchoAgent.get_capabilities()."""

    def test_capabilities_before_initialize(self) -> None:
        """get_capabilities() works before initialize() is called."""
        agent = EchoAgent(config={})
        caps = agent.get_capabilities()
        assert caps is not None, "Expected capabilities to be returned before initialize()"

    def test_agent_id_is_echo(self) -> None:
        """Capabilities agent_id is 'echo'."""
        agent = EchoAgent(config={})
        caps = agent.get_capabilities()
        assert caps.agent_id == "echo", f"Expected agent_id='echo', got {caps.agent_id!r}"

    def test_framework_is_example(self) -> None:
        """Capabilities framework is 'example'."""
        agent = EchoAgent(config={})
        caps = agent.get_capabilities()
        assert caps.framework == "example", f"Expected framework='example', got {caps.framework!r}"

    def test_supports_streaming_true(self) -> None:
        """EchoAgent reports that it supports streaming."""
        agent = EchoAgent(config={})
        caps = agent.get_capabilities()
        assert caps.supports_streaming is True, (
            f"Expected supports_streaming=True, got {caps.supports_streaming}"
        )

    def test_supported_protocols(self) -> None:
        """EchoAgent supports rest, sse, and websocket protocols."""
        agent = EchoAgent(config={})
        caps = agent.get_capabilities()
        expected = ["rest", "sse", "websocket"]
        for protocol in expected:
            assert protocol in caps.supported_protocols, (
                f"Expected '{protocol}' in supported_protocols, got {caps.supported_protocols}"
            )

    def test_available_tools_empty(self) -> None:
        """EchoAgent has no available tools."""
        agent = EchoAgent(config={})
        caps = agent.get_capabilities()
        assert caps.available_tools == [], f"Expected empty tools list, got {caps.available_tools}"

    def test_version_is_1_0_0(self) -> None:
        """EchoAgent version is '1.0.0'."""
        agent = EchoAgent(config={})
        caps = agent.get_capabilities()
        assert caps.version == "1.0.0", f"Expected version='1.0.0', got {caps.version!r}"

    def test_description_is_non_empty(self) -> None:
        """EchoAgent has a non-empty description."""
        agent = EchoAgent(config={})
        caps = agent.get_capabilities()
        assert caps.description != "", "Expected non-empty description for EchoAgent"


# ---------------------------------------------------------------------------
# invoke() tests
# ---------------------------------------------------------------------------


class TestEchoAgentInvoke:
    """Tests for EchoAgent.invoke()."""

    async def test_invoke_returns_agent_response(self) -> None:
        """invoke() returns an AgentResponse instance."""
        agent = EchoAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)
        request = make_request("Hello!")
        response = await agent.invoke(request, ctx)
        assert isinstance(response, AgentResponse), f"Expected AgentResponse, got {type(response)}"

    async def test_invoke_echoes_input(self) -> None:
        """invoke() returns 'Echo: {input}' as output."""
        agent = EchoAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)
        request = make_request("test message")
        response = await agent.invoke(request, ctx)
        assert response.output == "Echo: test message", (
            f"Expected 'Echo: test message', got {response.output!r}"
        )

    async def test_invoke_echo_prefix(self) -> None:
        """invoke() output always starts with 'Echo: '."""
        agent = EchoAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)
        for input_text in ["hi", "Hello, world!", "A" * 1000]:
            request = make_request(input_text)
            response = await agent.invoke(request, ctx)
            assert response.output.startswith("Echo: "), (
                f"Expected output to start with 'Echo: ', got {response.output[:20]!r}"
            )

    async def test_invoke_agent_id_is_echo(self) -> None:
        """invoke() returns response with agent_id='echo'."""
        agent = EchoAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)
        request = make_request()
        response = await agent.invoke(request, ctx)
        assert response.agent_id == "echo", f"Expected agent_id='echo', got {response.agent_id!r}"

    async def test_invoke_includes_correlation_id_in_metadata(self) -> None:
        """invoke() includes correlation_id in response metadata."""
        agent = EchoAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)
        request = make_request()
        response = await agent.invoke(request, ctx)
        assert "request_id" in response.metadata, "Expected 'request_id' key in response metadata"
        assert response.metadata["request_id"] == ctx.correlation_id, (
            f"Expected correlation_id in metadata, got {response.metadata.get('request_id')!r}"
        )

    async def test_invoke_usage_is_none(self) -> None:
        """EchoAgent invoke() returns None usage (no LLM called)."""
        agent = EchoAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)
        request = make_request()
        response = await agent.invoke(request, ctx)
        assert response.usage is None, f"Expected usage=None (no LLM call), got {response.usage}"

    async def test_invoke_artifacts_empty(self) -> None:
        """EchoAgent invoke() returns empty artifacts list."""
        agent = EchoAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)
        request = make_request()
        response = await agent.invoke(request, ctx)
        assert response.artifacts == [], f"Expected empty artifacts, got {response.artifacts}"

    async def test_invoke_empty_input(self) -> None:
        """invoke() handles empty input string correctly."""
        agent = EchoAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)
        request = make_request("")
        response = await agent.invoke(request, ctx)
        assert response.output == "Echo: ", (
            f"Expected 'Echo: ' for empty input, got {response.output!r}"
        )


# ---------------------------------------------------------------------------
# stream() tests
# ---------------------------------------------------------------------------


class TestEchoAgentStream:
    """Tests for EchoAgent.stream()."""

    async def test_stream_yields_thinking_first(self) -> None:
        """stream() yields a THINKING event as the first event."""
        agent = EchoAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)
        request = make_request("hello")

        events = []
        async for event in agent.stream(request, ctx):
            events.append(event)

        assert len(events) > 0, "Expected at least one event"
        assert events[0].event_type == EventType.THINKING, (
            f"Expected first event to be THINKING, got {events[0].event_type}"
        )

    async def test_stream_yields_token_events_for_each_char(self) -> None:
        """stream() yields a TOKEN event for each character in input."""
        agent = EchoAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)
        input_text = "abc"
        request = make_request(input_text)

        events = []
        async for event in agent.stream(request, ctx):
            events.append(event)

        token_events = [e for e in events if e.event_type == EventType.TOKEN]
        assert len(token_events) == len(input_text), (
            f"Expected {len(input_text)} TOKEN events for input '{input_text}', "
            f"got {len(token_events)}"
        )

    async def test_stream_token_data_matches_chars(self) -> None:
        """stream() TOKEN events carry one character each."""
        agent = EchoAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)
        input_text = "Hi!"
        request = make_request(input_text)

        events = []
        async for event in agent.stream(request, ctx):
            events.append(event)

        token_events = [e for e in events if e.event_type == EventType.TOKEN]
        token_data = "".join(e.data for e in token_events)
        assert token_data == input_text, (
            f"Expected concatenated token data='{input_text}', got '{token_data}'"
        )

    async def test_stream_empty_input_no_token_events(self) -> None:
        """stream() with empty input yields only THINKING, no TOKEN events."""
        agent = EchoAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)
        request = make_request("")

        events = []
        async for event in agent.stream(request, ctx):
            events.append(event)

        token_events = [e for e in events if e.event_type == EventType.TOKEN]
        assert len(token_events) == 0, (
            f"Expected no TOKEN events for empty input, got {len(token_events)}"
        )

    async def test_stream_thinking_event_has_agent_metadata(self) -> None:
        """stream() THINKING event includes agent metadata."""
        agent = EchoAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)
        request = make_request("test")

        events = []
        async for event in agent.stream(request, ctx):
            events.append(event)

        thinking_event = next(e for e in events if e.event_type == EventType.THINKING)
        assert "agent" in thinking_event.metadata, (
            f"Expected 'agent' in THINKING event metadata, got {thinking_event.metadata}"
        )

    async def test_stream_does_not_yield_started_or_completed(self) -> None:
        """stream() does not yield STARTED or COMPLETED events (handled by SSE/WS handler)."""
        agent = EchoAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)
        request = make_request("hello")

        events = []
        async for event in agent.stream(request, ctx):
            events.append(event)

        event_types = [e.event_type for e in events]
        assert EventType.STARTED not in event_types, (
            f"Expected no STARTED event from stream(), got events: {event_types}"
        )
        assert EventType.COMPLETED not in event_types, (
            f"Expected no COMPLETED event from stream(), got events: {event_types}"
        )


# ---------------------------------------------------------------------------
# Lifecycle tests
# ---------------------------------------------------------------------------


class TestEchoAgentLifecycle:
    """Tests for EchoAgent lifecycle (initialize/shutdown)."""

    async def test_full_lifecycle(self) -> None:
        """EchoAgent supports full lifecycle: create → initialize → invoke → shutdown."""
        agent = EchoAgent(config={})
        ctx = make_context()

        # Before initialize
        assert agent._initialized is False, "Expected not initialized before initialize()"

        # Initialize
        await agent.initialize(ctx)
        assert agent._initialized is True, "Expected initialized after initialize()"

        # Invoke
        request = make_request("lifecycle test")
        response = await agent.invoke(request, ctx)
        assert response.output == "Echo: lifecycle test", "Expected correct output"

        # Shutdown
        await agent.shutdown()
        assert agent._initialized is False, "Expected not initialized after shutdown()"

    def test_accepts_any_config_type(self) -> None:
        """EchoAgent constructor accepts any config type."""
        for config in [None, {}, AgentConfig(), "string-config", 42]:
            agent = EchoAgent(config=config)
            assert agent is not None, f"Expected EchoAgent to accept config={config!r}"
