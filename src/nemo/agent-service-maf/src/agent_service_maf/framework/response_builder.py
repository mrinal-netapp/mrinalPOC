"""Streaming-event aggregator that produces an :class:`InvokeResponse`.

Per §5.4.4 of the migration plan, every adapter is responsible for
emitting an :class:`InvokeResponse` on its final ``COMPLETED`` event:

.. code-block:: python

    yield AgentEvent(
        event_type=EventType.COMPLETED,
        metadata={
            "invokeResponse": builder.finalize().model_dump(by_alias=True)
        },
    )

:class:`ResponseBuilder` is the default assembly path. Adapters feed it
the per-event slices they already know about (tokens, tool calls, tool
results, KB citations) and ``finalize()`` returns the same
:class:`InvokeResponse` that REST sync and async polling clients see.
That guarantees the three transports share **one** wire contract.

Aggregation rules (locked):

- Tokens concatenate into ``output``.
- Tool-call events open new entries in the current
  :class:`AgentTraceStep`; tool-result events fill ``result_summary``
  and ``duration_ms`` on the matching open call (matched by
  ``toolCallId``).
- Any tool that emits ``kbCitations`` in its result metadata
  contributes to the top-level :attr:`Citations.kb_citations`,
  deduplicated by ``(knowledgeBaseId, documentId, chunkId)`` keeping
  the highest ``score`` per key (§5.3.4). Whether a tool emits
  citations is decided by the tool's own implementation (see
  :class:`~agent_service_maf.tools.functions.FunctionToolResult`) rather
  than by a name-based allowlist -- a tool that returns no citations
  simply contributes nothing.
- Durations / counts power the optional :class:`PerformanceBreakdown`.
- Parsed-output handling — see :meth:`ResponseBuilder.finalize` for
  the four-path decision tree that ports the legacy
  ``_extract_structured_output`` behaviour and adds full Pydantic-v2
  schema validation. The raw ``output`` text is preserved in every
  branch.
"""

from __future__ import annotations

import json
import re
import time
from typing import Any

import structlog
from pydantic import ValidationError

from agent_service_maf.core.interfaces import (
    AgentTraceStep,
    Citations,
    KbCitation,
    PerformanceBreakdown,
    ToolExecution,
)
from agent_service_maf.core.session_store import _strip_scope
from agent_service_maf.framework._outcome_schema import build_outcome_model
from agent_service_maf.interface_layer.models import InvokeResponse

logger = structlog.get_logger(__name__)

# Matches a JSON object / array inside a ```json ... ``` fence (or bare
# ``` ... ```). Mirrors the legacy ``_extract_structured_output`` from
# ``src/nemo/agent-service/src/main.py:216``.
_FENCED_JSON_RE = re.compile(
    r"```(?:json)?\s*(?P<body>\{.*?\}|\[.*?\])\s*```",
    re.DOTALL | re.IGNORECASE,
)


def _try_parse_json(text: str) -> dict[str, Any] | None:
    """Best-effort JSON-parse of an agent's raw text output.

    Tries (in order):

    1. ``json.loads`` on the trimmed text -- works when the LLM
       returned a pure JSON object.
    2. ``json.loads`` on the first fenced ``` ```json ... ``` ``` block --
       works when the LLM wrapped its JSON in markdown.

    Returns ``None`` (never raises) on failure. The raw ``output``
    text remains authoritative when parsing fails; ``parsedOutput``
    becomes ``null`` on the wire and the consumer can fall back to
    parsing ``output`` itself.
    """
    if not text:
        return None
    stripped = text.strip()
    try:
        parsed = json.loads(stripped)
        return parsed if isinstance(parsed, dict) else None
    except (ValueError, TypeError):
        pass
    match = _FENCED_JSON_RE.search(stripped)
    if match:
        try:
            parsed = json.loads(match.group("body"))
            return parsed if isinstance(parsed, dict) else None
        except (ValueError, TypeError):
            return None
    return None


