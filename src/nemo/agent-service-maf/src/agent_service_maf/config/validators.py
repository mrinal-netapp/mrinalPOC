"""Pydantic config schemas for the agent framework.

All configuration sections are separate Pydantic models composed into the
root :class:`AgentConfig`. Every field has a typed default so that
``AgentConfig()`` with no arguments returns a valid configuration.

Environment variable convention (for reference):
  - Prefix: ``AGENT_``
  - Nesting: double underscore (``__``)
  - Examples:
    - ``AGENT_AGENT__MODEL=anthropic/claude-haiku-4-20250414``
    - ``AGENT_INTERFACE__PORT=9000``
    - ``AGENT_INTERFACE__AUTH__ENABLED=true``
    - ``AGENT_INTERFACE__AUTH__API_KEYS=["sk-abc","sk-def"]``
    - ``AGENT_INTERFACE__STREAMING__MAX_DURATION_SECONDS=600``
    - ``AGENT_GATEWAY__URL=http://gateway.internal:4000``
    - ``AGENT_GUARDRAILS__ENABLED=false``
    - ``AGENT_MCP__TOOL_CALL_TIMEOUT_SECONDS=120``

Locked fields (cannot be overridden per-request):
  - ``agent.framework``
  - ``project_id``

(``interface.host`` and ``interface.port`` were removed from the model in
2026-05-30 — the service bind is driven by the uvicorn launcher's CLI
flags, not the config layer, so the fields had no functional effect.
Legacy payloads still carrying them land in ``__pydantic_extra__`` and
are silently ignored.)
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field  # noqa: F401

# ---------------------------------------------------------------------------
# Sub-section models
# ---------------------------------------------------------------------------


class AuthSection(BaseModel):
    """Authentication sub-configuration for the interface layer.

    Controls which authentication scheme is enforced on incoming requests.

    Attributes:
        enabled: Primary switch. Set to ``False`` for local development.
        scheme: Authentication scheme — ``api_key``, ``oauth2``, or ``mtls``.
        api_key_header: HTTP header name used for API key authentication.
        api_keys: Allowlist of valid API keys. Prefer setting via env var
            ``AGENT_INTERFACE__AUTH__API_KEYS`` rather than the JSON file,
            because API keys are secrets.
        oauth2_issuer: OIDC issuer URL used to fetch the JWKS and validate
            Bearer tokens (only relevant when ``scheme=oauth2``).
        oauth2_audience: Expected ``aud`` claim in the JWT token.

    Example env vars:
        - ``AGENT_INTERFACE__AUTH__ENABLED=true``
        - ``AGENT_INTERFACE__AUTH__SCHEME=api_key``
        - ``AGENT_INTERFACE__AUTH__API_KEY_HEADER=X-API-Key``
        - ``AGENT_INTERFACE__AUTH__API_KEYS=["sk-abc"]``
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    enabled: bool = False
    scheme: str = Field(
        "api_key",
        description=(
            "Authentication scheme: api_key | gateway_identity | oauth2 | mtls. "
            "``gateway_identity`` trusts gateway-injected headers "
            "(X-User-ID / X-Project-ID / X-User-Token); the pod MUST be "
            "behind a gateway-only network policy when this scheme is used."
        ),
    )
    api_key_header: str = Field(
        "X-API-Key",
        description="HTTP header name carrying the API key",
    )
    api_keys: list[str] = Field(
        default_factory=list,
        description="Allowlist of valid API keys (prefer env var over JSON)",
    )
    oauth2_issuer: str = Field(
        "",
        description="OIDC issuer URL for OAuth2 token validation",
    )
    oauth2_audience: str = Field(
        "",
        description="Expected audience claim in the OAuth2 JWT",
    )


class StreamingSection(BaseModel):
    """Streaming limits sub-configuration for the interface layer.

    Enforces hard limits on long-running SSE or WebSocket streams to prevent
    resource exhaustion.

    Attributes:
        max_duration_seconds: Maximum wall-clock time a stream may run.
            After this limit :class:`~agent_service_maf.core.exceptions.StreamingError`
            is raised and the connection is closed.
        max_events: Maximum number of events the stream may emit. Prevents
            runaway agents from flooding clients.
        idle_timeout_seconds: Maximum time between successive events. Closes
            the connection if no event is produced within this window.

    Example env vars:
        - ``AGENT_INTERFACE__STREAMING__MAX_DURATION_SECONDS=600``
        - ``AGENT_INTERFACE__STREAMING__MAX_EVENTS=5000``
        - ``AGENT_INTERFACE__STREAMING__IDLE_TIMEOUT_SECONDS=30``
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    max_duration_seconds: int = Field(
        300,
        ge=1,
        description="Maximum stream duration in seconds",
    )
    max_events: int = Field(
        10000,
        ge=1,
        description="Maximum number of SSE/WS events per stream",
    )
    idle_timeout_seconds: int = Field(
        60,
        ge=1,
        description="Seconds of idle before the stream is terminated",
    )


# ---------------------------------------------------------------------------
# Top-level section models
# ---------------------------------------------------------------------------


class AgentSection(BaseModel):
    """Agent execution settings.

    Controls which framework adapter is used and the default LLM parameters
    for every invocation.

    Attributes:
        framework: Framework adapter identifier (e.g. ``maf``,
            ``echo``). This field is *locked* — it cannot be
            overridden per-request.
        model: Default LLM model string passed to the gateway proxy.
        temperature: Sampling temperature in ``[0.0, 2.0]``.
        max_tokens: Maximum output tokens ``[1, 200 000]``.
        timeout_seconds: Wall-clock timeout for a single agent invocation
            ``[1, 600]`` seconds.

    Example env vars:
        - ``AGENT_AGENT__FRAMEWORK=maf``
        - ``AGENT_AGENT__MODEL=anthropic/claude-haiku-4-20250414``
        - ``AGENT_AGENT__TEMPERATURE=0.2``
        - ``AGENT_AGENT__MAX_TOKENS=8192``
        - ``AGENT_AGENT__TIMEOUT_SECONDS=60``
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    framework: str = Field(
        "maf",
        description="Framework adapter to use (locked — cannot be overridden per-request)",
    )
    model: str = Field(
        "anthropic/claude-sonnet-4-20250514",
        description="Default LLM model",
    )
    temperature: float = Field(
        0.7,
        ge=0.0,
        le=2.0,
        description="LLM sampling temperature [0.0, 2.0]",
    )
    max_tokens: int = Field(
        4096,
        ge=1,
        le=200000,
        description="Max output tokens [1, 200000]",
    )
    timeout_seconds: int = Field(
        120,
        ge=1,
        le=600,
        description="Agent execution timeout in seconds [1, 600]",
    )
    metadata: dict[str, Any] = Field(
        default_factory=dict,
        description="Project metadata (project, version, environment)",
    )


