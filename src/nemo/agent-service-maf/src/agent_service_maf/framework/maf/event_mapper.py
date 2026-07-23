"""MAF event mapper -- converts Agent Framework results to framework wire models.

Agent Framework already assembles streamed updates into a single
:class:`agent_framework.AgentResponse`, so the streaming path in the adapter taps
text chunks directly into :class:`~agent_service_maf.framework.response_builder.ResponseBuilder`.
This mapper provides the non-streaming assembly: turning a final output string +
citations + usage into the framework's
:class:`~agent_service_maf.core.interfaces.AgentResponse`.
"""

from __future__ import annotations

import json
from typing import Any

import structlog

from agent_service_maf.core.interfaces import (
    AgentResponse,
    Citations,
    KbCitation,
    TokenUsage,
    ToolExecution,
)

logger = structlog.get_logger(__name__)

#: Cap on the ``result_summary`` length, matching the SK adapter.
_RESULT_PREVIEW_MAX = 200


def _is_stream_update(obj: Any) -> bool:  # noqa: ANN401
    """True when *obj* is a streaming token delta rather than a full response.

    ``workflow.run(..., stream=True)`` surfaces per-token ``output`` events whose
    ``data`` is an ``AgentRunResponseUpdate`` / ``AgentResponseUpdate`` (a partial
    delta), interleaved with the real per-turn ``executor_completed`` result. Each
    delta carries a ``.text`` fragment, so if we treated them as turn outputs the
    per-agent trace would gain one bogus step per token and the "final output"
    would be the last token fragment (e.g. a lone ```` ``` ````). Non-streaming
    runs never emit these, so skipping them is a no-op there.
    """
    return obj is not None and type(obj).__name__.endswith("Update")


def _delegation_call(content: Any) -> tuple[str, str] | None:  # noqa: ANN401
    """``(specialist_name, call_id)`` if *content* is an ``Agent.as_tool`` call.

    AF surfaces tool invocations as a ``Content`` carrying ``name`` + ``call_id``
    (and no ``result``). For triage/route the tool name IS the specialist's name.
    """
    name = getattr(content, "name", None)
    call_id = getattr(content, "call_id", None)
    if name and call_id and getattr(content, "result", None) is None:
        return str(name), str(call_id)
    return None


def _delegation_task_arg(content: Any) -> str:  # noqa: ANN401
    """Best-effort ``task`` argument the router passed to a specialist tool.

    ``Agent.as_tool`` names its single argument ``task``. ``arguments`` may be a
    dict or a JSON string depending on the client; fall back to "" on anything
    unexpected so the trace input is simply blank rather than erroring.
    """
    args = getattr(content, "arguments", None)
    if isinstance(args, str):
        try:
            args = json.loads(args)
        except (ValueError, TypeError):
            return args.strip()
    if isinstance(args, dict):
        value = args.get("task")
        if isinstance(value, str):
            return value
    return ""


def _delegation_result(content: Any) -> tuple[str, str] | None:  # noqa: ANN401
    """``(call_id, result_text)`` if *content* is a tool (specialist) result."""
    call_id = getattr(content, "call_id", None)
    result = getattr(content, "result", None)
    if call_id is None or result is None:
        return None
    text = result if isinstance(result, str) else (getattr(result, "text", None) or str(result))
    return str(call_id), text


