"""Server-Sent Events (SSE) streaming handler.

Creates async generators that stream :class:`~agent_service_maf.core.interfaces.AgentEvent`
objects from agent adapters in the SSE wire format consumed by ``sse-starlette``.

SSE format (one dict per event):

.. code-block:: json

    {"event": "token", "data": "{\"data\": \"Hello\", \"metadata\": {}, \"timestamp\": \"...\"}"}

Streaming limits (per engineering-standards.md §1.5):

- ``max_duration_seconds``: Maximum wall-clock time for the entire stream.
  Default: 600 seconds. Streams exceeding this limit receive an ERROR event
  and the generator closes.
- ``max_events``: Maximum number of events the generator may yield.
  Default: 10000. Prevents run-away adapter loops.
- ``idle_timeout_seconds``: Maximum time between events. Default: 60 seconds.
  Detects stale or hung connections and closes them.

All three limits result in an ERROR event being yielded before the generator
closes so the client can detect and handle the termination reason.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from typing import Any

import structlog

from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.interfaces import AgentEvent, AgentRequest, EventType
from agent_service_maf.framework.registry import FrameworkRegistryProtocol

logger = structlog.get_logger(__name__)

# Default streaming limits — override via ``interface.streaming`` config section.
DEFAULT_MAX_DURATION_SECONDS: int = 600
DEFAULT_MAX_EVENTS: int = 10_000
DEFAULT_IDLE_TIMEOUT_SECONDS: int = 60


async def create_sse_generator(
    registry: type[FrameworkRegistryProtocol],
    agent_request: AgentRequest,
    context: AgentExecutionContext,
    *,
    max_duration_seconds: int = DEFAULT_MAX_DURATION_SECONDS,
    max_events: int = DEFAULT_MAX_EVENTS,
    idle_timeout_seconds: int = DEFAULT_IDLE_TIMEOUT_SECONDS,
) -> AsyncIterator[dict[str, str]]:
    """Create an SSE event generator from an agent's stream output.

    Yields SSE-compatible dicts with ``event`` and ``data`` keys. The ``event``
    key holds the event type string; the ``data`` key holds a JSON-encoded
    payload with ``data``, ``metadata``, and ``timestamp`` fields.

    Emits a STARTED event before the adapter stream begins, and a COMPLETED event
    after. If the adapter raises, an ERROR event is yielded instead.

    Streaming limits are enforced:
    - ``max_duration_seconds``: Terminates the stream if total wall time exceeds limit.
    - ``max_events``: Terminates the stream after this many events are yielded.
    - ``idle_timeout_seconds``: Terminates the stream if no events arrive within this
      period (detects hung adapters or stale connections).

    Args:
        registry: The framework registry protocol to create the adapter from.
        agent_request: The agent invocation request.
        context: Runtime dependencies for the invocation.
        max_duration_seconds: Maximum total stream duration in seconds.
        max_events: Maximum number of events to yield before terminating.
        idle_timeout_seconds: Maximum seconds to wait between events.

    Yields:
        Dicts with ``"event"`` and ``"data"`` keys compatible with ``sse-starlette``.

    Example:
        >>> gen = create_sse_generator(registry, request, context)
        >>> async for event_dict in gen:
        ...     print(event_dict["event"], event_dict["data"])
    """
    stream_start = time.monotonic()
    event_count = 0

    try:
        framework = context.config.agent.framework
        agent = registry.create(framework, context.config)
        await agent.initialize(context)

        # §B1 / §5.4.4: the adapter is the single source of truth for the
        # STARTED / COMPLETED bookends and the
        # ``COMPLETED.metadata.invokeResponse`` envelope. Adapters that
        # used to rely on the SSE handler to inject STARTED for them
        # have been migrated. Contract violations (an adapter that does
        # NOT emit STARTED) are caught in tests
        # (``test_sse_handler.py::test_yields_started_event_first``,
        # ``test_empty_stream_yields_started_and_completed``); the
        # handler does NOT probe or patch at runtime -- doing so would
        # either no-op (current shape) or double-up bookends on
        # conforming adapters.
        last_event_time = time.monotonic()
        async for event in agent.stream(agent_request, context):
            now = time.monotonic()
            elapsed = now - stream_start
            idle = now - last_event_time

            # Enforce total duration limit.
            if elapsed > max_duration_seconds:
                logger.warning(
                    "SSE stream exceeded max duration",
                    agent_id=agent_request.agent_id,
                    elapsed_seconds=round(elapsed, 1),
                    max_duration_seconds=max_duration_seconds,
                    correlation_id=context.correlation_id,
                )
                yield _format_event(
                    AgentEvent(
                        event_type=EventType.ERROR,
                        data=(
                            f"Stream terminated: exceeded max duration of "
                            f"{max_duration_seconds}s. "
                            "Increase streaming.max_duration_seconds in config "
                            "or use the REST endpoint for long-running tasks."
                        ),
                        metadata={"reason": "max_duration_exceeded", "elapsed_seconds": elapsed},
                    )
                )
                return

            # Enforce idle timeout.
            if idle > idle_timeout_seconds:
                logger.warning(
                    "SSE stream idle timeout",
                    agent_id=agent_request.agent_id,
                    idle_seconds=round(idle, 1),
                    idle_timeout_seconds=idle_timeout_seconds,
                    correlation_id=context.correlation_id,
                )
                yield _format_event(
                    AgentEvent(
                        event_type=EventType.ERROR,
                        data=(
                            f"Stream terminated: idle for {idle:.1f}s "
                            f"(limit: {idle_timeout_seconds}s). "
                            "Increase streaming.idle_timeout_seconds in config."
                        ),
                        metadata={"reason": "idle_timeout", "idle_seconds": idle},
                    )
                )
                return

            # Enforce event count limit.
            if event_count >= max_events:
                logger.warning(
                    "SSE stream exceeded max events",
                    agent_id=agent_request.agent_id,
                    event_count=event_count,
                    max_events=max_events,
                    correlation_id=context.correlation_id,
                )
                yield _format_event(
                    AgentEvent(
                        event_type=EventType.ERROR,
                        data=(
                            f"Stream terminated: exceeded max event count of {max_events}. "
                            "Increase streaming.max_events in config."
                        ),
                        metadata={"reason": "max_events_exceeded", "event_count": event_count},
                    )
                )
                return

            yield _format_event(event)
            event_count += 1
            last_event_time = time.monotonic()

        # §B1: adapter owns the COMPLETED envelope; the handler does not
        # emit its own COMPLETED here. (A defensive ERROR is emitted by
        # the except branches below for adapters that bail without one
        # of their own.)

    except asyncio.CancelledError:
        # Client disconnected — log and exit cleanly without yielding.
        logger.info(
            "SSE stream cancelled by client",
            agent_id=agent_request.agent_id,
            correlation_id=context.correlation_id,
            events_sent=event_count,
        )
        raise

    except Exception as exc:
        logger.error(
            "SSE stream error",
            agent_id=agent_request.agent_id,
            error_type=type(exc).__name__,
            correlation_id=context.correlation_id,
            exc_info=True,
        )
        yield _format_event(
            AgentEvent(
                event_type=EventType.ERROR,
                data="An error occurred during streaming. Check server logs for details.",
                metadata={
                    "error_type": type(exc).__name__,
                    "correlation_id": context.correlation_id,
                },
            )
        )


def _format_event(event: AgentEvent) -> dict[str, str]:
    """Format an :class:`~agent_service_maf.core.interfaces.AgentEvent` as an
    SSE-compatible dict for ``sse-starlette``.

    The ``event`` key holds the event type string (e.g., ``"token"``).
    The ``data`` key holds a JSON string with ``data``, ``metadata``,
    and ``timestamp`` fields.

    Args:
        event: The agent event to format.

    Returns:
        Dict with ``"event"`` and ``"data"`` keys.

    Example:
        >>> evt = AgentEvent(event_type=EventType.TOKEN, data="Hello")
        >>> d = _format_event(evt)
        >>> d["event"]
        'token'
        >>> import json; json.loads(d["data"])["data"]
        'Hello'
    """
    payload: dict[str, Any] = {
        "data": event.data,
        "metadata": event.metadata,
        "timestamp": event.timestamp.isoformat(),
    }
    return {
        "event": event.event_type.value,
        "data": json.dumps(payload),
    }