class ReadinessSection(BaseModel):
    """Readiness probe (``GET /ready``) settings (§5.8 lock-in).

    Attributes:
        check_gateway: When ``True`` the readiness probe also performs
            a lightweight gateway smoke check. Off by default because
            the gateway is best probed by the upstream control plane,
            and a probe-time call burns a real LLM round-trip.
        cache_ttl_seconds: Window in which the readiness checker
            re-uses the previous result rather than re-running the
            five checks. Prevents probe storms from hammering Redis.
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    check_gateway: bool = Field(
        False,
        description="Include the LLM gateway in the /ready sweep (off by default)",
    )
    cache_ttl_seconds: float = Field(
        1.5,
        ge=0.0,
        le=30.0,
        description="ReadinessChecker result-cache TTL (seconds)",
    )


class InterfaceSection(BaseModel):
    """API interface settings.

    Controls the HTTP server bind address, port, CORS policy, concurrency
    limits, authentication, streaming limits, and the ``GET /ready``
    probe (§5.8).

    Attributes:
        cors_origins: Allowed CORS origins. Use ``["*"]`` for development only.
        request_timeout_seconds: Maximum time a synchronous request may take.
        max_concurrent_requests: Hard cap on simultaneous in-flight requests.
        auth: Authentication sub-section. See :class:`AuthSection`.
        streaming: Streaming limit sub-section. See :class:`StreamingSection`.
        readiness: Readiness-probe sub-section. See
            :class:`ReadinessSection`.

    Example env vars:
        - ``AGENT_INTERFACE__CORS_ORIGINS=["https://app.example.com"]``
        - ``AGENT_INTERFACE__AUTH__ENABLED=true``
        - ``AGENT_INTERFACE__STREAMING__MAX_DURATION_SECONDS=600``
        - ``AGENT_INTERFACE__READINESS__CHECK_GATEWAY=false``
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    # ``host`` / ``port`` were intentionally removed: the main HTTP
    # server's bind is driven by uvicorn's --host / --port CLI flags,
    # not the config layer. If a legacy payload still carries them
    # (env vars, JSON, request override), they land in
    # ``__pydantic_extra__`` because ``extra="allow"`` and have no
    # runtime effect.

    cors_origins: list[str] = Field(
        default_factory=lambda: ["*"],
        description="Allowed CORS origins",
    )
    request_timeout_seconds: int = Field(
        300,
        ge=1,
        description="Max synchronous request duration in seconds",
    )
    max_concurrent_requests: int = Field(
        50,
        ge=1,
        description="Maximum simultaneous in-flight requests",
    )
    auth: AuthSection = Field(
        default_factory=lambda: AuthSection(),  # type: ignore[call-arg]
        description="Authentication sub-section",
    )
    streaming: StreamingSection = Field(
        default_factory=lambda: StreamingSection(),  # type: ignore[call-arg]
        description="Streaming limit sub-section",
    )
    readiness: ReadinessSection = Field(
        default_factory=lambda: ReadinessSection(),  # type: ignore[call-arg]
        description="Readiness probe sub-section (§5.8)",
    )
    health_check_path: str = Field(
        "/health",
        description="Health check endpoint path",
    )
    api_prefix: str = Field(
        "",
        description="API route prefix",
    )


class GatewaySection(BaseModel):
    """LLM gateway connection settings.

    Controls how the framework communicates with the external Bifrost proxy.
    Secrets (``api_key``) MUST be provided via environment variable
    ``AGENT_GATEWAY__API_KEY``, not the JSON config file.

    Attributes:
        url: Full URL of the LLM gateway proxy.
        api_key: Authentication key for the gateway. Must be empty in config
            files — provide via ``AGENT_GATEWAY__API_KEY`` env var instead.
        default_model: Fallback model when no model is specified per-request.
        request_timeout_seconds: Per-request timeout for gateway calls.
        retry_on_timeout: Whether to retry the request on timeout.
        max_retries: Maximum retry attempts ``[0, 5]``.
        api_key_env: Environment variable name for the gateway API key.
        retry_backoff_multiplier: Backoff multiplier for retries.

    Example env vars:
        - ``AGENT_GATEWAY__URL=http://gateway.internal:4000``
        - ``AGENT_GATEWAY__API_KEY=sk-...``  (secret — env only)
        - ``AGENT_GATEWAY__DEFAULT_MODEL=openai/gpt-4o``
        - ``AGENT_GATEWAY__MAX_RETRIES=3``
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    url: str = Field(
        "http://localhost:4000",
        description="URL of the LLM gateway proxy",
    )
    api_key: str = Field(
        "",
        description=(
            "API key for the LLM gateway (must be empty in JSON; "
            "use AGENT_GATEWAY__API_KEY env var)"
        ),
    )
    default_model: str = Field(
        "anthropic/claude-sonnet-4-20250514",
        description="Default model when not specified per-request",
    )
    request_timeout_seconds: int = Field(
        120,
        ge=1,
        le=600,
        description="Per-request gateway timeout in seconds [1, 600]",
    )
    retry_on_timeout: bool = Field(
        True,
        description="Retry the request once on timeout",
    )
    max_retries: int = Field(
        2,
        ge=0,
        le=5,
        description="Maximum retry attempts [0, 5]",
    )
    api_key_env: str = Field(
        "",
        description="Env var name for gateway API key",
    )
    retry_backoff_multiplier: float = Field(
        2.0,
        ge=1.0,
        description="Backoff multiplier for retries",
    )
    # §F2 / §3 — Bifrost identity-propagation knobs.
    # ``forward_user_identity`` controls the always-on attribution
    # headers (X-User-ID, X-Project-ID, X-User-Email, X-User-Name)
    # that Bifrost can use for per-user observability /
    # rate-limiting heuristics.
    # ``forward_user_token`` is the opt-in switch for the per-call
    # ``X-User-Token`` header carrying the inbound user JWT.
    # Default off: Bifrost typically can't validate user JWTs.
    # When the deployment wants the audit trail on Bifrost (or
    # forwards-to-provider per-user attribution), set this true.
    forward_user_identity: bool = Field(
        True,
        description=(
            "Emit X-User-ID / X-Project-ID / X-User-Email / X-User-Name "
            "on Bifrost outbound calls when an identity is bound."
        ),
    )
    forward_user_token: bool = Field(
        False,
        description=(
            "Emit X-User-Token (user JWT) on Bifrost outbound calls. "
            "Off by default — opt in per deployment when Bifrost is "
            "configured to forward the token to the LLM provider."
        ),
    )


class GuardrailRule(BaseModel):
    """A single guardrail rule applied to agent input or output.

    Attributes:
        name: Unique identifier for this guardrail (e.g. ``pii_masker``).
        enabled: Whether this rule is active.
        action_on_trigger: What to do when the rule fires:
            ``block`` — reject the request;
            ``modify`` — transform the content in place;
            ``warn`` — allow but log a warning.
        config: Guardrail-specific parameters (schema varies per guardrail).
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    name: str = Field(..., description="Guardrail identifier")
    enabled: bool = Field(True, description="Whether this rule is active")
    action_on_trigger: str = Field(
        "block",
        description="Action when triggered: block | modify | warn",
    )
    config: dict[str, Any] = Field(
        default_factory=dict,
        description="Guardrail-specific parameters",
    )
    type: str = Field(
        "",
        description=(
            "Guardrail type: validation | security | privacy | safety | accuracy | content_policy"
        ),
    )
    priority: int = Field(
        0,
        ge=0,
        description="Execution priority (lower runs first)",
    )
    message: str | None = Field(
        None,
        description="Custom message when guardrail triggers",
    )


