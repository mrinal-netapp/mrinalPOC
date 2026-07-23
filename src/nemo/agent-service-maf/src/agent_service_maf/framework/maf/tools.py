"""Tools -- builds Agent Framework tools from config (Phase 2).

This is the AF analogue of the SK
``function_kernel_plugin.py`` + ``mcp_kernel_plugin.py`` pair. Where SK wrapped
each tool as a ``Kernel`` plugin function, AF takes plain callables, so this
module produces :class:`agent_framework.FunctionTool` objects (via
:func:`agent_framework.tool`) that AF's ``FunctionInvocationLayer`` invokes
automatically during ``runner.run()``.

Two tool sources are supported, mirroring the SK adapter exactly:

* **function bindings** -- ``type="function"`` :class:`FunctionBinding` resolved
  through a :class:`FunctionToolProvider`. KB-retrieval tools return a
  :class:`FunctionToolResult` carrying ``kb_citations``; the recording wrapper
  feeds ``.text`` back to the model and stashes the citations on the tool-history
  entry so they reach the wire as ``toolExecutions[].kbCitations``.
* **MCP tools** -- discovered via the MCP registry's ``tool_registry`` and called
  through ``mcp_registry.call_tool``. The same ``auth_hook`` gating and server-wins
  ``default_arguments`` semantics as the SK MCP plugin are preserved. One
  intentional divergence: a guardrail-denied call is surfaced to the model as an
  ``"ERROR: ... denied"`` tool result (soft-fail) instead of aborting the turn --
  the call is still blocked before reaching the MCP server. See
  :func:`_make_mcp_tool` for the rationale.

Every tool is wrapped in a recording closure that captures a ``tool_history``
entry (``tool_name``, ``arguments``, ``result``, ``duration_ms``, ``tool_type``,
and optionally ``error`` / ``kb_citations`` / ``tokens_used``) using the **exact**
dict keys the SK adapter records, so the downstream
:func:`~agent_service_maf.framework.maf.event_mapper.MafEventMapper.build_tool_executions`
converter produces byte-identical ``ToolExecution`` citations.

Tools are built **per invocation** (each carrying a fresh ``tool_history`` list)
so concurrent requests never cross-contaminate trace data.
"""

from __future__ import annotations

import inspect
import json
import time
import typing
from typing import TYPE_CHECKING, Any

import structlog
from agent_framework import FunctionTool, tool

from agent_service_maf.core.exceptions import AgentInvocationError
from agent_service_maf.tools.binding import FunctionBinding
from agent_service_maf.tools.functions import FunctionToolResult, get_function

if TYPE_CHECKING:
    from collections.abc import Callable

    from agent_service_maf.config.validators import SKAgentDefinition
    from agent_service_maf.tools.binding import ToolBinding
    from agent_service_maf.tools.function_provider import FunctionToolProvider

logger = structlog.get_logger(__name__)

# Auth-hook signature mirrors SK's ``ToolAuthorizationHook``:
# ``await hook(tool_name, arguments) -> bool`` (``False`` denies the call).

_PY_TO_JSON_TYPE: dict[type, str] = {
    str: "string",
    int: "integer",
    float: "number",
    bool: "boolean",
    list: "array",
    dict: "object",
}


class MafToolset:
    """A per-invocation bundle of AF tools plus the trace they record into.

    Attributes:
        tools: AF :class:`agent_framework.FunctionTool` objects to pass to
            ``runner.run(messages, tools=...)``.
        tool_history: Ordered list of recorded tool-call entries, populated as a
            side effect while the agent runs. Keys match the SK adapter's
            ``tool_history`` schema so citation building is shared.
    """

    def __init__(self) -> None:
        self.tools: list[FunctionTool] = []
        self.tool_history: list[dict[str, Any]] = []


