"""SSE parsing + result types for the agent-service streaming invoke endpoints.

The agent-service ``/invoke/stream`` routes return Server-Sent Events
(``text/event-stream``). Each event carries an ``event`` name (one of the
``EventType`` values: ``started``, ``thinking``, ``token``, ``tool_call``,
``tool_result``, ``artifact``, ``error``, ``completed``) and a ``data`` field
that is a JSON string (for ``token`` events:
``{"data": "Hello", "metadata": {...}, "timestamp": "..."}``).

Only ``httpx`` is available in the integration env (no SSE client lib), so this
module parses the SSE byte/line stream itself. :func:`parse_sse_lines` turns the
decoded lines into :class:`SSEEvent` objects; :class:`StreamResult` is the
eagerly-collected result returned by the client's streaming methods.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any

# EventType values mirrored from agent-service-maf
# (agent_framework.core.interfaces.EventType).
EVENT_STARTED = "started"
EVENT_THINKING = "thinking"
EVENT_TOKEN = "token"
EVENT_TOOL_CALL = "tool_call"
EVENT_TOOL_RESULT = "tool_result"
EVENT_ARTIFACT = "artifact"
EVENT_ERROR = "error"
EVENT_COMPLETED = "completed"


@dataclass(frozen=True)
class SSEEvent:
    """A single Server-Sent Event: an ``event`` name and its raw ``data``."""

    event: str
    data: str

    @property
    def data_json(self) -> Any | None:
        """Parsed ``data`` as JSON, or ``None`` when it is not valid JSON.

        Function use:
            Lazily decodes the event's raw ``data`` string as JSON for
            callers that need the structured payload.

        Input:
            None

        Output:
            Any | None: The decoded JSON value, or ``None`` if invalid.
        """
        try:
            return json.loads(self.data)
        except (TypeError, ValueError):
            return None


@dataclass
class StreamResult:
    """Eagerly-collected result of a streaming invoke.

    Holds the HTTP status/headers plus every parsed :class:`SSEEvent`. On a
    non-200 response the body is a JSON error (not SSE); it is captured in
    ``raw_non_sse_body`` and ``events`` is empty.
    """

    status_code: int
    headers: dict[str, str] = field(default_factory=dict)
    events: list[SSEEvent] = field(default_factory=list)
    raw_non_sse_body: str | None = None

    def by_type(self, event_type: str) -> list[SSEEvent]:
        """All events whose ``event`` name equals ``event_type``.

        Function use:
            Filters the collected events by their event name.

        Input:
            event_type (str): The event name to match.

        Output:
            list[SSEEvent]: Matching events, in order.
        """
        return [e for e in self.events if e.event == event_type]

    @property
    def completed_event(self) -> SSEEvent | None:
        """The terminal ``completed`` event, if present.

        Function use:
            Returns the last ``completed`` event marking stream end.

        Input:
            None

        Output:
            SSEEvent | None: The completed event, or ``None`` if absent.
        """
        events = self.by_type(EVENT_COMPLETED)
        return events[-1] if events else None

    @property
    def error_event(self) -> SSEEvent | None:
        """The first ``error`` event, if any.

        Function use:
            Returns the first ``error`` event so callers can inspect failures.

        Input:
            None

        Output:
            SSEEvent | None: The first error event, or ``None`` if absent.
        """
        events = self.by_type(EVENT_ERROR)
        return events[0] if events else None

    @property
    def token_events(self) -> list[SSEEvent]:
        """All ``token`` events, in order.

        Function use:
            Returns the streamed ``token`` events for text reconstruction.

        Input:
            None

        Output:
            list[SSEEvent]: The token events, in order.
        """
        return self.by_type(EVENT_TOKEN)

    @property
    def text(self) -> str:
        """Concatenated streamed text from the ``token`` events.

        Function use:
            Each ``token`` event's ``data`` is JSON like
            ``{"data": "Hello", ...}``; the inner ``data`` string is the text
            chunk. Falls back to the raw event ``data`` when it is not the
            expected JSON shape.

        Input:
            None

        Output:
            str: The concatenated streamed text.
        """
        chunks: list[str] = []
        for event in self.token_events:
            parsed = event.data_json
            if isinstance(parsed, dict) and "data" in parsed:
                chunks.append(str(parsed["data"]))
            else:
                chunks.append(event.data)
        return "".join(chunks)


def parse_sse_lines(lines: Iterable[str]) -> list[SSEEvent]:
    """Parse decoded SSE lines into :class:`SSEEvent` objects.

    Function use:
        Follows the SSE grammar: ``event:`` sets the current event name,
        ``data:`` lines accumulate (joined by newlines), comment lines
        (starting with ``:``) are ignored, and a blank line dispatches the
        buffered event. A trailing event without a final blank line is still
        flushed.

    Input:
        lines (Iterable[str]): Decoded SSE text lines from the response.

    Output:
        list[SSEEvent]: The parsed events, in order.
    """
    events: list[SSEEvent] = []
    event_name = "message"
    data_lines: list[str] = []
    has_payload = False

    def flush() -> None:
        nonlocal event_name, data_lines, has_payload
        if has_payload:
            events.append(SSEEvent(event=event_name, data="\n".join(data_lines)))
        event_name = "message"
        data_lines = []
        has_payload = False

    for raw in lines:
        line = raw.rstrip("\r\n")
        if line == "":
            flush()
            continue
        if line.startswith(":"):
            # Comment / keep-alive ping (e.g. sse-starlette ": ping").
            continue
        field_name, _, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if field_name == "event":
            event_name = value
            has_payload = True
        elif field_name == "data":
            data_lines.append(value)
            has_payload = True
        # Other fields (id, retry) are ignored for our purposes.

    flush()
    return events
