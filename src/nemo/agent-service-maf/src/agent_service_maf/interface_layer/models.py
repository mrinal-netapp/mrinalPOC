"""Pydantic models for the HTTP API layer.

These models define the wire format for REST, SSE, and WebSocket endpoints.
Every wire-facing model inherits from
:class:`~agent_service_maf.interface_layer._base_model.CamelCaseModel` so the
Python attribute names stay snake_case (PEP 8) while JSON serialization
emits camelCase (§5.2 of the migration plan).

Route handlers convert between API models and core models using the
``from_agent_response()`` class method pattern.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal

import structlog
from pydantic import BaseModel, ConfigDict, Field, model_validator

from agent_service_maf.core._base_model import CamelCaseModel
from agent_service_maf.core.interfaces import (
    AgentCapabilities,
    AgentResponse,
    Citations,
    TokenUsage,
    ToolExecution,
)
from agent_service_maf.core.session import ConversationMessage, SessionSummary
from agent_service_maf.core.task_models import TaskStatus

if TYPE_CHECKING:
    from agent_service_maf.core.task_models import Task

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Per-request config-override sub-models
# ---------------------------------------------------------------------------


class AgentConfigOverride(CamelCaseModel):
    """Per-agent override block, keyed under
    ``configOverrides.agentOverrides`` in the request body.

    Used by multi-agent team invokes to override a single member's
    LLM settings without touching the team manager. Unknown agent
    names in the parent ``agentOverrides`` map are silently ignored
    (§5.1.4); unknown fields here are silently dropped via
    ``extra="ignore"`` (§5.1.1 loose-validation lock-in).

    Attributes:
        model: Override model id for this agent.
        temperature: Override sampling temperature (validated 0..2).
        max_tokens: Override max output tokens (validated 1..200_000).
    """

    model_config = ConfigDict(
        extra="ignore",
        populate_by_name=True,
        alias_generator=CamelCaseModel.model_config["alias_generator"],
    )

    model: str | None = Field(default=None, description="Per-agent model override")
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, ge=1, le=200_000)


class ConfigOverrides(CamelCaseModel):
    """Per-request overrides for selected agent config fields.

    Conservative allowlist + loose validation per §5.1.1: known fields
    are still Pydantic-range-validated, unknown fields are silently
    dropped at parse time and emit a DEBUG ``config_override_ignored``
    log line. Locked fields (``agent.framework``, ``project_id``) are
    not exposed here and cannot appear -- defense-in-depth still lives
    in the ConfigLoader.

    Attributes:
        model: Top-level model override. Applies to the responding agent
            in single-agent invokes or the team manager in team invokes.
        temperature: Top-level sampling temperature.
        max_tokens: Top-level output-token cap.
        agent_overrides: Per-agent overrides keyed by agent name
            (matches ``semantic_kernel.agents[].name`` in the team
            config). Unknown names are silently ignored. In single-agent
            invokes this map is silently ignored.
    """

    model_config = ConfigDict(
        extra="ignore",
        populate_by_name=True,
        alias_generator=CamelCaseModel.model_config["alias_generator"],
    )

    model: str | None = Field(default=None, description="Top-level model override")
    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, ge=1, le=200_000)
    agent_overrides: dict[str, AgentConfigOverride] | None = Field(
        default=None,
        description="Per-agent overrides keyed by agent name (team invokes only)",
    )

    @model_validator(mode="before")
    @classmethod
    def _log_ignored_keys(cls, data: Any) -> Any:  # noqa: ANN401
        """Emit a DEBUG ``config_override_ignored`` line per unknown key.

        Visibility-only -- the wire behaviour (``extra="ignore"``) is
        unchanged. Catches typos like ``maxToken`` while keeping the
        contract forward-compatible.
        """
        if isinstance(data, dict):
            known = {
                "model",
                "temperature",
                "max_tokens",
                "maxTokens",
                "agent_overrides",
                "agentOverrides",
            }
            for key in list(data.keys()):
                if key not in known:
                    logger.debug("config_override_ignored", field=key)
        return data


class AttachmentItem(CamelCaseModel):
    """A single base64-encoded attachment carried on
    :class:`InvokeRequest.attachments`.

    Wire shape per §5.1.2. Counts and sizes enforced by
    :mod:`agent_service_maf.interface_layer._attachments` before the
    request enters the adapter (5 attachments / 5 MB per item caps,
    mirroring the legacy ``_validate_attachments`` in
    ``src/nemo/agent-service/src/main.py:1453``).

    Attributes:
        filename: Display name shown in the agent prompt / UI.
        mime_type: MIME type (``application/pdf``, ``image/png``, ...).
        content: Base64-encoded raw bytes.
    """

    filename: str = Field(..., description="Attachment display name")
    mime_type: str = Field(..., description="MIME type")
    content: str = Field(..., description="Base64-encoded raw bytes")


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------


class InvokeRequest(CamelCaseModel):
    """Request body for REST sync, SSE stream, async submit, and WS frames.

    Wire shape per §5.1.2. ``input`` replaces the legacy ``message``
    field; the legacy top-level ``modelId`` field is dropped (use
    ``configOverrides.model`` instead).

    Attributes:
        input: The user prompt or task description sent to the agent.
        session_id: Optional session id for conversation continuity.
            When provided, the AgentService injects conversation history
            from the session store.
        context: Additional runtime context. Allowed keys (loose --
            unknown keys ignored):

            - ``backstory`` (str): Agent persona / background.
            - ``conversationHistory`` (list[dict]): Prior conversation turns.
            - ``customSettings`` (dict): Adapter-specific settings.
            - ``toolsHint`` (list[str]): Preferred tool names.
            - ``outputSchema`` (dict): JSON Schema for the expected output.
              When set, the response includes ``parsedOutput`` on success.

        attachments: Optional list of base64-encoded attachments. Capped
            at 5 items / 5 MB each (see :mod:`._attachments`).
        config_overrides: Per-request overrides for selected agent
            config fields (typed, allowlist of 3 + ``agentOverrides``).
            Unknown fields silently ignored.
        metadata: Passthrough metadata for tracing/logging. **Never**
            forwarded to the LLM.

    Example:
        >>> body = InvokeRequest(
        ...     input="Summarize this document.",
        ...     context={"backstory": "You are a concise summarizer."},
        ...     session_id="sess-abc123",
        ... )
    """

    input: str = Field(..., description="The user prompt or task description")
    session_id: str | None = Field(
        default=None,
        description="Optional session id for conversation continuity",
    )
    context: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Additional runtime context. Allowed keys: backstory, "
            "conversationHistory, customSettings, toolsHint, outputSchema."
        ),
    )
    attachments: list[AttachmentItem] | None = Field(
        default=None,
        description="Optional base64-encoded attachments (5 × 5 MB caps)",
    )
    config_overrides: ConfigOverrides | None = Field(
        default=None,
        description="Per-request config overrides (typed allowlist)",
    )
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description="Passthrough metadata — never forwarded to the LLM",
    )


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------


class InvokeResponse(CamelCaseModel):
    """Response body for ``POST .../invoke``.

    One model is returned by REST sync, SSE ``completed.metadata.invokeResponse``,
    and async ``TaskStatusResponse.result`` (§5.2.2 / §5.4.2 / §5.5.2).
    Wire form is camelCase.

    ``modelName`` is intentionally **not** a top-level field; the
    canonical location is ``citations.respondingAgent.model``.

    Attributes:
        agent_id: Identifier of the responding agent.
        output: The agent's final text output.
        parsed_output: JSON-parsed output when the request carried
            ``context.outputSchema`` and the LLM returned parseable
            JSON. ``None`` otherwise.
        artifacts: Generated artifacts (files, structured outputs).
        usage: Token usage statistics, or ``None`` when the adapter did
            not track usage.
        metadata: Response metadata (tool calls made, framework version, etc.).
        citations: Unified :class:`Citations` envelope (§5.3).
        duration_ms: Wall-clock execution time in milliseconds.
        memory_degraded: ``True`` when one or more session-store ops
            failed during the invocation.
        session_id: Session id used for the turn. Echoed regardless of
            whether the client supplied one.
        trace_id: Tracing id (Phoenix / OpenTelemetry).

    Example:
        >>> resp = InvokeResponse.from_agent_response(agent_response)
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
    usage: dict[str, Any] | None = Field(
        default=None,
        description="Token usage statistics — None if not tracked",
    )
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description="Response metadata",
    )
    citations: Citations | None = Field(
        default=None,
        description="Structured citations showing how the response was produced",
    )
    duration_ms: int = Field(default=0, ge=0, description="Execution time in milliseconds")
    memory_degraded: bool = Field(
        default=False,
        description=(
            "True when one or more session-store ops failed during the "
            "invocation. The agent ran with empty / partial history; the "
            "response is otherwise valid. Clients may surface this as "
            "'history not loaded — please retry'."
        ),
    )
    session_id: str | None = Field(
        default=None,
        description="Session id used for the turn (echoed even when not supplied)",
    )
    trace_id: str | None = Field(
        default=None,
        description="Tracing id (Phoenix / OpenTelemetry); populated when tracing is enabled",
    )

    @classmethod
    def from_agent_response(
        cls,
        response: AgentResponse,
        *,
        session_id: str | None = None,
    ) -> InvokeResponse:
        """Convert a core :class:`~agent_service_maf.core.interfaces.AgentResponse`
        to an API response model.

        Args:
            response: The domain response from the agent adapter.
            session_id: Optional explicit session id to echo back to the
                client. Overrides ``response.session_id`` when provided.
                Used by the route handler to return the raw caller-facing
                form (pre-scope) rather than the storage key.

        Returns:
            :class:`InvokeResponse` ready for JSON serialization.

        Example:
            >>> api_resp = InvokeResponse.from_agent_response(agent_response)
            >>> api_resp.duration_ms
            42
        """
        return cls(
            agent_id=response.agent_id,
            output=response.output,
            parsed_output=response.parsed_output,
            artifacts=response.artifacts,
            usage=response.usage.model_dump(by_alias=True) if response.usage else None,
            metadata=response.metadata,
            citations=response.citations,
            duration_ms=response.duration_ms,
            memory_degraded=response.memory_degraded,
            session_id=session_id if session_id is not None else response.session_id,
            trace_id=response.trace_id,
        )