def build_toolset(
    *,
    agent_def: SKAgentDefinition,
    function_provider: FunctionToolProvider | None,
    tool_bindings: list[ToolBinding] | None,
    mcp_registry: Any | None,  # noqa: ANN401
    auth_hook: Any | None = None,  # noqa: ANN401
) -> MafToolset:
    """Build the AF tools an agent can call, with recording closures.

    Ordering mirrors the SK ``ToolConfigurator``: MCP-server tools first, then
    individually-named MCP tools, then function bindings. Names are de-duplicated
    so a tool referenced via both ``mcp_servers`` and ``tools`` is only exposed
    once.

    MCP tools are strictly scoped to the agent's own configuration: both
    ``mcp_servers`` and ``tools`` resolve only against the servers in
    ``agent_def.mcp_servers``. A ``tools`` entry that names a tool living on a
    server the agent is not configured to use is dropped (and logged), never
    satisfied from another agent's server in the shared team registry. The
    resulting MCP tool closures also re-check the server at call time
    (defense-in-depth) so an unconfigured server can never be reached.

    Per-server tool whitelisting (``agent_def.allowed_tools_by_server``) is
    applied on top of the above: when a linked server has a non-empty
    whitelist, only the named tools from that server are exposed; an absent
    or empty entry means "no per-tool restriction" and all of the server's
    tools are exposed. This is how the UI's "pick individual tools per
    server" selection reaches the agent without leaking the rest of the
    server's catalogue.

    Args:
        agent_def: Agent config (``tools`` / ``mcp_servers`` / ``tool_bindings``).
        function_provider: Provider resolving ``function`` bindings, or ``None``.
        tool_bindings: Full binding catalogue (function + mcp typed).
        mcp_registry: MCP registry exposing ``tool_registry`` + ``call_tool``.
        auth_hook: Optional async ``(tool_name, args) -> bool`` authorization gate
            applied to MCP tool calls.

    Returns:
        A :class:`MafToolset` whose ``tool_history`` fills as the agent runs.
    """
    toolset = MafToolset()
    seen: set[str] = set()

    registry = None
    if mcp_registry is not None:
        registry = getattr(mcp_registry, "tool_registry", mcp_registry)

    # The set of MCP servers configured for THIS agent. An agent may only ever
    # be exposed (and, at call time, only ever invoke) MCP tools that live on
    # one of these servers -- both the ``mcp_servers`` (all-tools) path and the
    # ``tools`` (named-whitelist) path are scoped to it, so a tool that belongs
    # to another agent's server can never leak in.
    allowed_servers: set[str] = set(agent_def.mcp_servers or [])

    # Per-server tool whitelist (config-service ``mcpServerConfig.allowedTools``).
    # A server present here exposes ONLY the named tools; a server absent
    # (or with an empty list) stays in "all tools" mode -- matches the UI
    # contract where leaving the override empty means "no restriction".
    per_server_whitelist: dict[str, set[str]] = {
        server: set(names)
        for server, names in (agent_def.allowed_tools_by_server or {}).items()
        if names
    }

    if registry is not None and (agent_def.mcp_servers or agent_def.tools):
        get_for_server = getattr(registry, "get_tools_for_server", None)

        if agent_def.mcp_servers:
            for server_name in agent_def.mcp_servers:
                schemas = get_for_server(server_name) if callable(get_for_server) else []
                server_whitelist = per_server_whitelist.get(server_name)
                for schema in schemas:
                    if server_whitelist is not None and schema.name not in server_whitelist:
                        continue
                    if schema.name in seen:
                        continue
                    seen.add(schema.name)
                    toolset.tools.append(
                        _make_mcp_tool(
                            schema, mcp_registry, toolset.tool_history, auth_hook, allowed_servers
                        )
                    )
                if server_whitelist is not None:
                    found_names = {schema.name for schema in schemas}
                    missing = server_whitelist - found_names
                    if missing:
                        logger.warning(
                            "Per-agent allowedTools reference tools not present "
                            "on this MCP server; dropping",
                            agent_name=agent_def.name,
                            server=server_name,
                            missing_tools=sorted(missing),
                        )

        if agent_def.tools:
            wanted = set(agent_def.tools)
            # Resolve named tools ONLY within the agent's configured servers so a
            # ``tools`` entry can never pull a tool from a server the agent isn't
            # configured to use. Names absent from those servers are dropped (and
            # logged) rather than satisfied from the team-wide registry.
            candidate: list[tuple[str, Any]] = []
            if callable(get_for_server):
                for server_name in allowed_servers:
                    for schema in get_for_server(server_name) or []:
                        candidate.append((server_name, schema))
            found = {schema.name for _, schema in candidate}
            for server_name, schema in candidate:
                if schema.name not in wanted or schema.name in seen:
                    continue
                # A per-server whitelist also gates the named-tools path -- so
                # an entry in ``tools`` can't reach a tool the operator
                # explicitly removed from ``allowedTools`` for that server.
                sw = per_server_whitelist.get(server_name)
                if sw is not None and schema.name not in sw:
                    continue
                seen.add(schema.name)
                toolset.tools.append(
                    _make_mcp_tool(
                        schema, mcp_registry, toolset.tool_history, auth_hook, allowed_servers
                    )
                )
            missing = wanted - found
            if missing:
                logger.warning(
                    "Configured MCP tools are not available on this agent's "
                    "configured servers; dropping",
                    agent_name=agent_def.name,
                    missing_tools=sorted(missing),
                    mcp_servers=sorted(allowed_servers),
                )
    elif (agent_def.mcp_servers or agent_def.tools) and registry is None:
        logger.warning(
            "Agent references MCP tools but no MCP registry is available; skipping",
            agent_name=agent_def.name,
            mcp_servers=agent_def.mcp_servers,
            tools=agent_def.tools,
        )

    if agent_def.tool_bindings and function_provider is not None:
        bindings_by_name = {b.name: b for b in (tool_bindings or [])}
        for binding_name in agent_def.tool_bindings:
            binding = bindings_by_name.get(binding_name)
            if binding is None or not isinstance(binding, FunctionBinding):
                continue
            if binding.name in seen:
                continue
            seen.add(binding.name)
            toolset.tools.append(
                _make_function_tool(binding, function_provider, toolset.tool_history)
            )

    # Visibility: surface the per-invocation tool selection so operators can
    # confirm the per-server whitelist (config-service ``allowedTools``) is
    # being honored without having to inspect the Bifrost request body.
    logger.info(
        "Built agent toolset",
        agent_name=agent_def.name,
        mcp_servers=list(agent_def.mcp_servers or []),
        allowed_tools_by_server={
            k: list(v) for k, v in (agent_def.allowed_tools_by_server or {}).items()
        },
        exposed_tool_names=[t.name for t in toolset.tools],
    )

    return toolset


