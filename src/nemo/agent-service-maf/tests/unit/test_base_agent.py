"""Unit tests for BaseAgent abstract base class.

Tests cover:
- BaseAgent is abstract and cannot be instantiated directly
- Concrete subclasses can be instantiated
- initialize() stores context and sets _initialized flag
- shutdown() clears context and resets _initialized
- context property raises RuntimeError before initialize()
- context property returns stored context after initialize()
- Lifecycle state transitions (initialized → shutdown → uninitialized)
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

import pytest

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

# ---------------------------------------------------------------------------
# Minimal concrete implementation for testing
# ---------------------------------------------------------------------------


class ConcreteTestAgent(BaseAgent):
    """Minimal concrete BaseAgent implementation for unit testing."""

    async def invoke(
        self,
        request: AgentRequest,
        context: AgentExecutionContext,
    ) -> AgentResponse:
        return AgentResponse(agent_id="test", output=f"Response: {request.input}")

    async def stream(
        self,
        request: AgentRequest,
        context: AgentExecutionContext,
    ) -> AsyncIterator[AgentEvent]:
        yield AgentEvent(event_type=EventType.TOKEN, data=request.input)

    def get_capabilities(self) -> AgentCapabilities:
        return AgentCapabilities(
            agent_id="test",
            framework="test",
            description="Concrete test agent",
        )


def make_context(config: AgentConfig | None = None) -> AgentExecutionContext:
    """Create a minimal AgentExecutionContext for testing."""
    return AgentExecutionContext(
        config=config or AgentConfig(),
        correlation_id=str(uuid.uuid4()),
    )


# ---------------------------------------------------------------------------
# Abstract enforcement
# ---------------------------------------------------------------------------


class TestBaseAgentAbstract:
    """Tests verifying that BaseAgent enforces abstract method implementation."""

    def test_base_agent_cannot_be_instantiated(self) -> None:
        """BaseAgent cannot be instantiated because it has abstract methods."""
        with pytest.raises(TypeError) as exc_info:
            BaseAgent(config={})  # type: ignore[abstract]
        assert "abstract" in str(exc_info.value).lower(), (
            f"Expected TypeError about abstract methods, got: {exc_info.value}"
        )

    def test_partial_implementation_cannot_be_instantiated(self) -> None:
        """A BaseAgent subclass missing some abstract methods raises TypeError."""

        class PartialAgent(BaseAgent):
            async def invoke(self, request, context):
                return AgentResponse(agent_id="p", output="")

            # Missing: stream() and get_capabilities()

        with pytest.raises(TypeError):
            PartialAgent(config={})  # type: ignore[abstract]

    def test_full_implementation_can_be_instantiated(self) -> None:
        """A BaseAgent subclass implementing all methods can be instantiated."""
        agent = ConcreteTestAgent(config={})
        assert agent is not None, "Expected ConcreteTestAgent to be instantiatable"


# ---------------------------------------------------------------------------
# Constructor and initial state
# ---------------------------------------------------------------------------


class TestBaseAgentConstruction:
    """Tests for BaseAgent constructor and initial state."""

    def test_config_is_stored(self) -> None:
        """Config passed to constructor is stored as _config."""
        config = {"model": "test-model"}
        agent = ConcreteTestAgent(config=config)
        assert agent._config is config, "Expected _config to be stored as-is"

    def test_context_initially_none(self) -> None:
        """_context is None before initialize() is called."""
        agent = ConcreteTestAgent(config={})
        assert agent._context is None, f"Expected _context=None, got {agent._context}"

    def test_initialized_initially_false(self) -> None:
        """_initialized is False before initialize() is called."""
        agent = ConcreteTestAgent(config={})
        assert agent._initialized is False, f"Expected _initialized=False, got {agent._initialized}"


# ---------------------------------------------------------------------------
# context property
# ---------------------------------------------------------------------------


class TestContextProperty:
    """Tests for the context property behavior before and after initialize()."""

    def test_context_raises_before_initialize(self) -> None:
        """Accessing context before initialize() raises RuntimeError."""
        agent = ConcreteTestAgent(config={})
        with pytest.raises(RuntimeError) as exc_info:
            _ = agent.context
        error_msg = str(exc_info.value)
        assert "initialize" in error_msg.lower() or "context" in error_msg.lower(), (
            f"Expected error about calling initialize first, got: {error_msg}"
        )

    def test_context_raises_with_actionable_message(self) -> None:
        """RuntimeError from context property contains actionable guidance."""
        agent = ConcreteTestAgent(config={})
        with pytest.raises(RuntimeError) as exc_info:
            _ = agent.context
        error_msg = str(exc_info.value)
        # Should mention initialize()
        assert "initialize" in error_msg, (
            f"Expected 'initialize' in RuntimeError message, got: {error_msg}"
        )

    async def test_context_available_after_initialize(self) -> None:
        """Accessing context after initialize() returns the stored context."""
        agent = ConcreteTestAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)
        assert agent.context is ctx, "Expected agent.context to return the stored context"

    async def test_context_raises_after_shutdown(self) -> None:
        """Accessing context after shutdown() raises RuntimeError again."""
        agent = ConcreteTestAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)
        await agent.shutdown()
        with pytest.raises(RuntimeError):
            _ = agent.context


# ---------------------------------------------------------------------------
# initialize() lifecycle
# ---------------------------------------------------------------------------


class TestBaseAgentInitialize:
    """Tests for the initialize() lifecycle method."""

    async def test_initialize_stores_context(self) -> None:
        """initialize() stores the context in _context."""
        agent = ConcreteTestAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)
        assert agent._context is ctx, "Expected _context to be stored after initialize()"

    async def test_initialize_sets_initialized_flag(self) -> None:
        """initialize() sets _initialized to True."""
        agent = ConcreteTestAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)
        assert agent._initialized is True, (
            f"Expected _initialized=True after initialize(), got {agent._initialized}"
        )

    async def test_initialize_with_different_contexts(self) -> None:
        """initialize() with a new context updates the stored context."""
        agent = ConcreteTestAgent(config={})
        ctx1 = make_context()
        ctx2 = make_context()
        await agent.initialize(ctx1)
        assert agent._context is ctx1, "Expected ctx1 to be stored"
        await agent.initialize(ctx2)
        assert agent._context is ctx2, "Expected ctx2 to overwrite ctx1"


# ---------------------------------------------------------------------------
# shutdown() lifecycle
# ---------------------------------------------------------------------------


class TestBaseAgentShutdown:
    """Tests for the shutdown() lifecycle method."""

    async def test_shutdown_clears_context(self) -> None:
        """shutdown() sets _context to None."""
        agent = ConcreteTestAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)
        await agent.shutdown()
        assert agent._context is None, (
            f"Expected _context=None after shutdown(), got {agent._context}"
        )

    async def test_shutdown_resets_initialized_flag(self) -> None:
        """shutdown() resets _initialized to False."""
        agent = ConcreteTestAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)
        await agent.shutdown()
        assert agent._initialized is False, (
            f"Expected _initialized=False after shutdown(), got {agent._initialized}"
        )

    async def test_shutdown_before_initialize_does_not_raise(self) -> None:
        """shutdown() before initialize() does not raise an exception."""
        agent = ConcreteTestAgent(config={})
        # Should not raise even though never initialized
        await agent.shutdown()
        assert agent._initialized is False, "Expected _initialized=False after premature shutdown()"

    async def test_shutdown_twice_does_not_raise(self) -> None:
        """Calling shutdown() twice in a row does not raise."""
        agent = ConcreteTestAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)
        await agent.shutdown()
        await agent.shutdown()  # Should not raise


# ---------------------------------------------------------------------------
# Full lifecycle sequence
# ---------------------------------------------------------------------------


class TestBaseAgentLifecycle:
    """Tests for complete agent lifecycle sequences."""

    async def test_full_lifecycle_initialize_invoke_shutdown(self) -> None:
        """Complete lifecycle: initialize → invoke → shutdown works correctly."""
        agent = ConcreteTestAgent(config={})
        ctx = make_context()

        await agent.initialize(ctx)
        assert agent._initialized is True, "Expected initialized after initialize()"

        request = AgentRequest(agent_id="test", input="hello")
        response = await agent.invoke(request, ctx)
        assert response.output == "Response: hello", (
            f"Expected 'Response: hello', got {response.output!r}"
        )

        await agent.shutdown()
        assert agent._initialized is False, "Expected not initialized after shutdown()"

    async def test_reinitialize_after_shutdown(self) -> None:
        """Agent can be re-initialized after shutdown for a new invocation."""
        agent = ConcreteTestAgent(config={})
        ctx1 = make_context()
        ctx2 = make_context()

        await agent.initialize(ctx1)
        await agent.shutdown()
        await agent.initialize(ctx2)

        assert agent._initialized is True, "Expected initialized after re-initialize()"
        assert agent._context is ctx2, "Expected new context after re-initialize()"

    async def test_stream_yields_events(self) -> None:
        """stream() method yields AgentEvent objects."""
        agent = ConcreteTestAgent(config={})
        ctx = make_context()
        await agent.initialize(ctx)

        request = AgentRequest(agent_id="test", input="hi")
        events = []
        async for event in agent.stream(request, ctx):
            events.append(event)

        assert len(events) > 0, "Expected at least one event from stream()"
        assert all(isinstance(e, AgentEvent) for e in events), (
            "Expected all stream events to be AgentEvent instances"
        )

    def test_get_capabilities_before_initialize(self) -> None:
        """get_capabilities() works before initialize() (static, no context needed)."""
        agent = ConcreteTestAgent(config={})
        # Should not raise even though not initialized
        caps = agent.get_capabilities()
        assert isinstance(caps, AgentCapabilities), (
            f"Expected AgentCapabilities from get_capabilities(), got {type(caps)}"
        )
