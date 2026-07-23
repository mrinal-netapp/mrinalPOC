"""Transport factory — registry-based MCP server parameter builder.

Implements the Open/Closed Principle: new transports can be registered
without modifying this file.

This module is framework-agnostic and does NOT import any agent framework
libraries (Microsoft Agent Framework, etc.).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import timedelta

import structlog
from mcp import StdioServerParameters
from mcp.client.session_group import (
    ServerParameters,
    SseServerParameters,
    StreamableHttpParameters,
)

from agent_service_maf.core.exceptions import ConfigurationError
from agent_service_maf.mcp.config_loader import MCPServerConfig

logger = structlog.get_logger(__name__)

# Type alias for a transport builder callable.
TransportBuilder = Callable[[MCPServerConfig], ServerParameters]


class TransportFactory:
    """Registry that maps transport names to MCP ``ServerParameters`` builders.

    New transports can be added at runtime without modifying this class:

        >>> factory = TransportFactory()
        >>> def my_builder(cfg: MCPServerConfig) -> MyServerParameters:
        ...     return MyServerParameters(url=cfg.url)
        >>> factory.register("my-transport", my_builder)

    The registry is populated at module import time with built-in builders for
    ``stdio``, ``sse``, and ``streamable-http``.

    Example:
        >>> factory = TransportFactory.default()
        >>> params = factory.build(server_cfg)
    """

    def __init__(self) -> None:
        self._builders: dict[str, TransportBuilder] = {}

    def register(self, transport_name: str, builder: TransportBuilder) -> None:
        """Register a transport builder.

        Args:
            transport_name: Transport identifier string (e.g. ``"stdio"``).
            builder: Callable ``(MCPServerConfig) -> ServerParameters``.
        """
        self._builders[transport_name] = builder
        logger.debug("Registered MCP transport builder", transport=transport_name)

    def build(self, server_cfg: MCPServerConfig) -> ServerParameters:
        """Build the appropriate ``ServerParameters`` for *server_cfg*.

        Args:
            server_cfg: Validated server configuration.

        Returns:
            An MCP SDK ``ServerParameters`` instance (one of
            :class:`~mcp.StdioServerParameters`,
            :class:`~mcp.client.session_group.SseServerParameters`, or
            :class:`~mcp.client.session_group.StreamableHttpParameters`).

        Raises:
            :class:`~agent_service_maf.core.exceptions.ConfigurationError`:
                If no builder is registered for the transport in *server_cfg*.
        """
        transport = server_cfg.transport
        builder = self._builders.get(transport)
        if builder is None:
            available = ", ".join(sorted(self._builders))
            raise ConfigurationError(
                f"No transport builder registered for '{transport}' "
                f"(server: '{server_cfg.name}'). "
                f"Available transports: {available}. "
                f"Register a custom builder with TransportFactory.register()."
            )
        params = builder(server_cfg)
        logger.debug(
            "Built MCP server parameters",
            server=server_cfg.name,
            transport=transport,
        )
        return params

    def list_transports(self) -> list[str]:
        """Return a sorted list of registered transport names.

        Returns:
            List of transport identifier strings.
        """
        return sorted(self._builders)

    # ------------------------------------------------------------------
    # Factory constructor
    # ------------------------------------------------------------------

    @classmethod
    def default(cls) -> TransportFactory:
        """Create a :class:`TransportFactory` pre-populated with built-in builders.

        Built-in transports registered:

        * ``stdio`` — :class:`~mcp.StdioServerParameters`
        * ``sse`` — :class:`~mcp.client.session_group.SseServerParameters`
        * ``streamable-http`` — :class:`~mcp.client.session_group.StreamableHttpParameters`

        Returns:
            New :class:`TransportFactory` instance with all three builders.
        """
        factory = cls()
        factory.register("stdio", _build_stdio)
        factory.register("sse", _build_sse)
        factory.register("streamable-http", _build_streamable_http)
        return factory


# ---------------------------------------------------------------------------
# Built-in transport builders
# ---------------------------------------------------------------------------


def _build_stdio(cfg: MCPServerConfig) -> StdioServerParameters:
    """Build ``StdioServerParameters`` for a stdio MCP server.

    Args:
        cfg: Validated server configuration with ``transport == "stdio"``.

    Returns:
        :class:`~mcp.StdioServerParameters` ready to pass to
        ``ClientSessionGroup.connect_to_server()``.

    Raises:
        :class:`~agent_service_maf.core.exceptions.ConfigurationError`:
            If ``command`` is missing (should have been caught by
            ``MCPServerConfig`` validation).
    """
    if not cfg.command:
        raise ConfigurationError(
            f"Stdio server '{cfg.name}' has no 'command'. "
            f"Set the 'command' field in the mcp_servers config."
        )
    # Pass env only when non-empty; None triggers MCP SDK default env handling.
    env: dict[str, str] | None = cfg.env if cfg.env else None
    return StdioServerParameters(
        command=cfg.command,
        args=cfg.args,
        env=env,
    )


def _build_sse(cfg: MCPServerConfig) -> SseServerParameters:
    """Build ``SseServerParameters`` for an SSE MCP server.

    Args:
        cfg: Validated server configuration with ``transport == "sse"``.

    Returns:
        :class:`~mcp.client.session_group.SseServerParameters` ready to pass to
        ``ClientSessionGroup.connect_to_server()``.

    Raises:
        :class:`~agent_service_maf.core.exceptions.ConfigurationError`:
            If ``url`` is missing (should have been caught by
            ``MCPServerConfig`` validation).
    """
    if not cfg.url:
        raise ConfigurationError(
            f"SSE server '{cfg.name}' has no 'url'. Set the 'url' field in the mcp_servers config."
        )
    headers: dict[str, str] | None = cfg.headers if cfg.headers else None
    return SseServerParameters(
        url=cfg.url,
        headers=headers,
        timeout=cfg.timeout_seconds,
        sse_read_timeout=cfg.sse_read_timeout_seconds,
    )


def _build_streamable_http(cfg: MCPServerConfig) -> StreamableHttpParameters:
    """Build ``StreamableHttpParameters`` for a streamable-HTTP MCP server.

    Args:
        cfg: Validated server configuration with ``transport == "streamable-http"``.

    Returns:
        :class:`~mcp.client.session_group.StreamableHttpParameters` ready to pass
        to ``ClientSessionGroup.connect_to_server()``.

    Raises:
        :class:`~agent_service_maf.core.exceptions.ConfigurationError`:
            If ``url`` is missing (should have been caught by
            ``MCPServerConfig`` validation).
    """
    if not cfg.url:
        raise ConfigurationError(
            f"Streamable-HTTP server '{cfg.name}' has no 'url'. "
            f"Set the 'url' field in the mcp_servers config."
        )
    headers: dict[str, str] | None = cfg.headers if cfg.headers else None
    return StreamableHttpParameters(
        url=cfg.url,
        headers=headers,
        timeout=timedelta(seconds=cfg.timeout_seconds),
        sse_read_timeout=timedelta(seconds=cfg.sse_read_timeout_seconds),
    )