# ---------------------------------------------------------------------------
# Tool factories
# ---------------------------------------------------------------------------


def _make_function_tool(
    binding: FunctionBinding,
    provider: FunctionToolProvider,
    tool_history: list[dict[str, Any]],
) -> FunctionTool:
    """Wrap a function binding as a recording AF tool.

    The wrapper unpacks a :class:`FunctionToolResult` exactly like the SK
    recording executor: ``.text`` is returned to the model, while
    ``kb_citations`` / ``tool_type`` / ``tokens_used`` land on the tool-history
    entry.
    """
    fn = get_function(binding.function_ref)
    schema = _function_schema(fn) if fn is not None else _empty_schema()
    tool_name = binding.name

    async def _exec(**kwargs: Any) -> str:  # noqa: ANN401
        start = time.perf_counter()
        # Log arg *keys* only (not values) — values may carry user PII /
        # secrets; the keys are enough to see what the agent is doing.
        logger.debug(
            "tool_call_started",
            tool_name=tool_name,
            tool_kind="function",
            arg_keys=sorted(kwargs),
        )
        tool_type = "toolset"
        kb_citations: list[Any] = []
        tokens_used: int | None = None
        error: str | None = None
        text = ""
        try:
            result = await provider.call_tool(binding.name, dict(kwargs))
            if isinstance(result, FunctionToolResult):
                text = result.text
                kb_citations = list(result.kb_citations)
                if result.tool_type:
                    tool_type = result.tool_type
                if result.tokens_used is not None:
                    tokens_used = result.tokens_used
            else:
                text = str(result)
        except Exception as exc:  # noqa: BLE001
            error = f"{type(exc).__name__}: {exc}"
            text = f"ERROR: {exc}"
        finally:
            elapsed_ms = int((time.perf_counter() - start) * 1000)

        entry: dict[str, Any] = {
            "tool_name": tool_name,
            "arguments": dict(kwargs),
            "result": text,
            "duration_ms": elapsed_ms,
            "tool_type": tool_type,
        }
        if error is not None:
            entry["error"] = error
        if kb_citations:
            entry["kb_citations"] = kb_citations
        if tokens_used is not None:
            entry["tokens_used"] = tokens_used
        tool_history.append(entry)
        logger.info(
            "tool_call_completed",
            tool_name=tool_name,
            tool_kind="function",
            tool_type=tool_type,
            duration_ms=elapsed_ms,
            ok=error is None,
            error=error,
            result_chars=len(text),
        )
        return text

    return tool(_exec, name=tool_name, description=binding.description or "", schema=schema)


