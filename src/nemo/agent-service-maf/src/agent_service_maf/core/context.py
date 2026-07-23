"""Agent execution context — dependency injection container for agent invocations.

The :class:`AgentExecutionContext` is the single object passed to every agent adapter
during invocation. It carries all runtime dependencies (config, gateway, MCP registry,
guardrails) without performing any logic itself.

Per the Single Responsibility Principle, this class is a pure DI container.
Config-resolution helpers (``get_model``, ``get_temperature``, etc.) are intentionally
*not* on this class — see the ``ConfigAccessor`` in Phase 2 for that concern.

The ``correlation_id`` field is validated as UUID4 on construction. If the caller
provides an empty string, a new UUID4 is auto-generated.

Phase note:
    ``gateway`` and ``mcp_registry`` are ``None`` in Phase 1 because those
    infrastructure components are implemented in Phase 2 (gateway) and Phase 5
    (MCP). Route handlers and adapters that require these must guard with
    ``if context.gateway is not None`` until those phases are wired in.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from agent_service_maf.config.validators import AgentConfig, ToolPolicy
    from agent_service_maf.core.identity import IdentityContext
    from agent_service_maf.core.session import SessionManager
    from agent_service_maf.gateway.llm_gateway import LLMGateway
    from agent_service_maf.guardrails.pipeline import GuardrailPipeline
    from agent_service_maf.mcp.mcp_registry import MCPRegistry

# UUID4 pattern: 8-4-4-4-12 hex digits, version 4 marker, variant bits
_UUID4_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


@dataclass
class AgentExecutionContext:
    """Runtime dependency container for a single agent invocation.

    This dataclass is instantiated by the routes or AgentService for each incoming
    request and passed through the executor to the adapter. It provides access to
    all shared infrastructure without coupling adapters to global state.

    This class is a DI container only. It does NOT perform config resolution or
    validation — those concerns belong to ``ConfigAccessor`` (Phase 2) and the
    ``ConfigLoader`` respectively.

    Attributes:
        config: The fully merged and validated ``AgentConfig`` for this request.
            Includes env var tier, JSON config tier, and request override tier.
        gateway: The LLM gateway for sending completions to the LiteLLM proxy.
            Shared across requests — do not mutate it. ``None`` in Phase 1
            (implemented in Phase 2).
        mcp_registry: Registry of connected MCP server clients. Provides tool
            discovery and invocation. Shared across requests — do not mutate it.
            ``None`` in Phase 1 (implemented in Phase 5).
        guardrails: Optional guardrail pipeline (Phase 3.5). When present, adapters
            should pass input/output through it. May be ``None`` before Phase 3.5
            is integrated.
        request_metadata: Passthrough metadata from the original request. Used for
            tracing and logging only — never forwarded to the LLM.
        session_id: Optional session identifier for conversation continuity. When set,
            the ``AgentService`` has already injected conversation history into the
            request context.
        correlation_id: UUID4 string identifying this specific invocation. Auto-generated
            if not provided. Used in structured logs and error responses for tracing.
            Validated as UUID4 format — invalid values raise ``ValueError`` in
            ``__post_init__``.

    Raises:
        ValueError: If ``correlation_id`` is provided but is not a valid UUID4 string.

    Example:
        >>> from agent_service_maf.config.validators import AgentConfig
        >>> context = AgentExecutionContext(
        ...     config=AgentConfig(),
        ...     correlation_id="550e8400-e29b-41d4-a716-446655440000",
        ... )
        >>> context.correlation_id
        '550e8400-e29b-41d4-a716-446655440000'
    """

    config: AgentConfig
    gateway: LLMGateway | None = field(default=None)
    mcp_registry: MCPRegistry | None = field(default=None)
    guardrails: GuardrailPipeline | None = field(default=None)
    session_manager: SessionManager | None = field(default=None)
    request_metadata: dict[str, Any] = field(default_factory=dict)
    session_id: str | None = field(default=None)
    correlation_id: str = field(default="")
    # §A2 / §3 — server-side identity carrier for this invocation.
    # Bound by the auth middleware at the edge; route handlers thread
    # it through here so adapters that prefer explicit access can read
    # ``context.identity``, while function tools and async helpers
    # call :func:`agent_service_maf.core.identity.get_current_identity`
    # to pick it up from the ContextVar. ``None`` when no identity
    # was bound (dev / no-auth path, framework startup, tests that
    # bypass the auth middleware).
    identity: IdentityContext | None = field(default=None)

    def __post_init__(self) -> None:
        """Validate and auto-generate ``correlation_id`` if necessary.

        If ``correlation_id`` is empty, generates a new UUID4. If it is provided,
        validates it against the UUID4 format (8-4-4-4-12 hex digits, version 4).

        Raises:
            ValueError: If a non-empty ``correlation_id`` is provided but does not
                match the UUID4 format. This prevents injection of arbitrary strings
                into log fields and correlation headers.

        Example:
            >>> ctx = AgentExecutionContext(config=config)
            >>> len(ctx.correlation_id) == 36
            True
        """
        if not self.correlation_id:
            self.correlation_id = str(uuid.uuid4())
        else:
            self._validate_correlation_id(self.correlation_id)

    def get_tool_policy(self) -> ToolPolicy:
        """Return the resolved tool policy for the current agent.

        Looks up a per-agent override from ``config.guardrails.agent_overrides``
        using the agent identifier stored in ``request_metadata["agent_id"]``.
        Falls back to ``config.guardrails.tool_guardrails`` when no override
        exists or ``request_metadata`` does not contain ``"agent_id"``.

        Returns:
            The :class:`~agent_service_maf.config.validators.ToolPolicy` for this
            agent. Always returns a valid policy (never ``None``).

        Example:
            >>> policy = context.get_tool_policy()
            >>> policy.mode
            'denylist'
        """
        agent_id = self.request_metadata.get("agent_id", "")
        if agent_id:
            override = self.config.guardrails.agent_overrides.get(str(agent_id))
            if override is not None:
                return override.tool_policy
        return self.config.guardrails.tool_guardrails

    @staticmethod
    def _validate_correlation_id(value: str) -> None:
        """Validate that ``value`` is a well-formed UUID4 string.

        Args:
            value: The correlation ID string to validate.

        Raises:
            ValueError: If ``value`` does not match the UUID4 pattern. The message
                includes the invalid value and guidance on generating a valid one.
        """
        if not _UUID4_RE.match(value):
            raise ValueError(
                f"Invalid correlation_id '{value}': must be a UUID4 string "
                "(e.g., '550e8400-e29b-41d4-a716-446655440000'). "
                "Generate one with: import uuid; str(uuid.uuid4()). "
                "Or omit correlation_id to have one auto-generated."
            )
