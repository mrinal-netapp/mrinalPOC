"""WebSocket frame parsing + result types for the agent-service WS endpoints.

The agent-service ``/ws`` routes are bidirectional WebSocket sessions. The
client sends one text frame per turn (an ``InvokeRequest`` JSON) and the server
streams back JSON text frames, each with ``event`` / ``data`` / ``metadata`` /
``timestamp`` keys (``event`` is one of the ``EventType`` values: ``started``,
``thinking``, ``token``, ``tool_call``, ``tool_result``, ``artifact``,
``error``, ``completed``).

Unlike SSE, the WS frames are already-decoded JSON objects: ``data`` is the raw
token string and ``metadata`` is a real dict (not a JSON-encoded string). The
terminal ``completed`` frame emitted by the adapter carries the full
``InvokeResponse`` under ``metadata.invokeResponse`` (the same shape REST sync
returns); the handler then sends a second, empty ``completed`` sentinel.

Only the async ``websockets`` library is used here; :class:`AgentServiceClient`
wraps :func:`collect_ws` in ``asyncio.run`` so the suites stay synchronous.
"""

from __future__ import annotations

import asyncio
import json
import ssl
from dataclasses import dataclass, field
from typing import Any

import websockets
from websockets.exceptions import ConnectionClosed, InvalidStatus

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

# Default normal-closure code (RFC 6455). Set when the collector finishes
# cleanly after the terminal event.
WS_NORMAL_CLOSURE = 1000


@dataclass(frozen=True)
class WSEvent:
    """A single decoded WebSocket frame from the server."""

    event: str
    data: str
    metadata: dict[str, Any] = field(default_factory=dict)
    timestamp: str = ""


@dataclass
class WSResult:
    """Eagerly-collected result of a WebSocket invoke turn.

    Holds every parsed :class:`WSEvent` plus the close code. On a handshake
    failure (e.g. a ``4401`` auth close) ``events`` is empty and
    ``connect_error`` / ``close_code`` describe the failure.
    """

    events: list[WSEvent] = field(default_factory=list)
    close_code: int | None = None
    connect_error: str | None = None

    def by_type(self, event_type: str) -> list[WSEvent]:
        """All events whose ``event`` name equals ``event_type``.

        Function use:
            Filters the collected frames by their event name.

        Input:
            event_type (str): The event name to match.

        Output:
            list[WSEvent]: Matching events, in order.
        """
        return [e for e in self.events if e.event == event_type]

    @property
    def completed_event(self) -> WSEvent | None:
        """The terminal ``completed`` event.

        Function use:
            Prefers a ``completed`` frame that carries
            ``metadata.invokeResponse`` (the adapter's bookend); falls back to
            the last ``completed`` frame (the handler's empty sentinel) when
            none carry it.

        Input:
            None

        Output:
            WSEvent | None: The completed event, or ``None`` if absent.
        """
        completed = self.by_type(EVENT_COMPLETED)
        if not completed:
            return None
        for event in completed:
            if isinstance(event.metadata.get("invokeResponse"), dict):
                return event
        return completed[-1]

    @property
    def error_event(self) -> WSEvent | None:
        """The first ``error`` event, if any.

        Function use:
            Returns the first ``error`` frame so callers can inspect failures.

        Input:
            None

        Output:
            WSEvent | None: The first error event, or ``None`` if absent.
        """
        errors = self.by_type(EVENT_ERROR)
        return errors[0] if errors else None

    @property
    def token_events(self) -> list[WSEvent]:
        """All ``token`` events, in order.

        Function use:
            Returns the streamed ``token`` frames for text reconstruction.

        Input:
            None

        Output:
            list[WSEvent]: The token events, in order.
        """
        return self.by_type(EVENT_TOKEN)

    @property
    def text(self) -> str:
        """Concatenated streamed text from the ``token`` events.

        Function use:
            Each ``token`` frame's ``data`` is already the raw text chunk, so
            they are joined directly.

        Input:
            None

        Output:
            str: The concatenated streamed text.
        """
        return "".join(event.data for event in self.token_events)

    @property
    def invoke_response(self) -> dict[str, Any] | None:
        """The ``completed.metadata.invokeResponse`` envelope, if present.

        Function use:
            Extracts the full ``InvokeResponse`` carried on the terminal
            ``completed`` frame's metadata.

        Input:
            None

        Output:
            dict[str, Any] | None: The invokeResponse dict, or ``None`` if
            absent.
        """
        completed = self.completed_event
        if completed is None:
            return None
        invoke_response = completed.metadata.get("invokeResponse")
        return invoke_response if isinstance(invoke_response, dict) else None


