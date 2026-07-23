"""Unit tests for TransportFactory.

Tests cover:
- TransportFactory.default() creates all three built-in transports
- register() adds new transport builders
- build() calls the correct builder
- build() raises ConfigurationError for unknown transport
- list_transports() returns sorted names
- Custom transport registration
- Built-in stdio builder produces correct StdioServerParameters
- Built-in sse builder produces correct SseServerParameters
- Built-in streamable-http builder produces correct StreamableHttpParameters
- Builder called with env=None when cfg.env is empty
"""

from __future__ import annotations

from datetime import timedelta
from unittest.mock import MagicMock

import pytest
from mcp import StdioServerParameters
from mcp.client.session_group import ServerParameters, SseServerParameters, StreamableHttpParameters

from agent_service_maf.core.exceptions import ConfigurationError
from agent_service_maf.mcp.config_loader import MCPServerConfig, reset_allowlist
from agent_service_maf.mcp.transport_factory import TransportFactory

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def restore_allowlist() -> None:
    """Restore default stdio allowlist after each test."""
    yield
    reset_allowlist()


def stdio_cfg(
    name: str = "s",
    command: str = "npx",
    args: list[str] | None = None,
    env: dict[str, str] | None = None,
) -> MCPServerConfig:
    """Create a minimal stdio MCPServerConfig."""
    return MCPServerConfig(
        name=name,
        transport="stdio",
        command=command,
        args=args or [],
        env=env or {},
    )


def sse_cfg(
    name: str = "s",
    url: str = "http://localhost:8080/sse",
    headers: dict[str, str] | None = None,
    timeout_seconds: float = 30.0,
    sse_read_timeout_seconds: float = 300.0,
) -> MCPServerConfig:
    """Create a minimal SSE MCPServerConfig."""
    return MCPServerConfig(
        name=name,
        transport="sse",
        url=url,
        headers=headers or {},
        timeout_seconds=timeout_seconds,
        sse_read_timeout_seconds=sse_read_timeout_seconds,
    )


def streamable_http_cfg(
    name: str = "s",
    url: str = "http://localhost:9000",
    headers: dict[str, str] | None = None,
    timeout_seconds: float = 30.0,
    sse_read_timeout_seconds: float = 300.0,
) -> MCPServerConfig:
    """Create a minimal streamable-http MCPServerConfig."""
    return MCPServerConfig(
        name=name,
        transport="streamable-http",
        url=url,
        headers=headers or {},
        timeout_seconds=timeout_seconds,
        sse_read_timeout_seconds=sse_read_timeout_seconds,
    )


# ---------------------------------------------------------------------------
# TransportFactory — default() constructor
# ---------------------------------------------------------------------------


class TestTransportFactoryDefault:
    """Tests for TransportFactory.default() class method."""

    def test_default_registers_stdio(self) -> None:
        """TransportFactory.default() registers the 'stdio' transport."""
        factory = TransportFactory.default()
        assert "stdio" in factory.list_transports(), (
            "'stdio' must be registered in the default factory"
        )

    def test_default_registers_sse(self) -> None:
        """TransportFactory.default() registers the 'sse' transport."""
        factory = TransportFactory.default()
        assert "sse" in factory.list_transports(), "'sse' must be registered in the default factory"

    def test_default_registers_streamable_http(self) -> None:
        """TransportFactory.default() registers the 'streamable-http' transport."""
        factory = TransportFactory.default()
        assert "streamable-http" in factory.list_transports(), (
            "'streamable-http' must be registered in the default factory"
        )

    def test_default_has_exactly_three_transports(self) -> None:
        """TransportFactory.default() has exactly three built-in transports."""
        factory = TransportFactory.default()
        transports = factory.list_transports()
        assert len(transports) == 3, (
            "default factory must have exactly 3 transports (stdio, sse, streamable-http)"
        )

    def test_list_transports_is_sorted(self) -> None:
        """list_transports() returns names in sorted order."""
        factory = TransportFactory.default()
        transports = factory.list_transports()
        assert transports == sorted(transports), (
            "list_transports() must return sorted transport names"
        )


# ---------------------------------------------------------------------------
# TransportFactory — register()
# ---------------------------------------------------------------------------