class ToolPolicy(BaseModel):
    """Tool authorization policy controlling which MCP tools an agent may call.

    Attributes:
        mode: ``allowlist`` — only listed tools are permitted;
            ``denylist`` — listed tools are blocked, everything else is allowed.
        tools: Tool names subject to the policy.
        max_calls_per_request: Hard cap on total tool calls per invocation
            ``[1, 100]``.
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    mode: str = Field(
        "allowlist",
        description="Policy mode: allowlist | denylist",
    )
    tools: list[str] = Field(
        default_factory=list,
        description="Tool names covered by this policy",
    )
    max_calls_per_request: int = Field(
        20,
        ge=1,
        le=100,
        description="Maximum tool calls per invocation [1, 100]",
    )


class AgentGuardrailConfig(BaseModel):
    """Per-agent guardrail override.

    Allows specific agent identifiers to override the default guardrail
    pipeline defined in :class:`GuardrailSection`.

    Attributes:
        input_guardrails: Ordered list of input guardrail rules for this agent.
        output_guardrails: Ordered list of output guardrail rules for this agent.
        tool_policy: Tool authorization policy for this agent.
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    input_guardrails: list[GuardrailRule] = Field(
        default_factory=list,
        description="Input guardrail rules for this agent",
    )
    output_guardrails: list[GuardrailRule] = Field(
        default_factory=list,
        description="Output guardrail rules for this agent",
    )
    tool_policy: ToolPolicy = Field(
        default_factory=lambda: ToolPolicy(),  # type: ignore[call-arg]
        description="Tool authorization policy for this agent",
    )


