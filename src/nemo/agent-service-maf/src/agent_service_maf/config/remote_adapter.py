"""Schema translation between config-service payloads and MAF's nested
``AgentConfig`` shape.

Two source granularities are translated here:

- **Agent record** → entry in ``semantic_kernel.agents[]``. Used directly for
  ``/projects/{pid}/agents/{aid}/invoke`` (wrapped in a synthetic
  single-agent team) and recursively when fanning out a team's ``members[]``.
- **Team record** → full MAF payload that ``ConfigLoader`` can validate. The
  team's ``members[]`` list contains agent IDs only; the actual agent dicts
  are spliced in by the caller and passed to :func:`team_blob_to_maf_payload`.

The translation is intentionally permissive — config-service may grow new
fields, drop old ones, or rename ``modelId``/``model_id``. The mapper falls
back to MAF defaults whenever a required field is absent so an under-specified
record still loads (and surfaces the resulting validation error through
``ConfigLoader`` on the same code path as today's file-loaded payloads).

These helpers do NOT call into ``ConfigLoader`` or build a ``TeamBundle``.
They produce a MAF-shaped dict that the caller hands to
``ConfigLoader(json_config_data=...).resolve()``.
"""

from __future__ import annotations

import contextlib
import json
import re
from typing import Any

import structlog

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Field accessors — accept both snake_case and camelCase (config-service uses
# camelCase historically; MAF uses snake_case). The mapper checks both so the
# same code works against the agent-service flat shape AND a future MAF-shaped
# endpoint.
# ---------------------------------------------------------------------------


def _pick(
    payload: dict[str, Any],
    *keys: str,
    default: Any = None,  # noqa: ANN401  # accepts any sentinel
) -> Any:  # noqa: ANN401  # returns whatever was stored under the picked key
    """Return the first non-None value in ``payload`` for any of ``keys``.

    Used so a mapper can write ``_pick(rec, "model_id", "modelId")`` once
    instead of repeating the camelCase/snake_case ladder at every field.
    """
    for k in keys:
        if k in payload and payload[k] is not None:
            return payload[k]
    return default


def _coerce_list(value: Any) -> list[Any]:  # noqa: ANN401
    """Coerce ``value`` to a list. Returns ``[]`` for ``None``, wraps a scalar."""
    if value is None:
        return []
    if isinstance(value, list):
        return list(value)
    return [value]


def _coerce_dict(value: Any) -> dict[str, Any]:  # noqa: ANN401
    """Coerce ``value`` to a dict; ``None`` → empty."""
    if isinstance(value, dict):
        return dict(value)
    return {}


def _extract_allowed_tools_by_server(
    mcp_server_config: Any,  # noqa: ANN401
    linked_server_ids: list[Any],
) -> dict[str, list[str]]:
    """Derive ``SKAgentDefinition.allowed_tools_by_server`` from the agent record.

    Config-service stores per-server tool whitelists on
    ``Agent.mcpServerConfig[serverId].allowedTools``. Without this, MAF only sees
    ``mcpServerIds`` and exposes every tool on every linked server -- silently
    ignoring the user's per-tool selection in the UI.

    Lenient on shape (the field is jsonb and the override is optional):

    * non-dict ``mcp_server_config`` → ``{}``
    * server not in ``linked_server_ids`` → skipped (a stale override for a
      server the agent has since unlinked must not resurrect tools)
    * ``allowedTools`` missing / not a list / empty → server omitted (means
      "no per-tool restriction" — fall back to all tools on the server)
    * non-string entries in ``allowedTools`` → dropped
    """
    if not isinstance(mcp_server_config, dict):
        return {}
    linked = {str(s) for s in linked_server_ids if s is not None}
    result: dict[str, list[str]] = {}
    for server_id, override in mcp_server_config.items():
        if not isinstance(override, dict) or str(server_id) not in linked:
            continue
        allowed = override.get("allowedTools")
        if allowed is None:
            allowed = override.get("allowed_tools")
        if not isinstance(allowed, list) or not allowed:
            continue
        cleaned = [str(t) for t in allowed if isinstance(t, str) and t]
        if cleaned:
            result[str(server_id)] = cleaned
    return result


def _model_display_name_from_value(model_value: Any) -> str | None:  # noqa: ANN401
    """User-facing model label from a config-service model dict (registration name)."""
    if not isinstance(model_value, dict):
        return None
    for key in ("displayName", "display_name", "name"):
        raw = model_value.get(key)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
    return None


# ---------------------------------------------------------------------------
# Memory schema translation
# ---------------------------------------------------------------------------


# config-service contextStrategy values that imply LLM-backed summarization.
_SUMMARY_STRATEGIES: frozenset[str] = frozenset({"summary_buffer", "summarize", "hybrid"})


def translate_memory_blob(
    memory_type: Any,  # noqa: ANN401  # comes in as None | str
    memory_config: Any,  # noqa: ANN401  # comes in as None | dict
) -> dict[str, Any]:
    """Translate config-service's memory schema to MAF's ``MemorySection``.

    Config-service stores two fields on each agent/team record:

    - ``memoryType``: ``"none" | "conversation" | "sliding_window"`` — the
      top-level toggle that controls whether memory is enabled and
      whether it's summary-backed.
    - ``memoryConfig``: nested dict with ``windowSize``, ``contextStrategy``,
      ``summaryModel``, ``verbatimTurns`` (all camelCase).

    MAF's ``MemorySection`` (``validators.py``) reads snake_case keys:
    ``enabled``, ``buffer_type``, ``max_history_length``, ``summary_model``.
    ``MemorySection`` has ``extra="allow"`` so unknown camelCase keys are
    silently accepted and ignored — which is why every memory variant
    team historically ran with MAF defaults regardless of UI config.

    This helper bridges the two schemas. Unknown / missing fields fall
    through so MAF's env-var defaults still win.

    Args:
        memory_type: Top-level ``memoryType`` from the team / agent record.
        memory_config: Nested ``memoryConfig`` dict from the same record.

    Returns:
        A snake_case dict suitable for merging into the MAF payload's
        ``memory`` section. Empty if there's nothing to translate (the
        caller should then let env defaults win).
    """
    cfg = _coerce_dict(memory_config)
    out: dict[str, Any] = {}

    mtype = (memory_type or "").strip().lower() if isinstance(memory_type, str) else ""

    if mtype == "none":
        out["enabled"] = False
        # No further fields matter once disabled.
        return out

    if mtype:
        out["enabled"] = True

    # Resolve buffer_type. ``memoryType=conversation`` plus a summary-style
    # contextStrategy means the summary buffer; everything else falls
    # back to sliding_window.
    strategy_raw = _pick(cfg, "contextStrategy", "context_strategy", default="")
    strategy = strategy_raw.strip().lower() if isinstance(strategy_raw, str) else ""
    if mtype == "conversation" and strategy in _SUMMARY_STRATEGIES:
        out["buffer_type"] = "summary"
    elif mtype == "sliding_window":
        out["buffer_type"] = "sliding_window"
    elif mtype == "conversation":
        # Conversation memory without a summary strategy is just a
        # plain sliding window.
        out["buffer_type"] = "sliding_window"

    # windowSize → max_history_length. ``verbatimTurns`` is config-service's
    # synonym for "how many recent turns to keep verbatim under a summary
    # buffer"; if both are present, ``windowSize`` wins, otherwise
    # ``verbatimTurns`` fills in.
    window_size = _pick(cfg, "windowSize", "window_size")
    verbatim = _pick(cfg, "verbatimTurns", "verbatim_turns")
    if isinstance(window_size, int) and window_size > 0:
        out["max_history_length"] = window_size
    elif isinstance(verbatim, int) and verbatim > 0:
        out["max_history_length"] = verbatim

    # summaryModel → summary_model (only meaningful when buffer is summary,
    # but pass it through unconditionally so the MemorySection validator
    # sees the operator's intent).
    summary_model = _pick(cfg, "summaryModel", "summary_model")
    if isinstance(summary_model, str) and summary_model:
        out["summary_model"] = summary_model

    # Pass any already-snake_case keys through verbatim so an
    # already-translated payload (or a hand-written team JSON) still
    # works. We do this last so explicit snake_case keys win.
    for k in (
        "enabled",
        "buffer_type",
        "max_history_length",
        "max_chars_per_session",
        "max_tokens_per_session",
        "summary_model",
        "summarizer_timeout_seconds",
        "summary_max_tokens",
        "storage_backend",
        "ttl_seconds",
    ):
        if k in cfg and cfg[k] is not None:
            out[k] = cfg[k]

    return out


# ---------------------------------------------------------------------------
# New unified MemoryContext schema → MemorySection
# ---------------------------------------------------------------------------
# config-service ships ``memoryContext`` on agent + team records as the new
# source of truth. The wire shape (locked in the memory-context design):
#
#     {
#       enabled: bool,
#       type: 'none' | 'window' | 'summary' | 'summary_buffer',
#       message_window_limit?: int,           # messages, not turns
#       message_token_limit?: int,            # wins over window_limit when set
#       summary_token_limit?: int,
#       summary_refresh_every_turns?: int,
#       summary_model?: str,
#       adaptive_summarize?: { overflow_threshold: float },
#       budget?: {
#         tool_round_reservation?: int,
#         output_reservation?: int,
#         safety_buffer_pct?: float,
#       },
#     }
#
# Stage 2 (this function) maps the public schema onto MAF's existing
# ``MemorySection`` fields where they overlap (``buffer_type``,
# ``max_history_length``, ``max_tokens_per_session``, ``summary_model``,
# ``summary_max_tokens``). New fields with no MemorySection equivalent
# yet (``summary_refresh_every_turns``, ``adaptive_summarize``, ``budget``)
# pass through as-is — ``MemorySection`` has ``extra="allow"`` so they're
# accepted and visible to ``team_loader`` for Stage 3 enforcement.

#: Mapping from public memoryContext.type to MAF's runtime buffer_type.
#: ``summary`` and ``summary_buffer`` both land on the same buffer impl
#: today (SummaryBuffer already keeps a verbatim tail); Stage 3 may
#: differentiate them via ``adaptive_summarize`` and verbatim sizing.
_MEMORY_TYPE_TO_BUFFER_TYPE: dict[str, str] = {
    "window": "sliding_window",
    "summary": "summary",
    "summary_buffer": "summary",
}

# Defaults applied when MemoryContext fields are absent. Must match the
# constants in config-service's MemoryContextDerivation.ts so both
# code paths produce the same values regardless of which side filled them.
_DEFAULT_MESSAGE_WINDOW_LIMIT = 20
_DEFAULT_SUMMARY_TOKEN_LIMIT = 2000
_DEFAULT_SUMMARY_REFRESH_EVERY_TURNS = 0


def _legacy_agent_memory_context_to_new(ctx: dict[str, Any]) -> dict[str, Any]:
    """Convert a legacy ``AgentMemoryContext`` dict to the new shape.

    The legacy shape (from the original Figma "Conversation memory and
    context" panel) used ``message_retention_policy`` + ``message_history_limit``
    with NO ``type`` field. Existing agent rows persisted before config-service's
    Stage 4 derivation lands still carry this. Mirror config-service's
    ``normalizeMemoryContextInput`` for parity:

      * ``message_retention_policy='none'``   → ``type='none'``, ``enabled=False``
      * ``message_retention_policy='sliding_window'``  → ``type='window'``,
        ``message_window_limit=message_history_limit``
      * ``message_retention_policy='summarize'``       → ``type='summary_buffer'``,
        ``message_window_limit=message_history_limit``
      * ``message_history_limit=0`` or ``enabled=False``  → disabled

    ``session_history_limit`` is dropped — out of scope for the new schema.
    """
    enabled = ctx.get("enabled") is not False
    policy_raw = ctx.get("message_retention_policy")
    policy = policy_raw.strip().lower() if isinstance(policy_raw, str) else ""
    limit_raw = ctx.get("message_history_limit")
    limit = limit_raw if isinstance(limit_raw, int) else None

    if not enabled or policy == "none" or limit == 0:
        return {"enabled": False, "type": "none"}

    if policy == "summarize":
        out: dict[str, Any] = {"enabled": True, "type": "summary_buffer"}
        if isinstance(limit, int) and limit > 0:
            out["message_window_limit"] = limit
        return out

    # Default to window for sliding_window or unrecognised policy values.
    out = {"enabled": True, "type": "window"}
    if isinstance(limit, int) and limit > 0:
        out["message_window_limit"] = limit
    return out


def translate_memory_context(
    memory_context: Any,  # noqa: ANN401  # comes in as None | dict
) -> dict[str, Any]:
    """Translate the new ``memoryContext`` schema to MAF's ``MemorySection``.

    Returns an empty dict when the input is missing or empty so the caller
    can fall through to the legacy translator or the default. Returns a
    dict with ``enabled=False`` when memory is explicitly disabled
    (``enabled: false`` or ``type: 'none'``); the caller should respect
    that (it's not "missing data", it's an explicit opt-out).

    Args:
        memory_context: The ``memoryContext`` dict from a team or agent
            record. May be ``None`` or non-dict; both yield ``{}``.

    Returns:
        A snake_case dict for merging into the MAF payload's ``memory``
        section. Field semantics:

        - ``enabled``: ``False`` when disabled; ``True`` (or absent) otherwise.
        - ``buffer_type``: ``'sliding_window'`` for ``type='window'``;
          ``'summary'`` for ``'summary'`` / ``'summary_buffer'``.
        - ``max_history_length``: from ``message_window_limit``.
        - ``max_tokens_per_session``: from ``message_token_limit``. Wins
          over ``max_history_length`` per the locked tiebreaker — both
          fields are emitted; the buffer prefers the token limit when set.
        - ``summary_max_tokens``: from ``summary_token_limit``.
        - ``summary_model``: passed through (resolved by team_loader).
        - ``summary_refresh_every_turns``: passed through verbatim.
        - ``adaptive_summarize``: passed through verbatim (Stage 3 reads it).
        - ``budget``: passed through verbatim (Stage 3 reads it).
    """
    ctx = _coerce_dict(memory_context)
    if not ctx:
        return {}

    # Backward-compat: existing rows may carry the legacy AgentMemoryContext
    # shape (`message_retention_policy` + `message_history_limit`, no `type`
    # field). Normalize it to the new shape before translation so DB rows
    # written before config-service's Stage 4 derivation lands still resolve.
    if "type" not in ctx and "message_retention_policy" in ctx:
        ctx = _legacy_agent_memory_context_to_new(ctx)
        if not ctx:
            return {}

    out: dict[str, Any] = {}

    # Explicit disable → enabled=False, short-circuit.
    enabled_raw = ctx.get("enabled")
    if enabled_raw is False:
        return {"enabled": False}

    raw_type = ctx.get("type")
    mtype = raw_type.strip().lower() if isinstance(raw_type, str) else ""
    if mtype == "none":
        return {"enabled": False}

    # From here on, memory is enabled. Default true if not specified.
    out["enabled"] = True if enabled_raw is None else bool(enabled_raw)

    if mtype in _MEMORY_TYPE_TO_BUFFER_TYPE:
        out["buffer_type"] = _MEMORY_TYPE_TO_BUFFER_TYPE[mtype]

    # message_window_limit → max_history_length (messages, not turns).
    # `window` and `summary_buffer` default to DEFAULT_MESSAGE_WINDOW_LIMIT
    # when the field is absent so the buffer always has a concrete limit.
    msg_window = ctx.get("message_window_limit")
    if isinstance(msg_window, int) and msg_window >= 0:
        out["max_history_length"] = msg_window
    elif mtype in ("window", "summary_buffer"):
        out["max_history_length"] = _DEFAULT_MESSAGE_WINDOW_LIMIT

    # message_token_limit → max_tokens_per_session.
    # Per the locked tiebreaker rule, both fields are emitted when both are
    # set; the runtime buffer prefers the token limit when non-zero.
    msg_tokens = ctx.get("message_token_limit")
    if isinstance(msg_tokens, int) and msg_tokens >= 0:
        out["max_tokens_per_session"] = msg_tokens

    # summary_token_limit → summary_max_tokens. Defaults to
    # DEFAULT_SUMMARY_TOKEN_LIMIT for summary / summary_buffer types so
    # the SummaryBuffer always receives a concrete cap.
    summary_tokens = ctx.get("summary_token_limit")
    if isinstance(summary_tokens, int) and summary_tokens > 0:
        out["summary_max_tokens"] = summary_tokens
    elif mtype in ("summary", "summary_buffer"):
        out["summary_max_tokens"] = _DEFAULT_SUMMARY_TOKEN_LIMIT

    # summary_model: pass through. team_loader resolves UUID → provider/name
    # via the existing ``_resolve_summary_model`` chain (manager → first
    # agent → framework default).
    summary_model = ctx.get("summary_model")
    if isinstance(summary_model, str) and summary_model:
        out["summary_model"] = summary_model

    # summary_refresh_every_turns: pass through, with default cadence of 0
    # (always summarize on overflow). Only emitted for summary types.
    refresh = ctx.get("summary_refresh_every_turns")
    if isinstance(refresh, int) and refresh > 0:
        out["summary_refresh_every_turns"] = refresh
    elif mtype in ("summary", "summary_buffer"):
        out["summary_refresh_every_turns"] = _DEFAULT_SUMMARY_REFRESH_EVERY_TURNS

    # adaptive_summarize: pass through nested. Stage 3 reads it.
    adaptive = ctx.get("adaptive_summarize")
    if isinstance(adaptive, dict) and adaptive:
        out["adaptive_summarize"] = adaptive

    # budget: pass through nested. Stage 3 reads it for token-budget
    # subtraction before history slicing.
    budget = ctx.get("budget")
    if isinstance(budget, dict) and budget:
        out["budget"] = budget

    return out


# Absolute fallback when neither memoryContext nor legacy fields carry any
# memory config. Matches the locked decision (20 messages, sliding window).
_DEFAULT_MEMORY_FALLBACK: dict[str, Any] = {
    "enabled": True,
    "buffer_type": "sliding_window",
    "max_history_length": 20,
}


def resolve_memory(record: dict[str, Any]) -> dict[str, Any]:
    """Dual-read memory resolution for a team or agent record.

    Resolution order (per the locked memory-context design):

    1. ``memoryContext`` (new schema) — if present and non-empty, use it.
       An explicit ``enabled: false`` or ``type: 'none'`` is honored here
       and short-circuits the chain.
    2. Legacy ``memoryType`` + ``memoryConfig`` — derived via
       :func:`translate_memory_blob` when (1) yields nothing.
    3. Absolute default — ``{type: 'window', limit: 20}`` when neither
       source carries any memory configuration.

    The chain means existing data (legacy fields only, no memoryContext)
    keeps working unchanged: no backfill is required at the DB layer.

    Args:
        record: The team blob or agent record (a dict from config-service).

    Returns:
        A snake_case dict suitable for the MAF payload's ``memory`` section.
    """
    # Tier 1 — new memoryContext schema
    ctx = _pick(record, "memoryContext", "memory_context")
    translated = translate_memory_context(ctx)
    if translated:
        return translated

    # Tier 2 — legacy memoryType + memoryConfig
    legacy = translate_memory_blob(
        memory_type=_pick(record, "memoryType", "memory_type"),
        memory_config=_pick(record, "memory", "memoryConfig", default={}),
    )
    if legacy:
        return legacy

    # Tier 3 — absolute default
    return dict(_DEFAULT_MEMORY_FALLBACK)


# ---------------------------------------------------------------------------
# Agent record → SK agent entry
# ---------------------------------------------------------------------------


def agent_record_to_sk_agent(
    agent_record: dict[str, Any],
    member_overrides: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Map a config-service agent record → MAF ``semantic_kernel.agents[]`` entry.

    Recognized field aliases (config-service ↔ MAF):

    ===========================  =======================================
    Config-service (any of)      MAF target
    ===========================  =======================================
    ``id`` / ``agent_id``        ``name`` (fallback when ``name`` absent)
    ``name``                     ``name``
    ``description``              ``description``
    ``instructions`` /            ``instructions``
      ``systemPrompt`` /
      ``system_prompt``
    ``model`` / ``modelId`` /     ``model``
      ``model_id``
    ``modelAlias`` /              ``model_alias``  (passed through; SK
      ``model_alias``               adapter may ignore)
    ``temperature``               ``temperature``
    ``maxTokens`` / ``max_tokens``  ``max_tokens``
    ``mcpServerIds`` /             ``mcp_servers``
      ``mcp_servers``
    ``tools``                     ``tools``
    ``structuredOutput.``          ``response_format`` +
      ``responseFormat`` +          ``output_schema`` (json_object) or
      ``structuredOutput.``          appended ``instructions`` (text).
      ``outputSchema``               Only when ``structuredOutput.enabled``;
                                     the deprecated top-level
                                     ``outcomeSchema`` is no longer read.
    ``functionChoiceBehavior`` /   ``function_choice_behavior``
      ``function_choice_behavior``
    ``skipPostToolSynthesis`` /    ``skip_post_tool_synthesis``
      ``skip_post_tool_synthesis``   (defaults to ``False`` when absent
                                     — config-service does not model
                                     this field yet)
    ===========================  =======================================

    Args:
        agent_record: The raw payload from config-service.
        member_overrides: Optional per-member overrides supplied by the
            team blob (e.g. a member-specific ``role`` or ``description``).
            Applied last so they win over the agent record's defaults.

    Returns:
        A dict shaped for MAF's ``SKAgentDefinition`` Pydantic model.
    """
    raw_name = (
        _pick(agent_record, "name") or _pick(agent_record, "id", "agent_id", "agentId") or "agent"
    )
    # SK / MAF's agent name validator only accepts ``^[a-zA-Z0-9_-]{1,64}$``
    # (see ``agent_builder._validate_agent_name``) because the name is used as
    # an SK KernelPlugin identifier downstream. The UI allows spaces and other
    # display-friendly characters, so sanitize verbatim here: collapse every
    # invalid char into ``_`` and truncate to 64 chars. The original
    # human-friendly label is preserved via ``description``.
    sanitised_name = re.sub(r"[^a-zA-Z0-9_-]", "_", str(raw_name))[:64] or "agent"
    raw_description = _pick(agent_record, "description", default="") or ""
    # Prepend the original name to description when sanitisation changed it,
    # so operators can still trace UI → engine identity.
    if sanitised_name != str(raw_name) and not str(raw_description):
        raw_description = f"({raw_name})"

    sk_agent: dict[str, Any] = {
        "name": sanitised_name,
        "description": str(raw_description),
        "instructions": str(
            _pick(
                agent_record,
                "instructions",
                "systemPrompt",
                "system_prompt",
                default="",
            )
            or ""
        ),
        "tools": _coerce_list(_pick(agent_record, "tools", default=[])),
        "mcp_servers": _coerce_list(
            _pick(agent_record, "mcp_servers", "mcpServerIds", "mcpServers", default=[])
        ),
        "allowed_tools_by_server": _extract_allowed_tools_by_server(
            _pick(agent_record, "mcp_server_config", "mcpServerConfig", default={}),
            _coerce_list(
                _pick(agent_record, "mcp_servers", "mcpServerIds", "mcpServers", default=[])
            ),
        ),
        "function_choice_behavior": _pick(
            agent_record,
            "function_choice_behavior",
            "functionChoiceBehavior",
            default="auto",
        ),
    }

    # Config-service either inlines the raw catalog UUID on ``modelId`` or
    # expands the field into a resolved model dict carrying the
    # Bifrost-routable ``gatewayModelId``. The SK adapter needs the routable
    # form (e.g. ``azure/projXX_credYY_gpt-4``); a bare provider name or a
    # catalog UUID will not resolve at the Bifrost gateway. Mirror the VK
    # resolver's loud-failure stance: a missing ``gatewayModelId`` is a
    # config-service bug (model not registered with Bifrost yet), and
    # silently sending ``providerModelId`` or the UUID downstream just
    # converts a clear failure into a confusing one.
    raw_model = _pick(agent_record, "model", "modelId", "model_id")
    model_display_name = _model_display_name_from_value(raw_model)
    model = raw_model
    if isinstance(model, dict):
        gateway_id = model.get("gatewayModelId")
        if not gateway_id:
            raise ValueError(
                f"agent_record_to_sk_agent: agent {sanitised_name!r} references model "
                f"{model.get('id')!r} which has no `gatewayModelId`. "
                "Config-service computes `gatewayModelId` when the model is "
                "registered with Bifrost — check that registration completed "
                "for this project."
            )
        model = gateway_id
    if model is not None:
        sk_agent["model"] = str(model)
    if model_display_name:
        sk_agent["model_display_name"] = model_display_name

    temperature = _pick(agent_record, "temperature")
    if temperature is not None:
        sk_agent["temperature"] = float(temperature)

    max_tokens = _pick(agent_record, "max_tokens", "maxTokens")
    if max_tokens is not None:
        sk_agent["max_tokens"] = int(max_tokens)

    # Structured output. The config-service ``structuredOutput`` card carries:
    #
    #   enabled        - feature flag; when false/absent we install nothing
    #   responseFormat - "text" | "json_object"
    #   outputSchema   - a STRING: a JSON Schema serialized as a string
    #                    (json_object) or free-form text guidelines (text)
    #
    # ``response_format`` is stamped only when the card is enabled so a
    # disabled card never trips ``expect_json`` downstream. For
    # ``json_object`` the schema string is parsed into the dict that
    # SKAgentDefinition expects; malformed JSON is logged and skipped rather
    # than crashing the build. For ``text`` the guidelines are appended to the
    # agent instructions below (after member overrides, so an override cannot
    # silently drop them).
    text_output_guidelines: str | None = None
    structured = _pick(agent_record, "structuredOutput", "structured_output")
    if isinstance(structured, dict) and structured.get("enabled"):
        response_format = structured.get("responseFormat") or structured.get("response_format")
        if response_format:
            sk_agent["response_format"] = response_format
        output_schema_raw = structured.get("outputSchema")
        if output_schema_raw is None:
            output_schema_raw = structured.get("output_schema")
        if isinstance(output_schema_raw, str) and output_schema_raw.strip():
            if response_format == "json_object":
                try:
                    sk_agent["output_schema"] = json.loads(output_schema_raw)
                except json.JSONDecodeError:
                    logger.warning(
                        "structured_output_schema_invalid_json_ignored",
                        agent_name=sk_agent.get("name"),
                    )
            elif response_format == "text":
                text_output_guidelines = output_schema_raw.strip()

    # ``skip_post_tool_synthesis`` is a MAF runtime switch (default False
    # in SKAgentDefinition). Config-service does not yet model this knob,
    # so we always stamp the False default explicitly. Once config-service
    # grows a ``skipPostToolSynthesis`` / ``skip_post_tool_synthesis``
    # field, this passthrough will pick it up automatically.
    skip_post_tool = _pick(agent_record, "skip_post_tool_synthesis", "skipPostToolSynthesis")
    sk_agent["skip_post_tool_synthesis"] = (
        bool(skip_post_tool) if skip_post_tool is not None else False
    )

    # Member overrides (role, description, etc.) win over agent defaults.
    # The team blob is the more specific source for cross-cutting metadata
    # like "this agent plays the manager role in this particular team".
    if member_overrides:
        for key in ("role", "description", "instructions"):
            value = member_overrides.get(key)
            if value is not None and value != "":
                sk_agent[key] = value

    # Text-mode structured output: inject the free-form output guidelines into
    # the system prompt so the model follows them. Done after member overrides
    # so an ``instructions`` override does not drop the guidelines.
    if text_output_guidelines:
        base_instructions = sk_agent.get("instructions") or ""
        header = "Output format guidelines:"
        sk_agent["instructions"] = (
            f"{base_instructions}\n\n{header}\n{text_output_guidelines}"
            if base_instructions
            else f"{header}\n{text_output_guidelines}"
        )

    return sk_agent


# ---------------------------------------------------------------------------
# MCP-server record → MAF inline server config
# ---------------------------------------------------------------------------


def derive_mcp_base_url(gateway_url: str) -> str:
    """Derive the Bifrost MCP-proxy base URL from the gateway URL.

    Bifrost serves MCP at a single aggregated ``/mcp`` endpoint at the
    server **root** — not nested under the OpenAI-compat path. The
    typical ``AGENT_GATEWAY__URL`` carries an OpenAI subpath like
    ``/litellm/v1`` (for chat-completions); we strip the full subpath
    and append ``/mcp`` so the MCP proxy URL lands at the root.

    Legacy reference: ``agent-service/src/llmproxy_gateway_settings.py:
    mcp_url_for_server`` returns ``f"{base}/mcp"`` from the bare gateway
    base — same shape.

    Examples::

        http://bifrost:4001/litellm/v1   → http://bifrost:4001/mcp
        http://bifrost:4001/v1           → http://bifrost:4001/mcp
        http://bifrost:4001              → http://bifrost:4001/mcp
        http://bifrost:4001/             → http://bifrost:4001/mcp
    """
    base = gateway_url.rstrip("/")
    # Strip the longest known OpenAI-compat subpath suffix so what's left
    # is the bare host[:port]. Order matters: ``/litellm/v1`` first so a
    # bare ``/v1`` URL isn't accidentally turned into ``/litellm/mcp``
    # later.
    for suffix in ("/litellm/v1", "/v1"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    return base + "/mcp"


def mcp_server_record_to_inline_config(
    record: dict[str, Any],
    *,
    mcp_base_url: str,
) -> dict[str, Any] | None:
    """Map a config-service MCP-server record → MAF inline ``mcp_servers[]`` entry.

    All MCP traffic from MAF goes through Bifrost's **single aggregated
    `/mcp` endpoint**. Bifrost multiplexes every registered MCP client
    behind that one URL and namespaces tool names with the client's
    ``gatewayServerName`` prefix (e.g. ``projXY_weather-get_forecast``).

    The adapter therefore:

    * Sets ``url = mcp_base_url`` (no per-server path segment — appending
      ``/<gatewayServerName>`` makes Bifrost return ``405 Method Not
      Allowed``, since the proxy lives at the bare ``/mcp`` route).
    * Emits ``gateway_server_name`` as a standalone field so the MCP
      manager can prefix-filter the aggregated tool list down to just
      this server's tools, and re-prefix on dispatch when calling back
      through Bifrost.

    Legacy parity: ``agent-service/src/llmproxy_gateway_settings.py:
    mcp_url_for_server(_server_name)`` returns ``f"{base}/mcp"`` (the
    leading underscore on the argument is intentional — Bifrost's URL
    is server-name-independent).

    Fields mapped:

    ===========================  =======================================
    Config-service                MAF inline config
    ===========================  =======================================
    ``name``                      ``name`` (REQUIRED — agent uses this
                                  to reference the server)
    ``gatewayServerName``         ``gateway_server_name`` (REQUIRED —
      / ``gateway_server_name``   the Bifrost client name, used as the
                                  tool-name prefix for filter + dispatch)
    ``transport``                 ``transport`` (``streamable-http`` /
                                  ``sse`` / ``stdio``)
    ``command``, ``args``,        ``command``, ``args``, ``env`` —
      ``env``                       only meaningful for stdio transport
    ``timeout`` (ms)              ``timeout_seconds`` (s, ÷1000)
    ``staticHeaders`` +           ``headers`` (merged)
      ``extraHeaders``
    ``allowedTools``              ``allowed_tools``
    ``disallowedTools``           ``disallowed_tools``
    ===========================  =======================================

    Returns ``None`` when the record lacks ``name`` or
    ``gatewayServerName`` — both are required to produce a usable
    binding. ``record["url"]`` is never read.
    """
    if not isinstance(record, dict):
        return None
    name = _pick(record, "name")
    if not name:
        return None

    gateway_server = _pick(
        record,
        "llmproxyGatewayServerName",
        "gatewayServerName",
        "gateway_server_name",
    )
    if not gateway_server:
        # No fallback — a record without a gateway-registered name is
        # not reachable through the Bifrost MCP proxy. Caller logs the
        # skip as a composition warning so operators can spot it on
        # /agent-teams.
        return None

    out: dict[str, Any] = {
        "name": str(name),
        "enabled": True,
        "url": mcp_base_url.rstrip("/"),
        "gateway_server_name": str(gateway_server),
    }

    transport = _pick(record, "transport")
    if transport:
        # config-service accepts "http" as a synonym for "streamable-http"
        # (both go through MCP over HTTP); MAF's MCPServerConfig validator
        # only recognises the canonical "streamable-http" name.
        if transport == "http":
            transport = "streamable-http"
        out["transport"] = str(transport)

    # stdio transport carries command/args/env instead of a URL.
    command = _pick(record, "command")
    if command:
        out["command"] = str(command)
    args = _pick(record, "args")
    if isinstance(args, list):
        out["args"] = list(args)
    env = _pick(record, "env")
    if isinstance(env, dict):
        out["env"] = dict(env)

    # `timeout` from config-service is milliseconds; MAF wants seconds.
    timeout_ms = _pick(record, "timeout")
    if timeout_ms is not None:
        with contextlib.suppress(TypeError, ValueError):
            out["timeout_seconds"] = max(1, int(int(timeout_ms) / 1000))

    # Headers: merge staticHeaders + extraHeaders into a single dict.
    headers: dict[str, str] = {}
    for hkey in ("staticHeaders", "extraHeaders"):
        block = _pick(record, hkey)
        if isinstance(block, dict):
            for k, v in block.items():
                if isinstance(k, str) and v is not None:
                    headers[k] = str(v)
    if headers:
        out["headers"] = headers

    allowed = _pick(record, "allowedTools", "allowed_tools")
    if isinstance(allowed, list):
        out["allowed_tools"] = list(allowed)
    disallowed = _pick(record, "disallowedTools", "disallowed_tools")
    if isinstance(disallowed, list):
        out["disallowed_tools"] = list(disallowed)

    return out


# ---------------------------------------------------------------------------
# Knowledge-base record → MAF FunctionBinding (kb_retrieve)
# ---------------------------------------------------------------------------


#: Pattern that MAF's :class:`FunctionBinding.name` enforces. Anything
#: outside this character set has to be slugified before becoming a
#: binding name.
_BINDING_NAME_PATTERN = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


def _slugify_binding_name(raw: str, fallback: str) -> str:
    """Reduce a free-form string to a FunctionBinding-compatible name.

    Replaces unsupported characters with ``_`` and clamps length to 64.
    Falls back to ``fallback`` when nothing survives the sanitisation
    (which would otherwise produce an empty / invalid name).
    """
    cleaned = re.sub(r"[^a-zA-Z0-9_-]", "_", raw or "")
    cleaned = cleaned.strip("_-")
    if not cleaned:
        cleaned = fallback
    return cleaned[:64]


def knowledge_base_record_to_function_binding(
    record: dict[str, Any],
    *,
    project_id: str,
    rag_overrides: dict[str, Any] | None = None,
    default_top_k: int = 5,
    default_similarity_threshold: float = 0.5,
) -> dict[str, Any] | None:
    """Map a config-service KB record → MAF ``kb_retrieve`` binding.

    The binding becomes an LLM-callable tool whose fixed ``params``
    contain the KB id + project id; the LLM-supplied call args carry
    the user's query. MAF's registered ``kb_retrieve`` function reads
    these params at invocation time (see ``kb_retrieve.py:217``: it
    requires ``kbId`` and ``projectId`` in ``params``).

    Fields mapped:

    ===========================  =======================================
    Config-service               MAF FunctionBinding
    ===========================  =======================================
    ``id``                        ``params.kbId`` (REQUIRED)
    ``name``                      ``name`` (slugified to fit
                                  ``[a-zA-Z0-9_-]{1,64}``)
    ``description``               ``description`` (with a "Search the
                                  <name> knowledge base." prefix when
                                  the source description is empty)
    ===========================  =======================================

    Per-agent overrides (``rag_overrides``) come from
    ``agent.ragConfig[kbId]`` on the config-service Agent record. When
    provided they replace the static defaults; missing keys fall back
    to the defaults so partial configs stay safe:

    =============================  =====================================
    rag_overrides key              Effect on ``params``
    =============================  =====================================
    ``topK`` (int)                  Sets ``params.topK``.
    ``similarityThreshold`` (num)   Sets ``params.similarityThreshold``.
    ``similarityThresholdEnabled``  When ``False``, drops the threshold
        (bool)                      from ``params`` entirely so the
                                    upstream applies no minimum-score
                                    filter (its own default of 0).
    ``searchMode`` (str)            Sets ``params.searchMode``
                                    (forwarded as-is; valid values:
                                    ``"semantic" | "hybrid" | "fts"``).
    =============================  =====================================

    .. note::
       ``ragConfig.rerankingEnabled`` is intentionally NOT wired here:
       kb-retrieval-service takes ``rerankerType`` as a model-name
       string (not a boolean), so there's no clean mapping until
       config-service grows a ``rerankerType: string`` field on
       ``AgentRagConfig``. Track this in the rag-wiring follow-up.

    Defaults baked into ``params`` when no overrides apply:

    - ``topK``: 5 (chunks to retrieve per call)
    - ``similarityThreshold``: 0.5
    - ``projectId``: the team's ``project_id`` (passed in)

    Returns ``None`` when the record lacks an ``id`` — without it the
    binding can't reach a KB at invocation time, so producing a stub
    would just defer the failure.
    """
    if not isinstance(record, dict):
        return None
    kb_id = _pick(record, "id", "knowledge_base_id", "knowledgeBaseId")
    if not kb_id:
        return None

    raw_name = _pick(record, "name", default="") or f"kb_{kb_id}"
    # Normalise to "kb-retrieval-<rest>" so every KB tool has a consistent
    # "retrieval" segment that distinguishes it from other function bindings.
    # Strip an existing "kb-" / "kb_" prefix first to avoid "kb-retrieval-kb-gcnv".
    raw_name_s = str(raw_name)
    _stripped = re.sub(r"^kb[-_]retrieval[-_]", "", raw_name_s)
    _stripped = re.sub(r"^kb[-_]", "", _stripped)
    _normalised = f"kb-retrieval-{_stripped}" if _stripped else f"kb-retrieval-{kb_id}"
    name = _slugify_binding_name(_normalised, fallback=f"kb-retrieval-{kb_id}")

    description = (
        _pick(record, "description", default="") or f"Search the {raw_name!s} knowledge base."
    )

    overrides = rag_overrides if isinstance(rag_overrides, dict) else {}

    top_k_override = overrides.get("topK")
    top_k = (
        int(top_k_override)
        if isinstance(top_k_override, (int, float)) and not isinstance(top_k_override, bool)
        else default_top_k
    )

    params: dict[str, Any] = {
        "kbId": str(kb_id),
        "projectId": str(project_id),
        "topK": top_k,
    }

    threshold_enabled = overrides.get("similarityThresholdEnabled")
    if threshold_enabled is not False:
        thr_override = overrides.get("similarityThreshold")
        params["similarityThreshold"] = (
            float(thr_override)
            if isinstance(thr_override, (int, float)) and not isinstance(thr_override, bool)
            else default_similarity_threshold
        )

    search_mode = overrides.get("searchMode")
    if isinstance(search_mode, str) and search_mode:
        params["searchMode"] = search_mode

    return {
        "name": name,
        "type": "function",
        "function_ref": "kb_retrieve",
        "description": str(description),
        "tags": ["retrieval", "knowledge_base"],
        "params": params,
        "enabled": True,
    }


# ---------------------------------------------------------------------------
# Team record (composed) → MAF payload
# ---------------------------------------------------------------------------


#: Translation from config-service's ``orchestrationPolicy`` vocabulary
#: (carried over from the legacy Agno-based agent-service) to MAF's
#: orchestration type registry. The legacy terms have no 1:1 MAF
#: equivalents, so we pick the closest semantic match:
#:
#: * ``coordinate`` → ``magentic``: a manager (Magentic-One planner)
#:   delegates to workers. Aligns with the UI's requirement that
#:   ``coordinate`` teams carry a ``managerModel`` — MAF's
#:   ``manager_model`` / ``max_rounds`` plumbing already targets the
#:   magentic builder via :func:`_manager_block_to_orchestration_fields`.
#: * ``route`` → ``triage``: a single LLM router call selects the
#:   best-matching specialist (by agent ``description``) and the chosen
#:   agent answers directly. Replaces the previous ``handoff`` mapping —
#:   handoff lets specialists pass control between themselves and can
#:   amplify ambiguous prompts into long ping-pong chains; triage's
#:   one-shot routing is the more predictable analogue to Agno's route
#:   semantics for short / "pick the right agent" requests.
#: * ``collaborate`` → ``group_chat``: free-form multi-agent discussion.
#:
#: Native MAF type names already supplied by callers (``sequential``,
#: ``concurrent``, ``magentic``, ``handoff``, ``group_chat``, ``triage``,
#: ``graph``, ``single``) pass through unchanged.
_LEGACY_ORCHESTRATION_POLICY_MAP: dict[str, str] = {
    "coordinate": "magentic",
    "route": "triage",
    "collaborate": "group_chat",
}


def _normalise_orchestration_block(
    raw: Any,  # noqa: ANN401
    agent_count: int,
) -> dict[str, Any]:
    """Coerce ``orchestration`` / ``orchestrationPolicy`` to a dict.

    Config-service serialises ``orchestrationPolicy`` as a string. Most
    values name a MAF orchestration ``type`` directly (``"single"`` /
    ``"sequential"`` / ``"concurrent"`` / ``"handoff"`` / ``"group_chat"``
    / ``"magentic"`` / ``"triage"`` / ``"graph"``), but the schema also
    accepts the legacy Agno terms ``coordinate`` / ``route`` /
    ``collaborate`` (default is ``coordinate``). Translate the legacy
    names via :data:`_LEGACY_ORCHESTRATION_POLICY_MAP` so they land on
    MAF's registry instead of failing with ``Unknown orchestration type``.

    Accepts three shapes:

    1. ``str``: translated (if legacy) then wrapped as ``{"type": <name>}``.
    2. ``dict`` with ``type`` (and any companion fields like ``edges``,
       ``handoffs``, ``selection_strategy``, ``termination_strategy``):
       returned as-is (shallow-copied; ``type`` is translated in place).
    3. ``None`` / missing / non-str / non-dict: ``{}`` — the caller injects
       a single-vs-multi-agent fallback ``type``.
    """
    if isinstance(raw, str) and raw:
        return {"type": _LEGACY_ORCHESTRATION_POLICY_MAP.get(raw, raw)}
    if isinstance(raw, dict):
        out = dict(raw)
        t = out.get("type")
        if isinstance(t, str) and t in _LEGACY_ORCHESTRATION_POLICY_MAP:
            out["type"] = _LEGACY_ORCHESTRATION_POLICY_MAP[t]
        return out
    return {}


def _normalise_termination_strategy(raw: Any) -> dict[str, Any]:  # noqa: ANN401
    """Coerce a config-service ``terminationStrategy`` block into MAF shape.

    Config-service shapes (per swagger ``TerminationStrategy``):

    - ``{"type": "maximum_iterations", "maximum_iterations": N}``
    - ``{"type": "keyword", "keywords": [...]}``
    - ``{"type": "timeout", "timeout_seconds": N}``
    - ``{"type": "aggregator", "condition": "any"|"all", "sub_strategies": [...]}``

    MAF's :class:`TerminationStrategyConfig` accepts these shapes natively —
    ``type``, ``maximum_iterations``, ``keywords``, ``timeout_seconds``,
    ``condition``, and ``sub_strategies`` are all first-class fields. We
    pass through verbatim and recursively normalise ``sub_strategies`` so a
    keyword leaf nested inside an aggregator also lands in MAF shape.

    Returns an empty dict for ``None`` / non-dict input so the caller's
    Pydantic-default termination strategy stays in effect.
    """
    if not isinstance(raw, dict):
        return {}
    out: dict[str, Any] = dict(raw)
    subs = out.get("sub_strategies")
    if isinstance(subs, list):
        out["sub_strategies"] = [
            _normalise_termination_strategy(s) for s in subs if isinstance(s, dict)
        ]
    return out


def _manager_block_to_orchestration_fields(
    manager: dict[str, Any],
) -> dict[str, Any]:
    """Extract magentic-style manager fields from a config-service ``manager``.

    Config-service ``AgentTeamManager`` carries ``modelId``, ``temperature``,
    ``maxTokens``, ``systemPrompt``, plus an embedded ``guardrails`` block
    that holds ``maxIterations`` / ``timeoutSeconds``.

    MAF's :class:`OrchestrationConfig` wants ``manager_model`` (and its
    ``magentic_manager_model`` alias), ``manager_temperature``, and
    ``max_rounds``. Map them so a magentic team configured in config-service
    runs with the operator's intended model / temperature / round cap rather
    than silently falling back to MAF defaults.
    """
    out: dict[str, Any] = {}
    # Prefer the resolved model dict (config-service's enrichAgentTeamReadShape
    # injects ``manager.model`` as a ModelSummary carrying ``gatewayModelId``).
    # Mirror agent_record_to_sk_agent's loud-failure stance: if the model dict
    # is present but lacks ``gatewayModelId``, the model isn't registered with
    # Bifrost and we'd send a raw UUID downstream — fail clearly here. Fall
    # back to the legacy raw string path for compatibility with pre-enrichment
    # team blobs (older config-service builds, file-based team configs).
    raw_model = _pick(manager, "model", "modelId", "model_id")
    model_str: str | None = None
    if isinstance(raw_model, dict):
        gateway_id = raw_model.get("gatewayModelId") or raw_model.get("gateway_model_id")
        if not gateway_id:
            raise ValueError(
                "_manager_block_to_orchestration_fields: manager references "
                f"model {raw_model.get('id')!r} which has no `gatewayModelId`. "
                "Config-service computes `gatewayModelId` when the model is "
                "registered with Bifrost — check that registration completed."
            )
        model_str = str(gateway_id)
    elif isinstance(raw_model, str) and raw_model:
        model_str = raw_model
    if model_str:
        out["manager_model"] = model_str
        out["magentic_manager_model"] = model_str
    manager_display_name = _model_display_name_from_value(raw_model)
    if manager_display_name:
        out["manager_model_display_name"] = manager_display_name
    temperature = _pick(manager, "temperature")
    if temperature is not None:
        try:
            t = float(temperature)
            out["manager_temperature"] = t
            out["magentic_manager_temperature"] = t
        except (TypeError, ValueError):
            pass
    # Name + instructions are required for triage (HandoffBuilder uses the
    # manager as the start agent and exposes its instructions to the LLM as
    # the routing prompt). For magentic/group_chat they are optional knobs
    # that override the framework-supplied defaults.
    name = _pick(manager, "name")
    if isinstance(name, str) and name.strip():
        out["manager_name"] = name.strip()
    instructions = _pick(manager, "instructions", "systemPrompt", "system_prompt")
    if isinstance(instructions, str) and instructions.strip():
        out["manager_instructions"] = instructions
    max_tokens = _pick(manager, "maxTokens", "max_tokens")
    if max_tokens is not None:
        with contextlib.suppress(TypeError, ValueError):
            out["manager_max_tokens"] = int(max_tokens)
    guardrails = _coerce_dict(_pick(manager, "guardrails", default={}))
    max_iter = _pick(guardrails, "maxIterations", "max_iterations") or _pick(
        manager, "maxIterations", "max_iterations"
    )
    if max_iter is not None:
        with contextlib.suppress(TypeError, ValueError):
            out["max_rounds"] = int(max_iter)
    return out


def team_blob_to_maf_payload(
    team_blob: dict[str, Any],
    agent_dicts: list[dict[str, Any]],
) -> dict[str, Any]:
    """Compose the full MAF JSON payload from a team record + resolved members.

    Sections produced (mirrors ``configs/team/*.json`` shape):

    - Top-level: ``project_id``, ``_team_id``, ``_team_name``, ``_description``,
      ``_schema_version`` (when present in the team blob).
    - ``agent``: framework + default model / temperature.
    - ``gateway``: passed through verbatim if present, otherwise empty so
      env defaults take over.
    - ``guardrails``, ``mcp``, ``memory``, ``tasks``, ``logging``: passed
      through if present.
    - ``semantic_kernel.agents``: the spliced ``agent_dicts``.
    - ``semantic_kernel.orchestration``: from the team blob's
      ``orchestration`` / ``orchestrationPolicy``.
    - ``semantic_kernel.manager``: when the team blob supplies a manager
      config (group_chat / triage / handoff orchestrations).

    Args:
        team_blob: Raw team record from config-service.
        agent_dicts: Resolved ``semantic_kernel.agents[]`` entries (already
            mapped through :func:`agent_record_to_sk_agent`).

    Returns:
        A dict ready for ``ConfigLoader(json_config_data=...).resolve()``.
    """
    project_id = _pick(team_blob, "project_id", "projectId", default="")
    team_id = _pick(team_blob, "_team_id", "id", "team_id", "teamId", default="")
    team_name = _pick(team_blob, "_team_name", "name", default=team_id)
    description = _pick(team_blob, "_description", "description", default="")

    raw_policy = _pick(team_blob, "orchestration", "orchestrationPolicy")
    orchestration = _normalise_orchestration_block(raw_policy, len(agent_dicts))
    if "type" not in orchestration:
        # Couldn't determine the orchestration type from the blob — fall
        # back to the multi-agent count heuristic so the executor still
        # gets *some* type. Single-agent → "single", multi-agent →
        # "concurrent" (lossy but deterministic; operators are expected
        # to declare orchestrationPolicy explicitly).
        orchestration["type"] = "single" if len(agent_dicts) <= 1 else "concurrent"

    # Termination strategy (config-service ``terminationStrategy`` top-level).
    # MAF expects this nested under ``orchestration.termination_strategy``;
    # don't overwrite one already present in the orchestration block (a dict
    # ``orchestrationPolicy`` may carry its own).
    termination = _normalise_termination_strategy(
        _pick(team_blob, "terminationStrategy", "termination_strategy")
    )
    if termination and "termination_strategy" not in orchestration:
        orchestration["termination_strategy"] = termination

    # Selection strategy (group_chat). Top-level alias mirrors the
    # termination wiring; falls through if absent.
    selection = _coerce_dict(
        _pick(team_blob, "selectionStrategy", "selection_strategy", default={})
    )
    if selection and "selection_strategy" not in orchestration:
        orchestration["selection_strategy"] = selection

    # Handoff edges (handoff orchestration). Top-level ``handoffs`` is a
    # list of ``{source, target, description}`` per MAF's HandoffDefinition.
    handoffs = _coerce_list(_pick(team_blob, "handoffs", default=[]))
    if handoffs and "handoffs" not in orchestration:
        orchestration["handoffs"] = handoffs

    # Graph edges (graph orchestration). Top-level ``edges`` is a list of
    # ``{source, target, condition}`` per MAF's GraphEdge.
    edges = _coerce_list(_pick(team_blob, "edges", default=[]))
    if edges and "edges" not in orchestration:
        orchestration["edges"] = edges

    # Manager block (magentic / group_chat / triage). Pull out the model /
    # temperature / max_rounds fields MAF's OrchestrationConfig understands,
    # without losing the original ``manager`` payload (kept on sk_section
    # below for adapters that read it directly).
    manager = _coerce_dict(_pick(team_blob, "manager", default={}))
    if manager:
        for k, v in _manager_block_to_orchestration_fields(manager).items():
            orchestration.setdefault(k, v)

    # TODO(config-service): once config-service exposes `handoffs[]` on the
    # team schema (CreateAgentTeamRequest currently has no field for
    # source/target/description handoff edges), remove this synthetic
    # fallback and rely on the explicit list above. Tracked in the
    # config-service migration follow-ups.
    #
    # For now, when a team's orchestration type is "handoff" but no
    # handoffs[] were supplied, synthesize all-pairs directed edges
    # between every resolved agent. This is the most permissive default
    # — any agent can route to any other — so the orchestrator has a
    # valid edge set to work with instead of failing at adapter init.
    if (
        orchestration.get("type") == "handoff"
        and not orchestration.get("handoffs")
        and len(agent_dicts) >= 2
    ):
        names = [a.get("name") for a in agent_dicts if a.get("name")]
        orchestration["handoffs"] = [
            {
                "source": src,
                "target": tgt,
                "description": (
                    "auto-generated all-pairs handoff (no explicit handoffs in team blob)"
                ),
            }
            for src in names
            for tgt in names
            if src != tgt
        ]

    sk_section: dict[str, Any] = {
        "agents": agent_dicts,
        "orchestration": orchestration,
        "default_function_choice_behavior": _pick(
            team_blob,
            "default_function_choice_behavior",
            "defaultFunctionChoiceBehavior",
            default="auto",
        ),
    }
    if manager:
        sk_section["manager"] = manager

    # Pull through optional cross-cutting sections when present. Empty dict
    # fallbacks mean "let env + defaults win" instead of overwriting valid
    # env-provided gateway / memory settings with an empty payload.
    gateway = _coerce_dict(_pick(team_blob, "gateway", default={}))
    # Memory: dual-read chain (resolve_memory). Prefers the new
    # `memoryContext` schema; falls back to legacy `memoryType` +
    # `memoryConfig`; defaults to a 20-message sliding window when neither
    # is set. The team blob is the source of truth on team-invoke — member
    # agents' memory blocks are intentionally NOT merged here.
    memory = resolve_memory(team_blob)
    guardrails = _coerce_dict(_pick(team_blob, "guardrails", default={}))
    mcp = _coerce_dict(_pick(team_blob, "mcp", default={}))
    mcp_servers = _coerce_list(_pick(team_blob, "mcp_servers", "mcpServers", default=[]))
    tasks = _coerce_dict(_pick(team_blob, "tasks", default={}))
    logging_cfg = _coerce_dict(_pick(team_blob, "logging", default={}))
    agent_defaults = _coerce_dict(_pick(team_blob, "agent", default={}))
    tool_bindings = _coerce_list(_pick(team_blob, "tool_bindings", "toolBindings", default=[]))

    payload: dict[str, Any] = {
        "project_id": str(project_id) if project_id else "",
        "_team_id": str(team_id),
        "_team_name": str(team_name),
        "_description": str(description) if description else "",
        "agent": agent_defaults,
        "semantic_kernel": sk_section,
    }
    if "_schema_version" in team_blob:
        payload["_schema_version"] = team_blob["_schema_version"]
    if gateway:
        payload["gateway"] = gateway
    if memory:
        payload["memory"] = memory
    if guardrails:
        payload["guardrails"] = guardrails
    if mcp:
        payload["mcp"] = mcp
    if mcp_servers:
        payload["mcp_servers"] = mcp_servers
    if tasks:
        payload["tasks"] = tasks
    if logging_cfg:
        payload["logging"] = logging_cfg
    if tool_bindings:
        # MAF reads top-level ``tool_bindings`` via
        # ``getattr(config, "tool_bindings", None)`` (extra="allow" on
        # AgentConfig). Pass the list through so synthesized KB
        # bindings — and any inline bindings on the source blob — reach
        # the SK adapter's _build_function_provider.
        payload["tool_bindings"] = tool_bindings

    return payload


# ---------------------------------------------------------------------------
# Single-agent synthetic team
# ---------------------------------------------------------------------------


def synthetic_single_agent_team(
    *,
    project_id: str,
    agent_id: str,
    agent_dict: dict[str, Any],
    source: dict[str, Any],
) -> dict[str, Any]:
    """Wrap one agent record in a synthetic single-agent team payload.

    Used by :func:`build_team_bundle_from_agent` so the rest of MAF's
    runtime (gateway, MCP, sessions, tasks, guardrails) keeps its current
    TeamBundle-centric contract — the executor never sees a "bare agent",
    it sees a one-agent team with ``orchestration.type='single'``.

    The synthetic team_id (``_agent_{agent_id}_``) is recognised at the
    registry level; routes do not need to special-case it.

    Args:
        project_id: Project that owns the agent.
        agent_id: The agent's id (the source-of-truth one, not the
            synthetic team_id).
        agent_dict: Already-mapped ``semantic_kernel.agents[]`` entry.
        source: The raw agent record — used to lift optional sections
            (gateway / memory / mcp / guardrails) that the agent might
            carry directly.

    Returns:
        A MAF-shaped payload ready for
        ``ConfigLoader(json_config_data=...).resolve()``.
    """
    synthetic_team_id = f"_agent_{agent_id}_"
    payload: dict[str, Any] = {
        "project_id": project_id,
        "_team_id": synthetic_team_id,
        "_team_name": str(_pick(source, "name", default=agent_id) or agent_id),
        "_description": str(_pick(source, "description", default="") or ""),
        "agent": _coerce_dict(_pick(source, "agent", default={})),
        "semantic_kernel": {
            "agents": [agent_dict],
            "orchestration": {"type": "single"},
            "default_function_choice_behavior": agent_dict.get("function_choice_behavior", "auto"),
        },
    }

    # Carry over optional sections from the agent record when present so
    # an agent-only invoke does not silently lose memory / gateway / MCP
    # config the operator attached at the agent level.
    for src_key, dst_key in (
        ("gateway", "gateway"),
        ("guardrails", "guardrails"),
        ("mcp", "mcp"),
        ("tasks", "tasks"),
        ("logging", "logging"),
    ):
        section = source.get(src_key)
        if isinstance(section, dict) and section:
            payload[dst_key] = dict(section)

    # Memory: same dual-read chain as team_blob_to_maf_payload. On
    # standalone agent-invoke the agent record's memory wins; the new
    # `memoryContext` field is preferred over legacy `memoryType` +
    # `memoryConfig`, with a 20-message default when neither is set.
    memory = resolve_memory(source)
    if memory:
        payload["memory"] = memory

    mcp_servers = _coerce_list(_pick(source, "mcp_servers", "mcpServers", default=[]))
    if mcp_servers:
        payload["mcp_servers"] = mcp_servers

    return payload


# Backwards-compatible alias used in early plan drafts.
def adapt_remote_to_maf_config(remote: dict[str, Any]) -> dict[str, Any]:
    """Map a flat config-service team payload → MAF nested JSON shape.

    Convenience wrapper kept for parity with the plan document
    (§Step 2.3). Internally builds a one-shot team using the same helpers
    that the lazy registry uses.
    """
    members = _coerce_list(_pick(remote, "members", "agents", default=[]))
    agent_dicts: list[dict[str, Any]] = []
    for member in members:
        if isinstance(member, dict) and any(
            k in member for k in ("name", "instructions", "model", "modelId")
        ):
            # Inlined agent — translate directly.
            agent_dicts.append(agent_record_to_sk_agent(member, None))
    return team_blob_to_maf_payload(remote, agent_dicts)


__all__ = [
    "agent_record_to_sk_agent",
    "team_blob_to_maf_payload",
    "synthetic_single_agent_team",
    "adapt_remote_to_maf_config",
    "translate_memory_blob",
    "translate_memory_context",
    "resolve_memory",
]