def extract_parsed_output(
    output_text: str,
    *,
    output_schema: dict[str, Any] | None,
    expect_json: bool,
    agent_id: str | None = None,
    session_id: str | None = None,
) -> dict[str, Any] | None:
    """Run the §4 D2 decision tree to produce ``parsed_output``.

    Single source of truth for parsed-output extraction. Called from
    :meth:`ResponseBuilder.finalize` (streaming path) and from
    non-streaming adapter ``invoke()`` paths that build
    :class:`AgentResponse` directly.

    The decision tree (``output_schema`` × ``expect_json`` × parseability):

    * no schema, ``expect_json=False`` → ``None``
    * no schema, ``expect_json=True``, not parseable as JSON →
      ``None`` plus a ``expect_json_but_not_parseable`` warning
    * no schema, ``expect_json=True``, parseable → raw parsed dict
    * schema valid, output not parseable as JSON → ``None`` (silent)
    * schema valid, parseable, validation fails → ``None`` plus a
      ``parsed_output_validation_failed`` warning
    * schema valid, parseable, validation succeeds →
      ``validated.model_dump()``
    * schema malformed (build failed), parseable → raw parsed dict
      plus a ``outcome_model_build_failed`` warning (legacy fallback)

    Schema path wins when both ``output_schema`` and ``expect_json``
    are set — validation is the stronger signal.

    Args:
        output_text: The assembled LLM output text.
        output_schema: Effective schema (per-request override or
            agent-level default), already merged by the adapter.
        expect_json: ``True`` when the agent's
            :attr:`SKAgentDefinition.response_format` was
            ``"json_object"``.
        agent_id: Echoed onto WARNING logs for trace lookup.
        session_id: Echoed onto WARNING logs for trace lookup.

    Returns:
        A plain ``dict`` (validated when ``output_schema`` is set, raw
        when only ``expect_json`` is set) or ``None``. The caller is
        responsible for placing the result on the response payload.
    """
    if not output_text:
        return None

    if output_schema is not None:
        # PATH 1 — schema-validated parse. Validation wins over expect_json.
        raw_parsed = _try_parse_json(output_text)
        if raw_parsed is None:
            return None
        model_cls = build_outcome_model(output_schema)
        if model_cls is None:
            # Malformed schema (already logged inside build_outcome_model);
            # fall back to the legacy raw-parsed behaviour so callers
            # with a relaxed / under-construction schema still see
            # something useful in parsedOutput.
            return raw_parsed
        try:
            validated = model_cls.model_validate(raw_parsed)
        except ValidationError as exc:
            errors = exc.errors()
            logger.warning(
                "parsed_output_validation_failed",
                agent_id=agent_id,
                session_id=session_id,
                error_count=len(errors),
                first_error=errors[0] if errors else None,
                raw_parsed_keys=(
                    sorted(raw_parsed.keys())[:10] if isinstance(raw_parsed, dict) else None
                ),
            )
            return None
        dumped = validated.model_dump()
        return dumped if isinstance(dumped, dict) else None

    if expect_json:
        # PATH 2 — agent.response_format=="json_object", no schema declared.
        # Trust the LLM contract; parse without validation.
        parsed = _try_parse_json(output_text)
        if parsed is None:
            logger.warning(
                "expect_json_but_not_parseable",
                agent_id=agent_id,
                session_id=session_id,
                output_preview=output_text[:200],
            )
        return parsed

    return None


