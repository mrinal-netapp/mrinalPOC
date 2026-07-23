"""Unit tests for AgentExecutor.

Tests cover:
- invoke() resolves adapter, initializes, and returns response
- invoke() sets duration_ms on the response
- invoke() wraps non-AgentInvocationError exceptions
- invoke() re-raises AgentInvocationError without double-wrapping
- stream() resolves adapter, initializes, and yields events
- stream() wraps non-AgentInvocationError exceptions
- stream() re-raises AgentInvocationError without double-wrapping
- Error details contain agent_id, framework, correlation_id, duration_ms
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator

import pytest

from agent_service_maf.config.validators import AgentConfig
from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.exceptions import AgentInvocationError, FrameworkNotFoundError
from agent_service_maf.core.interfaces import (
    AgentCapabilities,
    AgentEvent,
    AgentRequest,
    AgentResponse,
    EventType,
    TokenUsage,
)
from agent_service_maf.framework.base_agent import BaseAgent
from agent_service_maf.framework.executor import AgentExecutor
from agent_service_maf.framework.registry import FrameworkRegistry, FrameworkRegistryProtocol

# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------


def make_context(framework: str = "test") -> AgentExecutionContext:
    """Create a minimal AgentExecutionContext for testing."""
    config = AgentConfig(**{"agent": {"framework": framework}})
    return AgentExecutionContext(
        config=config,
        correlation_id=str(uuid.uuid4()),
    )


def make_request(agent_id: str = "test-agent", input: str = "hello") -> AgentRequest:
    """Create a minimal AgentRequest for testing."""
    return AgentRequest(agent_id=agent_id, input=input)


class SuccessAdapter(BaseAgent):
    """Adapter that always succeeds."""

    async def invoke(self, request: AgentRequest, context: AgentExecutionContext) -> AgentResponse:
        return AgentResponse(
            agent_id=request.agent_id,
            output=f"Success: {request.input}",
            usage=TokenUsage(prompt_tokens=10, completion_tokens=20, total_tokens=30),
        )

    async def stream(
        self, request: AgentRequest, context: AgentExecutionContext
    ) -> AsyncIterator[AgentEvent]:
        yield AgentEvent(event_type=EventType.THINKING, data="thinking")
        yield AgentEvent(event_type=EventType.TOKEN, data="result")

    def get_capabilities(self) -> AgentCapabilities:
        return AgentCapabilities(agent_id="success", framework="success")


class FailingAdapter(BaseAgent):
    """Adapter that always raises a generic exception."""

    async def invoke(self, request: AgentRequest, context: AgentExecutionContext) -> AgentResponse:
        raise ValueError("Adapter failed")

    async def stream(
        self, request: AgentRequest, context: AgentExecutionContext
    ) -> AsyncIterator[AgentEvent]:
        raise ValueError("Stream adapter failed")
        yield  # Make it an async generator

    def get_capabilities(self) -> AgentCapabilities:
        return AgentCapabilities(agent_id="failing", framework="failing")


class InvocationErrorAdapter(BaseAgent):
    """Adapter that raises AgentInvocationError directly."""

    async def invoke(self, request: AgentRequest, context: AgentExecutionContext) -> AgentResponse:
        raise AgentInvocationError("Already wrapped error", details={"agent_id": "test"})

    async def stream(
        self, request: AgentRequest, context: AgentExecutionContext
    ) -> AsyncIterator[AgentEvent]:
        raise AgentInvocationError("Already wrapped stream error")
        yield  # Make it an async generator

    def get_capabilities(self) -> AgentCapabilities:
        return AgentCapabilities(agent_id="invocation-error", framework="invocation-error")


class MockRegistry(FrameworkRegistryProtocol):
    """Mock registry for executor dependency injection."""

    def __init__(
        self, adapter_cls: type[BaseAgent] | None = None, raise_on_create: bool = False
    ) -> None:
        self._adapter_cls = adapter_cls
        self._raise_on_create = raise_on_create

    @classmethod
    def create(cls, name: str, config: object) -> BaseAgent:
        raise NotImplementedError("Use instance method via executor injection")

    @classmethod
    def list_frameworks(cls) -> list[str]:
        return []

    @classmethod
    def list_capabilities(cls) -> list[AgentCapabilities]:
        return []

    @classmethod
    def is_registered(cls, name: str) -> bool:
        return False


def make_mock_registry(
    adapter_cls: type[BaseAgent] | None = None,
    raise_on_create: Exception | None = None,
) -> type[FrameworkRegistryProtocol]:
    """Create a mock registry class for injection into AgentExecutor."""
    _adapter = adapter_cls
    _raise = raise_on_create

    class _MockRegistry(FrameworkRegistryProtocol):
        @classmethod
        def create(cls, name: str, config: object) -> BaseAgent:
            if _raise is not None:
                raise _raise
            return _adapter(config)  # type: ignore[misc]

        @classmethod
        def list_frameworks(cls) -> list[str]:
            return ["mock"] if _adapter else []

        @classmethod
        def list_capabilities(cls) -> list[AgentCapabilities]:
            return []

        @classmethod
        def is_registered(cls, name: str) -> bool:
            return True

    return _MockRegistry


# ---------------------------------------------------------------------------
# AgentExecutor.invoke() tests
# ---------------------------------------------------------------------------


class TestAgentExecutorInvoke:
    """Tests for AgentExecutor.invoke()."""

    async def test_invoke_returns_agent_response(self) -> None:
        """invoke() returns an AgentResponse from the adapter."""
        registry = make_mock_registry(SuccessAdapter)
        executor = AgentExecutor(registry=registry)
        context = make_context()
        request = make_request()

        response = await executor.invoke(request, context)
        assert isinstance(response, AgentResponse), f"Expected AgentResponse, got {type(response)}"

    async def test_invoke_response_output_matches_adapter(self) -> None:
        """invoke() response contains the adapter's output."""
        registry = make_mock_registry(SuccessAdapter)
        executor = AgentExecutor(registry=registry)
        context = make_context()
        request = make_request(input="test input")

        response = await executor.invoke(request, context)
        assert "test input" in response.output, (
            f"Expected 'test input' in output, got {response.output!r}"
        )

    async def test_invoke_sets_duration_ms_positive(self) -> None:
        """invoke() sets duration_ms to a non-negative value."""
        registry = make_mock_registry(SuccessAdapter)
        executor = AgentExecutor(registry=registry)
        context = make_context()
        request = make_request()

        response = await executor.invoke(request, context)
        assert response.duration_ms >= 0, f"Expected duration_ms >= 0, got {response.duration_ms}"

    async def test_invoke_wraps_generic_exception_in_invocation_error(self) -> None:
        """invoke() wraps non-AgentInvocationError exceptions."""
        registry = make_mock_registry(FailingAdapter)
        executor = AgentExecutor(registry=registry)
        context = make_context()
        request = make_request()

        with pytest.raises(AgentInvocationError) as exc_info:
            await executor.invoke(request, context)
        assert "ValueError" in str(exc_info.value) or "failed" in str(exc_info.value).lower(), (
            f"Expected wrapped ValueError in AgentInvocationError, got: {exc_info.value}"
        )

    async def test_invoke_exception_chains_original(self) -> None:
        """invoke() chains the original exception via __cause__."""
        registry = make_mock_registry(FailingAdapter)
        executor = AgentExecutor(registry=registry)
        context = make_context()
        request = make_request()

        with pytest.raises(AgentInvocationError) as exc_info:
            await executor.invoke(request, context)
        assert exc_info.value.__cause__ is not None, (
            "Expected __cause__ to be set on the wrapped exception"
        )
        assert isinstance(exc_info.value.__cause__, ValueError), (
            f"Expected __cause__ to be ValueError, got {type(exc_info.value.__cause__)}"
        )

    async def test_invoke_error_details_contain_context(self) -> None:
        """invoke() error details contain agent_id, framework, correlation_id, duration_ms."""
        registry = make_mock_registry(FailingAdapter)
        executor = AgentExecutor(registry=registry)
        context = make_context(framework="failing")
        request = make_request(agent_id="my-agent")

        with pytest.raises(AgentInvocationError) as exc_info:
            await executor.invoke(request, context)
        details = exc_info.value.details
        assert details.get("agent_id") == "my-agent", (
            f"Expected agent_id='my-agent' in details, got {details.get('agent_id')!r}"
        )
        assert details.get("framework") == "failing", (
            f"Expected framework='failing' in details, got {details.get('framework')!r}"
        )
        assert "correlation_id" in details, "Expected 'correlation_id' in error details"
        assert "duration_ms" in details, "Expected 'duration_ms' in error details"

    async def test_invoke_does_not_double_wrap_invocation_error(self) -> None:
        """invoke() re-raises AgentInvocationError without wrapping it again."""
        registry = make_mock_registry(InvocationErrorAdapter)
        executor = AgentExecutor(registry=registry)
        context = make_context()
        request = make_request()

        with pytest.raises(AgentInvocationError) as exc_info:
            await executor.invoke(request, context)
        # The original AgentInvocationError message should be preserved
        assert "Already wrapped error" in str(exc_info.value), (
            f"Expected original message preserved, got: {exc_info.value}"
        )

    async def test_invoke_wraps_framework_not_found(self) -> None:
        """invoke() wraps FrameworkNotFoundError in AgentInvocationError."""
        registry = make_mock_registry(raise_on_create=FrameworkNotFoundError("Framework not found"))
        executor = AgentExecutor(registry=registry)
        context = make_context()
        request = make_request()

        with pytest.raises(AgentInvocationError):
            await executor.invoke(request, context)

    async def test_invoke_uses_framework_from_config(self) -> None:
        """invoke() uses config.agent.framework to select the adapter."""
        call_log: list[str] = []

        class LoggingRegistry(FrameworkRegistryProtocol):
            @classmethod
            def create(cls, name: str, config: object) -> BaseAgent:
                call_log.append(name)
                return SuccessAdapter(config)

            @classmethod
            def list_frameworks(cls) -> list[str]:
                return []

            @classmethod
            def list_capabilities(cls) -> list[AgentCapabilities]:
                return []

            @classmethod
            def is_registered(cls, name: str) -> bool:
                return True

        executor = AgentExecutor(registry=LoggingRegistry)
        context = make_context(framework="my-framework")
        request = make_request()

        await executor.invoke(request, context)
        assert "my-framework" in call_log, (
            f"Expected registry.create called with 'my-framework', got: {call_log}"
        )


