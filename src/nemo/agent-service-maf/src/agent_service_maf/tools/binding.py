"""Pydantic models for the unified tool-binding config.

Bindings are the single addressable list of named tools an agent can
call. Each entry has a ``type`` discriminator:

    * ``"function"`` — Python-registered callable. The binding points at
      a function (via ``function_ref``) registered in
      :mod:`agent_service_maf.tools.functions`. The function owns its
      transport (HTTP, DB, ...) and receives the binding's ``params``
      as a keyword-only argument the LLM cannot see.
    * ``"mcp"`` — MCP-server-backed. Carries transport/URL/headers
      inline; ``default_arguments`` provide server-wins pinned params.

There is no separate ``mcp_servers[]`` array and no ``function_tool``
endpoint block. Each binding is fully self-contained.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

# ---------------------------------------------------------------------------
# Bindings
# ---------------------------------------------------------------------------


_NAME_PATTERN = r"^[a-zA-Z0-9_-]{1,64}$"


class FunctionBinding(BaseModel):
    """A function-typed (Python-registered) tool binding.

    Each binding becomes a distinct addressable tool exposed to the
    LLM. The binding's ``params`` are passed as a keyword-only argument
    to the registered function, so deployment-fixed values (tenant ids,
    kb ids) are unreachable from the LLM-supplied call arguments.

    Attributes:
        name: Stable identifier; also forms the SK kernel plugin name.
            Must match ``[a-zA-Z0-9_-]{1,64}``.
        type: Discriminator literal ``"function"``.
        function_ref: Name of a function registered via
            :func:`agent_service_maf.tools.functions.register_function`.
            Validated at config-load time, fail-fast on typos.
        description: One-sentence description handed to the LLM.
            Overrides the registered function's docstring when SK
            renders the kernel function metadata.
        tags: Free-form labels used by tag-based filters / discovery.
        params: Per-binding fixed parameters injected into the function
            via the keyword-only ``params`` argument. Never reach the
            LLM, never pass through the LLM-supplied arg dict.
        enabled: When False the binding is silently skipped at load time.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str = Field(..., pattern=_NAME_PATTERN, description="Binding identifier")
    type: Literal["function"] = "function"
    function_ref: str = Field(
        ...,
        min_length=1,
        description="Name of the registered Python function this binding invokes",
    )
    description: str = Field("", description="Description handed to the LLM")
    tags: list[str] = Field(default_factory=list, description="Free-form labels")
    params: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Fixed per-binding parameters passed to the registered function "
            "via its keyword-only ``params`` argument. Invisible to the LLM. "
            "Values may be any JSON-serialisable type — the function decides "
            "what to do with each key (request body field, HTTP header, "
            "query string, etc.)."
        ),
    )
    enabled: bool = Field(True, description="Skip this binding when False")


class MCPBinding(BaseModel):
    """An MCP-server-backed tool binding.

    Carries the connection details inline — there is no separate
    ``mcp_servers[]`` array. This is the single source of truth for
    the server reachable as ``name``.

    Attributes:
        name: Stable identifier; also the SK kernel plugin namespace.
        type: Discriminator literal ``"mcp"``.
        description: One-sentence description.
        tags: Free-form labels.
        transport: ``"stdio"`` | ``"sse"`` | ``"streamable-http"``.
        url: HTTP endpoint (network transports).
        command: Executable (stdio).
        args: CLI args (stdio).
        env: Extra env vars (stdio).
        headers: Static HTTP headers (network transports).
        timeout_seconds: Request timeout.
        sse_read_timeout_seconds: SSE/streamable-HTTP read timeout.
        tools: Optional whitelist of MCP tool names to expose. ``[]`` /
            absent means all discovered tools.
        default_arguments: Server-wins arguments merged into every tool
            call (parity with FunctionBinding.params).
        enabled: When False the binding is silently skipped at load time.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str = Field(..., pattern=_NAME_PATTERN)
    type: Literal["mcp"] = "mcp"
    description: str = Field("")
    tags: list[str] = Field(default_factory=list)
    transport: Literal["stdio", "sse", "streamable-http"] = "streamable-http"
    url: str | None = Field(None)
    command: str | None = Field(None)
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    headers: dict[str, str] = Field(default_factory=dict)
    timeout_seconds: float = Field(30.0, gt=0.0, le=300.0)
    sse_read_timeout_seconds: float = Field(300.0, gt=0.0, le=3600.0)
    tools: list[str] = Field(default_factory=list)
    default_arguments: dict[str, Any] = Field(default_factory=dict)
    enabled: bool = Field(True)

    @model_validator(mode="after")
    def _check_transport_fields(self) -> MCPBinding:
        if self.transport == "stdio":
            if not self.command:
                raise ValueError(
                    f"MCP binding '{self.name}' uses stdio transport but has no 'command'."
                )
        elif self.transport in {"sse", "streamable-http"} and not self.url:
            raise ValueError(f"MCP binding '{self.name}' uses '{self.transport}' but has no 'url'.")
        return self


# Discriminated union over the ``type`` field.
ToolBinding = FunctionBinding | MCPBinding


# ---------------------------------------------------------------------------
# Loader helper
# ---------------------------------------------------------------------------


def parse_tool_bindings(raw: list[dict[str, Any]]) -> list[ToolBinding]:
    """Parse the ``tool_bindings`` array from a raw JSON config.

    For function-typed bindings, also validates that ``function_ref``
    points at a registered callable — fails fast on typos rather than
    surfacing the error at the first request.

    Args:
        raw: List of binding dicts read from JSON config.

    Returns:
        List of validated, enabled bindings.

    Raises:
        ValueError: If any binding fails validation. The exception
            message identifies the offending binding by name (or index
            when ``name`` is missing).
    """
    # Local import to avoid an import cycle: tools.functions registers
    # its kb_retrieve at import time, which itself imports tools.binding
    # transitively via httpx — keep the import lazy.
    from agent_service_maf.tools.functions import (
        get_function,
        registered_function_names,
    )

    out: list[ToolBinding] = []
    for idx, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise ValueError(f"tool_bindings[{idx}] must be an object, got {type(entry).__name__}.")
        binding_type = entry.get("type")
        if binding_type == "function":
            model_cls: type[BaseModel] = FunctionBinding
        elif binding_type == "mcp":
            model_cls = MCPBinding
        else:
            raise ValueError(
                f"tool_bindings[{idx}] has unknown or missing type "
                f"(got {binding_type!r}). Valid types: 'function', 'mcp'."
            )
        try:
            binding = model_cls.model_validate(entry)
        except Exception as exc:
            label = entry.get("name", f"index {idx}")
            raise ValueError(f"Invalid tool binding '{label}': {exc}") from exc

        if isinstance(binding, FunctionBinding) and get_function(binding.function_ref) is None:
            raise ValueError(
                f"Function binding '{binding.name}' references unknown "
                f"function_ref='{binding.function_ref}'. "
                f"Registered functions: {registered_function_names()}."
            )

        if not binding.enabled:  # type: ignore[union-attr]
            continue
        out.append(binding)  # type: ignore[arg-type]
    return out