class ErrorResponse(BaseModel):
    """Structured error response body.

    Returned by exception handlers for all ``AgentFrameworkError`` subclasses.
    Internal details (stack traces, file paths, API keys) are scrubbed by
    :class:`~agent_service_maf.interface_layer.error_formatter.SafeErrorFormatter`
    before populating this model.

    Attributes:
        error: Human-readable error message safe for external consumption.
        error_type: The exception class name (e.g., ``"FrameworkNotFoundError"``).
        details: Sanitized debugging details. In production mode this is empty or
            contains only safe metadata (correlation_id, agent_id). In dev mode
            this may include a redacted stack trace.
        correlation_id: The request's correlation ID for log correlation. Populated
            from ``context.correlation_id`` when available.

    Example:
        >>> err = ErrorResponse(
        ...     error="Framework 'unknown' is not registered.",
        ...     error_type="FrameworkNotFoundError",
        ...     correlation_id="550e8400-e29b-41d4-a716-446655440000",
        ... )
    """

    error: str = Field(..., description="Human-readable error message")
    error_type: str = Field(..., description="Exception class name")
    details: dict[str, Any] = Field(
        default_factory=dict,
        description="Sanitized debugging details (empty in production mode)",
    )
    correlation_id: str = Field(
        default="",
        description="Request correlation ID for log tracing",
    )


