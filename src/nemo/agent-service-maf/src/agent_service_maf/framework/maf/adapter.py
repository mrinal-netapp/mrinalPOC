"""Microsoft Agent Framework adapter -- registered as ``"maf"``.

The production adapter that runs agents on **Microsoft Agent Framework**
(upstream import root ``agent_framework``). It reads the framework-agnostic
``semantic_kernel`` config section (key name retained for back-compat) and
produces the wire contract (:class:`~agent_service_maf.core.interfaces.AgentResponse` /
``InvokeResponse`` / SSE events) consumed by all interface channels.

Phase 1 implements the **single-agent** path (``orchestration.type == "single"``):
``invoke`` and ``stream`` both delegate to a built AF :class:`agent_framework.Agent`
whose LLM calls route through
:class:`~agent_service_maf.framework.maf.gateway_chat_client.BifrostChatClient`.
Multi-agent orchestration (sequential, concurrent, handoff, group_chat, magentic,
triage, graph) is added in Phase 3; until then non-``single`` orchestration types
raise a clear :class:`AgentInvocationError` at invoke/stream time.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import AsyncIterator, Iterator
from contextlib import contextmanager, suppress
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import structlog

from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.exceptions import AgentInvocationError
from agent_service_maf.core.interfaces import (
    AgentCapabilities,
    AgentCitationSource,
    AgentEvent,
    AgentRequest,
    AgentResponse,
    AgentTraceStep,
    Citations,
    ContextUsed,
    EventType,
    PerformanceBreakdown,
    TokenUsage,
)
from agent_service_maf.framework.base_agent import BaseAgent
from agent_service_maf.framework.maf.agent_builder import MafAgentBuilder, friendly_model_label
from agent_service_maf.framework.maf.event_mapper import (
    MafEventMapper,
    _delegation_call,
    _delegation_result,
    _is_stream_update,
)
from agent_service_maf.framework.maf.gateway_chat_client import (
    sum_token_usage,
    usage_capture_scope,
)
from agent_service_maf.framework.maf.orchestration_builder import (
    SUPPORTED_ORCHESTRATION_TYPES,
    MafOrchestrationBuilder,
)
from agent_service_maf.framework.maf.tools import build_toolset
from agent_service_maf.framework.registry import FrameworkRegistry
from agent_service_maf.framework.response_builder import ResponseBuilder, extract_parsed_output

if TYPE_CHECKING:
    from agent_framework import Agent

    from agent_service_maf.config.validators import OrchestrationConfig
    from agent_service_maf.framework.maf.agent_builder import BuiltMafAgent
    from agent_service_maf.framework.maf.tools import MafToolset
    from agent_service_maf.tools.binding import ToolBinding
    from agent_service_maf.tools.function_provider import FunctionToolProvider

logger = structlog.get_logger(__name__)

#: Framework identifier used in ``agent.framework`` config and API paths.
FRAMEWORK_ID = "maf"

#: Default wall-clock budget (seconds) for a multi-agent orchestration when the
#: config declares no explicit ``termination_strategy.timeout_seconds`` and no
#: ``max_rounds``. Mirrors the SK adapter's ``_ORCHESTRATION_TIMEOUT_DEFAULT``.
_ORCHESTRATION_TIMEOUT_DEFAULT = 300.0

#: Per-round heuristic (seconds) used to derive the default orchestration budget
#: from ``max_rounds`` -- parity with the SK adapter's ``_get_orchestration_timeout``.
_SECONDS_PER_ROUND_HEURISTIC = 30.0


def _utc_now_iso() -> str:
    """ISO-8601 UTC timestamp for per-agent lifecycle event metadata."""
    return datetime.now(tz=UTC).isoformat()


@dataclass
class _OrchestrationRun:
    """Everything needed to run (or stream) one multi-agent orchestration.

    Produced by :meth:`AgentFrameworkAdapter._setup_orchestration_run` and shared
    by the synchronous (:meth:`_invoke_orchestrated`) and streaming
    (:meth:`_stream_orchestrated_wrapper`) paths so both build the workflow,
    messages, and participant set identically.
    """

    workflow: Any
    messages: list[Any]
    participant_names: set[str]
    prefer_last: bool
    toolsets: dict[str, MafToolset]
    context_used: Any | None
    agent_names: list[str] = field(default_factory=list)


@FrameworkRegistry.register(FRAMEWORK_ID)
class AgentFrameworkAdapter(BaseAgent):
    """Microsoft Agent Framework adapter with single-agent support (Phase 1).

    Reads the ``semantic_kernel`` config section (agent definitions + per-agent
    model knobs + orchestration type), builds AF agents via
    :class:`~agent_service_maf.framework.maf.agent_builder.MafAgentBuilder`, and
    routes every LLM call through the in-repo gateway. Produces the same wire
    contract as the SK adapter so callers cannot tell the two apart.

    Attributes:
        _agents: Built AF agents, in config definition order.
        _orchestration_type: Orchestration type from config (``"single"`` is the
            only one supported in Phase 1).
        _session_manager: Shared session manager for conversation persistence.
    """

    def __init__(self, config: object) -> None:
        super().__init__(config)
        self._agents: list[BuiltMafAgent] = []
        self._orchestration_type: str = "single"
        self._orchestration_config: OrchestrationConfig | None = None
        self._session_manager: Any | None = None
        self._mcp_registry: Any | None = None
        self._function_provider: FunctionToolProvider | None = None
        self._tool_bindings: list[ToolBinding] = []
        self._auth_hook: Any | None = None
        self._orchestration_builder = MafOrchestrationBuilder()
        self._agent_builder: MafAgentBuilder | None = None
        self._default_model: str = ""
        self._manager_agents: list[BuiltMafAgent] = []

    async def initialize(self, context: AgentExecutionContext) -> None:
        """Build all agents from config.

        Args:
            context: Runtime dependencies including config, gateway, and MCP registry.

        Raises:
            AgentInvocationError: If the gateway is missing or agent building fails.
        """
        await super().initialize(context)
        sk_config = context.config.semantic_kernel
        self._session_manager = context.session_manager
        self._orchestration_type = sk_config.orchestration.type
        self._orchestration_config = sk_config.orchestration
        self._mcp_registry = context.mcp_registry
        self._default_model = context.config.agent.model

        if context.gateway is None:
            raise AgentInvocationError(
                "LLMGateway is required for the Microsoft Agent Framework adapter. "
                "Ensure the gateway is configured and available in the execution context.",
                details={},
            )

        try:
            self._auth_hook = self._build_auth_hook(context)
            self._function_provider, self._tool_bindings = self._build_function_provider(
                context.config
            )

            builder = MafAgentBuilder(
                gateway=context.gateway,
                mcp_registry=context.mcp_registry,
                default_model=context.config.agent.model,
                default_temperature=context.config.agent.temperature,
                default_max_tokens=context.config.agent.max_tokens,
            )
            self._agent_builder = builder
            self._agents = builder.build_all_agents(sk_config)

            if getattr(sk_config, "enable_telemetry", False):
                from agent_service_maf.framework.maf.observability import (
                    enable_af_observability,
                )

                # AF instrumentation is process-wide, so a deployment-level env
                # override is the practical toggle; the per-team config field is
                # honored too. Either enables prompt/completion capture on spans.
                enable_sensitive = getattr(
                    sk_config, "enable_sensitive_telemetry", False
                ) or os.environ.get("AF_ENABLE_SENSITIVE_TELEMETRY", "").strip().lower() in (
                    "1",
                    "true",
                    "yes",
                    "on",
                )
                enable_af_observability(enable_sensitive_data=enable_sensitive)
        except AgentInvocationError:
            raise
        except Exception as exc:
            raise AgentInvocationError(
                f"Failed to initialize Microsoft Agent Framework adapter: {exc}. "
                "Check semantic_kernel config section for errors.",
                details={"error": str(exc)},
            ) from exc

        logger.info(
            "MAF adapter initialized",
            agent_count=len(self._agents),
            orchestration_type=self._orchestration_type,
            agent_names=[a.name for a in self._agents],
        )

    async def invoke(
        self,
        request: AgentRequest,
        context: AgentExecutionContext,
    ) -> AgentResponse:
        """Invoke the agent synchronously.

        Args:
            request: The invocation request.
            context: Runtime dependencies.

        Returns:
            Complete :class:`AgentResponse`.

        Raises:
            AgentInvocationError: If invocation fails or a non-single orchestration
                type is configured (Phase 3 will add multi-agent orchestration).
        """
        self._require_supported_orchestration()
        try:
            if self._orchestration_type == "single":
                response = await self._invoke_single(request, context)
            else:
                response = await self._invoke_orchestrated(request, context)
        except AgentInvocationError:
            raise
        except Exception as exc:
            raise AgentInvocationError(
                f"Microsoft Agent Framework invocation failed: {exc}. "
                "Check agent configuration and gateway connectivity.",
                details={"error": str(exc)},
            ) from exc

        # Output-schema validation (plan §4 D2), mirroring the SK adapter so both
        # frameworks run the same decision tree. Precedence: per-request
        # ``context.outputSchema`` > agent-level ``output_schema``.
        active_agent = self._agents[0] if self._agents else None
        effective_schema, expect_json = self._resolve_output_schema_context(
            request, agent=active_agent
        )
        if effective_schema is not None or expect_json:
            response.parsed_output = extract_parsed_output(
                response.output,
                output_schema=effective_schema,
                expect_json=expect_json,
                agent_id=request.agent_id,
                session_id=request.session_id,
            )
        return response

    async def stream(
        self,
        request: AgentRequest,
        context: AgentExecutionContext,
    ) -> AsyncIterator[AgentEvent]:
        """Stream events using the §5.4 wire vocabulary.

        Dispatches by orchestration type: single-agent streams tokens live;
        multi-agent (sequential / concurrent) runs the workflow then replays the
        terminal output as tokens. Both end in a ``completed`` event carrying the
        same ``InvokeResponse`` payload REST sync returns.

        Args:
            request: The invocation request.
            context: Runtime dependencies.

        Yields:
            :class:`AgentEvent` instances ending in ``completed``.
        """
        self._require_supported_orchestration()
        if self._orchestration_type == "single":
            async for event in self._stream_single_wrapper(request, context):
                yield event
        else:
            async for event in self._stream_orchestrated_wrapper(request, context):
                yield event

    async def _stream_single_wrapper(
        self,
        request: AgentRequest,
        context: AgentExecutionContext,
    ) -> AsyncIterator[AgentEvent]:
        """Single-agent streaming: live token stream + completed envelope."""
        agent = self._agents[0] if self._agents else None
        effective_schema, expect_json = self._resolve_output_schema_context(request, agent=agent)

        builder = ResponseBuilder(
            agent_id=request.agent_id,
            session_id=request.session_id,
            framework=FRAMEWORK_ID,
            output_schema=effective_schema,
            expect_json=expect_json,
        )
        if agent is not None:
            builder.set_citations(Citations(responding_agent=self._build_agent_citation(agent)))

        started_metadata: dict[str, Any] = {
            "agentId": request.agent_id,
            "framework": FRAMEWORK_ID,
        }
        if agent is not None:
            started_metadata["model"] = agent.model

        yield AgentEvent(event_type=EventType.STARTED, metadata=started_metadata)

        if agent is not None:
            agent.client.reset_usage()

        toolset = self._build_toolset(agent) if agent is not None else None

        output_preview_max = 200
        output_preview_buf: list[str] = []
        output_preview_len = 0
        invoke_start = time.monotonic()

        try:
            async for event in self._stream_single(request, context, toolset):
                if event.event_type == EventType.TOKEN and event.data:
                    builder.add_token(event.data)
                    if output_preview_len < output_preview_max:
                        remaining = output_preview_max - output_preview_len
                        snippet = event.data[:remaining]
                        output_preview_buf.append(snippet)
                        output_preview_len += len(snippet)
                yield event
        except AgentInvocationError as exc:
            yield AgentEvent(
                event_type=EventType.ERROR,
                data=str(exc),
                metadata={"errorType": type(exc).__name__},
            )
        except Exception as exc:  # noqa: BLE001
            yield AgentEvent(
                event_type=EventType.ERROR,
                data=str(exc),
                metadata={"errorType": type(exc).__name__},
            )

        if agent is not None:
            acc = agent.client.get_accumulated_usage()
            if acc.total_tokens > 0:
                builder.set_usage(acc.model_dump(by_alias=True))

            invoke_duration_ms = int((time.monotonic() - invoke_start) * 1000)
            llm_ms = agent.client.get_llm_duration_ms()
            llm_calls = agent.client.get_llm_call_count()
            output_preview = "".join(output_preview_buf)
            tool_history = toolset.tool_history if toolset is not None else []
            tool_executions = MafEventMapper.build_tool_executions(
                tool_history, invoked_by=agent.name
            )
            tool_ms = self._sum_tool_duration(tool_history)
            builder.set_citations(
                Citations(
                    responding_agent=self._build_agent_citation(agent),
                    agent_trace=[
                        AgentTraceStep(
                            agent_name=agent.name,
                            action="respond",
                            input=request.input[:200] if request.input else "",
                            output=output_preview,
                            duration_ms=invoke_duration_ms,
                            round=1,
                            tool_executions=tool_executions,
                        )
                    ],
                    performance=PerformanceBreakdown(
                        total_duration_ms=invoke_duration_ms,
                        llm_duration_ms=llm_ms,
                        tool_duration_ms=tool_ms,
                        framework_overhead_ms=max(0, invoke_duration_ms - llm_ms - (tool_ms or 0)),
                        llm_call_count=llm_calls,
                    ),
                )
            )
            builder.merge_metadata(
                {
                    "orchestration_type": "single",
                    "agent_names": [agent.name],
                    "model": agent.model,
                }
            )

        yield AgentEvent(
            event_type=EventType.COMPLETED,
            metadata={
                "invokeResponse": builder.finalize().model_dump(by_alias=True, mode="json"),
            },
        )

    def get_capabilities(self) -> AgentCapabilities:
        """Return this adapter's static capabilities metadata."""
        return AgentCapabilities(
            agent_id=FRAMEWORK_ID,
            framework=FRAMEWORK_ID,
            supports_streaming=True,
            supported_protocols=["rest", "sse", "websocket"],
            available_tools=[],
            description=(
                "Microsoft Agent Framework adapter with single-agent invocation, "
                "function + MCP tool calling, and multi-agent orchestration "
                "(sequential, concurrent, handoff, triage, group_chat, magentic, graph)."
            ),
            version="1.0.0",
        )

    async def shutdown(self) -> None:
        """Clean up agents and sessions."""
        self._agents.clear()
        self._session_manager = None
        await super().shutdown()

    # ------------------------------------------------------------------
    # Single-agent invocation
    # ------------------------------------------------------------------

    async def _invoke_single(
        self,
        request: AgentRequest,
        context: AgentExecutionContext,
    ) -> AgentResponse:
        """Single-agent invocation through the AF agent runner.

        Args:
            request: The invocation request.
            context: Runtime dependencies.

        Returns:
            :class:`AgentResponse` with the agent's output, citations, and usage.
        """
        from agent_framework import Message

        from agent_service_maf.core.session import ConversationMessage
        from agent_service_maf.interface_layer.models import AssistantMessageMetadata

        agent = self._agents[0]
        agent.client.reset_usage()

        toolset = self._build_toolset(agent)

        messages, context_used = await self._build_history_messages(request.session_id)
        messages.append(Message("user", [request.input]))

        invoke_start = time.monotonic()
        with self._bifrost_mcp_scope([agent]):
            result = await agent.runner.run(messages, tools=toolset.tools or None)
        invoke_duration_ms = int((time.monotonic() - invoke_start) * 1000)
        output = result.text or ""

        usage = self._read_usage(agent)
        tool_executions = MafEventMapper.build_tool_executions(
            toolset.tool_history, invoked_by=agent.name
        )

        llm_ms = agent.client.get_llm_duration_ms()
        llm_calls = agent.client.get_llm_call_count()
        tool_ms = self._sum_tool_duration(toolset.tool_history)
        perf = PerformanceBreakdown(
            total_duration_ms=invoke_duration_ms,
            llm_duration_ms=llm_ms,
            tool_duration_ms=tool_ms,
            framework_overhead_ms=max(0, invoke_duration_ms - llm_ms - (tool_ms or 0)),
            llm_call_count=llm_calls,
        )

        citations = Citations(
            responding_agent=self._build_agent_citation(agent),
            context_used=context_used,
            agent_trace=[
                AgentTraceStep(
                    agent_name=agent.name,
                    action="respond",
                    input=request.input[:200] if request.input else "",
                    output=output[:200],
                    duration_ms=invoke_duration_ms,
                    round=1,
                    tool_executions=tool_executions,
                )
            ],
            performance=perf,
        )

        if self._session_manager and request.session_id:
            await self._session_manager.append_message(
                request.session_id,
                ConversationMessage(role="user", content=request.input),
            )
            assistant_metadata = AssistantMessageMetadata(
                duration_ms=invoke_duration_ms,
                usage=usage,
                citations=citations,
            )
            await self._session_manager.append_message(
                request.session_id,
                ConversationMessage(
                    role="assistant",
                    content=output,
                    metadata=assistant_metadata.model_dump(by_alias=True, exclude_none=True),
                ),
            )

        return MafEventMapper.map_to_agent_response(
            output=output,
            agent_id=request.agent_id,
            orchestration_type="single",
            agent_names=[agent.name],
            metadata={"model": agent.model},
            citations=citations,
            usage=usage,
        )

    async def _stream_single(
        self,
        request: AgentRequest,
        context: AgentExecutionContext,
        toolset: MafToolset | None = None,
    ) -> AsyncIterator[AgentEvent]:
        """Stream tokens from a single AF agent.

        Conversation persistence happens after the stream completes so a partial
        stream does not leave a dangling user turn without its assistant reply.

        Args:
            request: The invocation request.
            context: Runtime dependencies.
            toolset: Pre-built tools (with the shared ``tool_history``). When
                ``None``, the agent runs without tools.

        Yields:
            TOKEN events for each text chunk.
        """
        from agent_framework import Message

        from agent_service_maf.core.session import ConversationMessage
        from agent_service_maf.interface_layer.models import AssistantMessageMetadata

        agent = self._agents[0]
        tools = toolset.tools if toolset is not None else None

        messages, _context_used = await self._build_history_messages(request.session_id)
        messages.append(Message("user", [request.input]))

        collected: list[str] = []
        invoke_start = time.monotonic()
        with self._bifrost_mcp_scope([agent]):
            async for update in agent.runner.run(messages, tools=tools or None, stream=True):
                text = update.text or ""
                if text:
                    collected.append(text)
                    yield AgentEvent(
                        event_type=EventType.TOKEN,
                        data=text,
                        metadata={"agent_name": agent.name},
                    )

        full_output = "".join(collected)
        invoke_duration_ms = int((time.monotonic() - invoke_start) * 1000)

        if self._session_manager and request.session_id:
            usage = self._read_usage(agent)
            tool_history = toolset.tool_history if toolset is not None else []
            tool_executions = MafEventMapper.build_tool_executions(
                tool_history, invoked_by=agent.name
            )
            llm_ms = agent.client.get_llm_duration_ms()
            llm_calls = agent.client.get_llm_call_count()
            tool_ms = self._sum_tool_duration(tool_history)
            perf = PerformanceBreakdown(
                total_duration_ms=invoke_duration_ms,
                llm_duration_ms=llm_ms,
                tool_duration_ms=tool_ms,
                framework_overhead_ms=max(0, invoke_duration_ms - llm_ms - (tool_ms or 0)),
                llm_call_count=llm_calls,
            )
            citations = Citations(
                responding_agent=self._build_agent_citation(agent),
                agent_trace=[
                    AgentTraceStep(
                        agent_name=agent.name,
                        action="respond",
                        input=request.input[:200] if request.input else "",
                        output=full_output[:200],
                        duration_ms=invoke_duration_ms,
                        round=1,
                        tool_executions=tool_executions,
                    )
                ],
                performance=perf,
            )
            await self._session_manager.append_message(
                request.session_id,
                ConversationMessage(role="user", content=request.input),
            )
            assistant_metadata = AssistantMessageMetadata(
                duration_ms=invoke_duration_ms,
                usage=usage,
                citations=citations,
            )
            await self._session_manager.append_message(
                request.session_id,
                ConversationMessage(
                    role="assistant",
                    content=full_output,
                    metadata=assistant_metadata.model_dump(by_alias=True, exclude_none=True),
                ),
            )

    # ------------------------------------------------------------------
    # Multi-agent orchestration (sequential / concurrent)
    # ------------------------------------------------------------------

    async def _invoke_orchestrated(
        self,
        request: AgentRequest,
        context: AgentExecutionContext,
    ) -> AgentResponse:
        """Run a multi-agent workflow synchronously and assemble the wire response.

        Builds an AF workflow for the configured orchestration type, runs it over
        the conversation, then maps the terminal output + per-participant trace +
        aggregated usage into the same :class:`Citations` envelope the single-agent
        path produces. Shares setup (:meth:`_setup_orchestration_run`) and response
        assembly (:meth:`_assemble_orchestrated_response`) with the streaming path
        so the two never diverge.
        """
        run = await self._setup_orchestration_run(request)

        invoke_start = time.monotonic()
        # Union scope across every participant. See
        # _build_bifrost_mcp_include_value docstring -- this is a
        # what-the-LLM-sees bound; execution-time enforcement remains
        # per-agent via build_toolset's per-server whitelist.
        with self._bifrost_mcp_scope(self._agents):
            output, participant_steps, terminated_by = await self._run_orchestration_workflow(
                run.workflow,
                run.messages,
                participant_names=run.participant_names,
                prefer_last=run.prefer_last,
            )

        return await self._assemble_orchestrated_response(
            request,
            output=output,
            participant_steps=participant_steps,
            terminated_by=terminated_by,
            toolsets=run.toolsets,
            context_used=run.context_used,
            invoke_start=invoke_start,
        )

    async def _setup_orchestration_run(self, request: AgentRequest) -> _OrchestrationRun:
        """Build the workflow, messages, and participant set for one orchestration.

        Extracted from :meth:`_invoke_orchestrated` so the synchronous and
        streaming paths construct the run identically. Resets per-agent usage,
        (re)builds participant runners + toolsets, constructs the AF workflow, and
        assembles the conversation messages (magentic gets a single task message;
        everything else replays session history).
        """
        from agent_framework import Message

        for agent in self._agents:
            agent.client.reset_usage()

        # Per-invocation managers (magentic / LLM group-chat orchestrator) are
        # tracked so their LLM usage aggregates alongside the participants.
        self._manager_agents = []
        participants, toolsets = self._prepare_orchestration_participants()

        assert self._orchestration_config is not None  # set in initialize()
        workflow = self._orchestration_builder.build(
            self._orchestration_type,
            participants,
            agent_names=[a.name for a in self._agents],
            config=self._orchestration_config,
            manager_factory=self._build_manager_runner,
            # Triage uses these for per-target handoff descriptions — see
            # _build_triage in orchestration_builder.
            agent_descriptions=[a.description for a in self._agents],
        )

        if self._orchestration_type == "magentic":
            # Magentic plans from a SINGLE task message and rejects a replayed
            # multi-turn transcript: agent_framework_orchestrations._magentic raises
            # "Magentic only support a single task message to start the workflow."
            # Feed it just the latest user input. The turn is still persisted to the
            # session afterwards; it's only the *replay into the planner* that's
            # unsupported. (context_used stays None since no history is fed.)
            messages = [Message("user", [request.input])]
            context_used = None
        else:
            messages, context_used = await self._build_history_messages(request.session_id)
            messages.append(Message("user", [request.input]))

        # ``self._manager_agents`` is empty unless ``_build_manager_runner`` was
        # invoked during orchestration construction (magentic / group_chat with
        # LLM selection / triage). Including the manager's name here lets the
        # event mapper attribute the manager's turn — otherwise its routing or
        # planning turn is silently filtered out, ``participant_steps`` ends up
        # empty, and ``_responding_agent_for_steps`` falls back to ``self._agents[0]``
        # — making the trace lie about who actually responded.
        participant_names = {a.name for a in self._agents}
        participant_names.update(m.name for m in self._manager_agents)
        prefer_last = self._orchestration_type in ("group_chat", "magentic", "handoff", "triage")

        return _OrchestrationRun(
            workflow=workflow,
            messages=messages,
            participant_names=participant_names,
            prefer_last=prefer_last,
            toolsets=toolsets,
            context_used=context_used,
            agent_names=[a.name for a in self._agents],
        )

    async def _assemble_orchestrated_response(
        self,
        request: AgentRequest,
        *,
        output: str,
        participant_steps: list[tuple[str, str, str]],
        terminated_by: str,
        toolsets: dict[str, MafToolset],
        context_used: Any,  # noqa: ANN401
        invoke_start: float,
        usage_override: TokenUsage | None = None,
    ) -> AgentResponse:
        """Assemble the final :class:`AgentResponse` from a completed run.

        Extracted from :meth:`_invoke_orchestrated`. Computes duration + aggregated
        usage, builds the :class:`Citations` envelope (responding agent, per-agent
        trace, performance), persists the user/assistant turn to the session, and
        maps everything into the wire response. Used by both the sync and streaming
        paths so the final envelope is identical regardless of transport.

        ``usage_override`` is supplied by the streaming path: AF's streaming agent
        run records usage only into the :func:`usage_capture_scope` ContextVar (not
        each client's ``_accumulated_usage``), so ``_read_total_usage`` would read
        zero. The streaming wrapper captures the scope total and passes it here.
        """
        from agent_service_maf.core.session import ConversationMessage
        from agent_service_maf.interface_layer.models import AssistantMessageMetadata

        invoke_duration_ms = int((time.monotonic() - invoke_start) * 1000)

        usage = usage_override if usage_override is not None else self._read_total_usage()

        responding = self._responding_agent_for_steps(participant_steps)
        citations = Citations(
            responding_agent=self._build_agent_citation(responding),
            context_used=context_used,
            agent_trace=self._build_orchestration_trace(participant_steps, toolsets),
            performance=self._build_orchestration_perf(invoke_duration_ms, toolsets),
        )

        if self._session_manager and request.session_id:
            await self._session_manager.append_message(
                request.session_id,
                ConversationMessage(role="user", content=request.input),
            )
            assistant_metadata = AssistantMessageMetadata(
                duration_ms=invoke_duration_ms,
                usage=usage,
                citations=citations,
            )
            await self._session_manager.append_message(
                request.session_id,
                ConversationMessage(
                    role="assistant",
                    content=output,
                    metadata=assistant_metadata.model_dump(by_alias=True, exclude_none=True),
                ),
            )

        return MafEventMapper.map_to_agent_response(
            output=output,
            agent_id=request.agent_id,
            orchestration_type=self._orchestration_type,
            agent_names=[a.name for a in self._agents],
            metadata={"model": responding.model, "terminated_by": terminated_by},
            citations=citations,
            usage=usage,
        )

    def _resolve_orchestration_timeout(self) -> tuple[float, bool]:
        """Resolve the orchestration's wall-clock budget and graceful flag.

        Implements the ``termination_strategy`` timeout semantics:

        * ``type == "timeout"`` with ``timeout_seconds`` set -> **graceful** cap:
          hitting the budget returns the last collected participant output with
          ``terminated_by="timeout"`` instead of raising.
        * Any other ``type`` with ``timeout_seconds`` set -> **hard** cap: a
          wall-clock budget that raises :class:`AgentInvocationError` on expiry.
        * No explicit ``timeout_seconds`` -> a hard cap derived from
          ``max_rounds`` (``max_rounds * 30s``), falling back to
          :data:`_ORCHESTRATION_TIMEOUT_DEFAULT`. This mirrors SK's always-on
          orchestration budget so a looping LLM cannot run unboundedly.

        Returns:
            ``(timeout_seconds, graceful)``.
        """
        config = self._orchestration_config
        strategy = getattr(config, "termination_strategy", None) if config else None
        strategy_type = str(getattr(strategy, "type", "default") or "default")
        raw_timeout = getattr(strategy, "timeout_seconds", None)
        explicit_timeout = (
            float(raw_timeout)
            if isinstance(raw_timeout, (int, float)) and raw_timeout > 0
            else None
        )

        if explicit_timeout is not None:
            return explicit_timeout, strategy_type == "timeout"

        max_rounds = int(getattr(config, "max_rounds", 0) or 0) if config else 0
        if max_rounds > 0:
            return float(max_rounds) * _SECONDS_PER_ROUND_HEURISTIC, False
        return _ORCHESTRATION_TIMEOUT_DEFAULT, False

    async def _run_orchestration_workflow(
        self,
        workflow: Any,  # noqa: ANN401  # agent_framework.Workflow (TYPE_CHECKING only)
        messages: list[Any],
        *,
        participant_names: set[str],
        prefer_last: bool,
    ) -> tuple[str, list[tuple[str, str, str]], str]:
        """Run *workflow* under the resolved wall-clock budget.

        Dispatches to the graceful or hard-cap runner depending on
        :meth:`_resolve_orchestration_timeout`. Returns
        ``(output, participant_steps, terminated_by)`` where ``terminated_by`` is
        ``"completed"`` or ``"timeout"`` (parity with the SK adapter's response
        metadata).
        """
        timeout_seconds, graceful = self._resolve_orchestration_timeout()
        if graceful:
            return await self._run_workflow_graceful(
                workflow,
                messages,
                timeout_seconds=timeout_seconds,
                participant_names=participant_names,
                prefer_last=prefer_last,
            )
        return await self._run_workflow_hard_cap(
            workflow,
            messages,
            timeout_seconds=timeout_seconds,
            participant_names=participant_names,
            prefer_last=prefer_last,
        )

    async def _run_workflow_hard_cap(
        self,
        workflow: Any,  # noqa: ANN401
        messages: list[Any],
        *,
        timeout_seconds: float,
        participant_names: set[str],
        prefer_last: bool,
    ) -> tuple[str, list[tuple[str, str, str]], str]:
        """Run the workflow non-streaming under a hard wall-clock budget.

        Uses the clean non-streaming ``workflow.run(...)`` path (no per-update
        trace duplication). On budget expiry raises :class:`AgentInvocationError`
        -- matching SK's non-graceful timeout behavior.
        """
        try:
            result = await asyncio.wait_for(workflow.run(messages), timeout=timeout_seconds)
        except TimeoutError as exc:
            logger.warning(
                "MAF orchestration hit wall-clock budget -- aborting",
                orchestration_type=self._orchestration_type,
                timeout_seconds=timeout_seconds,
            )
            raise AgentInvocationError(
                f"Orchestration '{self._orchestration_type}' exceeded its "
                f"{timeout_seconds:.0f}s wall-clock budget. Lower max_rounds, raise "
                "termination_strategy.timeout_seconds, or set "
                'termination_strategy.type="timeout" for graceful partial results.',
                details={
                    "orchestration_type": self._orchestration_type,
                    "timeout_seconds": timeout_seconds,
                },
            ) from exc

        output = MafEventMapper.extract_final_output(
            result,
            participant_names=participant_names,
            prefer_last_participant=prefer_last,
        )
        steps = MafEventMapper.extract_participant_steps(result, participant_names)
        return output, steps, "completed"

    async def _run_workflow_graceful(
        self,
        workflow: Any,  # noqa: ANN401
        messages: list[Any],
        *,
        timeout_seconds: float,
        participant_names: set[str],
        prefer_last: bool,
    ) -> tuple[str, list[tuple[str, str, str]], str]:
        """Run the workflow with graceful timeout (``termination_strategy.type='timeout'``).

        Streams workflow events so partial progress is observable: if the budget
        expires the orchestration returns the last collected participant output
        with ``terminated_by="timeout"`` rather than raising (parity with SK's
        graceful timeout). AF surfaces partial output only via the streaming
        (``stream=True``) run, so this path is used solely for ``type="timeout"``
        configs; all other topologies keep the cleaner non-streaming trace.
        """
        handle = workflow.run(messages, stream=True)
        collected: list[Any] = []

        async def _consume() -> None:
            async for event in handle:
                collected.append(event)

        try:
            await asyncio.wait_for(_consume(), timeout=timeout_seconds)
        except TimeoutError:
            steps = self._drop_empty_steps(
                MafEventMapper.extract_participant_steps(collected, participant_names)
            )
            output = next(
                (output_text for _name, _input, output_text in reversed(steps) if output_text),
                "",
            )
            logger.info(
                "MAF orchestration terminated -- timeout reached (graceful)",
                orchestration_type=self._orchestration_type,
                timeout_seconds=timeout_seconds,
                partial_steps=len(steps),
            )
            return output, steps, "timeout"

        result = await handle.get_final_response()
        output = MafEventMapper.extract_final_output(
            result,
            participant_names=participant_names,
            prefer_last_participant=prefer_last,
        )
        steps = self._drop_empty_steps(
            MafEventMapper.extract_participant_steps(result, participant_names)
        )
        return output, steps, "completed"

    @staticmethod
    def _drop_empty_steps(
        steps: list[tuple[str, str, str]],
    ) -> list[tuple[str, str, str]]:
        """Drop participant steps with empty output text.

        The streaming run emits both per-update ``output`` events and a terminal
        ``executor_completed`` list, so empty-output placeholder steps can appear;
        they carry no trace value and are filtered for the graceful path. We
        key the filter on output (not input) because an empty output means
        the agent didn't actually speak this turn — and that's what makes a
        step interesting in the trace.
        """
        return [(name, input_text, output) for name, input_text, output in steps if output]

    @staticmethod
    def _dedupe_stream_steps(
        steps: list[tuple[str, str, str]],
    ) -> list[tuple[str, str, str]]:
        """Drop empty-output steps, then collapse consecutive duplicate turns.

        A streamed turn surfaces as ``output`` (text) + often an empty ``output``
        (the usage-only terminal chunk) + a terminal ``executor_completed`` list
        carrying the same text. :meth:`MafEventMapper.extract_participant_steps`
        only collapses *adjacent* identical ``(name, output)`` rows, so the empty
        row wedged between the two text rows defeats it. Dropping empties first,
        then collapsing consecutive ``(name, output)`` duplicates, yields one row
        per turn -- matching the non-streaming trace. Prefers the duplicate that
        carries a non-empty input.
        """
        deduped: list[tuple[str, str, str]] = []
        for name, input_text, output in steps:
            if not output:
                continue
            if deduped and deduped[-1][0] == name and deduped[-1][2] == output:
                if not deduped[-1][1] and input_text:
                    deduped[-1] = (name, input_text, output)
                continue
            deduped.append((name, input_text, output))
        return deduped

    async def _stream_orchestrated_wrapper(
        self,
        request: AgentRequest,
        context: AgentExecutionContext,
    ) -> AsyncIterator[AgentEvent]:
        """Multi-agent streaming with per-participant lifecycle events.

        Streams the AF workflow live (``workflow.run(..., stream=True)``) and
        translates per-executor workflow events into
        :attr:`~EventType.AGENT_STARTED` / :attr:`~EventType.AGENT_COMPLETED` so a
        client can see **which agent is running and when each turn starts and
        finishes**. Each agent turn emits::

            agent_started   {agentName, startedAt}
            agent_completed {agentName, completedAt, durationMs}

        The agent's output text is NOT streamed per-agent; the final answer is
        emitted once as a single terminal TOKEN at the end, so the chat message
        shows the final output rather than a concatenation of every turn.

        A single wall-clock budget bounds the run (mirroring the non-streaming
        ``_resolve_orchestration_timeout`` semantics): a hard cap surfaces an
        ERROR; a graceful (``termination_strategy.type="timeout"``) cap finalizes
        the partial transcript. The terminal COMPLETED envelope carries the full
        ``invokeResponse`` (agentTrace, usage, citations), assembled identically
        to the synchronous path via :meth:`_assemble_orchestrated_response`.
        """
        effective_schema, expect_json = self._resolve_output_schema_context(request)
        builder = ResponseBuilder(
            agent_id=request.agent_id,
            session_id=request.session_id,
            framework=FRAMEWORK_ID,
            output_schema=effective_schema,
            expect_json=expect_json,
        )

        yield AgentEvent(
            event_type=EventType.STARTED,
            metadata={"agentId": request.agent_id, "framework": FRAMEWORK_ID},
        )

        error_msg: str | None = None
        error_type = "AgentInvocationError"
        output = ""
        steps: list[tuple[str, str, str]] = []
        terminated_by = "completed"
        invoke_start = time.monotonic()

        try:
            run = await self._setup_orchestration_run(request)
        except AgentInvocationError as exc:
            error_msg, error_type = str(exc), type(exc).__name__

        if error_msg is None:
            timeout_seconds, graceful = self._resolve_orchestration_timeout()
            invoke_start = time.monotonic()
            deadline = invoke_start + timeout_seconds
            collected: list[Any] = []
            state: dict[str, Any] = {"active": {}, "closed": set()}
            timed_out = False
            pump_error: dict[str, BaseException | None] = {"exc": None}
            usage_override: TokenUsage | None = None

            # Union scope across every participant. See
            # _build_bifrost_mcp_include_value docstring -- this is a
            # what-the-LLM-sees bound; enforcement remains per-agent via
            # build_toolset's per-server whitelist.
            #
            # usage_capture_scope: AF's streaming agent run records token usage only
            # into this ContextVar (not each client's _accumulated_usage), so we
            # aggregate here and pass the total to _assemble_orchestrated_response.
            # Entered before create_task so the pump task inherits the buffer.
            with self._bifrost_mcp_scope(self._agents), usage_capture_scope() as usage_buf:
                handle = run.workflow.run(run.messages, stream=True)
                queue: asyncio.Queue[Any] = asyncio.Queue()
                sentinel = object()

                async def _pump() -> None:
                    """Drain the AF stream onto a queue so the generator can yield
                    per-event under a wall-clock budget."""
                    try:
                        async for ev in handle:
                            await queue.put(ev)
                    except BaseException as exc:  # noqa: BLE001 - surfaced as ERROR
                        pump_error["exc"] = exc
                    finally:
                        await queue.put(sentinel)

                pump_task = asyncio.create_task(_pump())
                try:
                    while True:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            timed_out = True
                            break
                        try:
                            event = await asyncio.wait_for(queue.get(), timeout=remaining)
                        except TimeoutError:
                            timed_out = True
                            break
                        if event is sentinel:
                            break
                        collected.append(event)
                        for out_event in self._translate_orchestration_event(
                            event, run.participant_names, state
                        ):
                            yield out_event
                finally:
                    if not pump_task.done():
                        pump_task.cancel()
                    with suppress(asyncio.CancelledError, Exception):
                        await pump_task

                # Close out any agent that emitted AGENT_STARTED but never a
                # matching completion. In triage / handoff the router fans an
                # AgentExecutorRequest out to every specialist, but the ones it
                # did not route to complete with an empty (``data=None``)
                # ``executor_completed`` -- _translate_orchestration_event only
                # completes turns that carry output, so those specialists would
                # otherwise spin forever in the UI while the terminal answer
                # streams past them. Drain them here so every started agent is
                # reported complete before the terminal COMPLETED event.
                for straggler, started_at in list(state["active"].items()):
                    state["active"].pop(straggler, None)
                    if straggler in state["closed"]:
                        continue
                    state["closed"].add(straggler)
                    yield AgentEvent(
                        event_type=EventType.AGENT_COMPLETED,
                        metadata={
                            "agentName": straggler,
                            "completedAt": _utc_now_iso(),
                            "durationMs": int((time.monotonic() - started_at) * 1000),
                        },
                    )

                # Same close-out for triage/route specialists tracked as router
                # tool calls (state["tool_calls"]) whose result never streamed.
                for _cid, (cname, started_at) in list(state.get("tool_calls", {}).items()):
                    yield AgentEvent(
                        event_type=EventType.AGENT_COMPLETED,
                        metadata={
                            "agentName": cname,
                            "completedAt": _utc_now_iso(),
                            "durationMs": int((time.monotonic() - started_at) * 1000),
                        },
                    )
                state.get("tool_calls", {}).clear()

                # Aggregate streamed usage (see usage_capture_scope comment above).
                _scoped_usage = sum_token_usage(usage_buf)
                usage_override = _scoped_usage if _scoped_usage.total_tokens > 0 else None

                if pump_error["exc"] is not None and not timed_out:
                    exc = pump_error["exc"]
                    error_msg, error_type = str(exc), type(exc).__name__
                elif timed_out and not graceful:
                    logger.warning(
                        "MAF orchestration hit wall-clock budget (stream) -- aborting",
                        orchestration_type=self._orchestration_type,
                        timeout_seconds=timeout_seconds,
                    )
                    error_msg = (
                        f"Orchestration '{self._orchestration_type}' exceeded its "
                        f"{timeout_seconds:.0f}s wall-clock budget. Lower max_rounds, raise "
                        "termination_strategy.timeout_seconds, or set "
                        'termination_strategy.type="timeout" for graceful partial results.'
                    )
                elif timed_out:
                    # Graceful timeout -- finalize the partial transcript.
                    steps = self._dedupe_stream_steps(
                        MafEventMapper.extract_participant_steps(collected, run.participant_names)
                    )
                    output = next(
                        (out_text for _n, _i, out_text in reversed(steps) if out_text), ""
                    )
                    terminated_by = "timeout"
                    logger.info(
                        "MAF orchestration terminated -- timeout reached (graceful, stream)",
                        orchestration_type=self._orchestration_type,
                        partial_steps=len(steps),
                    )
                else:
                    result = await handle.get_final_response()
                    output = MafEventMapper.extract_final_output(
                        result,
                        participant_names=run.participant_names,
                        prefer_last_participant=run.prefer_last,
                    )
                    steps = self._dedupe_stream_steps(
                        MafEventMapper.extract_participant_steps(result, run.participant_names)
                    )
                    # Handoff / triage: get_final_response() returns a
                    # WorkflowRunResult that does not carry the per-agent turns
                    # the extractors read -- they come back empty even though a
                    # specialist replied (its answer arrives only as streamed
                    # ``output`` events). The transcript we already collected
                    # does carry them, so fall back to that raw event list (the
                    # same source the graceful-timeout branch trusts) whenever
                    # the result-based extraction yields nothing.
                    if not steps:
                        steps = self._dedupe_stream_steps(
                            MafEventMapper.extract_participant_steps(
                                collected, run.participant_names
                            )
                        )
                    if not steps:
                        # Handoff / triage: the specialist's text arrived only as
                        # streamed AgentResponseUpdate deltas (empty completed
                        # response), so rebuild the per-turn text from them.
                        steps = MafEventMapper.reconstruct_stream_participant_steps(
                            collected, run.participant_names
                        )
                    if not output:
                        output = next(
                            (out_text for _n, _i, out_text in reversed(steps) if out_text), ""
                        )
                    terminated_by = "completed"

        if error_msg is None:
            try:
                response = await self._assemble_orchestrated_response(
                    request,
                    output=output,
                    participant_steps=steps,
                    terminated_by=terminated_by,
                    toolsets=run.toolsets,
                    context_used=run.context_used,
                    invoke_start=invoke_start,
                    usage_override=usage_override,
                )
            except AgentInvocationError as exc:
                error_msg, error_type = str(exc), type(exc).__name__
            else:
                # Emit the terminal answer as a single TOKEN so the chat message
                # shows the final output — NOT a concatenation of every agent's
                # turn. Per-agent progress is conveyed by the AGENT_STARTED /
                # AGENT_COMPLETED lifecycle events, not by streaming each agent's
                # text into the message body.
                if response.output:
                    builder.add_token(response.output)
                    yield AgentEvent(
                        event_type=EventType.TOKEN,
                        data=response.output,
                        metadata={"orchestration_type": self._orchestration_type},
                    )
                if response.citations is not None:
                    builder.set_citations(response.citations)
                if response.usage is not None:
                    builder.set_usage(response.usage.model_dump(by_alias=True))
                if response.metadata:
                    builder.merge_metadata(response.metadata)

        if error_msg is not None:
            yield AgentEvent(
                event_type=EventType.ERROR,
                data=error_msg,
                metadata={"errorType": error_type},
            )

        yield AgentEvent(
            event_type=EventType.COMPLETED,
            metadata={"invokeResponse": builder.finalize().model_dump(by_alias=True, mode="json")},
        )

    def _translate_orchestration_event(
        self,
        event: Any,  # noqa: ANN401 - agent_framework.WorkflowEvent
        participant_names: set[str],
        state: dict[str, Any],
    ) -> list[AgentEvent]:
        """Translate one AF ``WorkflowEvent`` into per-agent lifecycle events.

        Emits AGENT_STARTED when a participant executor is invoked and
        AGENT_COMPLETED when it produces output (the output text itself is not
        streamed per-agent — see :meth:`_complete_agent_turn`). ``state`` threads
        mutable bookkeeping across events:

        * ``state["active"]``: ``agent_name -> monotonic start`` for turns that
          have started but not yet completed. Popped on completion so a repeat
          turn (group_chat / handoff) emits a fresh started/completed pair.
        * ``state["closed"]``: names whose current turn has already emitted a
          COMPLETED. Guarantees exactly one completed per turn -- the duplicate
          completions AF emits for one turn (the ``output`` + ``executor_completed``
          pair, or a list carrying several updates for the same executor) are
          dropped. Cleared for an agent on its next ``executor_invoked`` so a
          genuine repeat turn is reported again. This is what prevents the 0ms
          started/completed storm for agents whose output text varies between
          duplicate emissions.

        AF interleaves non-participant executors (``input-conversation``,
        aggregators, orchestrators) and empty-text ``output`` updates (e.g. the
        usage-only terminal chunk); both are filtered out here.
        """
        event_type = getattr(event, "type", None)
        executor_id = getattr(event, "executor_id", None)
        data = getattr(event, "data", None)
        out: list[AgentEvent] = []

        if event_type == "executor_invoked" and executor_id is not None:
            name = str(executor_id)
            if name in participant_names:
                # New turn for this agent -- clear the "closed" marker so this
                # turn's completion is reported even if a prior turn already was.
                state["closed"].discard(name)
                if name not in state["active"]:
                    state["active"][name] = time.monotonic()
                    out.append(
                        AgentEvent(
                            event_type=EventType.AGENT_STARTED,
                            metadata={"agentName": name, "startedAt": _utc_now_iso()},
                        )
                    )
            return out

        # Triage / route: specialists run as the router's ``as_tool`` calls, not
        # as workflow executors, so they never emit executor_invoked/completed.
        # Re-source their lifecycle from the FunctionCall / FunctionResult content
        # in the router's output stream: AGENT_STARTED on the first call for a
        # specialist, AGENT_COMPLETED on its result. Runs on every output event
        # (including streamed deltas), deduped by call_id. Empty for topologies
        # whose members are real executors (no participant-named tool calls).
        contents = getattr(data, "contents", None)
        if contents is not None:
            tool_calls: dict[str, tuple[str, float]] = state.setdefault("tool_calls", {})
            for content in contents:
                call = _delegation_call(content)
                if call is not None:
                    cname, call_id = call
                    if cname in participant_names and call_id not in tool_calls:
                        tool_calls[call_id] = (cname, time.monotonic())
                        out.append(
                            AgentEvent(
                                event_type=EventType.AGENT_STARTED,
                                metadata={"agentName": cname, "startedAt": _utc_now_iso()},
                            )
                        )
                    continue
                res = _delegation_result(content)
                if res is not None:
                    call_id = res[0]
                    started = tool_calls.pop(call_id, None)
                    if started is not None:
                        cname, start = started
                        out.append(
                            AgentEvent(
                                event_type=EventType.AGENT_COMPLETED,
                                metadata={
                                    "agentName": cname,
                                    "completedAt": _utc_now_iso(),
                                    "durationMs": int((time.monotonic() - start) * 1000),
                                },
                            )
                        )

        # ``executor_completed`` list form (sequential / concurrent).
        if isinstance(data, list):
            for item in data:
                agent_response = getattr(item, "agent_response", None)
                completed_id = getattr(item, "executor_id", None) or executor_id
                if agent_response is None or completed_id is None:
                    continue
                name = str(completed_id)
                if name in participant_names:
                    out.extend(self._complete_agent_turn(name, agent_response.text or "", state))
            return out

        # Single ``output`` form (group_chat / handoff / graph turns). Skip
        # streaming token deltas (AgentRunResponseUpdate) — otherwise every token
        # of a streaming agent would fire its own agent_completed. The real turn
        # boundary is the ``executor_completed`` list handled above.
        if event_type == "output" and executor_id is not None and not _is_stream_update(data):
            name = str(executor_id)
            if name in participant_names:
                text = getattr(data, "text", None) or ""
                out.extend(self._complete_agent_turn(name, text, state))
        return out

    def _complete_agent_turn(
        self,
        name: str,
        text: str,
        state: dict[str, Any],
    ) -> list[AgentEvent]:
        """Emit AGENT_COMPLETED at most once per finished agent turn.

        Only the per-agent lifecycle is emitted here — the agent's output text is
        NOT streamed as a TOKEN (that would concatenate every agent's turn into
        the chat message body). The final answer is emitted once as a terminal
        TOKEN in :meth:`_stream_orchestrated_wrapper`. ``text`` is used only to
        detect a real (non-empty) turn; empty-text updates (the usage-only
        terminal chunk) are ignored.

        Exactly one COMPLETED is emitted per turn, gated on *turn state* rather
        than on the output text:

        * Turn *open* (``name`` in ``state["active"]``): pop it, emit COMPLETED
          with the real duration, mark the turn ``closed``.
        * Turn already *closed*: a duplicate completion AF emits for the same turn
          (the ``output`` + ``executor_completed`` pair, or a list of several
          updates for one executor) -- drop it. Gating on turn state instead of
          ``(name, text)`` is what stops the 0ms started/completed storm for
          agents whose output text varies between duplicate emissions.
        * Neither open nor closed: an AF variant that emitted no
          ``executor_invoked`` -- synthesize a single started/completed pair so
          the responding agent is still reported exactly once.
        """
        if not text:
            return []
        out: list[AgentEvent] = []
        start = state["active"].pop(name, None)
        if start is not None:
            duration_ms = int((time.monotonic() - start) * 1000)
        else:
            if name in state["closed"]:
                # Duplicate completion for an already-reported turn -- ignore.
                return []
            # No executor_invoked was seen for this turn (AF version variant) --
            # synthesize the start so the responding agent still gets one pair.
            out.append(
                AgentEvent(
                    event_type=EventType.AGENT_STARTED,
                    metadata={"agentName": name, "startedAt": _utc_now_iso()},
                )
            )
            duration_ms = 0
        out.append(
            AgentEvent(
                event_type=EventType.AGENT_COMPLETED,
                metadata={
                    "agentName": name,
                    "completedAt": _utc_now_iso(),
                    "durationMs": duration_ms,
                },
            )
        )
        state["closed"].add(name)
        return out

    def _prepare_orchestration_participants(
        self,
    ) -> tuple[list[Agent], dict[str, MafToolset]]:
        """Build per-invocation participant runners with tools (and handoff flags).

        Each participant gets a fresh :class:`MafToolset` (its own ``tool_history``)
        and a runner with those tools bound at the agent level so orchestrated
        agents can call functions / MCP just like the single-agent path. Handoff
        and triage participants additionally require AF's per-service-call history
        persistence.

        Returns:
            ``(runners, toolsets_by_agent_name)`` in agent-definition order.
        """
        # Only ``handoff`` uses AF's HandoffBuilder (which requires per-service-call
        # history persistence). ``triage`` is now a single router agent with the
        # members exposed as ``as_tool`` tools (see _build_triage), so its
        # participants run as ordinary tool-backed agents.
        needs_handoff = self._orchestration_type == "handoff"
        runners: list[Agent] = []
        toolsets: dict[str, MafToolset] = {}
        for agent in self._agents:
            toolset = self._build_toolset(agent)
            toolsets[agent.name] = toolset
            runners.append(
                agent.make_runner(
                    tools=toolset.tools or None,
                    require_handoff_persistence=needs_handoff,
                )
            )
        return runners, toolsets

    def _build_manager_runner(self, *, tools: Any | None = None) -> Agent:  # noqa: ANN401
        """Build the orchestration manager runner (magentic / LLM group chat / triage).

        Synthesizes a manager agent from ``magentic_manager_model`` /
        ``manager_model`` (falling back to the global default model) and tracks it
        in :attr:`_manager_agents` so its LLM usage aggregates with the
        participants.

        ``function_choice_behavior`` is ``"auto"`` (set in
        :meth:`MafAgentBuilder.build_manager_agent`) so the manager may emit tool
        calls. For triage the caller passes *tools* (the specialists wrapped via
        :meth:`agent_framework.Agent.as_tool`): the manager becomes the router,
        and calling a specialist tool runs that agent and returns its answer.
        """
        cfg = self._orchestration_config
        model = (
            getattr(cfg, "magentic_manager_model", None)
            or getattr(cfg, "manager_model", None)
            or self._default_model
        )
        temperature = (
            getattr(cfg, "manager_temperature", None)
            if getattr(cfg, "manager_temperature", None) is not None
            else getattr(cfg, "magentic_manager_temperature", 0.0)
        )
        # Optional manager system prompt + name. When ``manager_instructions`` is
        # empty the framework's built-in Magentic-One prompts apply; when set it
        # steers how the manager plans / coordinates / synthesizes / routes.
        instructions = getattr(cfg, "manager_instructions", None) or ""
        name = getattr(cfg, "manager_name", None) or "orchestrator"
        max_tokens = getattr(cfg, "manager_max_tokens", None)
        # ``auto`` — let the manager LLM either emit a handoff tool call or
        # reply in prose. AF's HandoffBuilder injects the handoff functions
        # into the manager's tool set; with a tight routing prompt the LLM
        # picks one. ``required`` was tried earlier and produced empty
        # outputs because the model emitted forced tool calls AF couldn't
        # always interpret as valid handoffs (see git history if revisiting).
        manager_display_name = getattr(cfg, "manager_model_display_name", None) or getattr(
            cfg, "magentic_manager_model_display_name", None
        )
        assert self._agent_builder is not None  # set in initialize()
        manager = self._agent_builder.build_manager_agent(
            model=model,
            temperature=float(temperature or 0.0),
            name=name,
            instructions=instructions,
            max_tokens=max_tokens,
            function_choice_behavior="auto",
            model_display_name=manager_display_name,
        )
        self._manager_agents.append(manager)
        # Triage passes the specialist ``as_tool`` tools so the manager becomes a
        # tool-calling router. The runner shares ``manager.client`` so usage
        # tracking still aggregates. magentic / group_chat pass no tools and use
        # the plain runner.
        if tools is not None:
            return manager.make_runner(tools=tools)
        return manager.runner

    def _build_orchestration_trace(
        self,
        participant_steps: list[tuple[str, str, str]],
        toolsets: dict[str, MafToolset],
    ) -> list[AgentTraceStep]:
        """One :class:`AgentTraceStep` per participant turn, in execution order.

        Each step carries the input that triggered this turn (last user /
        manager / handoff message seen by the executor) AND the agent's
        response text, both truncated to keep the trace lightweight.

        Tool executions are attached the first time an agent appears in the
        trace (its ``tool_history`` reflects the whole invocation, so it is
        emitted once to avoid duplicating across an agent's multiple turns).
        """
        emitted_tools: set[str] = set()
        steps: list[AgentTraceStep] = []
        for index, (name, input_text, output_text) in enumerate(participant_steps):
            tool_executions = []
            toolset = toolsets.get(name)
            if toolset is not None and name not in emitted_tools:
                tool_executions = MafEventMapper.build_tool_executions(
                    toolset.tool_history, invoked_by=name
                )
                emitted_tools.add(name)
            steps.append(
                AgentTraceStep(
                    step_index=index,
                    agent_name=name,
                    action="respond",
                    input=input_text[:200],
                    output=output_text[:200],
                    round=1,
                    tool_executions=tool_executions,
                )
            )
        return steps

    def _build_orchestration_perf(
        self,
        invoke_duration_ms: int,
        toolsets: dict[str, MafToolset],
    ) -> PerformanceBreakdown:
        """Aggregate LLM timing / call-count across participants + managers."""
        clients = [a.client for a in self._agents] + [m.client for m in self._manager_agents]
        llm_ms = sum(c.get_llm_duration_ms() for c in clients)
        llm_calls = sum(c.get_llm_call_count() for c in clients)
        tool_ms = sum(self._sum_tool_duration(ts.tool_history) or 0 for ts in toolsets.values())
        return PerformanceBreakdown(
            total_duration_ms=invoke_duration_ms,
            llm_duration_ms=llm_ms,
            tool_duration_ms=tool_ms or None,
            framework_overhead_ms=max(0, invoke_duration_ms - llm_ms - tool_ms),
            llm_call_count=llm_calls,
        )

    def _responding_agent_for_steps(
        self,
        participant_steps: list[tuple[str, str, str]],
    ) -> BuiltMafAgent:
        """Pick the agent that produced the terminal output (fallback: first).

        For sequential the last participant is the responder; for concurrent there
        is no single responder, so the last step (or first agent) is used as the
        citation source.
        """
        if participant_steps:
            last_name = participant_steps[-1][0]
            for agent in (*self._agents, *self._manager_agents):
                if agent.name == last_name:
                    return agent
        return self._agents[0]

    def _read_total_usage(self) -> TokenUsage | None:
        """Sum accumulated usage across every participant + manager client."""
        prompt = completion = total = 0
        cost = 0.0
        for agent in [*self._agents, *self._manager_agents]:
            acc = agent.client.get_accumulated_usage()
            prompt += acc.prompt_tokens
            completion += acc.completion_tokens
            total += acc.total_tokens
            cost += acc.estimated_cost_usd
        if total <= 0:
            return None
        return TokenUsage(
            prompt_tokens=prompt,
            completion_tokens=completion,
            total_tokens=total,
            estimated_cost_usd=cost,
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _require_supported_orchestration(self) -> None:
        """Guard unknown orchestration types.

        The AF adapter supports ``single`` plus every multi-agent topology in
        :data:`SUPPORTED_ORCHESTRATION_TYPES` (sequential, concurrent, handoff,
        triage, group_chat, magentic, graph).

        Raises:
            AgentInvocationError: If the configured orchestration type is unknown.
        """
        if self._orchestration_type == "single":
            return
        if self._orchestration_type in SUPPORTED_ORCHESTRATION_TYPES:
            return
        raise AgentInvocationError(
            f"Unknown orchestration type '{self._orchestration_type}' for the Microsoft "
            "Agent Framework adapter. Supported: 'single', 'sequential', 'concurrent', "
            "'handoff', 'triage', 'group_chat', 'magentic', 'graph'.",
            details={"orchestration_type": self._orchestration_type},
        )

    @staticmethod
    def _build_auth_hook(context: AgentExecutionContext) -> Any | None:  # noqa: ANN401
        """Wire the guardrail pipeline's ``check_tool`` as the MCP auth hook.

        Mirrors the SK adapter: when guardrails are configured, every MCP tool
        call is gated through ``check_tool`` (running the ToolAuthorizer +
        ToolParamValidator). Returns ``None`` when no guardrails are wired.
        """
        guardrails = context.guardrails
        if guardrails is None:
            return None

        from agent_service_maf.core.exceptions import GuardrailError

        async def _guardrail_auth_hook(tool_name: str, params: dict[str, Any]) -> bool:
            try:
                await guardrails.check_tool(
                    tool_name=tool_name,
                    tool_params=params,
                    agent_id="",
                    context={"correlation_id": context.correlation_id},
                )
                return True
            except GuardrailError:
                return False

        return _guardrail_auth_hook

    @staticmethod
    def _build_function_provider(
        config: Any,  # noqa: ANN401
    ) -> tuple[FunctionToolProvider | None, list[ToolBinding]]:
        """Resolve ``tool_bindings`` from raw config into a provider + catalogue.

        ``tool_bindings`` lands in ``__pydantic_extra__`` because ``AgentConfig``
        uses ``extra="allow"``. The provider serves only the function-typed
        bindings; the full catalogue is returned so the toolset builder can match
        binding names. Mirrors the SK adapter's ``_build_function_provider``.

        Returns:
            ``(provider, all_bindings)``. ``provider`` is ``None`` when no
            function-typed binding is present; ``all_bindings`` is always a list.
        """
        from agent_service_maf.tools.binding import FunctionBinding, parse_tool_bindings
        from agent_service_maf.tools.function_provider import FunctionToolProvider

        bindings_raw = getattr(config, "tool_bindings", None)
        all_bindings: list[ToolBinding] = []
        if bindings_raw:
            try:
                all_bindings = parse_tool_bindings(list(bindings_raw))
            except Exception as exc:
                raise AgentInvocationError(
                    f"Invalid 'tool_bindings' config: {exc}. "
                    "Check the tool_bindings array at the top level of the agent config.",
                    details={"error": str(exc)},
                ) from exc

        function_bindings = [b for b in all_bindings if isinstance(b, FunctionBinding)]
        provider: FunctionToolProvider | None = None
        if function_bindings:
            provider = FunctionToolProvider(bindings=function_bindings)
        return provider, all_bindings

    def _build_toolset(self, agent: BuiltMafAgent) -> MafToolset:
        """Build this agent's AF tools with a fresh per-invocation ``tool_history``."""
        return build_toolset(
            agent_def=agent.agent_def,
            function_provider=self._function_provider,
            tool_bindings=self._tool_bindings,
            mcp_registry=self._mcp_registry,
            auth_hook=self._auth_hook,
        )

    @staticmethod
    def _build_bifrost_mcp_include_value(
        agents: list[BuiltMafAgent],
        project_id: str | None,
    ) -> str | None:
        """Compute the ``x-bf-mcp-include-tools`` header value for one invocation.

        Bifrost's per-request MCP filter takes a comma-separated list of
        ``<clientName>-<toolName>`` entries (wildcards allowed). The
        ``clientName`` Bifrost knows is ``<projectId>_<serverName>`` --
        config-service registers MCP servers under that compound name.

        Single-agent path: pass ``[agent]``.

        Orchestration: pass every participant. We send the UNION of all
        participants' include sets so the orchestrator LLM can see any
        tool any sub-agent legitimately exposes. Strictly correct
        per-sub-agent enforcement (so participant A's prompt never sees
        participant B's tools) would require a hook in the MAF runner;
        the in-process toolset already enforces this at execution time
        via ``build_toolset``, so this is purely a "what does the LLM
        see" question.

        Returns ``None`` ONLY when ``project_id`` is missing -- the
        header is not applicable and must not be sent.

        When ``project_id`` is present but no participant links any MCP
        server, returns the empty string, which Bifrost reads as
        "deny all". This is deliberate and load-bearing for per-agent
        isolation: the project VK carries EVERY project MCP client in
        its ``mcp_configs`` (config-service maps each tool onto the VK so
        it is reachable at all). If the header were omitted here, Bifrost
        would expand that full VK scope into this agent's completion --
        exposing project MCP tools to an agent that was never configured
        with any. Sending an explicit deny-all keeps such an agent
        tool-less, which is the correct per-agent scope.
        """
        if not project_id:
            return None
        seen: set[str] = set()
        parts: list[str] = []
        for agent in agents:
            mcp_servers = agent.agent_def.mcp_servers or []
            whitelist = agent.agent_def.allowed_tools_by_server or {}
            for server in mcp_servers:
                client_name = f"{project_id}_{server}"
                allowed = whitelist.get(server) or []
                if allowed:
                    for tool in allowed:
                        entry = f"{client_name}-{tool}"
                        if entry not in seen:
                            seen.add(entry)
                            parts.append(entry)
                else:
                    entry = f"{client_name}-*"
                    if entry not in seen:
                        seen.add(entry)
                        parts.append(entry)
        # Empty string (NOT None) when no MCP servers are linked: an
        # explicit deny-all so Bifrost cannot fall back to the project
        # VK's full ``mcp_configs``. See the docstring.
        return ",".join(parts) if parts else ""

    @contextmanager
    def _bifrost_mcp_scope(self, agents: list[BuiltMafAgent]) -> Iterator[None]:
        """Bind ``x-bf-mcp-include-tools`` for the duration of a chat invocation.

        Wraps every ``agent.runner.run(...)`` call site so the per-request
        header overrides the project VK's auto-generated MCP scope
        (without the header, Bifrost expands the VK's ``mcp_configs``
        and the agent sees every project MCP tool regardless of its
        own ``allowedTools`` config).

        Imports are done lazily so module-load doesn't pull in the
        gateway package -- gateway -> llm_gateway -> config ->
        file_loader -> team_loader -> gateway.llm_gateway is a real
        import cycle when triggered at adapter module-load time.
        """
        from agent_service_maf.core.identity import get_current_identity
        from agent_service_maf.gateway.http_llm_client import (
            reset_request_extra_headers,
            set_request_extra_headers,
        )

        identity = get_current_identity()
        project_id = identity.project_id if identity is not None else None
        value = self._build_bifrost_mcp_include_value(agents, project_id)
        # ``value`` is None ONLY when project_id is missing (header not
        # applicable). An empty string is a MEANINGFUL value -- Bifrost's
        # documented "deny all" -- so gate on ``is not None``, not
        # truthiness, or an agent with no MCP servers would silently
        # inherit the project VK's entire ``mcp_configs``.
        extras = {"x-bf-mcp-include-tools": value} if value is not None else None
        token = set_request_extra_headers(extras)
        try:
            yield
        finally:
            reset_request_extra_headers(token)

    @staticmethod
    def _read_usage(agent: BuiltMafAgent) -> TokenUsage | None:
        """Return the agent's accumulated usage, or ``None`` when nothing was tracked."""
        acc = agent.client.get_accumulated_usage()
        if acc.total_tokens > 0:
            return acc
        return None

    @staticmethod
    def _sum_tool_duration(tool_history: list[dict[str, Any]]) -> int | None:
        """Total tool wall-clock time (ms) across a run, or ``None`` if no tools ran."""
        if not tool_history:
            return None
        return sum(int(entry.get("duration_ms", 0) or 0) for entry in tool_history)

    async def _build_history_messages(
        self,
        session_id: str | None,
    ) -> tuple[list[Any], ContextUsed | None]:
        """Build an AF ``Message`` list from session history.

        Unlike the SK builder, this does **not** prepend a system message with the
        agent instructions: AF agents carry their instructions natively (injected
        via ``ChatOptions`` by the agent runner), so prepending one here would
        duplicate the system prompt.

        Args:
            session_id: Session to retrieve history for. If ``None`` or no session
                manager is wired, returns an empty list.

        Returns:
            Tuple of (messages list, :class:`ContextUsed` citation or ``None``).
        """
        from agent_framework import Message

        messages: list[Any] = []
        context_used: ContextUsed | None = None

        if self._session_manager and session_id:
            history = await self._session_manager.get_history(session_id)
            valid_roles = {"user", "assistant", "system"}
            for msg in history:
                role = msg.role if msg.role in valid_roles else "user"
                messages.append(Message(role, [msg.content]))

            if history:
                preview = [{"role": msg.role, "content": msg.content[:200]} for msg in history[-3:]]
                context_used = ContextUsed(
                    session_id=session_id,
                    history_messages_count=len(history),
                    history_preview=preview,
                )

        return messages, context_used

    def _resolve_output_schema_context(
        self,
        request: AgentRequest,
        *,
        agent: BuiltMafAgent | None = None,
    ) -> tuple[dict[str, Any] | None, bool]:
        """Resolve the effective output schema and ``expect_json`` flag.

        Precedence: per-request ``context.outputSchema`` > agent-level
        ``output_schema``. ``expect_json`` derives from the active agent's
        ``response_format`` (``"json_object"`` -> ``True``). Mirrors the SK
        adapter's resolver.

        Args:
            request: The invocation request.
            agent: The active agent. Defaults to ``self._agents[0]``.

        Returns:
            ``(effective_schema, expect_json)``.
        """
        ctx = request.context if request.context else {}
        request_schema = ctx.get("output_schema") if ctx else None
        if request_schema is None and ctx:
            request_schema = ctx.get("outputSchema")
        if not isinstance(request_schema, dict):
            request_schema = None

        active = agent if agent is not None else (self._agents[0] if self._agents else None)
        agent_schema = getattr(active, "output_schema", None) if active else None
        if not isinstance(agent_schema, dict):
            agent_schema = None

        effective_schema = request_schema or agent_schema
        expect_json = bool(
            active is not None and getattr(active, "response_format", None) == "json_object"
        )
        return effective_schema, expect_json

    @staticmethod
    def _build_agent_citation(agent: BuiltMafAgent) -> AgentCitationSource:
        """Build a citation source from a :class:`BuiltMafAgent`."""
        return AgentCitationSource(
            name=agent.name,
            model=friendly_model_label(agent.model_display_name, agent.model),
            temperature=agent.temperature,
            framework=FRAMEWORK_ID,
            instructions_preview=agent.instructions[:120] if agent.instructions else "",
        )