class GuardrailSection(BaseModel):
    """Top-level guardrail configuration.

    Controls the default guardrail pipeline applied to all agents and
    allows per-agent overrides.

    Attributes:
        enabled: Primary switch. Set to ``False`` to disable all guardrails
            (not recommended for production).
        fail_open: When ``True``, a guardrail error allows the request through.
            When ``False`` (default), a guardrail error blocks the request.
        log_blocked_requests: Whether to emit a structured log entry when a
            request is blocked by a guardrail.
        input_guardrails: Ordered list of input guardrail rules applied
            to every agent unless overridden.
        output_guardrails: Ordered list of output guardrail rules applied
            to every agent unless overridden.
        tool_guardrails: Tool authorization policy applied to every agent
            unless overridden.
        agent_overrides: Per-agent guardrail overrides keyed by agent identifier.

    Example env vars:
        - ``AGENT_GUARDRAILS__ENABLED=false``
        - ``AGENT_GUARDRAILS__FAIL_OPEN=true``
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    enabled: bool = Field(True, description="Primary guardrail switch")
    fail_open: bool = Field(
        False,
        description="Allow requests through on guardrail error",
    )
    log_blocked_requests: bool = Field(
        True,
        description="Log requests blocked by guardrails",
    )
    input_guardrails: list[GuardrailRule] = Field(
        default_factory=list,
        description="Default input guardrail rules for all agents",
    )
    output_guardrails: list[GuardrailRule] = Field(
        default_factory=list,
        description="Default output guardrail rules for all agents",
    )
    tool_guardrails: ToolPolicy = Field(
        default_factory=lambda: ToolPolicy(),  # type: ignore[call-arg]
        description="Default tool authorization policy for all agents",
    )
    agent_overrides: dict[str, AgentGuardrailConfig] = Field(
        default_factory=dict,
        description="Per-agent guardrail configuration overrides",
    )


class MCPSection(BaseModel):
    """MCP client integration configuration.

    Controls how the framework connects to and interacts with external MCP
    servers. Includes Phase 5 extended fields for tool call behaviour.

    MCP servers are defined inline in the agent config via the top-level
    ``mcp_servers`` array (v2.0.0 format).

    Attributes:
        connection_timeout_seconds: Timeout for establishing MCP connections
            ``[1, 300]`` seconds.
        lazy_connect: When ``True``, MCP servers are connected on first use
            rather than at startup.
        tool_call_timeout_seconds: Per-tool-call timeout ``[1, 600]`` seconds.
        max_tool_retries: Number of retries for failed tool calls ``[0, 3]``.
        retry_on_timeout: Whether to retry a tool call that timed out.
        discovery_on_connect: Whether to auto-discover available tools when
            a server connection is established.
        tool_name_format: How tool names are exposed to the agent:
            ``qualified`` (``server.tool``) or ``bare`` (``tool``).
        max_concurrent_tool_calls: Maximum parallel tool calls ``[1, 20]``.

    Example env vars:
        - ``AGENT_MCP__TOOL_CALL_TIMEOUT_SECONDS=120``
        - ``AGENT_MCP__MAX_TOOL_RETRIES=2``
        - ``AGENT_MCP__MAX_CONCURRENT_TOOL_CALLS=10``
    """

    model_config = ConfigDict(frozen=True, extra="allow")
    connection_timeout_seconds: int = Field(
        30,
        ge=1,
        le=300,
        description="MCP connection timeout in seconds [1, 300]",
    )
    lazy_connect: bool = Field(
        True,
        description="Connect to MCP servers on first use rather than at startup",
    )
    tool_call_timeout_seconds: int = Field(
        60,
        ge=1,
        le=600,
        description="Per-tool-call timeout in seconds [1, 600]",
    )
    max_tool_retries: int = Field(
        1,
        ge=0,
        le=3,
        description="Retry count for failed tool calls [0, 3]",
    )
    retry_on_timeout: bool = Field(
        True,
        description="Retry a tool call that timed out",
    )
    discovery_on_connect: bool = Field(
        True,
        description="Auto-discover available tools when a connection is established",
    )
    tool_name_format: str = Field(
        "qualified",
        description="Tool name format exposed to the agent: qualified (server.tool) | bare (tool)",
    )
    max_concurrent_tool_calls: int = Field(
        5,
        ge=1,
        le=20,
        description="Maximum simultaneous tool calls [1, 20]",
    )
    health_check_interval_seconds: int = Field(
        60,
        ge=1,
        description="Health check interval for MCP connections",
    )
    # §3 / §E1+E2 — Two-token model for MCP HTTP/SSE transports.
    # ``service_token`` is the per-deployment MCP service-account JWT
    # placed on the outbound ``Authorization: Bearer`` header. It is
    # the secret that proves "this is MAF calling" to the MCP server.
    # MUST come from env -- never put a token literal in JSON config.
    # When unset, the identity transport wrapper falls back to
    # forwarding the inbound user JWT as ``Authorization`` for
    # legacy compatibility (§3 fallback table) -- but always also
    # sends ``X-User-Token`` so the MCP server can migrate to the
    # new contract at its own pace.
    service_token: str = Field(
        "",
        description=(
            "(SECRET) MCP service-account token sent on outbound "
            "Authorization headers for HTTP/SSE MCP servers. Env-only: "
            "AGENT_MCP__SERVICE_TOKEN. When empty, legacy-compat "
            "fallback forwards the user JWT instead."
        ),
    )


class MemorySection(BaseModel):
    """Session memory and token budget configuration.

    Controls conversation history persistence, token-level budgets, and
    the storage backend. The storage backend is optional — when set to
    ``"memory"`` (default), sessions are stored in-process with no
    external dependencies.

    Attributes:
        enabled: Master switch for session memory.
        storage_backend: Persistence backend — ``"memory"`` (default) or ``"redis"``.
        ttl_seconds: Session time-to-live in seconds.
        max_history_length: Maximum messages per session (0 = unlimited).
        max_tokens_per_session: Token budget per session (0 = unlimited).
            Uses approximate counting (1 token ≈ 4 chars).
        cleanup_interval_seconds: Background cleanup interval.
        redis_url: Redis connection URL (only used when ``storage_backend="redis"``).
            Can also be set via ``AGENT_MEMORY__REDIS_URL`` env var.
        redis_key_prefix: Key prefix for Redis (only used with Redis backend).

    Example env vars:
        - ``AGENT_MEMORY__STORAGE_BACKEND=redis``
        - ``AGENT_MEMORY__REDIS_URL=redis://redis:6379/0``
        - ``AGENT_MEMORY__MAX_TOKENS_PER_SESSION=16384``
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    enabled: bool = Field(True, description="Enable session memory")
    storage_backend: str = Field(
        "memory",
        description="Storage backend: 'memory' (default) or 'redis'",
    )
    ttl_seconds: int = Field(3600, ge=60, description="Session TTL in seconds")
    max_history_length: int = Field(
        100,
        ge=0,
        description="Max messages per session (0 = unlimited)",
    )
    max_tokens_per_session: int = Field(
        0,
        ge=0,
        description="Token budget per session (0 = unlimited). "
        "Uses approximate counting: 1 token ≈ 4 characters.",
    )
    cleanup_interval_seconds: int = Field(
        300,
        ge=30,
        description="Background cleanup interval in seconds",
    )
    redis_url: str = Field(
        "redis://localhost:6379/0",
        description="Redis URL (only used when storage_backend='redis')",
    )
    redis_sentinel_url: str = Field(
        "",
        description=(
            "Comma-separated list of sentinel hosts (host:port). When non-empty, "
            "the Redis backend uses Sentinel master-discovery for HA. Port "
            "defaults to 26379 if omitted."
        ),
    )
    redis_sentinel_master: str = Field(
        "mymaster",
        description=("Sentinel master service name (only used when redis_sentinel_url is set)."),
    )
    redis_password: str = Field(
        "",
        description=(
            "(SECRET) Redis password. Env-only: AGENT_MEMORY__REDIS_PASSWORD. "
            "Never put in JSON config."
        ),
    )
    redis_key_prefix: str = Field(
        "agent_session:",
        description="Redis key prefix for session payloads.",
    )
    redis_index_prefix: str = Field(
        "agent_session_index:",
        description="Redis key prefix for per-user index Sets.",
    )
    redis_meta_prefix: str = Field(
        "agent_session_meta:",
        description="Redis key prefix for per-session metadata Hashes.",
    )
    compression_level: int = Field(
        1,
        ge=1,
        le=9,
        description=(
            "zlib compression level for stored session payloads "
            "(1=fast .. 9=thorough). Default 1 matches POC."
        ),
    )
    buffer_type: str = Field(
        "sliding_window",
        description=(
            "Memory buffer strategy: 'sliding_window' "
            "(chat_memory_buffer) or 'summary' "
            "(chat_summary_memory_buffer)"
        ),
    )
    max_chars_per_session: int = Field(
        0,
        ge=0,
        description=(
            "Max total character length per session (0 = unlimited). Applied by the buffer."
        ),
    )
    summary_model: str = Field(
        "",
        description=(
            "Model for summarization (only used with "
            "'summary' buffer). Empty = use basic text summary."
        ),
    )
    max_session_bytes: int = Field(
        1_048_576,
        ge=0,
        description=(
            "Hard cap on encoded session size in bytes (0 = unlimited). "
            "Enforced before save in Phase 3 — over-cap sessions are trimmed "
            "aggressively, then truncated from the front if still over."
        ),
    )
    max_session_messages: int = Field(
        1000,
        ge=0,
        description=(
            "Hard cap on message count per session (0 = unlimited). "
            "Enforced before save in Phase 3 alongside max_session_bytes."
        ),
    )
    max_sessions_per_user: int = Field(
        100,
        ge=0,
        description=(
            "Hard cap on the number of sessions retained per (scope, anchor, user) "
            "tuple (0 = unlimited). When exceeded, the oldest session by "
            "created_at is evicted before the new one is saved."
        ),
    )
    summarizer_timeout_seconds: float = Field(
        5.0,
        gt=0,
        description=(
            "Wall-clock budget for a SummaryBuffer LLM call. On timeout or "
            "gateway error the buffer falls back to sliding-window trim "
            "(oldest messages drop, no summary message produced)."
        ),
    )
    summary_max_tokens: int = Field(
        2000,
        ge=64,
        description=(
            "Max output tokens for SummaryBuffer LLM calls. Default 2000 "
            "matches the locked DEFAULT_SUMMARY_TOKEN_LIMIT from the "
            "memory-context plan; the summary becomes a single system "
            "message at the head of the buffered window."
        ),
    )
    # ─── New MemoryContext-driven knobs (Stage 3) ───────────────────────────
    summary_refresh_every_turns: int = Field(
        0,
        ge=0,
        description=(
            "SummaryBuffer cadence gating: only invoke the summarizer once "
            "N new messages have accumulated since the last summary. 0 "
            "(default) disables gating — every overflow triggers a summary."
        ),
    )
    adaptive_summarize_threshold: float = Field(
        0.0,
        ge=0.0,
        le=1.0,
        description=(
            "SummaryBuffer-only adaptive switch: when the overflow ratio "
            "((excess) / limit) is BELOW this threshold, the buffer drops "
            "oldest messages (cheap) instead of invoking the summarizer "
            "(LLM call). When the ratio is at-or-above the threshold the "
            "summarizer runs. Default 0.0 = always summarize on overflow "
            "(legacy behavior). Set to e.g. 0.30 to mirror agent-service's "
            "DEFAULT_SUMMARY_OVERFLOW_THRESHOLD."
        ),
    )