class AgentListResponse(CamelCaseModel):
    """Response body for ``GET /agents``.

    Lists all registered agent framework adapters with their capabilities.

    Attributes:
        agents: List of capability descriptors for all registered adapters.
        total: Total number of registered adapters (convenience field for clients).

    Example:
        >>> resp = AgentListResponse(agents=[echo_caps, sk_caps], total=2)
    """

    agents: list[AgentCapabilities] = Field(
        default_factory=list,
        description="Capability descriptors for all registered adapters",
    )
    total: int = Field(default=0, ge=0, description="Total number of registered adapters")


class HealthResponse(CamelCaseModel):
    """Response body for ``GET /health``.

    Liveness probe -- always returns 200 when the process is alive.
    Readiness checks live at ``GET /ready`` (see §5.8).

    Attributes:
        status: Always ``"ok"`` per §5.8.2 wire example.
        version: Service version string from ``pyproject.toml``.
        uptime_seconds: Seconds since the server started.
    """

    status: str = Field(default="ok", description="Liveness status")
    version: str = Field(default="", description="Service version string")
    uptime_seconds: float = Field(
        default=0.0,
        ge=0.0,
        description="Seconds since server startup",
    )


class ReadinessResponse(CamelCaseModel):
    """Response body for ``GET /ready`` (§5.8.2).

    200 means every readiness check passed. 503 means at least one
    check failed; ``reason`` carries the first failing check's enum
    value so dashboards can branch.

    Attributes:
        status: ``"ready"`` (200) or ``"not_ready"`` (503).
        reason: First failing check, when ``status == "not_ready"``.
            One of ``startup_in_progress`` / ``no_healthy_teams`` /
            ``mcp_connect_failed`` / ``redis_unreachable``.
        teams: List of healthy team ids (informational).
        redis: ``"ok"`` / ``"unreachable"`` / ``"disabled"``.
        uptime: Seconds since server start.
        details: Free-form per-check details for debugging.
    """

    status: Literal["ready", "not_ready"] = Field(..., description="Overall readiness state")
    reason: str = Field(default="", description="First failing check on 503")
    teams: list[str] = Field(default_factory=list, description="Healthy team ids")
    redis: str = Field(default="disabled", description="Redis backend status")
    uptime: float = Field(default=0.0, ge=0.0, description="Seconds since server startup")
    details: dict[str, Any] = Field(
        default_factory=dict,
        description="Free-form per-check diagnostic details",
    )


