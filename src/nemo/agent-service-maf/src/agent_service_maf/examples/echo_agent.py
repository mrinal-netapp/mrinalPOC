"""EchoAgent — minimal reference implementation of the BaseAgent interface.

This module serves two purposes:
1. **Testing**: Provides a deterministic, dependency-free agent for unit and
   integration tests. The echo agent never calls any LLM or external service.
2. **Documentation**: Shows framework adapter authors exactly how to implement
   ``BaseAgent``. Follow this pattern to add a new framework adapter.

How to create a new framework adapter based on this template:

1. Create ``src/agent_service_maf/framework/{name}_adapter.py``.
2. Subclass ``BaseAgent`` and apply ``@FrameworkRegistry.register("{name}")``.
3. Implement ``invoke()``, ``stream()``, and ``get_capabilities()``.
4. Add config defaults in ``configs/agent_config.json`` under ``agent.framework``.
5. Import the module in ``src/agent_service_maf/framework/__init__.py``.
6. Write integration tests in ``tests/integration/test_{name}_adapter.py``.
7. Run ``make test-all`` to verify.

Key contracts this template demonstrates:
- ``get_capabilities()`` must work *before* ``initialize()`` is called.
- ``invoke()`` returns a complete ``AgentResponse`` (not a generator).
- ``stream()`` is an async generator; it yields ``AgentEvent`` objects.
- The executor adds STARTED/COMPLETED sentinels around ``stream()`` — do not
  yield them here (the SSE and WS handlers do this).
- ``metadata`` in ``AgentResponse`` is safe to populate with runtime info.
- ``context.correlation_id`` should be included in response metadata for tracing.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from datetime import UTC, datetime

from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.interfaces import (
    AgentCapabilities,
    AgentEvent,
    AgentRequest,
    AgentResponse,
    EventType,
)
from agent_service_maf.framework.base_agent import BaseAgent
from agent_service_maf.framework.registry import FrameworkRegistry


@FrameworkRegistry.register("echo")
class EchoAgent(BaseAgent):
    """Minimal reference implementation of AgentInterface.

    Echoes back the user's input without calling any LLM or external service.
    Demonstrates:
    - Synchronous invocation (``invoke()``)
    - Token-by-token streaming (``stream()``)
    - Capability self-description (``get_capabilities()``)
    - Proper use of ``context.correlation_id`` in response metadata

    This agent is registered as ``"echo"`` in the ``FrameworkRegistry``. To use it:

    .. code-block:: python

        # In agent_config.json or AGENT_AGENT__FRAMEWORK env var:
        {"agent": {"framework": "echo"}}

    Or programmatically:

    .. code-block:: python

        from agent_service_maf.examples.echo_agent import EchoAgent  # triggers registration
        from agent_service_maf.framework.registry import FrameworkRegistry

        agent = FrameworkRegistry.create("echo", config)
        await agent.initialize(context)
        response = await agent.invoke(request, context)
        print(response.output)  # "Echo: <input>"

    Streaming example:

    .. code-block:: python

        async for event in agent.stream(request, context):
            if event.event_type == EventType.TOKEN:
                print(event.data, end="", flush=True)

    Args:
        config: Configuration object (not used by EchoAgent, accepts any value).
    """

    async def invoke(
        self,
        request: AgentRequest,
        context: AgentExecutionContext,
    ) -> AgentResponse:
        """Echo the input text with a prefix.

        Returns the input prefixed with ``"Echo: "`` as a complete response.
        Includes ``correlation_id`` in response metadata for tracing.

        Args:
            request: The invocation request. ``request.input`` is echoed back.
            context: Runtime dependencies (not used by EchoAgent).

        Returns:
            :class:`~agent_service_maf.core.interfaces.AgentResponse` with:
            - ``output``: ``"Echo: {request.input}"``
            - ``artifacts``: empty list
            - ``usage``: ``None`` (EchoAgent does not call an LLM)
            - ``metadata``: ``{"request_id": context.correlation_id}``
            - ``duration_ms``: 0 (set to actual duration by the executor)

        Example:
            >>> response = await echo_agent.invoke(request, context)
            >>> response.output
            'Echo: Hello, world!'
        """
        return AgentResponse(
            agent_id="echo",
            output=f"Echo: {request.input}",
            artifacts=[],
            usage=None,
            metadata={"request_id": context.correlation_id},
            duration_ms=0,
        )

    async def stream(
        self,
        request: AgentRequest,
        context: AgentExecutionContext,
    ) -> AsyncIterator[AgentEvent]:
        """Stream the echoed input one character at a time.

        Yields a TOKEN event for each character in ``request.input``.
        The SSE/WebSocket handlers prepend a STARTED event and append a COMPLETED
        event around this generator — do not yield those here.

        Cancellation: Python sends ``GeneratorExit`` to the generator when the
        caller breaks out. Since EchoAgent has no external resources, it can
        exit cleanly without any cleanup.

        Args:
            request: The invocation request. ``request.input`` is streamed char by char.
            context: Runtime dependencies (not used by EchoAgent).

        Yields:
            - ``EventType.THINKING``: One event before the first token.
            - ``EventType.TOKEN``: One event per character in ``request.input``.

        Example:
            >>> events = []
            >>> async for evt in echo_agent.stream(request, context):
            ...     events.append(evt)
            >>> events[0].event_type
            <EventType.THINKING: 'thinking'>
            >>> events[1].event_type
            <EventType.TOKEN: 'token'>
            >>> events[1].data
            'H'
        """
        # Emit a THINKING event to show the agent is "processing".
        yield AgentEvent(
            event_type=EventType.THINKING,
            data="",
            metadata={"agent": "echo"},
            timestamp=datetime.now(tz=UTC),
        )

        # Stream each character as a TOKEN event.
        for char in request.input:
            yield AgentEvent(
                event_type=EventType.TOKEN,
                data=char,
                metadata={},
                timestamp=datetime.now(tz=UTC),
            )

    def get_capabilities(self) -> AgentCapabilities:
        """Return EchoAgent's capabilities metadata.

        This method is safe to call before ``initialize()`` — it returns static
        metadata without accessing ``self.context``.

        Returns:
            :class:`~agent_service_maf.core.interfaces.AgentCapabilities` describing:
            - ``agent_id``: ``"echo"``
            - ``framework``: ``"example"``
            - ``supports_streaming``: ``True``
            - ``supported_protocols``: ``["rest", "sse", "websocket"]``
            - ``available_tools``: ``[]`` (no tools needed)
            - ``description``: Human-readable description.
            - ``version``: ``"1.0.0"``

        Example:
            >>> caps = EchoAgent(config={}).get_capabilities()
            >>> caps.framework
            'example'
            >>> caps.supports_streaming
            True
        """
        return AgentCapabilities(
            agent_id="echo",
            framework="example",
            supports_streaming=True,
            supported_protocols=["rest", "sse", "websocket"],
            available_tools=[],
            description=(
                "Minimal echo agent for testing and as a template for new adapters. "
                "Echoes back the user input without calling any LLM. "
                "See src/agent_service_maf/examples/echo_agent.py for implementation guidance."
            ),
            version="1.0.0",
        )