class TasksSection(BaseModel):
    """Async-invoke task store configuration.

    Controls the ``/invoke/async`` + ``/tasks/{task_id}`` polling pattern.
    The backend is in-memory by default for dev; switch to Redis for
    multi-replica deployments where the polling client and the worker that
    ran the task are not guaranteed to be the same pod.

    Two-tier TTL is enforced by the Redis backend:

    - ``running_ttl_seconds`` is the configured **floor** for the in-flight
      TTL; team_loader raises it to ``max(running_ttl_seconds,
      agent.timeout_seconds + 60)`` before handing it to the store so a
      slow multi-tool agent is never evicted mid-call. The crashed-worker
      self-clean upper bound is therefore that effective max, not the
      bare ``running_ttl_seconds`` value -- a higher floor lengthens
      both the in-flight cap and the recovery window.
    - ``result_ttl_seconds`` once the task reaches a terminal state -- long
      enough for slow polling clients to fetch the result.

    Attributes:
        enabled: Master switch for async-invoke routes. When ``False``, the
            ``/invoke/async`` and ``/tasks`` routes return 404 for any team
            that has this section disabled.
        backend: ``"memory"`` (process-local, dev) or ``"redis"`` (durable,
            multi-replica).
        redis_url: Redis connection URL (only used when ``backend="redis"``).
        key_prefix: Redis key prefix for task entries.
        running_ttl_seconds: TTL while the task is in flight (60s..1d).
        result_ttl_seconds: TTL once the task is terminal (60s..7d).
        compression_level: zlib compression level for stored task payloads
            (1=fast..9=thorough). Default 1 matches the POC.

    Example env vars:
        - ``AGENT_TASKS__ENABLED=true``
        - ``AGENT_TASKS__BACKEND=redis``
        - ``AGENT_TASKS__REDIS_URL=redis://redis:6379/0``
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    enabled: bool = Field(
        True,
        description=(
            "Whether async-invoke routes are exposed. When False, /invoke/async returns 404."
        ),
    )
    backend: Literal["memory", "redis"] = Field(
        "memory",
        description=(
            "Backend type. 'memory' is process-local (dev only). "
            "'redis' is durable across replicas."
        ),
    )
    redis_url: str = Field(
        "redis://localhost:6379/0",
        description="Redis connection URL (only used when backend='redis').",
    )
    redis_sentinel_url: str = Field(
        "",
        description=(
            "Comma-separated list of sentinel hosts (host:port). When non-empty, "
            "the Redis backend uses Sentinel master-discovery for HA. Port "
            "defaults to 26379 if omitted. Matches the same field on "
            "MemorySection so session and task storage share connection policy."
        ),
    )
    redis_sentinel_master: str = Field(
        "mymaster",
        description=("Sentinel master service name (only used when redis_sentinel_url is set)."),
    )
    redis_password: str = Field(
        "",
        description=(
            "(SECRET) Redis password. Env-only: AGENT_TASKS__REDIS_PASSWORD. "
            "Never put in JSON config."
        ),
    )
    key_prefix: str = Field(
        "agent_task:",
        description="Redis key prefix for task entries.",
    )
    running_ttl_seconds: int = Field(
        600,
        ge=60,
        le=86400,
        description=(
            "Floor for the running-state TTL (seconds). The effective "
            "running TTL is computed at team-load time as "
            "``max(running_ttl_seconds, agent.timeout_seconds + 60)`` "
            "(§5.5.1) so a long multi-tool agent does not 404 from "
            "expiry while still computing. Crashed workers also clean "
            "up on that effective TTL, so raising this floor can delay "
            "cleanup beyond ``agent.timeout_seconds + 60``."
        ),
    )
    result_ttl_seconds: int = Field(
        3600,
        ge=60,
        le=604800,
        description="TTL once task reaches a terminal state.",
    )
    compression_level: int = Field(
        1,
        ge=1,
        le=9,
        description="zlib compression level for stored task payloads.",
    )


class LoggingSection(BaseModel):
    """Logging configuration.

    Attributes:
        level: Log level (``DEBUG``, ``INFO``, ``WARNING``, ``ERROR``).
        format: Log format — ``json`` (structured) or ``text`` (human-readable).
        include_timestamp: Whether to include ``timestamp`` in each log entry.

    Example env vars:
        - ``AGENT_LOGGING__LEVEL=DEBUG``
        - ``AGENT_LOGGING__FORMAT=text``
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    level: str = Field("INFO", description="Log level: DEBUG | INFO | WARNING | ERROR")
    format: str = Field(
        "json",
        description="Log output format: json | text",
    )
    include_timestamp: bool = Field(
        True,
        description="Include timestamp field in each log entry",
    )