# ---------------------------------------------------------------------------
# Chat Protocol Models (session-aware conversational interface)
# ---------------------------------------------------------------------------


class ChatMessageModel(CamelCaseModel):
    """A single message in a conversation (API representation).

    Attributes:
        role: Message sender role — ``"user"`` or ``"assistant"``.
        content: Message text content.
        timestamp: Unix timestamp when the message was created. Optional.
        metadata: Additional message metadata (e.g., token counts, agent version).
    """

    role: str = Field(..., description="Message role: 'user' or 'assistant'")
    content: str = Field(..., description="Message text content")
    timestamp: float | None = Field(default=None, description="Unix timestamp")
    metadata: dict[str, Any] = Field(default_factory=dict, description="Message metadata")


class ChatRequest(CamelCaseModel):
    """Request body for the chat protocol ``POST /chat/{agent_id}/message``.

    The chat protocol automatically manages session memory — conversation history
    is retrieved and injected into the agent context by the AgentService.

    Wire-shape parity (§5.1.2 / migration plan §A3): this request mirrors
    :class:`InvokeRequest` for the user-facing field that carries the
    prompt. The canonical field is ``input``; the legacy ``message`` field
    is no longer accepted (clients should migrate). Field shape was
    aligned so a single bruno / SDK body works against both the
    ``/invoke`` and ``/chat`` endpoints.

    Attributes:
        input: The user's prompt or task description. Replaces the
            legacy ``message`` field per migration plan §A3.
        session_id: Optional session ID for conversation continuity.
            When provided, the AgentService injects the matching session
            history. When omitted, the AgentService runs the turn
            without history (and the response echoes a generated id so
            the client can continue the conversation if it wants to).
        config_overrides: Per-request config overrides (highest merge priority).
        metadata: Passthrough metadata for tracing/logging.
    """

    input: str = Field(..., description="The user's prompt or task description")
    session_id: str | None = Field(
        default=None,
        description="Optional session id for conversation continuity",
    )
    config_overrides: dict[str, Any] = Field(
        default_factory=dict,
        description="Per-request config overrides",
    )
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description="Passthrough metadata",
    )


class ChatResponse(CamelCaseModel):
    """Response body for ``POST /chat/{agent_id}/message``.

    Attributes:
        agent_id: Identifier of the responding agent.
        session_id: The session ID (echoed from the request for client convenience).
        message: The assistant's response as a :class:`ChatMessageModel`.
        usage: Token usage as a plain dict, or ``None`` if not tracked.
        duration_ms: Wall-clock execution time in milliseconds.
    """

    agent_id: str = Field(..., description="Identifier of the responding agent")
    session_id: str = Field(..., description="Session ID")
    message: ChatMessageModel = Field(..., description="The assistant's response message")
    usage: dict[str, Any] | None = Field(default=None, description="Token usage or None")
    duration_ms: int = Field(default=0, ge=0, description="Execution time in milliseconds")

    @classmethod
    def from_agent_response(cls, response: AgentResponse, session_id: str) -> ChatResponse:
        """Convert a core :class:`~agent_service_maf.core.interfaces.AgentResponse`
        to a chat response model.

        Args:
            response: The domain response from the agent adapter.
            session_id: The session ID to echo in the response.

        Returns:
            :class:`ChatResponse` ready for JSON serialization.
        """
        return cls(
            agent_id=response.agent_id,
            session_id=session_id,
            message=ChatMessageModel(
                role="assistant",
                content=response.output,
                metadata=response.metadata,
            ),
            usage=response.usage.model_dump(by_alias=True) if response.usage else None,
            duration_ms=response.duration_ms,
        )