# ---------------------------------------------------------------------------
# AgentExecutor.stream() tests
# ---------------------------------------------------------------------------


class TestAgentExecutorStream:
    """Tests for AgentExecutor.stream()."""

    async def test_stream_yields_agent_events(self) -> None:
        """stream() yields AgentEvent objects from the adapter."""
        registry = make_mock_registry(SuccessAdapter)
        executor = AgentExecutor(registry=registry)
        context = make_context()
        request = make_request()

        events = []
        async for event in executor.stream(request, context):
            events.append(event)

        assert len(events) > 0, "Expected at least one event from stream()"
        assert all(isinstance(e, AgentEvent) for e in events), (
            "Expected all stream results to be AgentEvent instances"
        )

    async def test_stream_yields_events_in_order(self) -> None:
        """stream() yields events in the order the adapter produces them."""
        registry = make_mock_registry(SuccessAdapter)
        executor = AgentExecutor(registry=registry)
        context = make_context()
        request = make_request()

        events = []
        async for event in executor.stream(request, context):
            events.append(event)

        assert events[0].event_type == EventType.THINKING, (
            f"Expected first event to be THINKING, got {events[0].event_type}"
        )
        assert events[1].event_type == EventType.TOKEN, (
            f"Expected second event to be TOKEN, got {events[1].event_type}"
        )

    async def test_stream_wraps_generic_exception(self) -> None:
        """stream() wraps non-AgentInvocationError exceptions."""
        registry = make_mock_registry(FailingAdapter)
        executor = AgentExecutor(registry=registry)
        context = make_context()
        request = make_request()

        with pytest.raises(AgentInvocationError) as exc_info:
            async for _ in executor.stream(request, context):
                pass
        assert "ValueError" in str(exc_info.value) or "failed" in str(exc_info.value).lower(), (
            f"Expected wrapped ValueError, got: {exc_info.value}"
        )

    async def test_stream_chains_original_exception(self) -> None:
        """stream() chains the original exception via __cause__."""
        registry = make_mock_registry(FailingAdapter)
        executor = AgentExecutor(registry=registry)
        context = make_context()
        request = make_request()

        with pytest.raises(AgentInvocationError) as exc_info:
            async for _ in executor.stream(request, context):
                pass
        assert exc_info.value.__cause__ is not None, (
            "Expected __cause__ to be set on the wrapped exception"
        )

    async def test_stream_does_not_double_wrap_invocation_error(self) -> None:
        """stream() re-raises AgentInvocationError without wrapping."""
        registry = make_mock_registry(InvocationErrorAdapter)
        executor = AgentExecutor(registry=registry)
        context = make_context()
        request = make_request()

        with pytest.raises(AgentInvocationError) as exc_info:
            async for _ in executor.stream(request, context):
                pass
        assert "Already wrapped stream error" in str(exc_info.value), (
            f"Expected original message preserved, got: {exc_info.value}"
        )

    async def test_stream_error_details_contain_context(self) -> None:
        """stream() error details contain agent_id, framework, correlation_id."""
        registry = make_mock_registry(FailingAdapter)
        executor = AgentExecutor(registry=registry)
        context = make_context(framework="failing")
        request = make_request(agent_id="stream-agent")

        with pytest.raises(AgentInvocationError) as exc_info:
            async for _ in executor.stream(request, context):
                pass
        details = exc_info.value.details
        assert details.get("agent_id") == "stream-agent", (
            f"Expected agent_id='stream-agent' in details, got {details.get('agent_id')!r}"
        )
        assert details.get("framework") == "failing", (
            f"Expected framework='failing' in details, got {details.get('framework')!r}"
        )


# ---------------------------------------------------------------------------
# AgentExecutor construction
# ---------------------------------------------------------------------------


class TestAgentExecutorConstruction:
    """Tests for AgentExecutor initialization."""

    def test_default_registry_is_framework_registry(self) -> None:
        """AgentExecutor defaults to using FrameworkRegistry."""
        executor = AgentExecutor()
        assert executor.registry is FrameworkRegistry, (
            f"Expected default registry to be FrameworkRegistry, got {executor.registry}"
        )

    def test_custom_registry_is_stored(self) -> None:
        """AgentExecutor stores the custom registry passed to it."""
        registry = make_mock_registry(SuccessAdapter)
        executor = AgentExecutor(registry=registry)
        assert executor.registry is registry, "Expected custom registry to be stored on executor"