class ResponseBuilder:
    """Accumulate streaming events into an :class:`InvokeResponse`.

    Adapter authors construct one builder per invocation and feed it
    the same data they already emit on each ``AgentEvent``. They MUST
    call :meth:`finalize` and pack the result into the final
    ``COMPLETED`` event's metadata under the ``invokeResponse`` key
    (camelCase) per :class:`~agent_service_maf.core.event_metadata.CompletedMetadata`.

    Args:
        agent_id: The id of the responding agent. Echoed on
            :attr:`InvokeResponse.agent_id` and used as the default
            ``agentName`` on trace steps when adapters do not supply
            one.
        session_id: Session id used for this turn (echoed on the
            response even when not supplied by the client).
        output_schema: Optional effective JSON Schema to validate the
            agent's output against. Adapter authors resolve this from
            (in precedence order) per-request ``context.outputSchema``
            then agent-level :attr:`SKAgentDefinition.output_schema`.
            When set, :meth:`finalize` validates the parsed output via
            :func:`build_outcome_model` and populates
            :attr:`InvokeResponse.parsed_output` on success.
        expect_json: ``True`` when the agent's
            :attr:`SKAgentDefinition.response_format` is
            ``"json_object"``. Triggers the parse-without-validation
            path when no ``output_schema`` is supplied. See
            :meth:`finalize` / :func:`extract_parsed_output` for the
            full decision tree.
        trace_id: Optional tracing id (Phoenix / OTel).
        framework: Framework identifier
            (e.g. ``"maf"``) -- stamped on
            :attr:`AgentCitationSource.framework` for provenance.
    """

    def __init__(
        self,
        agent_id: str,
        session_id: str | None = None,
        *,
        output_schema: dict[str, Any] | None = None,
        expect_json: bool = False,
        trace_id: str | None = None,
        framework: str | None = None,
    ) -> None:
        self._agent_id = agent_id
        self._session_id = session_id
        self._output_schema = output_schema
        self._expect_json = expect_json
        self._trace_id = trace_id
        self._framework = framework

        self._start_monotonic = time.monotonic()
        self._output_chunks: list[str] = []
        self._artifacts: list[dict[str, Any]] = []
        self._metadata: dict[str, Any] = {}
        self._usage: dict[str, Any] | None = None
        self._citations: Citations | None = None
        self._memory_degraded = False

        # Per-step accumulators
        self._trace_steps: list[AgentTraceStep] = []
        # Map of toolCallId -> (step_index_in_trace, executions_index_in_step)
        self._open_tool_calls: dict[str, tuple[int, int]] = {}
        # KB-citation dedup: (kb_id, doc_id, chunk_id) -> KbCitation (best score)
        self._kb_dedup: dict[tuple[str, str, str], KbCitation] = {}

        # Performance accumulators
        self._tool_duration_ms = 0
        self._llm_duration_ms = 0
        self._llm_call_count = 0

    # ------------------------------------------------------------------ tokens
    def add_token(self, text: str) -> None:
        """Append a streamed token to the response ``output`` buffer.

        Empty strings are ignored. Adapters that emit reasoning trace
        as ``thinking`` events should NOT route those through
        ``add_token`` -- they are not part of the user-visible output.
        """
        if text:
            self._output_chunks.append(text)

    # --------------------------------------------------------------- artifacts
    def add_artifact(self, artifact: dict[str, Any]) -> None:
        """Append an artifact descriptor (file, chart, image, ...) to the response."""
        self._artifacts.append(artifact)

    # ------------------------------------------------------------------- usage
    def set_usage(self, usage: dict[str, Any] | None) -> None:
        """Set the per-turn :class:`TokenUsage`-shaped dict.

        Adapters typically call this once at the end of the LLM
        pipeline. ``None`` clears any previously recorded usage.
        """
        self._usage = usage

    def set_memory_degraded(self, degraded: bool) -> None:
        """Mark the turn as having run with degraded session-store state."""
        self._memory_degraded = bool(degraded)

    def set_citations(self, citations: Citations | None) -> None:
        """Replace the in-progress :class:`Citations` envelope wholesale.

        Most adapters do not need this -- the builder constructs a
        :class:`Citations` envelope from the trace and KB aggregation
        at :meth:`finalize` time. Adapters that have a pre-built
        envelope (e.g. legacy SK adapter code paths) can stamp it in
        here and skip the per-event helpers.
        """
        self._citations = citations

    def merge_metadata(self, extra: dict[str, Any]) -> None:
        """Merge keys into :attr:`InvokeResponse.metadata`."""
        self._metadata.update(extra)

    # -------------------------------------------------------- trace / tool ops
    def open_step(
        self,
        agent_name: str | None = None,
        action: str = "respond",
    ) -> int:
        """Open a new :class:`AgentTraceStep` and return its index.

        Adapters that emit a per-agent step boundary should call this
        whenever the active agent changes. Single-agent adapters may
        leave the trace implicit -- :meth:`finalize` will lazily open
        one ``respond`` step around the accumulated tokens if no step
        was opened explicitly.
        """
        step = AgentTraceStep(
            step_index=len(self._trace_steps),
            agent_name=agent_name or self._agent_id,
            action=action,
        )
        self._trace_steps.append(step)
        return len(self._trace_steps) - 1

    def add_tool_call(
        self,
        tool_call_id: str,
        tool_name: str,
        arguments: dict[str, Any] | None = None,
        *,
        agent_name: str | None = None,
    ) -> None:
        """Record a ``tool_call`` event.

        The tool call is appended to the most recent step's
        ``tool_executions`` (a step is auto-opened if none exists). On
        the matching ``tool_result`` event, the entry's
        ``result_summary`` / ``duration_ms`` / ``error`` /
        ``kb_citations`` will be filled in by :meth:`add_tool_result`.
        """
        step_idx = self._ensure_open_step(agent_name)
        step = self._trace_steps[step_idx]
        step.tool_executions.append(
            ToolExecution(
                tool_name=tool_name,
                tool_call_id=tool_call_id,
                arguments=arguments or {},
            )
        )
        self._open_tool_calls[tool_call_id] = (step_idx, len(step.tool_executions) - 1)

    def add_tool_result(
        self,
        tool_call_id: str,
        result: Any,  # noqa: ANN401
        *,
        duration_ms: int | None = None,
        error: str | None = None,
        kb_citations: list[dict[str, Any]] | list[KbCitation] | None = None,
    ) -> None:
        """Fill in the matching :class:`ToolExecution` from
        :meth:`add_tool_call`.

        Looks up the open tool call by ``tool_call_id``. Whenever
        ``kb_citations`` is non-empty, each citation lands on both the
        per-tool :attr:`ToolExecution.kb_citations` field and the
        top-level KB dedup map (highest ``score`` wins per
        ``(kbId, docId, chunkId)``). There is no allowlist -- a tool
        contributes citations exactly when it provides them, per the
        :class:`~agent_service_maf.tools.functions.FunctionToolResult`
        contract.

        Args:
            tool_call_id: Matches the id from the preceding
                :meth:`add_tool_call`. An unknown id is logged at WARNING
                and ignored (the tool call may have come from a
                different adapter path).
            result: Tool result payload. Stringified to ``result_summary``
                with a 200-char cap.
            duration_ms: Optional per-tool timing.
            error: Error message when the tool call failed.
            kb_citations: KB-citation dicts from the tool's metadata
                (camelCase wire keys: ``source`` / ``documentId`` /
                ``downloadUrl`` / ``knowledgeBaseId`` /
                ``knowledgeBaseName`` / ``score``; internal ``chunkId``
                used for dedup).
        """
        loc = self._open_tool_calls.get(tool_call_id)
        if loc is None:
            logger.warning(
                "response_builder_tool_result_no_matching_call",
                tool_call_id=tool_call_id,
            )
            return
        step_idx, exec_idx = loc
        execution = self._trace_steps[step_idx].tool_executions[exec_idx]
        execution.result_summary = str(result)[:200]
        if duration_ms is not None:
            execution.duration_ms = duration_ms
            self._tool_duration_ms += max(0, int(duration_ms))
        if error is not None:
            execution.error = error

        if kb_citations:
            parsed = self._coerce_kb_citations(kb_citations)
            execution.kb_citations = parsed
            for citation in parsed:
                self._dedup_kb(citation)

    def add_llm_timing(self, duration_ms: int) -> None:
        """Record a single LLM round-trip duration (ms).

        Adapters that wrap their LLM gateway with timing call this
        on every completion. ``finalize()`` aggregates these into
        :attr:`PerformanceBreakdown.llm_duration_ms` and
        :attr:`PerformanceBreakdown.llm_call_count`.
        """
        if duration_ms <= 0:
            return
        self._llm_duration_ms += duration_ms
        self._llm_call_count += 1

    # ------------------------------------------------------------------- final
    def finalize(self) -> InvokeResponse:
        """Assemble the accumulated state into an :class:`InvokeResponse`.

        Called once at the end of the adapter's stream. Safe to call
        multiple times -- the builder is not consumed -- but adapters
        typically call it exactly once when emitting the final
        ``COMPLETED`` event.

        Parsed-output handling is delegated to
        :func:`extract_parsed_output` and follows this four-path
        decision tree (see plan §4 D2):

        1. ``output_schema`` set + valid JSON + matches schema →
           ``parsed_output`` is the validated, type-coerced
           ``model_dump()`` dict.
        2. ``output_schema`` set + valid JSON + does NOT match →
           ``parsed_output = None`` with a structured
           ``parsed_output_validation_failed`` WARNING.
        3. ``output_schema`` set + malformed schema (build failed)
           → falls back to legacy raw parsed dict (logged at
           module-load via ``outcome_model_build_failed``).
        4. ``output_schema`` absent + ``expect_json=True`` + valid
           JSON → ``parsed_output`` is the raw parsed dict (no
           validation). Unparseable JSON emits the
           ``expect_json_but_not_parseable`` WARNING.

        Schema path wins when both ``output_schema`` and
        ``expect_json`` are set — validation is the stronger signal.
        Raw ``output`` text is preserved on every branch.

        Returns:
            A fully-populated :class:`InvokeResponse` with snake_case
            attributes; adapters should serialize with
            ``model_dump(by_alias=True)`` when packing it onto an
            ``AgentEvent.metadata`` dict.
        """
        total_ms = int((time.monotonic() - self._start_monotonic) * 1000)
        output_text = "".join(self._output_chunks)

        citations = self._citations
        if citations is None and (self._trace_steps or self._kb_dedup):
            citations = Citations(
                agent_trace=list(self._trace_steps),
                kb_citations=list(self._kb_dedup.values()),
                performance=self._build_performance(total_ms),
            )
        elif citations is not None and citations.performance is None:
            citations = citations.model_copy(
                update={"performance": self._build_performance(total_ms)}
            )

        parsed_output = extract_parsed_output(
            output_text,
            output_schema=self._output_schema,
            expect_json=self._expect_json,
            agent_id=self._agent_id,
            session_id=self._session_id,
        )

        # Echo the raw caller-facing session id rather than the scoped
        # storage key. The scoped form (``team:proj:tid:uid:sid``) is an
        # internal Redis key — surfacing it to clients would let them
        # replay it back and end up double-scoped.
        echoed_session_id = _strip_scope(self._session_id) if self._session_id else None
        return InvokeResponse(
            agent_id=self._agent_id,
            output=output_text,
            parsed_output=parsed_output,
            artifacts=list(self._artifacts),
            usage=self._usage,
            metadata=dict(self._metadata),
            citations=citations,
            duration_ms=total_ms,
            memory_degraded=self._memory_degraded,
            session_id=echoed_session_id,
            trace_id=self._trace_id,
        )

    # -------------------------------------------------------- internal helpers
    def _ensure_open_step(self, agent_name: str | None) -> int:
        if not self._trace_steps:
            return self.open_step(agent_name=agent_name, action="tool_call")
        return len(self._trace_steps) - 1

    def _coerce_kb_citations(
        self,
        raw: list[dict[str, Any]] | list[KbCitation],
    ) -> list[KbCitation]:
        out: list[KbCitation] = []
        for item in raw:
            if isinstance(item, KbCitation):
                out.append(item)
            elif isinstance(item, dict):
                try:
                    out.append(KbCitation.model_validate(item))
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "response_builder_kb_citation_invalid",
                        error=str(exc),
                        keys=list(item.keys()),
                    )
        return out

    def _dedup_kb(self, citation: KbCitation) -> None:
        """Insert into the dedup map keeping the highest-scoring entry per key.

        The dedup key is ``(knowledgeBaseId, documentId, chunkId)``.
        Missing components fall back to empty strings so legacy
        citations without ``chunkId`` collapse to one entry per
        ``(kb, doc)`` -- matching the legacy
        ``kb_retrieval.deduplicate_citations`` behavior.
        """
        key = (
            citation.knowledge_base_id or "",
            citation.document_id or "",
            citation.chunk_id or "",
        )
        existing = self._kb_dedup.get(key)
        if existing is None or (citation.score or 0.0) > (existing.score or 0.0):
            self._kb_dedup[key] = citation

    def _build_performance(self, total_ms: int) -> PerformanceBreakdown:
        overhead = max(0, total_ms - self._llm_duration_ms - self._tool_duration_ms)
        return PerformanceBreakdown(
            total_duration_ms=total_ms,
            llm_duration_ms=self._llm_duration_ms,
            tool_duration_ms=self._tool_duration_ms if self._tool_duration_ms else None,
            framework_overhead_ms=overhead,
            llm_call_count=self._llm_call_count,
        )
