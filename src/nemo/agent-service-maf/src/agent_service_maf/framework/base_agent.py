"""Base agent abstract class — common boilerplate for all framework adapters.

All framework adapters (the Microsoft Agent Framework adapter, EchoAgent, etc.) must subclass
:class:`BaseAgent` and implement the three abstract methods:
``invoke()``, ``stream()``, and ``get_capabilities()``.

:class:`BaseAgent` provides:
    - A concrete ``initialize()`` that stores context and logs startup.
    - A concrete ``shutdown()`` that clears context and logs shutdown.
    - A ``context`` property that raises :class:`RuntimeError` if accessed before
      ``initialize()`` is called — preventing silent bugs from un-initialized adapters.
    - Structured logging via ``structlog`` for all lifecycle events.

Usage example (see also ``src/agent_service_maf/examples/echo_agent.py``):

.. code-block:: python

    @FrameworkRegistry.register("my_framework")
    class MyAdapter(BaseAgent):
        async def invoke(self, request, context):
            return AgentResponse(
                agent_id=request.agent_id,
                output=f"Processed: {request.input}",
            )

        async def stream(self, request, context):
            yield AgentEvent(event_type=EventType.TOKEN, data="result")

        def get_capabilities(self):
            return AgentCapabilities(agent_id="my_framework", framework="my_framework")
"""

from __future__ import annotations

from abc import abstractmethod
from collections.abc import AsyncIterator

import structlog

from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.interfaces import (
    AgentCapabilities,
    AgentEvent,
    AgentInterface,
    AgentRequest,
    AgentResponse,
)

logger = structlog.get_logger(__name__)


class BaseAgent(AgentInterface):
    """Abstract base class for all framework adapters.

    Provides concrete implementations of ``initialize()`` and ``shutdown()``
    so that adapter authors only need to implement the three domain methods:
    ``invoke()``, ``stream()``, and ``get_capabilities()``.

    Subclasses MUST be decorated with ``@FrameworkRegistry.register("name")`` to be
    discoverable via the registry. See ``src/agent_service_maf/examples/echo_agent.py``
    for a complete reference implementation.

    Attributes:
        _config: The config object passed to the constructor. Type is intentionally
            ``object`` because adapters receive the full ``AgentConfig`` but may cast
            it internally to their required type.
        _context: The ``AgentExecutionContext`` stored during ``initialize()``.
            Access via the ``context`` property which guards against uninitialized use.
        _initialized: Boolean flag set to ``True`` after ``initialize()`` succeeds.
            Used for idempotency checks in lifecycle management.

    Args:
        config: Configuration object for this adapter. Typically an ``AgentConfig``
            instance or a framework-specific sub-config. Stored as ``_config``.

    Example:
        >>> @FrameworkRegistry.register("echo")
        ... class EchoAgent(BaseAgent):
        ...     async def invoke(self, request, context):
        ...         return AgentResponse(agent_id="echo", output=f"Echo: {request.input}")
        ...     async def stream(self, request, context):
        ...         yield AgentEvent(event_type=EventType.TOKEN, data=request.input)
        ...     def get_capabilities(self):
        ...         return AgentCapabilities(agent_id="echo", framework="echo")
    """

    def __init__(self, config: object) -> None:
        self._config = config
        self._context: AgentExecutionContext | None = None
        self._initialized: bool = False

    @property
    def context(self) -> AgentExecutionContext:
        """The active execution context for this invocation.

        Returns:
            The :class:`~agent_service_maf.core.context.AgentExecutionContext` stored
            during the last ``initialize()`` call.

        Raises:
            RuntimeError: If accessed before ``initialize()`` has been called. This
                indicates a programming error — the executor always calls
                ``initialize()`` before ``invoke()`` or ``stream()``.

        Example:
            >>> await agent.initialize(context)
            >>> model = agent.context.config.agent.model
        """
        if self._context is None:
            raise RuntimeError(
                "Agent context is not available. "
                "Call initialize(context) before accessing agent.context. "
                "The AgentExecutor handles this automatically — if you see this error "
                "in production, check that the executor's initialize() call succeeded."
            )
        return self._context

    async def initialize(self, context: AgentExecutionContext) -> None:
        """Initialize the agent with its execution context.

        Stores the context, sets the initialized flag, and logs the startup event.
        Subclasses may override this to perform additional setup (e.g., building
        an agent workflow), but MUST call
        ``await super().initialize(context)`` first.

        Args:
            context: Runtime dependencies for this invocation. Stored as
                ``self._context`` and accessible via the ``context`` property.

        Example:
            >>> await agent.initialize(context)
            >>> assert agent._initialized is True
        """
        self._context = context
        self._initialized = True
        logger.info(
            "Agent initialized",
            framework=self.get_capabilities().framework,
            agent_id=self.get_capabilities().agent_id,
            correlation_id=context.correlation_id,
        )

    async def shutdown(self) -> None:
        """Gracefully shut down the agent and release resources.

        Clears the stored context, resets the initialized flag, and logs the
        shutdown event. This prevents memory leaks when agents are reused across
        multiple invocations.

        Subclasses may override this to release framework-specific resources
        (e.g., closing LLM connections, shutting down background threads), but
        SHOULD call ``await super().shutdown()`` at the end.

        Example:
            >>> await agent.shutdown()
            >>> assert agent._initialized is False
            >>> assert agent._context is None
        """
        framework = "unknown"
        agent_id = "unknown"
        try:
            caps = self.get_capabilities()
            framework = caps.framework
            agent_id = caps.agent_id
        except Exception:
            pass

        self._initialized = False
        self._context = None
        logger.info("Agent shut down", framework=framework, agent_id=agent_id)

    @abstractmethod
    async def invoke(
        self,
        request: AgentRequest,
        context: AgentExecutionContext,
    ) -> AgentResponse:
        """Execute a synchronous agent invocation.

        Implement this to process a request and return a complete response.
        The executor measures wall-clock time and sets ``response.duration_ms``
        after this method returns — adapters do not need to set it.

        Args:
            request: The invocation request (input, context, overrides, etc.).
            context: Runtime dependencies. Same object passed to ``initialize()``.

        Returns:
            Complete :class:`~agent_service_maf.core.interfaces.AgentResponse`.

        Raises:
            AgentInvocationError: Wrap any framework-specific errors before raising.
        """
        ...

    @abstractmethod
    def stream(
        self,
        request: AgentRequest,
        context: AgentExecutionContext,
    ) -> AsyncIterator[AgentEvent]:
        """Execute a streaming agent invocation.

        Implement this to yield events as the agent processes the request.
        The SSE/WebSocket handlers send STARTED before and COMPLETED after
        iterating this generator — adapters should NOT yield those sentinels.

        Cancellation: If the caller breaks out of the async for loop
        (e.g., client disconnect), Python will throw ``GeneratorExit`` into
        the generator. Adapters should handle this to cancel in-flight calls.

        Args:
            request: The invocation request.
            context: Runtime dependencies.

        Yields:
            :class:`~agent_service_maf.core.interfaces.AgentEvent` instances in
            chronological order. Use ``EventType.TOKEN`` for text chunks and
            ``EventType.ERROR`` for failures.
        """
        ...

    @abstractmethod
    def get_capabilities(self) -> AgentCapabilities:
        """Return this adapter's static capabilities metadata.

        Must be callable before ``initialize()`` — do not access ``self._context``
        or ``self.context`` here.

        Returns:
            :class:`~agent_service_maf.core.interfaces.AgentCapabilities` with
            ``agent_id``, ``framework``, protocol support, and tool list.
        """
        ...