class ChatHistoryResponse(CamelCaseModel):
    """Response body for ``GET /chat/{agent_id}/history``.

    Attributes:
        session_id: The session whose history is returned.
        messages: Ordered list of conversation messages (oldest first).
        total: Total number of messages in the session.
    """

    session_id: str = Field(..., description="Session ID")
    messages: list[ChatMessageModel] = Field(
        default_factory=list,
        description="Ordered conversation messages (oldest first)",
    )
    total: int = Field(default=0, ge=0, description="Total number of messages")


# ---------------------------------------------------------------------------
# Async invoke models
# ---------------------------------------------------------------------------


class AsyncInvokeResponse(CamelCaseModel):
    """Response to ``POST .../invoke/async``.

    Returned immediately after the task is persisted as ``running``. The
    client polls ``GET .../tasks/{task_id}`` until the status reaches a
    terminal value.

    Attributes:
        task_id: UUID4 to use for polling.
        status: Always ``"running"`` at submission time.
    """

    task_id: str = Field(..., description="UUID4 to use for polling")
    status: Literal["running"] = Field(
        default="running",
        description="Always 'running' at submission time",
    )


class TaskStatusResponse(CamelCaseModel):
    """Response to ``GET .../tasks/{task_id}`` (§5.5.2).

    ``result`` is populated only when ``status == "completed"`` and is
    a typed :class:`InvokeResponse` so REST sync, SSE
    ``completed.metadata.invokeResponse``, and async polling share one
    contract. ``error`` and ``error_type`` are populated when
    ``status in {"failed", "cancelled"}``.

    Attributes:
        task_id: The task identifier.
        status: :class:`~agent_service_maf.core.task_models.TaskStatus`
            StrEnum -- ``running`` / ``completed`` / ``failed`` /
            ``cancelled``.
        project_id: Project the task was submitted under.
        team_id: Team that ran the work (may be the project's default).
        agent_id: Agent that ran the work (``"orchestrator"`` for team-level
            invokes).
        correlation_id: UUID4 used in logs and traces for this task.
        created_at: Submission time (POSIX epoch seconds).
        updated_at: Last status change.
        duration_ms: Total run time once terminal.
        result: Typed :class:`InvokeResponse` when ``status == "completed"``.
        error: Human-readable error message (no legacy ``[stage]`` prefix
            per §5.5.6 row "Step-prefix breadcrumb").
        error_type: Exception class name when ``status == "failed"``.
    """

    task_id: str
    status: TaskStatus
    project_id: str = ""
    team_id: str = ""
    agent_id: str = ""
    correlation_id: str = ""
    created_at: float = 0.0
    updated_at: float = 0.0
    duration_ms: int = 0
    result: InvokeResponse | None = None
    error: str = ""
    error_type: str = ""

    @classmethod
    def from_task(cls, task: Task) -> TaskStatusResponse:
        """Convert a domain :class:`~agent_service_maf.core.task_models.Task`
        to an API response model.

        ``task.result`` is stored as a free dict on the persisted Task
        (to keep storage format stable across schema evolutions); this
        method re-validates it into :class:`InvokeResponse` on the way
        out. A persisted task that pre-dates this schema (i.e. carries
        legacy snake_case keys) round-trips cleanly thanks to
        ``populate_by_name=True``.
        """
        result_model: InvokeResponse | None = None
        if task.result is not None:
            try:
                result_model = InvokeResponse.model_validate(task.result)
            except Exception:  # noqa: BLE001
                # Tolerate legacy / partial payloads -- a malformed result
                # shouldn't 500 a poll. Surface as None and keep status.
                logger.warning(
                    "task_result_validation_failed",
                    task_id=task.task_id,
                    keys=list(task.result.keys()) if isinstance(task.result, dict) else "?",
                )
                result_model = None
        return cls(
            task_id=task.task_id,
            status=task.status,
            project_id=task.project_id,
            team_id=task.team_id,
            agent_id=task.agent_id,
            correlation_id=task.correlation_id,
            created_at=task.created_at,
            updated_at=task.updated_at,
            duration_ms=task.duration_ms,
            result=result_model,
            error=task.error,
            error_type=task.error_type,
        )