# ---------------------------------------------------------------------------
# Agent-definition config models (framework-agnostic; consumed by the MAF adapter)
# ---------------------------------------------------------------------------


class SKAgentDefinition(BaseModel):
    """Configuration for a single agent within a multi-agent workflow.

    Each agent can have independent LLM settings, tools, and instructions.
    When ``model``, ``temperature``, or ``max_tokens`` are ``None``, the
    global defaults from :class:`AgentSection` are used.

    Two independent output-shape knobs (see plan §3 / §4 D2):

    * :attr:`response_format` (``"json_object"``) constrains the LLM via
      ``prompt_execution_settings`` — the provider is asked to emit
      well-formed JSON. No server-side validation is performed.
    * :attr:`output_schema` declares a JSON Schema the agent's text
      output is validated against in
      :meth:`ResponseBuilder.finalize` /
      :func:`build_outcome_model`. On success
      ``InvokeResponse.parsedOutput`` is populated with the
      type-coerced dict; on mismatch it is ``None`` and the raw
      ``output`` text is preserved.

    Configuration combinations:

    * neither knob set → no constraint, no validation, ``parsedOutput`` is ``null``.
    * ``response_format`` only → provider JSON mode, no validation, raw parsed dict.
    * ``output_schema`` only → no provider hint, full Pydantic validation,
      validated dict or ``null`` on mismatch.
    * both → provider JSON mode plus validation (strongest guarantee).

    Per-request ``context.outputSchema`` (on
    :class:`~agent_service_maf.interface_layer.models.InvokeRequest`)
    overrides the agent-level :attr:`output_schema` when both are set.

    Attributes:
        name: Agent name (unique within workflow). Must match
            ``^[a-zA-Z0-9_-]{1,64}$``.
        instructions: System prompt or instructions for the agent.
        description: Agent description used in selection strategies.
        model: Override model string (``None`` = use default).
        model_display_name: User-facing model label from registration
            (``displayName`` / ``name``). Shown in playground provenance;
            the wire ``model`` field remains the Bifrost gateway id.
        temperature: Override temperature (``None`` = use default).
        max_tokens: Override max tokens (``None`` = use default).
        top_p: Override top_p sampling parameter.
        presence_penalty: Override presence penalty.
        frequency_penalty: Override frequency penalty.
        response_format: ``"text"``, ``"json_object"``, or ``None``.
        output_schema: Default JSON Schema for this agent's output.
            When set, MAF parses and validates each invocation's output
            and populates ``InvokeResponse.parsedOutput`` on success.
            Overridden per request by ``context.outputSchema``. Mirror
            of the legacy ``outcomeSchema`` field
            (``src/nemo/agent-service/src/agent_factory.py:140``).
        tools: MCP tool names this agent can use.
        mcp_servers: MCP server names -- all tools from these servers.
        function_choice_behavior: ``"auto"``, ``"required"``, or ``"none"``.
        prompt_template: Jinja2/Handlebars template for instructions.
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    name: str = Field(..., description="Agent name (unique within workflow)")
    instructions: str = Field("", description="System prompt / instructions")
    description: str = Field("", description="Agent description (used in selection)")
    model: str | None = Field(None, description="Override model (None = use default)")
    model_display_name: str | None = Field(
        None,
        description="User-facing model label from registration (displayName / name)",
    )
    temperature: float | None = Field(None, ge=0.0, le=2.0, description="Override temperature")
    max_tokens: int | None = Field(None, ge=1, le=200000, description="Override max tokens")
    top_p: float | None = Field(None, ge=0.0, le=1.0, description="Override top_p")
    presence_penalty: float | None = Field(
        None, ge=-2.0, le=2.0, description="Override presence penalty"
    )
    frequency_penalty: float | None = Field(
        None, ge=-2.0, le=2.0, description="Override frequency penalty"
    )
    response_format: str | None = Field(
        None, description='Response format: "text", "json_object", or None'
    )
    output_schema: dict[str, Any] | None = Field(
        None,
        description=(
            "Default JSON Schema for this agent's output. When set, MAF parses "
            "and validates each invocation's output and populates "
            "InvokeResponse.parsedOutput on success. Overridden per request by "
            "context.outputSchema. Mirror of the legacy outcomeSchema field "
            "(src/nemo/agent-service/src/agent_factory.py:140)."
        ),
    )
    tools: list[str] = Field(default_factory=list, description="MCP tool names this agent can use")
    mcp_servers: list[str] = Field(
        default_factory=list, description="MCP server names -- all tools from these servers"
    )
    allowed_tools_by_server: dict[str, list[str]] = Field(
        default_factory=dict,
        description=(
            "Per-server tool whitelist. Keyed by server name; the value is the "
            "list of tool names the agent is allowed to call on that server. A "
            "server absent from this map (or mapped to an empty list) is "
            "unrestricted -- all of its tools are exposed via `mcp_servers`. "
            "Sourced from config-service's `Agent.mcpServerConfig[server]."
            "allowedTools`."
        ),
    )
    tool_bindings: list[str] = Field(
        default_factory=list,
        description=(
            "Names of unified tool bindings (function or mcp) this agent may "
            "call. Resolved against the top-level tool_bindings[] catalogue."
        ),
    )
    function_choice_behavior: str = Field(
        "auto", description='Function choice: "auto", "required", or "none"'
    )
    prompt_template: str | None = Field(None, description="Template for instructions")
    skip_post_tool_synthesis: bool = Field(
        False,
        description=(
            "When True (and the agent runs under a single-agent orchestration), "
            "stop after the first tool call and return the tool's output as the "
            "agent response without a second LLM call. Saves the synthesis "
            "round-trip for passthrough agents whose only job is to relay a "
            "tool result. Has no effect on agents that don't call tools."
        ),
    )


class HandoffDefinition(BaseModel):
    """A handoff connection between two agents in a handoff orchestration.

    Attributes:
        source: Source agent name.
        target: Target agent name.
        description: When to hand off.
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    source: str = Field(..., description="Source agent name")
    target: str = Field(..., description="Target agent name")
    description: str = Field("", description="When to hand off")


