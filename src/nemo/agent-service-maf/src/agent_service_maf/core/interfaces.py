"""Core data models and abstract interfaces for the agent framework.

This module defines the universal invocation contract that all agent adapters must
implement, along with the Pydantic data models for requests, responses, events,
and capabilities.

All agent adapters must implement the three segregated interfaces:
    - :class:`AgentInvoker`: Handles invoke() and stream() methods.
    - :class:`AgentLifecycle`: Handles initialize() and shutdown() methods.
    - :class:`AgentCapabilityProvider`: Handles get_capabilities() method.

These are combined via :class:`AgentInterface` which all framework adapters use
as their base contract.

Wire models inherit from :class:`~agent_service_maf.interface_layer._base_model.CamelCaseModel`
so JSON output is ``camelCase`` while Python attribute names stay ``snake_case``
(per §5.2 of the migration plan). Construction-time kwargs accept either form
via ``populate_by_name=True``; a handful of legacy kwargs (``agent=``,
``output_preview=``, ``result_preview=``, ``invoked_by=``,
``instructions_preview=``, ``history_preview=``, ``selection_method=``,
``candidates=``) are still accepted on the citation sub-models via
``model_validator(mode='before')`` for backward compatibility with stored
payloads.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from enum import StrEnum
from typing import TYPE_CHECKING, Any, Literal

from pydantic import Field, model_validator

from agent_service_maf.core._base_model import CamelCaseModel

if TYPE_CHECKING:
    from agent_service_maf.core.context import AgentExecutionContext


# ---------------------------------------------------------------------------
# Token Usage
# ---------------------------------------------------------------------------


class TokenUsage(CamelCaseModel):
    """Token usage tracking for an agent invocation.

    Attributes:
        prompt_tokens: Number of tokens in the input prompt.
        completion_tokens: Number of tokens in the generated output.
        total_tokens: Sum of prompt_tokens + completion_tokens.
        estimated_cost_usd: Estimated cost in US dollars for this invocation.

    Example:
        >>> usage = TokenUsage(prompt_tokens=100, completion_tokens=200)
        >>> usage.total_tokens
        0
    """

    prompt_tokens: int = Field(0, ge=0, description="Number of prompt tokens consumed")
    completion_tokens: int = Field(0, ge=0, description="Number of completion tokens generated")
    total_tokens: int = Field(0, ge=0, description="Total tokens (prompt + completion)")
    estimated_cost_usd: float = Field(0.0, ge=0.0, description="Estimated cost in USD")


# ---------------------------------------------------------------------------
# Request / Response
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Citations
# ---------------------------------------------------------------------------


class KbCitation(CamelCaseModel):
    """A single knowledge-base / RAG citation surfaced from a tool result.

    Strict back-compat with the legacy AgentStudio ``CitationItem``
    (``src/nemo/agent-service/src/main.py:158``) -- six wire fields, all
    camelCase. Internal ``chunk_id`` is used by
    :class:`~agent_service_maf.framework.response_builder.ResponseBuilder`
    for ``(knowledgeBaseId, documentId, chunkId)`` dedup but is excluded
    from the serialized wire form per §5.3.1.

    Attributes:
        source: Human-readable document name shown in the UI footer.
        document_id: Stable id of the source document.
        download_url: Pre-signed URL the UI links to.
        knowledge_base_id: Owning KB.
        knowledge_base_name: KB display name.
        score: Retriever relevance score (0..1).
        chunk_id: Internal dedup key -- never serialized.
    """

    source: str = Field(..., description="Document name shown in the UI")
    document_id: str | None = Field(default=None, description="Stable document id")
    download_url: str | None = Field(default=None, description="Pre-signed URL for download")
    knowledge_base_id: str | None = Field(default=None, description="Owning KB id")
    knowledge_base_name: str | None = Field(default=None, description="KB display name")
    score: float | None = Field(default=None, description="Retriever relevance score")
    chunk_id: str | None = Field(
        default=None,
        exclude=True,
        description="Internal dedup key; not serialized on the wire.",
    )


class AgentCitationSource(CamelCaseModel):
    """Provenance for the agent that produced the final response.

    Attributes:
        name: Agent name from config.
        model: LLM model used (canonical location for "what model
            answered" -- see §5.2.4, never top-level ``modelName``).
        temperature: Temperature setting used.
        framework: Framework identifier (``maf``, ``echo``).
        instructions_preview: First 120 chars of the agent's system
            prompt. Retained as an optional field for back-compat with
            existing tooling; not in the §5.3.5 example.
    """

    name: str = Field(..., description="Agent name")
    model: str = Field(default="", description="LLM model used")
    temperature: float | None = Field(default=None, description="Temperature used")
    framework: str | None = Field(default=None, description="Framework identifier")
    instructions_preview: str = Field(
        default="",
        description=(
            "First 120 chars of instructions (legacy diagnostic; absent from §5.3.5 wire example)."
        ),
    )


class ToolExecution(CamelCaseModel):
    """Record of a single tool invocation during the request.

    Wire shape per §5.3.2. Legacy kwargs ``result_preview`` and
    ``invoked_by`` are accepted at construction time (mapped to
    ``result_summary`` / dropped respectively) so the SK adapter
    continues to build trace entries without code churn.

    Attributes:
        tool_name: Name of the tool called.
        tool_call_id: Provider-issued tool-call id linking call/result events.
        tool_type: Discriminator for downstream consumers (UI statistics
            panel, analytics). ``"kb"`` for knowledge-base retrieval tools
            (``kb_retrieve`` and equivalents) that surface
            :attr:`kb_citations`; ``"toolset"`` for MCP / external tool
            calls that don't. ``None`` for adapters that haven't been
            taught to set it -- consumers should treat ``None`` as
            ``"toolset"`` since the KB path is the only currently-known
            citation-emitting flow.
        arguments: Arguments passed to the tool.
        result_summary: First N chars of the tool result (capped client-side).
        duration_ms: How long the tool call took.
        error: Error message when the tool call failed.
        kb_citations: KB citations expanded from this tool's result --
            populated whenever the tool itself emits them (see
            :class:`~agent_service_maf.tools.functions.FunctionToolResult`).
            ``None`` for tools that do not surface citations.
        invoked_by: (legacy) agent that invoked the tool. Retained for
            back-compat with existing SK adapter code; superseded by
            :attr:`AgentTraceStep.agent_name`.
    """

    tool_name: str = Field(..., description="Tool name")
    tool_call_id: str | None = Field(default=None, description="Provider tool-call id")
    tool_type: Literal["kb", "toolset"] | None = Field(
        default=None,
        description="Discriminator: 'kb' for KB retrieval tools, 'toolset' for MCP/external tools.",
    )
    arguments: dict[str, Any] = Field(default_factory=dict, description="Tool arguments")
    result_summary: str = Field(default="", description="First N chars of result")
    duration_ms: int | None = Field(default=None, description="Tool call duration in ms")
    tokens_used: int | None = Field(
        default=None,
        description=(
            "Approximate token count this tool's result will consume on the next LLM call. "
            "Surfaced for the UI Statistics panel's 'Context window usage' row; populated by "
            "KB tools today (rough chars/4 estimate). ``None`` when the tool doesn't know."
        ),
    )
    error: str | None = Field(default=None, description="Error message on failure")
    kb_citations: list[KbCitation] | None = Field(
        default=None,
        description=(
            "KB citations expanded from this tool's result (populated when the tool emits them)"
        ),
    )
    invoked_by: str = Field(
        default="",
        description="(legacy) Agent that called this tool",
    )

    @model_validator(mode="before")
    @classmethod
    def _accept_legacy_kwargs(cls, data: Any) -> Any:  # noqa: ANN401
        """Translate ``result_preview`` legacy kwarg to ``result_summary``."""
        if isinstance(data, dict) and "result_preview" in data and "result_summary" not in data:
            data = {**data, "result_summary": data.pop("result_preview")}
        return data


class AgentTraceStep(CamelCaseModel):
    """A single step in the multi-agent execution trace.

    Wire shape per §5.3.2. Legacy kwargs ``agent=`` (now ``agent_name``)
    and ``output_preview=`` (now ``output``) are accepted at construction
    time so the SK adapter continues to build trace steps without code
    churn.

    Attributes:
        step_index: Position of this step in the trace, 0-indexed.
        agent_name: Agent name that owns this step.
        action: What the agent did (``respond`` / ``route`` /
            ``tool_call`` / ``handoff``).
        output: Output text (or summary).
        tool_executions: Tools invoked by this agent in this step.
        timestamp: When the step was recorded (UTC).
        duration_ms: (legacy) Time this step took. Retained for back-compat.
        round: (legacy) Round number in the orchestration. Retained for back-compat.
    """

    step_index: int = Field(default=0, description="0-based position in the trace")
    agent_name: str = Field(default="", description="Agent name")
    action: str = Field(default="respond", description="Action type")
    input: str = Field(
        default="",
        description=(
            "Input text the agent received this step (the last user / "
            "manager / handoff message that triggered the response). Empty "
            "string when the input cannot be recovered from the event stream."
        ),
    )
    output: str = Field(default="", description="Step output text (or summary)")
    tool_executions: list[ToolExecution] = Field(
        default_factory=list,
        description="Tools invoked by this agent during this step",
    )
    timestamp: datetime = Field(
        default_factory=lambda: datetime.now(tz=UTC),
        description="When the step was recorded",
    )
    duration_ms: int | None = Field(default=None, description="(legacy) Step duration in ms")
    round: int | None = Field(default=None, description="(legacy) Orchestration round number")

    @model_validator(mode="before")
    @classmethod
    def _accept_legacy_kwargs(cls, data: Any) -> Any:  # noqa: ANN401
        """Translate ``agent`` / ``output_preview`` legacy kwargs."""
        if isinstance(data, dict):
            if "agent" in data and "agent_name" not in data:
                data = {**data, "agent_name": data.pop("agent")}
            if "output_preview" in data and "output" not in data:
                data = {**data, "output": data.pop("output_preview")}
        return data


class ContextUsed(CamelCaseModel):
    """Information about the conversation context provided to the agent.

    Wire shape per §5.3.2. ``history_preview`` is retained as an
    optional back-compat field; the new ``summary_used`` boolean lets
    the UI distinguish "raw history was passed" vs "summary buffer
    fired".

    Attributes:
        session_id: Session ID used for history lookup.
        history_messages_count: Number of history messages injected.
        summary_used: True when a summarization buffer rolled up the
            oldest history into a system message instead of passing
            raw turns.
        history_preview: (legacy) Last few messages from session history.
    """

    session_id: str | None = Field(default=None, description="Session ID")
    history_messages_count: int = Field(default=0, description="Number of history messages")
    summary_used: bool = Field(
        default=False,
        description="True when summary buffer collapsed old history",
    )
    history_preview: list[dict[str, str]] = Field(
        default_factory=list,
        description="(legacy) Preview of recent history messages",
    )


class RoutingInfo(CamelCaseModel):
    """Details about how the request was routed in triage orchestration.

    Wire shape per §5.3.2. Legacy ``selection_method`` / ``candidates``
    kwargs are accepted and stored on the new ``reason`` field when no
    explicit reason is supplied.

    Attributes:
        router_agent: Name of the router agent.
        selected_specialist: Name of the specialist chosen.
        reason: Human-readable explanation of why this specialist won.
        selection_method: (legacy) ``tool_call`` / ``text_parse`` /
            ``default`` -- which routing path fired.
        candidates: (legacy) List of available specialist names.
    """

    router_agent: str = Field(default="", description="Router agent name")
    selected_specialist: str = Field(default="", description="Selected specialist")
    reason: str | None = Field(default=None, description="Why this specialist was selected")
    selection_method: str = Field(default="", description="(legacy) Selection method")
    candidates: list[str] = Field(
        default_factory=list, description="(legacy) Available specialists"
    )


class PerformanceBreakdown(CamelCaseModel):
    """Time breakdown showing where the request duration was spent.

    Wire shape per §5.3.2.

    Attributes:
        total_duration_ms: Total wall-clock time for the invocation.
        llm_duration_ms: Time spent waiting for LLM gateway responses.
        tool_duration_ms: Aggregate time spent inside tool executions.
        framework_overhead_ms: Time spent on everything except LLM and
            tool calls (message serialization, guardrails, routing).
        llm_call_count: (legacy) Number of LLM roundtrips (1 for simple,
            2+ for tool use). Retained for back-compat.
    """

    total_duration_ms: int = Field(default=0, description="Total invocation time (ms)")
    llm_duration_ms: int = Field(default=0, description="Time in LLM gateway calls (ms)")
    tool_duration_ms: int | None = Field(default=None, description="Time in tool calls (ms)")
    framework_overhead_ms: int = Field(default=0, description="Non-LLM overhead (ms)")
    llm_call_count: int = Field(default=0, description="(legacy) Number of LLM roundtrips")


class Citations(CamelCaseModel):
    """Unified structured citations -- provenance + KB citations.

    Wire shape per §5.3.2 / §5.3.5. Combines MAF's agent-orchestration
    provenance (``responding_agent`` / ``routing`` / ``context_used`` /
    ``agent_trace`` / ``performance``) with the legacy KB-document
    citation list at the top (``kb_citations``) so the existing UI
    footer renders without changes.

    Attributes:
        responding_agent: The agent that produced the final output.
        routing: Routing details (populated for triage orchestration).
        context_used: Session history and context information.
        agent_trace: Step-by-step execution trace across agents. Each step
            includes the tools that specific agent invoked.
        performance: Time breakdown between LLM calls and framework overhead.
        kb_citations: Flat, deduplicated KB citations aggregated across
            the trace (see §5.3.4). Empty when no KB tool fired.
    """

    responding_agent: AgentCitationSource | None = Field(
        default=None,
        description="Agent that produced the response",
    )
    routing: RoutingInfo | None = Field(
        default=None,
        description="Routing details (triage only)",
    )
    context_used: ContextUsed | None = Field(
        default=None,
        description="Session context provided to the agent",
    )
    agent_trace: list[AgentTraceStep] = Field(
        default_factory=list,
        description="Multi-agent execution trace",
    )
    performance: PerformanceBreakdown | None = Field(
        default=None,
        description="LLM vs framework time breakdown",
    )
    kb_citations: list[KbCitation] = Field(
        default_factory=list,
        description="Flat, deduplicated KB citations (back-compat with legacy CitationItem[])",
    )


class AgentRequest(CamelCaseModel):
    """Universal agent invocation request.

    This model carries all data needed to invoke an agent. It is framework-agnostic
    and is forwarded as-is to the adapter.

    Attributes:
        agent_id: Identifier of the agent to invoke (must match a registered framework
            name or agent name in config). Validated as ``^[a-zA-Z0-9_-]{1,64}$``.
        input: The user prompt or task description.
        context: Additional runtime context. Allowed keys are:

            - ``backstory`` (str): Agent persona or background instructions.
            - ``conversation_history`` (list[dict]): Prior turns as
              ``[{"role": "user"|"assistant", "content": str}]``.
            - ``custom_settings`` (dict): Adapter-specific overrides not covered by
              ``config_overrides``.
            - ``tools_hint`` (list[str]): Suggested tool names the agent should prefer.
            - ``output_schema`` (dict): JSON Schema the agent's output should conform to.

            Unknown keys are accepted for forward-compatibility but may be ignored by
            adapters. Future phases may add allowlist enforcement.

        config_overrides: Per-request config overrides. These have the highest priority
            in the 3-tier merge (env → json → request). Cannot override locked fields
            (``agent.framework``, ``project_id``).
        session_id: Optional session identifier for conversation continuity. When set,
            the AgentService injects ``conversation_history`` from the session store.
        metadata: Passthrough metadata for tracing, logging, or downstream systems.
            Never passed to the LLM.

    Example:
        >>> req = AgentRequest(
        ...     agent_id="echo",
        ...     input="Hello, world!",
        ...     context={"backstory": "You are a helpful assistant."},
        ...     session_id="sess-001",
        ... )
    """

    agent_id: str = Field(..., description="Identifier of the agent to invoke")
    input: str = Field(..., description="The user prompt or task description")
    context: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Additional runtime context. Allowed keys: backstory, conversation_history, "
            "custom_settings, tools_hint, output_schema."
        ),
    )
    config_overrides: dict[str, Any] = Field(
        default_factory=dict,
        description="Per-request config overrides (highest priority in 3-tier merge)",
    )
    session_id: str | None = Field(
        default=None,
        description="Optional session ID for conversation continuity",
    )
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description="Passthrough metadata — never forwarded to the LLM",
    )


class AgentResponse(CamelCaseModel):
    """Universal agent invocation response.

    Wire shape per §5.2.2 / §5.4.2 / §5.5.2: one response model is
    returned by REST sync, SSE ``completed.metadata.invokeResponse``,
    and async ``TaskStatusResponse.result``. JSON output is camelCase
    via :class:`~agent_service_maf.interface_layer._base_model.CamelCaseModel`.

    Note that ``modelName`` is intentionally **not** a top-level field;
    the canonical location is ``citations.respondingAgent.model`` (§5.2.4).

    Attributes:
        agent_id: Identifier of the agent that produced this response.
        output: The agent's final text output.
        parsed_output: Structured parse of ``output`` when the request
            carried ``context.outputSchema`` and the LLM returned valid
            JSON (see §5.5.6 row 1). ``None`` otherwise; the raw text
            in ``output`` is still authoritative.
        artifacts: List of generated artifacts (files, structured outputs).
            Each artifact is a dict with at minimum ``type`` and ``content`` keys.
        usage: Token usage statistics. ``None`` if the adapter did not track usage.
        metadata: Response metadata (e.g., tool calls made, framework version).
        citations: Unified §5.3.2 :class:`Citations` envelope (provenance
            + ``kb_citations``). ``None`` for adapters that don't
            populate citations.
        duration_ms: Wall-clock execution time in milliseconds. Set by the executor
            after the adapter returns.
        memory_degraded: ``True`` when one or more session-store ops failed
            during the invocation. The agent still produced a valid output,
            but the conversation history was not loaded or persisted.
        session_id: Session id used for this turn. Always returned regardless
            of whether the client supplied one (§5.2.2).
        trace_id: Tracing id (Phoenix / OpenTelemetry). Populated when
            tracing is enabled.

    Example:
        >>> resp = AgentResponse(
        ...     agent_id="echo",
        ...     output="Echo: hello",
        ...     duration_ms=42,
        ... )
    """

    agent_id: str = Field(..., description="Identifier of the responding agent")
    output: str = Field(..., description="The agent's final text output")
    parsed_output: dict[str, Any] | None = Field(
        default=None,
        description="JSON-parsed output when context.outputSchema was provided",
    )
    artifacts: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Generated artifacts (files, structured outputs)",
    )
    usage: TokenUsage | None = Field(
        default=None,
        description="Token usage — None if the adapter did not track usage",
    )
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description="Response metadata (tool calls, framework version, etc.)",
    )
    citations: Citations | None = Field(
        default=None,
        description="Structured citations showing how the response was produced",
    )
    duration_ms: int = Field(
        default=0,
        ge=0,
        description="Wall-clock execution time in milliseconds",
    )
    memory_degraded: bool = Field(
        default=False,
        description=(
            "True when session-store ops failed during the invocation. "
            "The agent still produced output but history was not loaded/persisted."
        ),
    )
    session_id: str | None = Field(
        default=None,
        description="Session id used for this turn (echoed even when not supplied)",
    )
    trace_id: str | None = Field(
        default=None,
        description="Tracing id (Phoenix / OpenTelemetry); populated when tracing is enabled",
    )


# ---------------------------------------------------------------------------
# Streaming Events
# ---------------------------------------------------------------------------


class EventType(StrEnum):
    """Standard streaming event types emitted by agents.

    Used by both SSE and WebSocket transports. New event types can be registered
    at runtime without modifying this enum via :class:`EventTypeRegistry`.

    Values:
        STARTED: Agent has begun processing the request.
        THINKING: Agent is reasoning internally (no output token yet).
        TOKEN: A chunk of output text (streaming token).
        TOOL_CALL: Agent is invoking an MCP tool.
        TOOL_RESULT: An MCP tool returned a result.
        ARTIFACT: Agent produced a file or structured output.
        ERROR: An error occurred during processing.
        COMPLETED: Agent has finished processing.
        AGENT_STARTED: A participant agent began its turn in a multi-agent
            (team) orchestration. Metadata carries ``agentName`` and ``startedAt``.
        AGENT_COMPLETED: A participant agent finished its turn. Metadata carries
            ``agentName``, ``completedAt``, and ``durationMs``. Emitted once per
            turn; an agent that runs again (group_chat / handoff) gets a fresh
            AGENT_STARTED / AGENT_COMPLETED pair.
    """

    STARTED = "started"
    THINKING = "thinking"
    TOKEN = "token"
    TOOL_CALL = "tool_call"
    TOOL_RESULT = "tool_result"
    ARTIFACT = "artifact"
    ERROR = "error"
    # Per-participant lifecycle for multi-agent (team) orchestrations. These sit
    # between the invocation-level STARTED and COMPLETED envelopes: one
    # AGENT_STARTED..AGENT_COMPLETED pair per agent turn, so clients can show
    # which agent is running and when each begins/finishes.
    AGENT_STARTED = "agent_started"
    AGENT_COMPLETED = "agent_completed"
    COMPLETED = "completed"


class EventTypeRegistry:
    """Open/closed registry for streaming event types.

    Allows new event types to be registered at runtime without modifying the
    :class:`EventType` enum. This follows the Open/Closed Principle — the core
    set is fixed, but adapters can extend it.

    Class Attributes:
        _types: Set of all registered event type strings.

    Example:
        >>> EventTypeRegistry.register("custom_event")
        >>> EventTypeRegistry.validate("custom_event")
        True
        >>> EventTypeRegistry.validate("unknown")
        False
    """

    _types: set[str] = {e.value for e in EventType}

    @classmethod
    def register(cls, event_type: str) -> None:
        """Register a new event type string.

        Args:
            event_type: The event type identifier to register. Should be lowercase
                with underscores (e.g., ``"my_custom_event"``).

        Raises:
            ValueError: If ``event_type`` is empty or already registered.

        Example:
            >>> EventTypeRegistry.register("file_written")
        """
        if not event_type:
            raise ValueError(
                "event_type must be a non-empty string. "
                "Provide a lowercase identifier like 'my_custom_event'."
            )
        cls._types.add(event_type)

    @classmethod
    def validate(cls, event_type: str) -> bool:
        """Check whether an event type is registered.

        Args:
            event_type: The event type string to check.

        Returns:
            True if the event type is registered, False otherwise.
        """
        return event_type in cls._types

    @classmethod
    def list_types(cls) -> list[str]:
        """Return all currently registered event type strings.

        Returns:
            Sorted list of registered event type strings.
        """
        return sorted(cls._types)


class AgentEvent(CamelCaseModel):
    """A single streaming event emitted by an agent during execution.

    Both SSE and WebSocket transports carry events in this format.

    Attributes:
        event_type: The type of event. Must be a value from :class:`EventType`
            or a custom type registered via :class:`EventTypeRegistry`.
        data: The event payload as a string. For TOKEN events this is the text
            chunk. For ERROR events this is the error message. May be empty.
        metadata: Event-specific metadata (e.g., tool name for TOOL_CALL events).
        timestamp: UTC timestamp when the event was created. Auto-populated.

    Example:
        >>> evt = AgentEvent(event_type=EventType.TOKEN, data="Hello")
        >>> evt.timestamp is not None
        True
    """

    event_type: EventType = Field(..., description="The type of streaming event")
    data: str = Field(default="", description="Event payload (text chunk, error message, etc.)")
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description="Event-specific metadata (tool name, error type, etc.)",
    )
    timestamp: datetime = Field(
        default_factory=lambda: datetime.now(tz=UTC),
        description="UTC timestamp when the event was created",
    )


# ---------------------------------------------------------------------------
# Capabilities
# ---------------------------------------------------------------------------


class AgentCapabilities(CamelCaseModel):
    """Self-description of what an agent adapter can do.

    Returned by :meth:`AgentCapabilityProvider.get_capabilities` and used by
    the discovery endpoints (``GET /agents``, ``GET /agents/{id}/capabilities``).

    Attributes:
        agent_id: Stable identifier for this agent (must match FrameworkRegistry key).
        framework: Underlying framework name (e.g., ``"maf"``, ``"echo"``).
        supports_streaming: Whether this agent supports SSE/WebSocket streaming.
        supported_protocols: List of transport protocols supported
            (``"rest"``, ``"sse"``, ``"websocket"``).
        available_tools: List of tool names this agent can use. May be empty if
            tools are resolved at runtime from MCP.
        description: Human-readable description of the agent's purpose.
        version: Semantic version string for the adapter implementation.

    Example:
        >>> caps = AgentCapabilities(
        ...     agent_id="echo",
        ...     framework="example",
        ...     supports_streaming=True,
        ...     description="Echo agent for testing",
        ... )
    """

    agent_id: str = Field(..., description="Stable agent identifier")
    framework: str = Field(..., description="Underlying framework (maf, echo, etc.)")
    supports_streaming: bool = Field(default=True, description="Supports SSE/WebSocket streaming")
    supported_protocols: list[str] = Field(
        default_factory=lambda: ["rest", "sse", "websocket"],
        description="Supported transport protocols",
    )
    available_tools: list[str] = Field(
        default_factory=list,
        description="Available tool names (may be empty if resolved at runtime)",
    )
    description: str = Field(default="", description="Human-readable agent description")
    version: str = Field(default="1.0.0", description="Adapter semantic version")


# ---------------------------------------------------------------------------
# Segregated Abstract Interfaces (ISP)
# ---------------------------------------------------------------------------


class AgentInvoker(ABC):
    """Abstract interface for agent invocation methods.

    Clients that only need to call agents (e.g., the executor) should depend on
    this interface, not on the full :class:`AgentInterface`.

    All methods are async to support both blocking and non-blocking adapters.
    """

    @abstractmethod
    async def invoke(
        self,
        request: AgentRequest,
        context: AgentExecutionContext,
    ) -> AgentResponse:
        """Execute a synchronous agent invocation.

        Processes the request and returns a complete response. The executor
        measures wall-clock time and sets ``response.duration_ms`` after this
        method returns.

        Args:
            request: The invocation request including input, context, and overrides.
            context: Runtime dependencies (config, gateway, MCP registry, etc.).

        Returns:
            Complete :class:`AgentResponse` with output, artifacts, and usage.

        Raises:
            AgentInvocationError: If the adapter encounters an unrecoverable error.
                Should wrap any framework-specific exceptions.

        Example:
            >>> response = await agent.invoke(request, context)
            >>> print(response.output)
        """
        ...

    @abstractmethod
    def stream(
        self,
        request: AgentRequest,
        context: AgentExecutionContext,
    ) -> AsyncIterator[AgentEvent]:
        """Execute a streaming agent invocation.

        Implementations should be defined as ``async def`` (async generator) which
        yields AgentEvent objects directly. Using ``yield`` inside an ``async def``
        makes it an async generator, which is an ``AsyncIterator``.

        Yields events as the agent processes the request. The caller is responsible
        for sending STARTED and COMPLETED sentinel events around the adapter's stream.

        Cancellation: If the caller cancels the async iteration (e.g., client
        disconnects), this method must clean up any in-flight LLM or tool calls
        and release resources.

        Args:
            request: The invocation request.
            context: Runtime dependencies.

        Yields:
            :class:`AgentEvent` instances in chronological order. Must end with a
            COMPLETED or ERROR event.

        Raises:
            AgentInvocationError: If the adapter cannot start streaming.

        Example:
            >>> async for event in agent.stream(request, context):
            ...     print(event.event_type, event.data)
        """
        ...


class AgentLifecycle(ABC):
    """Abstract interface for agent lifecycle management.

    Components that manage agent startup/shutdown (e.g., the app lifespan) should
    depend on this interface.
    """

    @abstractmethod
    async def initialize(self, context: AgentExecutionContext) -> None:
        """Initialize the agent with its execution context.

        Called once before the first invocation. Adapters should use this to:
        - Store the context for later access.
        - Load framework-specific resources (kernels, graphs, etc.).
        - Pre-warm connections if needed.

        Args:
            context: Runtime dependencies (config, gateway, MCP registry).

        Raises:
            AgentInvocationError: If initialization fails and the agent cannot
                proceed. Must clean up any partially initialized state.

        Example:
            >>> await agent.initialize(context)
        """
        ...

    @abstractmethod
    async def shutdown(self) -> None:
        """Gracefully shut down the agent and release all resources.

        Called when the agent will no longer be used. Adapters should:
        - Cancel any in-flight requests.
        - Close open connections.
        - Clear stored context to prevent memory leaks.

        This method must not raise exceptions. Errors should be logged and swallowed.

        Example:
            >>> await agent.shutdown()
        """
        ...


class AgentCapabilityProvider(ABC):
    """Abstract interface for agent self-description.

    Discovery endpoints depend on this interface to list available agents and
    their capabilities without needing to invoke them.
    """

    @abstractmethod
    def get_capabilities(self) -> AgentCapabilities:
        """Return this agent's capabilities and metadata.

        This method must be callable before :meth:`AgentLifecycle.initialize` is
        called (i.e., it must not require context). It should return a static
        description of what the adapter supports.

        Returns:
            :class:`AgentCapabilities` describing the agent's protocols, tools,
            and framework.

        Example:
            >>> caps = agent.get_capabilities()
            >>> print(caps.framework)
            'maf'
        """
        ...


class AgentInterface(AgentInvoker, AgentLifecycle, AgentCapabilityProvider, ABC):
    """Combined abstract interface that all agent adapters must implement.

    Combines :class:`AgentInvoker`, :class:`AgentLifecycle`, and
    :class:`AgentCapabilityProvider` into a single base class for adapters.

    Adapters subclass :class:`~agent_service_maf.framework.base_agent.BaseAgent`
    (which extends this class) rather than implementing this directly.

    Callers that only need one capability should depend on the appropriate
    segregated interface rather than this combined one.

    Example:
        >>> class MyAdapter(BaseAgent):
        ...     async def invoke(self, request, context): ...
        ...     async def stream(self, request, context): ...
        ...     def get_capabilities(self): ...
    """

    pass