# ---------------------------------------------------------------------------
# Session HTTP CRUD models (Phase 2)
# ---------------------------------------------------------------------------


class AssistantMessageMetadata(CamelCaseModel):
    """Typed per-message metadata stored on past assistant messages.

    Wire shape per §5.6.2. Mirrors the relevant slice of
    :class:`InvokeResponse` so past-turn rendering matches live SSE
    ``completed`` rendering one-for-one. Attached to assistant
    messages only -- user / system messages omit this block.

    Attributes:
        duration_ms: Wall-clock time of the turn that produced this message.
        usage: Per-turn token usage.
        citations: Full §5.3 :class:`Citations` envelope (provenance +
            ``kb_citations``).
        trace_id: Tracing id for the turn.
        tool_calls: Denormalized tool executions from the turn, in call
            order. Same shape as :class:`ToolExecution`.
        parsed_output: Structured output when ``context.outputSchema``
            was provided.
        memory_degraded: ``True`` when the turn ran with degraded
            session-store state.
    """

    duration_ms: int | None = Field(default=None, description="Per-turn wall-clock time")
    usage: TokenUsage | None = Field(default=None, description="Per-turn token usage")
    citations: Citations | None = Field(default=None, description="Full §5.3 Citations envelope")
    trace_id: str | None = Field(default=None, description="Tracing id")
    tool_calls: list[ToolExecution] | None = Field(
        default=None,
        description="Denormalized tool executions from the turn",
    )
    parsed_output: dict[str, Any] | None = Field(
        default=None,
        description="JSON-parsed output (when outputSchema was set)",
    )
    memory_degraded: bool = Field(
        default=False,
        description="True when the turn ran with degraded session state",
    )


class SessionListResponse(CamelCaseModel):
    """Response body for ``GET /sessions`` (team or agent scope).

    Wire shape per §5.6.2.

    Attributes:
        scope: ``"team"`` or ``"agent"`` -- mirrors the URL hierarchy
            that produced the list.
        project_id: Project that owns the listed sessions.
        anchor: ``team_id`` when scope=team, ``agent_id`` otherwise.
        user_id: Authenticated caller's id. Empty in dev mode.
        sessions: Newest-first list of summaries.
        total: Convenience count.
        memory_degraded: True when one or more store ops failed during
            this list operation. Same contract as
            :attr:`InvokeResponse.memory_degraded`.
    """

    scope: Literal["team", "agent"]
    project_id: str
    anchor: str
    user_id: str = ""
    sessions: list[SessionSummary] = Field(default_factory=list)
    total: int = 0
    memory_degraded: bool = False


class SessionDetailResponse(CamelCaseModel):
    """Response body for ``GET /sessions/{session_id}`` (§5.6.3).

    Returns the full transcript. Callers that want only the summary
    should use the listing endpoint and avoid the round-trip on the
    message blob.
    """

    scope: Literal["team", "agent"]
    project_id: str
    anchor: str
    user_id: str = ""
    session_id: str
    name: str = ""
    created_at: float = 0.0
    last_accessed: float = 0.0
    token_count: int = 0
    messages: list[ConversationMessage] = Field(default_factory=list)
    memory_degraded: bool = False


class SessionRenameRequest(CamelCaseModel):
    """Request body for ``PATCH .../sessions/{session_id}`` (§5.9.2).

    The legacy verb ``POST .../rename`` has been replaced by ``PATCH``
    on the session resource per §5.9 -- partial update is exactly what
    PATCH is for.

    Attributes:
        name: New friendly name. Stripped of surrounding whitespace by
            the route handler. Empty / whitespace-only inputs are
            rejected with HTTP 400.
    """

    name: str = Field(..., min_length=1, max_length=200)