def _make_mcp_tool(
    schema: Any,  # noqa: ANN401  # ToolSchema
    mcp_registry: Any,  # noqa: ANN401
    tool_history: list[dict[str, Any]],
    auth_hook: Any | None,  # noqa: ANN401
    allowed_servers: set[str] | None = None,
) -> FunctionTool:
    """Wrap an MCP tool schema as a recording AF tool.

    Preserves the SK MCP plugin semantics: optional ``auth_hook`` gate,
    server-wins ``default_arguments`` merge, and ``ToolResult`` content
    serialization. MCP tools never carry ``kb_citations`` (``tool_type`` stays
    ``"toolset"``).

    When ``allowed_servers`` is provided, the call-time closure refuses to
    invoke any tool whose ``server_name`` is not in that set -- the
    defense-in-depth backstop for the per-agent server scoping enforced in
    :func:`build_toolset`.
    """
    server_name = schema.server_name
    tool_name = schema.name
    input_schema = schema.input_schema if isinstance(schema.input_schema, dict) else _empty_schema()

    async def _exec(**kwargs: Any) -> str:  # noqa: ANN401
        start = time.perf_counter()
        # Log arg *keys* only (not values) to avoid leaking PII / secrets.
        logger.debug(
            "tool_call_started",
            tool_name=tool_name,
            tool_kind="mcp",
            server=server_name,
            arg_keys=sorted(kwargs),
        )
        error: str | None = None
        text = ""
        try:
            # Defense-in-depth: refuse to call a server this agent isn't
            # configured to use. ``build_toolset`` already scopes the exposed
            # tool surface to ``agent_def.mcp_servers``; this is the call-time
            # backstop so a tool can never reach an unconfigured server even if
            # one slipped into the toolset. Surfaced as a soft-fail error result
            # (same pattern as the auth-hook denial below).
            if allowed_servers is not None and server_name not in allowed_servers:
                raise AgentInvocationError(
                    f"Tool '{tool_name}' on server '{server_name}' is not "
                    f"configured for this agent.",
                    details={"tool": tool_name, "server": server_name},
                )
            # Authorization gate -- runs the guardrail ``check_tool`` pipeline
            # before any MCP call. The security guarantee matches the SK MCP
            # plugin exactly: when the hook denies, ``mcp_registry.call_tool`` is
            # never reached, so a blocked tool never executes.
            #
            # PARITY DIVERGENCE (intentional, soft-fail): unlike the SK plugin --
            # which raises out of the executor and aborts the turn -- this raise
            # is caught by the catch-all ``except`` below and surfaced to the model
            # as an ``"ERROR: ... denied"`` tool result. AF's FunctionInvocationLayer
            # contract expects a tool to *return a string*, and MAF uniformly feeds
            # tool errors back to the model rather than crashing the run. The denial
            # is still recorded in ``tool_history`` (so it reaches the trace). See
            # the auth-hook tests in tests/unit/test_maf_tools.py.
            if auth_hook is not None:
                allowed = await auth_hook(tool_name, dict(kwargs))
                if not allowed:
                    raise AgentInvocationError(
                        f"Tool '{tool_name}' denied by authorization policy.",
                        details={"tool": tool_name},
                    )
            merged = dict(kwargs)
            get_defaults = getattr(mcp_registry, "get_default_arguments", None)
            if callable(get_defaults):
                defaults = get_defaults(server_name) or {}
                merged.update(defaults)  # server-wins
            result = await mcp_registry.call_tool(
                server_name=server_name,
                tool_name=tool_name,
                arguments=merged,
            )
            text = _mcp_result_to_str(result)
        except Exception as exc:  # noqa: BLE001
            error = f"{type(exc).__name__}: {exc}"
            text = f"ERROR: {exc}"
        finally:
            elapsed_ms = int((time.perf_counter() - start) * 1000)

        entry: dict[str, Any] = {
            "tool_name": tool_name,
            "arguments": dict(kwargs),
            "result": text,
            "duration_ms": elapsed_ms,
            "tool_type": "toolset",
        }
        if error is not None:
            entry["error"] = error
        tool_history.append(entry)
        logger.info(
            "tool_call_completed",
            tool_name=tool_name,
            tool_kind="mcp",
            server=server_name,
            duration_ms=elapsed_ms,
            ok=error is None,
            error=error,
            result_chars=len(text),
        )
        return text

    return tool(
        _exec,
        name=tool_name,
        description=getattr(schema, "description", "") or "",
        schema=input_schema,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mcp_result_to_str(result: Any) -> str:  # noqa: ANN401
    """Serialize an MCP ``ToolResult`` to the string handed back to the model."""
    content = getattr(result, "content", result)
    if isinstance(content, (dict, list)):
        try:
            return json.dumps(content)
        except (TypeError, ValueError):
            return str(content)
    return str(content)


def _empty_schema() -> dict[str, Any]:
    """A no-parameter JSON Schema object."""
    return {"type": "object", "properties": {}, "required": []}


def _function_schema(fn: Callable[..., Any]) -> dict[str, Any]:
    """Derive a JSON Schema for the LLM-visible parameters of *fn*.

    Mirrors the SK ``_signature_to_parameters`` logic: positional / keyword
    parameters are exposed; keyword-only parameters (e.g. the server-injected
    ``params``) and var-args are hidden. ``Annotated[T, "desc"]`` descriptions are
    surfaced into the schema.
    """
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):
        return _empty_schema()
    try:
        hints = typing.get_type_hints(fn, include_extras=True)
    except Exception:  # noqa: BLE001
        hints = {}

    properties: dict[str, Any] = {}
    required: list[str] = []
    for name, param in sig.parameters.items():
        if param.kind in (
            inspect.Parameter.KEYWORD_ONLY,
            inspect.Parameter.VAR_KEYWORD,
            inspect.Parameter.VAR_POSITIONAL,
        ):
            continue
        annotation = hints.get(name, param.annotation)
        base_type, description = _split_annotation(annotation)
        prop: dict[str, Any] = {"type": _json_type_for(base_type)}
        if description:
            prop["description"] = description
        properties[name] = prop
        if param.default is inspect.Parameter.empty:
            required.append(name)

    return {"type": "object", "properties": properties, "required": required}


def _split_annotation(annotation: Any) -> tuple[Any, str]:  # noqa: ANN401
    """Return ``(base_type, description)`` for a (possibly ``Annotated``) hint."""
    metadata = getattr(annotation, "__metadata__", None)
    if metadata:
        args = typing.get_args(annotation)
        base = args[0] if args else str
        description = next((m for m in metadata if isinstance(m, str)), "")
        return base, description
    return annotation, ""


def _json_type_for(annotation: Any) -> str:  # noqa: ANN401
    """Map a Python annotation to a JSON Schema scalar type (defaulting to string)."""
    if isinstance(annotation, type):
        return _PY_TO_JSON_TYPE.get(annotation, "string")
    return "string"
