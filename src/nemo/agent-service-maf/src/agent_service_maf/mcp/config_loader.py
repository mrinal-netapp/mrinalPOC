"""MCP server configuration loader.

Parses inline ``mcp_servers`` arrays (v2.0.0 config format) into typed
:class:`MCPServerConfig` Pydantic models with full validation, environment
variable interpolation, and stdio command allowlist enforcement.

This module is framework-agnostic and does NOT import any agent framework
libraries (Microsoft Agent Framework, etc.).
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

import structlog
from pydantic import BaseModel, Field, field_validator, model_validator

from agent_service_maf.core.exceptions import ConfigurationError

logger = structlog.get_logger(__name__)

# Default allowlist of commands permitted for stdio MCP servers.
# Can be extended at runtime via :func:`add_allowed_command`.
_DEFAULT_STDIO_ALLOWLIST: frozenset[str] = frozenset(
    {
        "npx",
        "node",
        "python",
        "python3",
        "uvx",
        "uv",
        "deno",
        "bun",
        "docker",
    }
)

# Module-level mutable copy so callers can extend it at runtime.
_stdio_allowlist: set[str] = set(_DEFAULT_STDIO_ALLOWLIST)


def add_allowed_command(command: str) -> None:
    """Register an additional command as safe for stdio MCP servers.

    Args:
        command: Executable name (base name, not full path) to allow.
    """
    _stdio_allowlist.add(command)


def reset_allowlist() -> None:
    """Reset the stdio command allowlist to factory defaults.

    Primarily useful in tests that modify the allowlist.
    """
    _stdio_allowlist.clear()
    _stdio_allowlist.update(_DEFAULT_STDIO_ALLOWLIST)


# ---------------------------------------------------------------------------
# Config model
# ---------------------------------------------------------------------------

_ENV_VAR_PATTERN = re.compile(r"\$\{([^}]+)\}")


def _interpolate(value: str) -> str:
    """Replace ``${ENV_VAR}`` placeholders with environment variable values.

    Args:
        value: String potentially containing ``${VAR}`` placeholders.

    Returns:
        String with all resolved placeholders substituted. Unresolved
        variables (not present in the environment) are left as empty strings.
    """

    def _replace(match: re.Match[str]) -> str:
        return os.environ.get(match.group(1), "")

    return _ENV_VAR_PATTERN.sub(_replace, value)


def _interpolate_dict(d: dict[str, str]) -> dict[str, str]:
    """Interpolate env-var placeholders in all values of *d*.

    Args:
        d: Dictionary whose string values may contain ``${VAR}`` placeholders.

    Returns:
        New dictionary with all values interpolated.
    """
    return {k: _interpolate(v) for k, v in d.items()}


class MCPServerConfig(BaseModel):
    """Validated configuration for a single MCP server connection.

    Supports three transport types:

    * ``stdio`` — spawns a local subprocess (requires ``command``).
    * ``sse`` — HTTP Server-Sent Events (requires ``url``).
    * ``streamable-http`` — Streamable HTTP transport (requires ``url``).

    Attributes:
        name: Server identifier (set by the loader from the JSON key).
        transport: Transport type — ``"stdio"``, ``"sse"``, or
            ``"streamable-http"``.
        command: Executable to run (stdio only).
        args: Command-line arguments (stdio only).
        env: Extra environment variables for the subprocess (stdio only).
        url: Endpoint URL (SSE / streamable-HTTP only).
        headers: HTTP headers sent with every request (SSE / streamable-HTTP).
        timeout_seconds: Request timeout in seconds.
        sse_read_timeout_seconds: Read timeout for SSE streams (SSE /
            streamable-HTTP only).
        enabled: When ``False`` the server is skipped at load time.
        description: Human-readable description of the server.
        tags: Arbitrary tags for filtering/grouping.

    Raises:
        ValueError: If *transport* is not one of the supported values.
        ValueError: If a stdio server has no ``command``.
        ValueError: If a network server has no ``url``.
        ValueError: If the stdio ``command`` is not on the allowlist.
    """

    name: str = Field(..., description="Server identifier")
    transport: str = Field(
        "stdio",
        description="Transport type: stdio | sse | streamable-http",
    )
    # stdio fields
    command: str | None = Field(None, description="Executable (stdio only)")
    args: list[str] = Field(default_factory=list, description="CLI arguments (stdio only)")
    env: dict[str, str] = Field(
        default_factory=dict, description="Extra env vars for subprocess (stdio only)"
    )
    # network fields (SSE + streamable-http)
    url: str | None = Field(None, description="Endpoint URL (SSE / streamable-HTTP only)")
    headers: dict[str, str] = Field(
        default_factory=dict, description="HTTP headers (SSE / streamable-HTTP only)"
    )
    timeout_seconds: float = Field(30.0, description="Request timeout in seconds")
    sse_read_timeout_seconds: float = Field(300.0, description="SSE read timeout in seconds")
    # common
    enabled: bool = Field(True, description="Set to false to skip this server at startup")
    description: str = Field("", description="Human-readable description of the server")
    tags: list[str] = Field(default_factory=list, description="Grouping/filtering tags")
    gateway_server_name: str | None = Field(
        default=None,
        description=(
            "Bifrost client name that namespaces this server's tools when MAF "
            "talks to the aggregated `/mcp` proxy (e.g. ``projXY_weather``). "
            "Set by ``mcp_server_record_to_inline_config`` from config-service "
            "records; ``None`` for file-source servers that aren't multiplexed "
            "behind Bifrost. When set, the MCP manager (1) filters the "
            "aggregated `tools/list` to entries whose name starts with "
            "``f'{gateway_server_name}-'``, (2) strips that prefix when "
            "registering them under this server's friendly ``name``, and "
            "(3) re-prefixes on ``tools/call`` dispatch so Bifrost routes the "
            "request to the right upstream."
        ),
    )
    default_arguments: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Per-server default arguments merged into every tool call. Use for "
            "deployment-fixed parameters the LLM shouldn't have to know about "
            "(tenant ids, knowledge-base ids, snapshot versions). LLM-supplied "
            "arguments take precedence on key conflict. Stop-gap for arg "
            "binding that should ultimately live at the gateway."
        ),
    )

    @field_validator("transport")
    @classmethod
    def validate_transport(cls, v: str) -> str:
        """Ensure *transport* is one of the supported values.

        Args:
            v: Raw transport string from the config.

        Returns:
            The validated transport string.

        Raises:
            ValueError: If *v* is not ``"stdio"``, ``"sse"``, or
                ``"streamable-http"``.
        """
        allowed = {"stdio", "sse", "streamable-http"}
        if v not in allowed:
            raise ValueError(
                f"Unknown transport '{v}'. "
                f"Must be one of: {', '.join(sorted(allowed))}. "
                f"Check the 'transport' field in the mcp_servers config."
            )
        return v

    @model_validator(mode="after")
    def validate_transport_fields(self) -> MCPServerConfig:
        """Cross-field validation: stdio needs command, network needs url.

        Returns:
            Self (unchanged) after validation.

        Raises:
            ValueError: If a stdio server is missing ``command``.
            ValueError: If a network server is missing ``url``.
            ValueError: If the stdio ``command`` is not on the allowlist.
        """
        if self.transport == "stdio":
            if not self.command:
                raise ValueError(
                    f"MCP server '{self.name}' uses stdio transport but has no 'command'. "
                    f"Set the 'command' field (e.g. 'npx', 'python') in the mcp_servers config."
                )
            # Extract base command name for allowlist check (ignore leading path).
            base_cmd = Path(self.command).name
            if base_cmd not in _stdio_allowlist:
                raise ValueError(
                    f"MCP server '{self.name}' uses command '{self.command}' which is not "
                    f"on the stdio allowlist. "
                    f"Allowed commands: {', '.join(sorted(_stdio_allowlist))}. "
                    f"Call add_allowed_command('{base_cmd}') to permit it explicitly."
                )
        elif self.transport in {"sse", "streamable-http"}:
            if not self.url:
                raise ValueError(
                    f"MCP server '{self.name}' uses '{self.transport}' transport but has no "
                    f"'url'. Set the 'url' field in the mcp_servers config."
                )
        return self

    # ------------------------------------------------------------------
    # Convenience properties
    # ------------------------------------------------------------------

    @property
    def is_stdio(self) -> bool:
        """Return ``True`` when this server uses the stdio transport.

        Returns:
            Boolean transport check.
        """
        return self.transport == "stdio"

    @property
    def is_sse(self) -> bool:
        """Return ``True`` when this server uses the SSE transport.

        Returns:
            Boolean transport check.
        """
        return self.transport == "sse"

    @property
    def is_streamable_http(self) -> bool:
        """Return ``True`` when this server uses the streamable-HTTP transport.

        Returns:
            Boolean transport check.
        """
        return self.transport == "streamable-http"


# ---------------------------------------------------------------------------
# Loader function
# ---------------------------------------------------------------------------


def load_mcp_configs_from_list(servers: list[dict[str, Any]]) -> list[MCPServerConfig]:
    """Parse an inline ``mcp_servers`` array into :class:`MCPServerConfig` models.

    This is the v2.0.0 config format where MCP servers are defined inline
    in the agent config rather than in a separate file::

        "mcp_servers": [
          {
            "name": "filesystem",
            "transport": "stdio",
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
            "enabled": true
          }
        ]

    Args:
        servers: List of server config dicts from the agent config.

    Returns:
        List of validated :class:`MCPServerConfig` objects (disabled servers
        excluded).

    Raises:
        :class:`~agent_service_maf.core.exceptions.ConfigurationError`:
            If a server config is invalid.
    """
    configs: list[MCPServerConfig] = []

    for raw in servers:
        interpolated: dict[str, Any] = _interpolate_raw(raw)

        if "transport" not in interpolated and "command" in interpolated:
            interpolated["transport"] = "stdio"

        server_name = interpolated.get("name", "<unnamed>")
        try:
            cfg = MCPServerConfig.model_validate(interpolated)
        except Exception as exc:
            raise ConfigurationError(
                f"Invalid inline MCP server config for '{server_name}': {exc}. "
                f"Check the 'mcp_servers' array in the agent config."
            ) from exc

        if not cfg.enabled:
            logger.debug("Skipping disabled MCP server", name=server_name)
            continue

        configs.append(cfg)
        logger.info(
            "Loaded inline MCP server config",
            name=server_name,
            transport=cfg.transport,
        )

    return configs


def _interpolate_raw(raw: dict[str, Any]) -> dict[str, Any]:
    """Recursively interpolate env-var placeholders in a raw config dict.

    Args:
        raw: Raw dict from parsed JSON.

    Returns:
        New dict with ``${VAR}`` placeholders resolved in all string values and
        nested string-to-string dicts.
    """
    result: dict[str, Any] = {}
    for key, value in raw.items():
        if isinstance(value, str):
            result[key] = _interpolate(value)
        elif isinstance(value, dict):
            # Only interpolate dicts whose values are strings (e.g. env, headers).
            result[key] = {
                k: (_interpolate(v) if isinstance(v, str) else v) for k, v in value.items()
            }
        else:
            result[key] = value
    return result