class TestTransportFactoryRegister:
    """Tests for the register() method."""

    def test_register_adds_transport(self) -> None:
        """register() adds a new transport to the factory."""
        factory = TransportFactory()
        builder = lambda cfg: MagicMock()  # noqa: E731
        factory.register("my-transport", builder)
        assert "my-transport" in factory.list_transports(), (
            "registered transport must appear in list_transports()"
        )

    def test_register_overwrites_existing(self) -> None:
        """register() silently replaces an existing transport builder."""
        factory = TransportFactory()
        old_builder = MagicMock(return_value=MagicMock())
        new_builder = MagicMock(return_value=MagicMock())
        factory.register("test", old_builder)
        factory.register("test", new_builder)
        # Build uses new builder
        cfg = stdio_cfg()
        object.__setattr__(cfg, "transport", "test")
        factory.build(cfg)
        new_builder.assert_called_once(), "new builder must be called after overwrite"
        old_builder.assert_not_called(), "old builder must not be called after overwrite"

    def test_register_empty_factory(self) -> None:
        """Registering on an empty TransportFactory() creates one transport."""
        factory = TransportFactory()
        factory.register("custom", lambda cfg: MagicMock())
        assert factory.list_transports() == ["custom"], (
            "empty factory with one custom transport must list only that transport"
        )


# ---------------------------------------------------------------------------
# TransportFactory — build()
# ---------------------------------------------------------------------------