class SelectionStrategyConfig(BaseModel):
    """Configuration for agent selection in group chat orchestration.

    Attributes:
        type: Strategy type -- ``"sequential"``, ``"round_robin"``, ``"kernel_function"``,
            ``"auto"``, or ``"custom"``.
        initial_agent: Agent to start with.
        function_prompt: Prompt for kernel_function strategy.
        candidate_agents: Restrict LLM selection to these agents only (empty = all).
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    type: str = Field("sequential", description="Selection strategy type")
    initial_agent: str | None = Field(None, description="Agent to start with")
    function_prompt: str | None = Field(None, description="Prompt for kernel_function strategy")
    candidate_agents: list[str] = Field(
        default_factory=list,
        description="Restrict LLM selection to these agents only (empty = all eligible)",
    )


class TerminationStrategyConfig(BaseModel):
    """Configuration for agent termination in orchestration.

    Attributes:
        type: Strategy type -- ``"default"``, ``"keyword"``, ``"approval"``,
            ``"timeout"``, ``"kernel_function"``, ``"aggregator"``.
        maximum_iterations: Max turns before forced stop.
        automatic_reset: Auto-reset on completion.
        agents: Which agents can trigger termination.
        function_prompt: Prompt for kernel_function strategy.
        condition: For aggregator -- ``"all"`` or ``"any"``.
        sub_strategies: For aggregator -- nested strategy configs.
        keywords: Stop words for keyword strategy.
        timeout_seconds: Wall-clock timeout for timeout strategy.
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    type: str = Field("default", description="Termination strategy type")
    maximum_iterations: int = Field(10, ge=1, le=1000, description="Max turns before forced stop")
    automatic_reset: bool = Field(False, description="Auto-reset on completion")
    agents: list[str] = Field(
        default_factory=list, description="Agents that can trigger termination"
    )
    function_prompt: str | None = Field(None, description="Prompt for kernel_function strategy")
    condition: str = Field("all", description='For aggregator: "all" or "any"')
    sub_strategies: list[dict[str, Any]] = Field(
        default_factory=list, description="For aggregator: nested strategy configs"
    )
    keywords: list[str] = Field(
        default_factory=list,
        description='Stop words for keyword strategy (e.g. ["DONE", "FINAL ANSWER"])',
    )
    timeout_seconds: float | None = Field(
        None,
        ge=1.0,
        le=3600.0,
        description="Wall-clock timeout in seconds for timeout termination strategy",
    )


class GraphEdge(BaseModel):
    """A directed edge between agents in a graph orchestration.

    Attributes:
        source: Source agent name.
        target: Target agent name.
        condition: Optional condition for traversing this edge.
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    source: str = Field(..., description="Source agent name")
    target: str = Field(..., description="Target agent name")
    condition: str = Field("", description="Condition for edge traversal")


class OrchestrationConfig(BaseModel):
    """Configuration for multi-agent orchestration.

    Attributes:
        type: Orchestration type -- ``"single"``, ``"sequential"``, ``"concurrent"``,
            ``"handoff"``, ``"group_chat"``, ``"magentic"``, ``"triage"``, ``"graph"``.
        handoffs: For handoff orchestration.
        selection_strategy: For group_chat orchestration.
        termination_strategy: Termination configuration.
        magentic_manager_model: Model for Magentic-One orchestrator.
        magentic_manager_temperature: Temperature for orchestrator.
        max_rounds: Max rounds for orchestration.
        agent_order: Custom agent execution order for sequential type.
        edges: Directed edges for graph orchestration.
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    type: str = Field("single", description="Orchestration type")
    handoffs: list[HandoffDefinition] = Field(
        default_factory=list, description="For handoff orchestration"
    )
    selection_strategy: SelectionStrategyConfig = Field(
        default_factory=lambda: SelectionStrategyConfig(),  # type: ignore[call-arg]
        description="For group_chat orchestration",
    )
    termination_strategy: TerminationStrategyConfig = Field(
        default_factory=lambda: TerminationStrategyConfig(),  # type: ignore[call-arg]
        description="Termination configuration",
    )
    magentic_manager_model: str | None = Field(
        None, description="Model for Magentic-One orchestrator"
    )
    magentic_manager_temperature: float = Field(
        0.0, ge=0.0, le=2.0, description="Temperature for orchestrator"
    )
    max_rounds: int = Field(20, ge=1, le=1000, description="Max rounds for orchestration")
    agent_order: list[str] = Field(
        default_factory=list,
        description="Custom agent execution order for sequential type (empty = definition order)",
    )
    edges: list[GraphEdge] = Field(
        default_factory=list,
        description="Directed edges for graph orchestration",
    )
    manager_model: str | None = Field(
        None,
        description="Model for orchestration manager (alias for magentic_manager_model)",
    )
    manager_model_display_name: str | None = Field(
        None,
        description="User-facing label for the orchestration manager model",
    )
    manager_temperature: float | None = Field(
        None,
        ge=0.0,
        le=2.0,
        description="Temperature for orchestration manager",
    )
    manager_instructions: str | None = Field(
        None,
        description=(
            "System prompt for the orchestration manager (Magentic / LLM group-chat "
            "selector). When set, it is applied as the manager agent's instructions; "
            "when empty, the framework's built-in Magentic-One prompts are used. "
            "Only meaningful for orchestration types that use a manager (magentic, "
            "and group_chat with LLM-based selection)."
        ),
    )
    manager_name: str | None = Field(
        None,
        description=(
            "Display name for the orchestration manager agent (defaults to "
            "'orchestrator'). Only meaningful for manager-based orchestration types."
        ),
    )
    manager_max_tokens: int | None = Field(
        None,
        gt=0,
        description=(
            "Max output tokens for the orchestration manager agent. Only meaningful "
            "for manager-based orchestration types (magentic, group_chat with LLM "
            "selection, triage)."
        ),
    )
    graph: dict[str, Any] = Field(
        default_factory=dict,
        description="Graph definition for graph_flow orchestration",
    )