def _to_event(raw: str) -> WSEvent | None:
    """Parse one server text frame into a :class:`WSEvent` (``None`` if junk)."""
    try:
        payload = json.loads(raw)
    except (TypeError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    metadata = payload.get("metadata")
    return WSEvent(
        event=str(payload.get("event", "")),
        data=str(payload.get("data", "")),
        metadata=metadata if isinstance(metadata, dict) else {},
        timestamp=str(payload.get("timestamp", "")),
    )


def _ssl_context(url: str, verify_tls: bool) -> ssl.SSLContext | None:
    """Build an SSL context for ``wss://`` URLs honouring ``verify_tls``.

    Mirrors the HTTP clients' ``CURL_INSECURE`` behaviour: when ``verify_tls`` is
    False (self-signed / internal certs), disable hostname + certificate
    verification. Returns ``None`` for plaintext ``ws://`` so the default applies.
    """
    if not url.startswith("wss://"):
        return None
    context = ssl.create_default_context()
    if not verify_tls:
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    return context


async def _connect(
    url: str, headers: dict[str, str], ssl_context: ssl.SSLContext | None
):
    """Open a WS connection, tolerating header-kwarg renames across versions.

    ``websockets`` renamed ``extra_headers`` to ``additional_headers`` in v13;
    try the new name first and fall back for older installs. ``ssl_context`` is
    passed through for ``wss://`` URLs (``None`` leaves the library default).
    """
    kwargs: dict[str, Any] = {}
    if ssl_context is not None:
        kwargs["ssl"] = ssl_context
    try:
        return await websockets.connect(
            url, additional_headers=headers or None, **kwargs
        )
    except TypeError:
        return await websockets.connect(url, extra_headers=headers or None, **kwargs)


async def collect_ws(
    url: str,
    body: dict[str, Any],
    *,
    headers: dict[str, str] | None = None,
    recv_timeout: float = 120.0,
    verify_tls: bool = True,
) -> WSResult:
    """Open a WS session, send one ``InvokeRequest``, and collect frames.

    Function use:
        Sends ``body`` as a single JSON text frame, then reads frames until
        the first ``completed`` (the adapter bookend, which carries
        ``metadata.invokeResponse``) or an ``error`` frame.
        Handshake/connection failures are captured in
        :attr:`WSResult.connect_error` / :attr:`WSResult.close_code` with an
        empty ``events`` list.

    Input:
        url (str): The WebSocket URL to connect to.
        body (dict[str, Any]): The InvokeRequest payload sent as one frame.
        headers (dict[str, str] | None): Optional handshake headers
            (e.g. auth); defaults to none.
        recv_timeout (float): Per-frame receive timeout in seconds.

    Output:
        WSResult: The eagerly-collected WebSocket result.
    """
    headers = headers or {}
    events: list[WSEvent] = []
    try:
        connection = await _connect(url, headers, _ssl_context(url, verify_tls))
    except InvalidStatus as exc:
        code = getattr(getattr(exc, "response", None), "status_code", None)
        return WSResult(events=[], close_code=code, connect_error=str(exc))
    except Exception as exc:  # pragma: no cover - defensive
        return WSResult(events=[], close_code=None, connect_error=str(exc))

    try:
        await connection.send(json.dumps(body))
        while True:
            raw = await asyncio.wait_for(connection.recv(), timeout=recv_timeout)
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", errors="replace")
            event = _to_event(raw)
            if event is None:
                continue
            events.append(event)
            if event.event in (EVENT_COMPLETED, EVENT_ERROR):
                break
    except ConnectionClosed as exc:
        return WSResult(
            events=events,
            close_code=getattr(exc, "code", None),
            connect_error=None if events else str(exc),
        )
    except TimeoutError:
        return WSResult(
            events=events, close_code=None, connect_error="recv timeout"
        )
    finally:
        await connection.close()

    return WSResult(events=events, close_code=WS_NORMAL_CLOSURE)