class TestTransportFactoryBuild:
    """Tests for the build() method."""

    def test_build_stdio_returns_stdio_parameters(self) -> None:
        """build() returns StdioServerParameters for stdio config."""
        factory = TransportFactory.default()
        params = factory.build(stdio_cfg(command="npx", args=["-y", "pkg"]))
        assert isinstance(params, StdioServerParameters), (
            "stdio config must produce StdioServerParameters"
        )

    def test_build_stdio_command_set(self) -> None:
        """StdioServerParameters has the correct command."""
        factory = TransportFactory.default()
        params = factory.build(stdio_cfg(command="node"))
        assert params.command == "node", "StdioServerParameters.command must match config"

    def test_build_stdio_args_set(self) -> None:
        """StdioServerParameters has the correct args."""
        factory = TransportFactory.default()
        params = factory.build(stdio_cfg(args=["--flag", "value"]))
        assert params.args == ["--flag", "value"], (
            "StdioServerParameters.args must match config args"
        )

    def test_build_stdio_env_none_when_empty(self) -> None:
        """StdioServerParameters.env is None when config.env is empty."""
        factory = TransportFactory.default()
        params = factory.build(stdio_cfg(env={}))
        assert params.env is None, "env must be None (not empty dict) when config has no env vars"

    def test_build_stdio_env_set_when_provided(self) -> None:
        """StdioServerParameters.env is set when config has env vars."""
        factory = TransportFactory.default()
        params = factory.build(stdio_cfg(env={"FOO": "bar"}))
        assert params.env == {"FOO": "bar"}, "env must be passed through when config has env vars"

    def test_build_sse_returns_sse_parameters(self) -> None:
        """build() returns SseServerParameters for sse config."""
        factory = TransportFactory.default()
        params = factory.build(sse_cfg())
        assert isinstance(params, SseServerParameters), (
            "sse config must produce SseServerParameters"
        )

    def test_build_sse_url_set(self) -> None:
        """SseServerParameters has the correct url."""
        factory = TransportFactory.default()
        params = factory.build(sse_cfg(url="http://my-server.example.com/sse"))
        assert params.url == "http://my-server.example.com/sse", (
            "SseServerParameters.url must match config url"
        )

    def test_build_sse_headers_none_when_empty(self) -> None:
        """SseServerParameters.headers is None when config.headers is empty."""
        factory = TransportFactory.default()
        params = factory.build(sse_cfg(headers={}))
        assert params.headers is None, (
            "SseServerParameters.headers must be None when config has no headers"
        )

    def test_build_sse_headers_set_when_provided(self) -> None:
        """SseServerParameters.headers is set when config has headers."""
        factory = TransportFactory.default()
        params = factory.build(sse_cfg(headers={"X-Token": "abc"}))
        assert params.headers == {"X-Token": "abc"}, (
            "SseServerParameters.headers must match config headers"
        )

    def test_build_sse_timeout_set(self) -> None:
        """SseServerParameters.timeout matches config.timeout_seconds."""
        factory = TransportFactory.default()
        params = factory.build(sse_cfg(timeout_seconds=45.0))
        assert params.timeout == 45.0, "SseServerParameters.timeout must be the config value"

    def test_build_sse_read_timeout_set(self) -> None:
        """SseServerParameters.sse_read_timeout matches config.sse_read_timeout_seconds."""
        factory = TransportFactory.default()
        params = factory.build(sse_cfg(sse_read_timeout_seconds=600.0))
        assert params.sse_read_timeout == 600.0, (
            "SseServerParameters.sse_read_timeout must be the config value"
        )

    def test_build_streamable_http_returns_streamable_http_parameters(self) -> None:
        """build() returns StreamableHttpParameters for streamable-http config."""
        factory = TransportFactory.default()
        params = factory.build(streamable_http_cfg())
        assert isinstance(params, StreamableHttpParameters), (
            "streamable-http config must produce StreamableHttpParameters"
        )

    def test_build_streamable_http_url_set(self) -> None:
        """StreamableHttpParameters has the correct url."""
        factory = TransportFactory.default()
        params = factory.build(streamable_http_cfg(url="http://stream.example.com"))
        assert params.url == "http://stream.example.com", (
            "StreamableHttpParameters.url must match config url"
        )

    def test_build_streamable_http_timeout_is_timedelta(self) -> None:
        """StreamableHttpParameters.timeout is a timedelta."""
        factory = TransportFactory.default()
        params = factory.build(streamable_http_cfg(timeout_seconds=60.0))
        assert isinstance(params.timeout, timedelta), (
            "StreamableHttpParameters.timeout must be a timedelta"
        )
        assert params.timeout.total_seconds() == 60.0, (
            "timedelta must represent the configured timeout_seconds"
        )

    def test_build_streamable_http_sse_read_timeout_is_timedelta(self) -> None:
        """StreamableHttpParameters.sse_read_timeout is a timedelta."""
        factory = TransportFactory.default()
        params = factory.build(streamable_http_cfg(sse_read_timeout_seconds=200.0))
        assert isinstance(params.sse_read_timeout, timedelta), (
            "StreamableHttpParameters.sse_read_timeout must be a timedelta"
        )
        assert params.sse_read_timeout.total_seconds() == 200.0, (
            "sse_read_timeout timedelta must match the config value"
        )

    def test_build_streamable_http_headers_none_when_empty(self) -> None:
        """StreamableHttpParameters.headers is None when config.headers is empty."""
        factory = TransportFactory.default()
        params = factory.build(streamable_http_cfg(headers={}))
        assert params.headers is None, (
            "StreamableHttpParameters.headers must be None for empty config headers"
        )

    def test_build_unknown_transport_raises_configuration_error(self) -> None:
        """build() raises ConfigurationError for unregistered transport."""
        factory = TransportFactory.default()
        # Create a mock config object with an unregistered transport
        mock_cfg = MagicMock(spec=MCPServerConfig)
        mock_cfg.transport = "websocket"
        mock_cfg.name = "test-server"
        with pytest.raises(ConfigurationError) as exc_info:
            factory.build(mock_cfg)
        assert "websocket" in str(exc_info.value), (
            "ConfigurationError must mention the unknown transport 'websocket'"
        )

    def test_build_unknown_transport_error_lists_available(self) -> None:
        """ConfigurationError for unknown transport lists available transports."""
        factory = TransportFactory.default()
        mock_cfg = MagicMock(spec=MCPServerConfig)
        mock_cfg.transport = "grpc"
        mock_cfg.name = "s"
        with pytest.raises(ConfigurationError) as exc_info:
            factory.build(mock_cfg)
        error_msg = str(exc_info.value)
        assert "stdio" in error_msg or "sse" in error_msg, (
            "Error must list at least one available transport"
        )

    def test_build_calls_registered_custom_builder(self) -> None:
        """build() delegates to the registered custom builder callable."""
        factory = TransportFactory()
        mock_params = MagicMock(spec=ServerParameters)
        mock_builder = MagicMock(return_value=mock_params)
        factory.register("custom", mock_builder)

        mock_cfg = MagicMock(spec=MCPServerConfig)
        mock_cfg.transport = "custom"
        mock_cfg.name = "custom-server"

        result = factory.build(mock_cfg)
        (
            mock_builder.assert_called_once_with(mock_cfg),
            ("custom builder must be called with the config object"),
        )
        assert result is mock_params, "build() must return what the builder returns"


# ---------------------------------------------------------------------------
# TransportFactory — list_transports()
# ---------------------------------------------------------------------------


class TestTransportFactoryListTransports:
    """Tests for the list_transports() method."""

    def test_empty_factory_returns_empty_list(self) -> None:
        """Empty TransportFactory has no transports."""
        factory = TransportFactory()
        assert factory.list_transports() == [], "new empty factory must have empty transport list"

    def test_list_after_register(self) -> None:
        """list_transports() returns names after registrations."""
        factory = TransportFactory()
        factory.register("zz", lambda cfg: MagicMock())
        factory.register("aa", lambda cfg: MagicMock())
        result = factory.list_transports()
        assert result == ["aa", "zz"], "list_transports must return sorted names"