class MafEventMapper:
    """Maps Agent Framework results to the framework's wire models.

    All methods are static -- this class is a pure function namespace with no
    mutable state.
    """

    @staticmethod
    def map_to_agent_response(
        output: str,
        agent_id: str,
        orchestration_type: str = "single",
        agent_names: list[str] | None = None,
        metadata: dict[str, Any] | None = None,
        citations: Citations | None = None,
        usage: TokenUsage | None = None,
    ) -> AgentResponse:
        """Convert AF output to a framework :class:`AgentResponse`.

        Args:
            output: Final text output from the agent(s).
            agent_id: The ``agent_id`` from the original request.
            orchestration_type: Type of orchestration used (``"single"`` in Phase 1).
            agent_names: Names of agents that participated.
            metadata: Additional metadata (e.g. ``{"model": ...}``).
            citations: Structured citations for the response.
            usage: Token usage aggregated from the gateway.

        Returns:
            :class:`AgentResponse` with output, metadata, citations, and usage.
        """
        response_metadata: dict[str, Any] = {
            "orchestration_type": orchestration_type,
        }
        if agent_names:
            response_metadata["agent_names"] = agent_names
        if metadata:
            response_metadata.update(metadata)

        return AgentResponse(
            agent_id=agent_id,
            output=output,
            metadata=response_metadata,
            citations=citations,
            usage=usage,
        )

    @staticmethod
    def build_tool_executions(
        tool_history: list[dict[str, Any]],
        invoked_by: str = "",
    ) -> list[ToolExecution]:
        """Convert recorded ``tool_history`` entries into ``ToolExecution`` citations.

        Replicates the SK adapter's ``_build_tool_citations`` decision tree so both
        frameworks emit identical ``agentTrace[].toolExecutions[]`` wire data:

        * ``result`` is truncated to the first 200 chars for ``result_summary``.
        * ``tool_type`` is honored only when it is ``"kb"`` or ``"toolset"``.
        * ``kb_citations`` are coerced via :meth:`KbCitation.model_validate`;
          invalid entries are dropped rather than failing the response.

        Args:
            tool_history: Entries recorded by the tool wrappers in
                :mod:`agent_service_maf.framework.maf.tools`.
            invoked_by: Name of the agent that invoked the tools (trace metadata).

        Returns:
            One :class:`ToolExecution` per history entry, in order.
        """
        executions: list[ToolExecution] = []
        for entry in tool_history:
            result_str = str(entry.get("result", ""))

            parsed_kb: list[KbCitation] = []
            for item in entry.get("kb_citations") or []:
                try:
                    parsed_kb.append(KbCitation.model_validate(item))
                except Exception:  # noqa: BLE001
                    logger.debug("Dropping invalid kb_citation", item=item)

            raw_tool_type = entry.get("tool_type")
            tool_type = raw_tool_type if raw_tool_type in ("kb", "toolset") else None

            tokens_used = entry.get("tokens_used")
            tokens_used_value = tokens_used if isinstance(tokens_used, int) else None

            arguments = entry.get("arguments")
            if not isinstance(arguments, dict):
                arguments = {}

            executions.append(
                ToolExecution(
                    tool_name=str(entry.get("tool_name", "")),
                    tool_type=tool_type,
                    arguments=arguments,
                    result_summary=result_str[:_RESULT_PREVIEW_MAX],
                    invoked_by=invoked_by,
                    duration_ms=entry.get("duration_ms"),
                    tokens_used=tokens_used_value,
                    kb_citations=parsed_kb or None,
                )
            )
        return executions

    @staticmethod
    def extract_participant_steps(
        result: Any,  # noqa: ANN401
        participant_names: set[str] | None = None,
    ) -> list[tuple[str, str, str]]:
        """Extract ``(agent_name, input_text, output_text)`` per participant.

        AF multi-agent workflows return a :class:`agent_framework.WorkflowRunResult`
        -- an iterable of :class:`WorkflowEvent`. Different topologies surface
        per-agent output differently:

        * ``sequential`` / ``concurrent`` -- an ``executor_completed`` event whose
          ``data`` is a list of ``AgentExecutorResponse`` (``.executor_id`` +
          ``.agent_response``).
        * ``group_chat`` / ``handoff`` / ``graph`` -- per-turn ``output`` events
          carrying a single ``AgentResponse`` tagged with ``event.executor_id``,
          *and* an ``executor_completed`` list for the same turn. We dedupe the
          two so each turn is counted once.

        Input capture: AF emits an ``executor_invoked`` event with
        ``data=AgentExecutorRequest`` immediately before each executor runs,
        carrying ``messages: list[Message]``. We track the latest pending
        invoked-input per executor_id and pair it with that executor's next
        output event. The last non-assistant message in the invoked request
        is the most informative input -- the user / manager / handoff turn
        that triggered this response. Falls back to ``""`` when no preceding
        invoked event was seen for the executor (e.g. AF version variant or
        synthetic test fixtures).

        When *participant_names* is provided, only steps for those agents are
        kept (orchestrator/aggregator executors are filtered out). Adjacent
        duplicate ``(name, input, output)`` triples -- the ``output`` +
        ``executor_completed`` pairing AF emits for one turn -- are collapsed.

        Args:
            result: The ``WorkflowRunResult`` returned by ``workflow.run(...)``.
            participant_names: Restrict to these agent names. ``None`` keeps all.

        Returns:
            ``(agent_name, input_text, output_text)`` triples in execution order.
        """
        steps: list[tuple[str, str, str]] = []
        # ``executor_id`` → most-recent ``executor_invoked`` input text. We use
        # last-write-wins so a re-invocation overwrites the prior pending input
        # before being paired with the next output.
        pending_inputs: dict[str, str] = {}

        def _pick_input_text(messages: Any) -> str:  # noqa: ANN401
            """Pick the most informative input text from a message sequence.

            Prefers the LAST non-assistant message (the latest user / tool
            result / handoff payload). Falls back to the last message of any
            role so we still surface SOMETHING when the request only carries
            assistant context (rare).
            """
            if not isinstance(messages, list) or not messages:
                return ""
            chosen_text = ""
            for msg in reversed(messages):
                role = str(getattr(msg, "role", "") or "")
                text = getattr(msg, "text", None) or ""
                if not text:
                    continue
                if role and role != "assistant":
                    return text
                if not chosen_text:
                    chosen_text = text
            return chosen_text

        def _accept(name: str, text: str, fallback_input: str = "") -> None:
            if participant_names is not None and name not in participant_names:
                return
            # Prefer the executor_invoked snapshot, fall back to the response's
            # full_conversation predecessor (used by graph / sequential where
            # invoked events don't always carry the request payload).
            input_text = pending_inputs.pop(name, "") or fallback_input
            # Dedup on (name, output) to collapse the ``output`` + matching
            # ``executor_completed`` pair AF emits for the same turn. If the
            # earlier entry was missing an input (e.g. ``output`` event arrived
            # first) and this one supplies one, upgrade it in place instead of
            # appending a duplicate row.
            if steps and steps[-1][0] == name and steps[-1][2] == text:
                if not steps[-1][1] and input_text:
                    steps[-1] = (name, input_text, text)
                return
            steps.append((name, input_text, text))

        for event in result:
            event_type = getattr(event, "type", None)
            data = getattr(event, "data", None)
            event_executor_id = getattr(event, "executor_id", None)

            # Track invoked inputs so the corresponding output can pick them up.
            if (
                event_type == "executor_invoked"
                and event_executor_id is not None
                and data is not None
                and not isinstance(data, list)
            ):
                input_text = _pick_input_text(getattr(data, "messages", None))
                if input_text:
                    pending_inputs[str(event_executor_id)] = input_text
                continue

            if isinstance(data, list):
                for item in data:
                    agent_response = getattr(item, "agent_response", None)
                    executor_id = getattr(item, "executor_id", None) or event_executor_id
                    if agent_response is None or executor_id is None:
                        continue
                    # ``full_conversation`` is the running transcript including
                    # the just-emitted response (`_agent_executor.py:400`); the
                    # message immediately before is the input view used as a
                    # fallback when no executor_invoked event was captured.
                    full_conversation = getattr(item, "full_conversation", None)
                    fallback = ""
                    if isinstance(full_conversation, list) and len(full_conversation) >= 2:
                        fallback = _pick_input_text(full_conversation[:-1])
                    _accept(str(executor_id), agent_response.text or "", fallback)
                continue

            # Single AgentResponse output event (group_chat / handoff / graph turns).
            # Skip streaming token deltas (AgentRunResponseUpdate) — those are
            # partial fragments, not turn results; the real turn arrives as the
            # ``executor_completed`` list handled above.
            if (
                event_type == "output"
                and event_executor_id is not None
                and not _is_stream_update(data)
            ):
                text = getattr(data, "text", None)
                if text is not None:
                    # AgentResponse alone doesn't carry the input — rely on
                    # the executor_invoked snapshot captured above.
                    _accept(str(event_executor_id), text or "")

        # Triage / route: members run as the router's ``as_tool`` calls, not as
        # workflow executors, so they never appear above. Surface each routed-to
        # specialist as its own step *before* the router's synthesis turn (they
        # ran first). Empty for every other topology — a participant-named
        # function call only exists when members are exposed as tools. Re-iterates
        # ``result`` (WorkflowRunResult is re-iterable; ``collected`` is a list).
        delegation_steps = MafEventMapper.extract_tool_delegation_steps(result, participant_names)
        return delegation_steps + steps

    @staticmethod
    def reconstruct_stream_participant_steps(
        events: Any,  # noqa: ANN401
        participant_names: set[str] | None = None,
    ) -> list[tuple[str, str, str]]:
        """Rebuild ``(agent_name, input_text, output_text)`` per turn from the
        streamed ``AgentResponseUpdate`` deltas.

        Streaming-only fallback for handoff / triage: there the routed-to
        specialist's answer arrives **only** as per-token ``output`` events
        whose ``data`` is an ``AgentResponseUpdate`` -- the matching
        ``executor_completed`` response carries empty text. :meth:`
        extract_participant_steps` deliberately skips those deltas (they would
        otherwise produce one step per token), so it returns nothing for those
        turns. Here we accumulate consecutive deltas per ``executor_id`` and
        flush one step per turn (on ``executor_completed`` for that executor, or
        at end of stream), reconstructing the full per-agent text.

        Only used when the normal extractors come back empty, so it never
        competes with the ``executor_completed``-list path that sequential /
        concurrent rely on.
        """
        steps: list[tuple[str, str, str]] = []
        buffers: dict[str, str] = {}

        def _flush(name: str) -> None:
            text = buffers.pop(name, "")
            if text and (participant_names is None or name in participant_names):
                steps.append((name, "", text))

        for event in events:
            event_type = getattr(event, "type", None)
            executor_id = getattr(event, "executor_id", None)
            if executor_id is None:
                continue
            name = str(executor_id)
            data = getattr(event, "data", None)
            if event_type == "output" and _is_stream_update(data):
                fragment = getattr(data, "text", None) or ""
                if fragment:
                    buffers[name] = buffers.get(name, "") + fragment
            elif event_type == "executor_completed":
                _flush(name)

        for name in list(buffers):
            _flush(name)
        return steps

    @staticmethod
    def extract_tool_delegation_steps(
        result: Any,  # noqa: ANN401
        participant_names: set[str] | None = None,
    ) -> list[tuple[str, str, str]]:
        """Extract ``(specialist_name, task_input, result_text)`` per delegation.

        For **triage / route**: the workflow is a single router agent whose
        members are exposed as :meth:`agent_framework.Agent.as_tool` tools. A
        routed-to specialist does not run as a workflow executor -- it runs
        inside the router's turn as a tool call, surfacing as a
        ``FunctionCall`` content (``name`` = specialist) paired with a
        ``FunctionResult`` content (same ``call_id``, carrying the specialist's
        answer). This pairs them into trace steps so the responding specialist
        is visible alongside the router's synthesis.

        Scans both event shapes: streamed ``output`` updates whose ``data`` has
        ``.contents``, and ``executor_completed`` list items whose
        ``agent_response.messages`` carry the call/result content.
        """
        calls: dict[str, tuple[str, str]] = {}  # call_id -> (name, task_input)
        results: dict[str, str] = {}  # call_id -> result_text
        order: list[str] = []  # call_ids in first-seen order

        def _scan(contents: Any) -> None:  # noqa: ANN401
            for content in contents or []:
                call = _delegation_call(content)
                if call is not None:
                    name, call_id = call
                    known = participant_names is None or name in participant_names
                    if known and call_id not in calls:
                        calls[call_id] = (name, _delegation_task_arg(content))
                        order.append(call_id)
                    continue
                res = _delegation_result(content)
                if res is not None:
                    call_id, text = res
                    results[call_id] = text

        for event in result:
            data = getattr(event, "data", None)
            if data is None:
                continue
            contents = getattr(data, "contents", None)
            if contents is not None:
                _scan(contents)
            elif isinstance(data, list):
                for item in data:
                    agent_response = getattr(item, "agent_response", None)
                    for msg in getattr(agent_response, "messages", None) or []:
                        _scan(getattr(msg, "contents", None))

        return [(calls[cid][0], calls[cid][1], results.get(cid, "")) for cid in order]

    @staticmethod
    def extract_final_output(
        result: Any,  # noqa: ANN401
        *,
        participant_names: set[str] | None = None,
        prefer_last_participant: bool = False,
    ) -> str:
        """Return the terminal text output of a workflow run.

        ``WorkflowRunResult.get_outputs()`` yields the terminal payload(s) -- for
        sequential that's the last agent's :class:`AgentResponse`; for concurrent
        it's the aggregated response. For ``group_chat`` / ``magentic`` the terminal
        payload can be an orchestrator notice (e.g. "max rounds reached") rather
        than a useful answer, so callers pass ``prefer_last_participant=True`` to
        take the last participant's message instead.

        Args:
            result: The ``WorkflowRunResult`` returned by ``workflow.run(...)``.
            participant_names: Participant agent names, used when
                *prefer_last_participant* is set.
            prefer_last_participant: When ``True``, return the last participant
                step's text if one exists (falls back to the terminal payload).

        Returns:
            The final output text, or ``""`` when nothing was produced.
        """
        if prefer_last_participant:
            steps = MafEventMapper.extract_participant_steps(result, participant_names)
            # steps now carries (name, input, output); use the output slot.
            if steps and steps[-1][2]:
                return steps[-1][2]

        # Drop streaming token deltas: for a streaming agent, get_outputs() can
        # return AgentRunResponseUpdate fragments whose last element is a lone
        # token (e.g. the closing ```` ``` ````) rather than the assembled answer.
        outputs = [o for o in (result.get_outputs() or []) if not _is_stream_update(o)]
        texts = [getattr(o, "text", None) or (str(o) if o is not None else "") for o in outputs]
        texts = [t for t in texts if t]
        if texts:
            return texts[-1]

        # No clean terminal payload (e.g. single streaming agent, whose outputs
        # were all deltas): fall back to the last non-empty participant step,
        # which the executor_completed result reassembled in full.
        steps = MafEventMapper.extract_participant_steps(result, participant_names)
        for _name, _input, output in reversed(steps):
            if output:
                return output
        return ""