class SemanticKernelSection(BaseModel):
    """Top-level agent-definition configuration consumed by the agent adapter.

    .. note::
        The section key (``semantic_kernel``) and this class name are retained
        for backward compatibility with stored team configs and the
        config-service wire format. The schema is **framework-agnostic** and is
        read by the Microsoft Agent Framework (``maf``) adapter; it is not tied
        to Semantic Kernel.

    Supports both single-agent and multi-agent workflows with configurable
    orchestration, per-agent model settings, and MCP tool integration.

    Attributes:
        agents: List of agent definitions. Defaults to a single ``"default"`` agent.
        orchestration: Orchestration configuration.
        default_function_choice_behavior: Default for all agents.
        chat_history_reducer: ``"summarize"`` or ``None``.
        chat_history_max_messages: Max messages before reduction.
        enable_telemetry: Telemetry/tracing toggle.
        enable_sensitive_telemetry: Also capture prompt/completion content on spans.
        session_ttl_seconds: TTL in seconds for stale conversation thread instances.

    Example env vars:
        - ``AGENT_SEMANTIC_KERNEL__ENABLE_TELEMETRY=true``
        - ``AGENT_SEMANTIC_KERNEL__CHAT_HISTORY_MAX_MESSAGES=200``
    """

    model_config = ConfigDict(frozen=True, extra="allow")

    agents: list[SKAgentDefinition] = Field(
        default_factory=lambda: [SKAgentDefinition(name="default")],  # type: ignore[call-arg]
        description="Agent definitions",
    )
    orchestration: OrchestrationConfig = Field(
        default_factory=lambda: OrchestrationConfig(),  # type: ignore[call-arg]
        description="Orchestration configuration",
    )
    default_function_choice_behavior: str = Field(
        "auto", description="Default function choice behavior for all agents"
    )
    chat_history_reducer: dict[str, Any] | None = Field(
        None,
        description=(
            "Chat history reducer config with type, trigger_at, keep_recent, summary_model"
        ),
    )
    chat_history_max_messages: int = Field(
        100, ge=1, le=10000, description="Max messages before reduction"
    )
    enable_telemetry: bool = Field(False, description="Telemetry/tracing toggle")
    enable_sensitive_telemetry: bool = Field(
        False,
        description=(
            "When telemetry is on, also capture prompt/completion message content "
            "on gen_ai spans (Agent Framework enable_sensitive_data). Off by "
            "default because message bodies may contain PII."
        ),
    )
    session_ttl_seconds: int = Field(
        3600, ge=60, le=86400, description="TTL in seconds for stale AgentThread instances"
    )


# ---------------------------------------------------------------------------
# Root config model
# ---------------------------------------------------------------------------


class AgentConfig(BaseModel):
    """Root configuration model — validated after 3-tier merge.

    Compose all section models into a single validated configuration object.
    After :meth:`~agent_service_maf.config.config_loader.ConfigLoader.resolve`
    returns an instance of this class, it is **frozen** (immutable).

    Locked fields (cannot be overridden per-request):
      - ``agent.framework``
      - ``project_id``

    Attributes:
        agent: Agent execution settings.
        interface: API interface settings including auth and streaming limits.
        gateway: LLM gateway connection settings.
        guardrails: Guardrail pipeline configuration.
        mcp: MCP client integration settings.
        logging: Logging settings.

    Example:
        >>> config = AgentConfig()            # all defaults
        >>> config.agent.model
        'anthropic/claude-sonnet-4-20250514'
        >>> config.interface.auth.enabled
        False
        >>> config.interface.streaming.max_duration_seconds
        300
    """

    model_config = ConfigDict(extra="allow", frozen=True)

    #: Fields that CANNOT be overridden per-request.  Enforced by ConfigLoader.
    #: ``interface.host`` / ``interface.port`` were previously locked but the
    #: service bind is driven by the uvicorn launcher's CLI flags, not the
    #: config layer — locking them was defense against a non-existent
    #: attack surface.
    locked_fields: list[str] = Field(
        default=["agent.framework", "project_id"],
        description=(
            "Fields that cannot be overridden per-request. "
            "Modifying this list requires a server restart."
        ),
    )

    project_id: str | None = Field(
        default=None,
        description=(
            "UUID of the project this team belongs to. Required for team configs "
            "loaded from disk (enforced by team_loader); optional at the Pydantic "
            "level so AgentConfig() with no args remains constructible for tests."
        ),
    )

    agent: AgentSection = Field(
        default_factory=lambda: AgentSection(),  # type: ignore[call-arg]
        description="Agent execution settings",
    )
    interface: InterfaceSection = Field(
        default_factory=lambda: InterfaceSection(),  # type: ignore[call-arg]
        description="API interface settings",
    )
    gateway: GatewaySection = Field(
        default_factory=lambda: GatewaySection(),  # type: ignore[call-arg]
        description="LLM gateway connection settings",
    )
    guardrails: GuardrailSection = Field(
        default_factory=lambda: GuardrailSection(),  # type: ignore[call-arg]
        description="Guardrail pipeline configuration",
    )
    mcp: MCPSection = Field(
        default_factory=lambda: MCPSection(),  # type: ignore[call-arg]
        description="MCP client integration settings",
    )
    memory: MemorySection = Field(
        default_factory=lambda: MemorySection(),  # type: ignore[call-arg]
        description="Session memory and token budget settings",
    )
    tasks: TasksSection = Field(
        default_factory=lambda: TasksSection(),  # type: ignore[call-arg]
        description="Async-invoke task store settings",
    )
    logging: LoggingSection = Field(
        default_factory=lambda: LoggingSection(),  # type: ignore[call-arg]
        description="Logging settings",
    )
    semantic_kernel: SemanticKernelSection = Field(
        default_factory=lambda: SemanticKernelSection(),  # type: ignore[call-arg]
        description=(
            "Agent-definition configuration (agents, orchestration, MCP). The "
            "key name is retained for back-compat; the schema is framework-agnostic."
        ),
    )
