"""Typed metadata schemas for streaming events.

Each :class:`~agent_service_maf.core.interfaces.AgentEvent` carries a
free-form ``metadata: dict[str, Any]`` payload. The TypedDicts in this
module describe the **expected shape of that inner ``metadata`` dict**
for each :class:`~agent_service_maf.core.interfaces.EventType`. They give
adapter authors a single source of truth (and mypy enforcement) for
what keys must / may appear on every event.

Wire convention:

- Event tag strings (``started``, ``token``, ``tool_call``,
  ``tool_result``, ``artifact``, ``error``, ``completed``) stay
  snake_case -- they are :class:`~agent_service_maf.core.interfaces.EventType`
  enum values, not field names.
- The **inner ``metadata`` dict** is **camelCase on the wire** to match
  the §5.2 CamelCaseModel convention; that is why the TypedDict keys
  here read camelCase even though Python adapter code may construct the
  dicts inline.

Locked per §5.4.3 of the migration analysis.

These TypedDicts are **advisory at runtime** -- Python does not enforce
TypedDict shapes on dynamic dicts. Their value is mypy --strict in CI,
which flags adapters that emit a ``tool_call`` without ``toolCallId``
or a ``completed`` without ``invokeResponse``. Runtime tests cover the
same ground but the TypedDicts catch the typo before it ships.
"""

from __future__ import annotations

from typing import Any, NotRequired, TypedDict

__all__ = [
    "ArtifactMetadata",
    "CompletedMetadata",
    "ErrorMetadata",
    "StartedMetadata",
    "StreamStats",
    "ThinkingMetadata",
    "TokenMetadata",
    "ToolCallMetadata",
    "ToolResultMetadata",
]


class StartedMetadata(TypedDict, total=False):
    """Optional metadata on a ``started`` event.

    All keys optional -- the bare ``started`` sentinel is valid on its
    own. When present, ``agentId`` and ``framework`` let UI clients
    render an "Agent X (framework Y) is starting..." affordance.
    """

    agentId: str
    framework: str


class ThinkingMetadata(TypedDict, total=False):
    """Optional metadata on a ``thinking`` event.

    The reasoning trace itself goes in the event's ``data`` field; this
    metadata block only carries which agent produced it (useful in
    multi-agent orchestrations).
    """

    agentId: str


class TokenMetadata(TypedDict, total=False):
    """Optional metadata on a ``token`` event.

    The token text goes in the event's ``data`` field. ``agentId`` is
    only required when ambiguous (multi-agent streams) -- single-agent
    streams may omit it.
    """

    agentId: str


class ToolCallMetadata(TypedDict):
    """Required metadata on every ``tool_call`` event.

    Adapters MUST emit ``toolCallId``, ``toolName``, and ``arguments``
    (the last may be an empty dict). ``agentId`` / ``agentName`` are
    only required in multi-agent orchestrations where the responding
    agent identity matters for citation attribution.
    """

    toolCallId: str
    toolName: str
    arguments: dict[str, Any]
    agentId: NotRequired[str]
    agentName: NotRequired[str]


class ToolResultMetadata(TypedDict):
    """Required metadata on every ``tool_result`` event.

    ``toolCallId`` links back to the ``tool_call`` event. ``result``
    holds the JSON-serializable tool output. ``kbCitations`` appears
    whenever the tool itself emits citations -- see
    :class:`~agent_service_maf.tools.functions.FunctionToolResult` for
    the function-tool contract that surfaces them.
    """

    toolCallId: str
    result: Any
    durationMs: NotRequired[int]
    agentId: NotRequired[str]
    agentName: NotRequired[str]
    # list[KbCitation] on the wire; left as list of dicts so this module
    # has no import-cycle with interface_layer/models.py
    kbCitations: NotRequired[list[dict[str, Any]]]


class ArtifactMetadata(TypedDict):
    """Required metadata on every ``artifact`` event.

    ``artifactType`` is a free string today (e.g. ``file`` / ``chart``
    / ``image``); a future tightening to a Literal may happen once
    consumers agree on a vocabulary (§5.4.8 open item #4).

    Exactly one of ``downloadUrl`` and ``inlineContent`` is expected
    in practice but not enforced here -- artifact emitters that have
    both (e.g. a chart with a fallback PNG and a URL) may carry both.
    """

    artifactType: str
    name: str
    mimeType: NotRequired[str]
    downloadUrl: NotRequired[str]
    inlineContent: NotRequired[str]


class ErrorMetadata(TypedDict, total=False):
    """Optional metadata on every ``error`` event.

    ``reason`` is the enum used by the SSE handler to label
    stream-limit triggers (``max_duration_exceeded`` / ``idle_timeout``
    / ``max_events_exceeded`` / ``adapter_error``) so the frontend can
    surface specific error UX. Adapter-raised errors set ``errorType``
    to the exception class name and may carry ``correlationId``.
    """

    errorType: str
    correlationId: str
    reason: str
    elapsedSeconds: float
    idleSeconds: float
    eventCount: int


class StreamStats(TypedDict):
    """Per-stream counters carried on the final ``completed`` event.

    Useful for observability dashboards. Adapter / handler implementations
    may add per-event-type counters later -- §5.4.8 open item #5.
    """

    eventsEmitted: int
    streamDurationMs: int


class CompletedMetadata(TypedDict):
    """Required metadata on the final ``completed`` event.

    ``invokeResponse`` is the **full** §5.4.2 :class:`InvokeResponse`
    payload serialized via ``model_dump(by_alias=True)`` so that REST
    sync, SSE ``completed.metadata.invokeResponse``, and async
    ``TaskStatusResponse.result`` all reach the consumer as the **same
    shape**. Adapters that do not produce a typed response (e.g. the
    bare ``StreamingError`` path) may omit it; the SSE handler then
    synthesizes a minimal response from the events it observed.
    """

    # dict on the wire so this module stays import-cycle-free with
    # interface_layer/models.py
    invokeResponse: dict[str, Any]
    streamStats: NotRequired[StreamStats]
