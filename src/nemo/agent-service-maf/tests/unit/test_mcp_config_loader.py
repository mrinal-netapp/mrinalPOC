"""Unit tests for MCPServerConfig and load_mcp_configs_from_list.

Tests cover:
- Stdio config validation (command required, allowlist enforcement)
- SSE config validation (url required)
- Streamable-HTTP config validation
- Invalid transport type
- Env var interpolation (${VAR} syntax)
- Disabled servers are skipped
- Empty list returns empty list
- Invalid server config raises ConfigurationError
- Convenience properties (is_stdio, is_sse, is_streamable_http)
- add_allowed_command / reset_allowlist
"""

from __future__ import annotations

import pytest

from agent_service_maf.core.exceptions import ConfigurationError
from agent_service_maf.mcp.config_loader import (
    MCPServerConfig,
    add_allowed_command,
    load_mcp_configs_from_list,
    reset_allowlist,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def reset_stdio_allowlist_after_test() -> None:
    """Restore the default stdio allowlist after each test."""
    yield
    reset_allowlist()


# ---------------------------------------------------------------------------
# MCPServerConfig — stdio validation
# ---------------------------------------------------------------------------


class TestMCPServerConfigStdio:
    """Tests for stdio transport MCPServerConfig validation."""

    def test_valid_stdio_config(self) -> None:
        """Valid stdio config with allowed command passes validation."""
        cfg = MCPServerConfig(name="test", transport="stdio", command="npx")
        assert cfg.name == "test", "name must be stored"
        assert cfg.transport == "stdio", "transport must be 'stdio'"
        assert cfg.command == "npx", "command must be 'npx'"

    def test_stdio_requires_command(self) -> None:
        """Stdio config without command raises ValueError."""
        with pytest.raises((ValueError, Exception)) as exc_info:
            MCPServerConfig(name="test", transport="stdio")
        assert "command" in str(exc_info.value).lower(), "Error message must mention 'command'"

    def test_stdio_command_must_be_on_allowlist(self) -> None:
        """Stdio command not on the allowlist raises ValueError."""
        with pytest.raises((ValueError, Exception)) as exc_info:
            MCPServerConfig(name="test", transport="stdio", command="dangerous_cmd")
        assert (
            "allowlist" in str(exc_info.value).lower() or "allowed" in str(exc_info.value).lower()
        ), "Error must mention allowlist when command is rejected"

    def test_stdio_allowlist_accepts_npx(self) -> None:
        """npx is on the default allowlist."""
        cfg = MCPServerConfig(name="s", transport="stdio", command="npx", args=["-y", "pkg"])
        assert cfg.command == "npx", "npx must be on the default allowlist"

    def test_stdio_allowlist_accepts_python3(self) -> None:
        """python3 is on the default allowlist."""
        cfg = MCPServerConfig(name="s", transport="stdio", command="python3")
        assert cfg.command == "python3", "python3 must be on the default allowlist"

    def test_stdio_allowlist_accepts_node(self) -> None:
        """node is on the default allowlist."""
        cfg = MCPServerConfig(name="s", transport="stdio", command="node")
        assert cfg.command == "node", "node must be on the default allowlist"

    def test_stdio_allowlist_accepts_python(self) -> None:
        """python is on the default allowlist."""
        cfg = MCPServerConfig(name="s", transport="stdio", command="python")
        assert cfg.command == "python", "python must be on the default allowlist"

    def test_stdio_allowlist_accepts_uvx(self) -> None:
        """uvx is on the default allowlist."""
        cfg = MCPServerConfig(name="s", transport="stdio", command="uvx")
        assert cfg.command == "uvx", "uvx must be on the default allowlist"

    def test_stdio_allowlist_accepts_docker(self) -> None:
        """docker is on the default allowlist."""
        cfg = MCPServerConfig(name="s", transport="stdio", command="docker")
        assert cfg.command == "docker", "docker must be on the default allowlist"

    def test_add_allowed_command_permits_custom_command(self) -> None:
        """add_allowed_command allows a new command to pass validation."""
        add_allowed_command("my_custom_cmd")
        cfg = MCPServerConfig(name="s", transport="stdio", command="my_custom_cmd")
        assert cfg.command == "my_custom_cmd", (
            "after add_allowed_command, the custom command must be accepted"
        )

    def test_reset_allowlist_removes_custom_command(self) -> None:
        """reset_allowlist removes any command added via add_allowed_command."""
        add_allowed_command("custom_cmd")
        reset_allowlist()
        with pytest.raises((ValueError, Exception)):
            MCPServerConfig(name="s", transport="stdio", command="custom_cmd")

    def test_stdio_is_stdio_property(self) -> None:
        """is_stdio returns True for stdio transport."""
        cfg = MCPServerConfig(name="s", transport="stdio", command="npx")
        assert cfg.is_stdio is True, "is_stdio must be True for stdio transport"

    def test_stdio_is_sse_property_false(self) -> None:
        """is_sse returns False for stdio transport."""
        cfg = MCPServerConfig(name="s", transport="stdio", command="npx")
        assert cfg.is_sse is False, "is_sse must be False for stdio transport"

    def test_stdio_is_streamable_http_property_false(self) -> None:
        """is_streamable_http returns False for stdio transport."""
        cfg = MCPServerConfig(name="s", transport="stdio", command="npx")
        assert cfg.is_streamable_http is False, (
            "is_streamable_http must be False for stdio transport"
        )

    def test_stdio_args_default_empty(self) -> None:
        """args defaults to empty list when not specified."""
        cfg = MCPServerConfig(name="s", transport="stdio", command="npx")
        assert cfg.args == [], "args must default to empty list"

    def test_stdio_args_stored_correctly(self) -> None:
        """args list is stored as provided."""
        cfg = MCPServerConfig(name="s", transport="stdio", command="npx", args=["-y", "pkg"])
        assert cfg.args == ["-y", "pkg"], "args must be stored as-is"

    def test_stdio_env_default_empty(self) -> None:
        """env defaults to empty dict when not specified."""
        cfg = MCPServerConfig(name="s", transport="stdio", command="npx")
        assert cfg.env == {}, "env must default to empty dict"

    def test_stdio_command_with_path_prefix_base_name_checked(self) -> None:
        """Allowlist check uses the base name of the command path."""
        add_allowed_command("myscript")
        cfg = MCPServerConfig(name="s", transport="stdio", command="/usr/bin/myscript")
        assert cfg.command == "/usr/bin/myscript", (
            "full path is stored but only base name is allowlist-checked"
        )


# ---------------------------------------------------------------------------
# MCPServerConfig — SSE validation
# ---------------------------------------------------------------------------


class TestMCPServerConfigSSE:
    """Tests for SSE transport MCPServerConfig validation."""

    def test_valid_sse_config(self) -> None:
        """Valid SSE config with url passes validation."""
        cfg = MCPServerConfig(name="s", transport="sse", url="http://localhost:8080/sse")
        assert cfg.url == "http://localhost:8080/sse", "url must be stored"
        assert cfg.transport == "sse", "transport must be 'sse'"

    def test_sse_requires_url(self) -> None:
        """SSE config without url raises ValueError."""
        with pytest.raises((ValueError, Exception)) as exc_info:
            MCPServerConfig(name="s", transport="sse")
        assert "url" in str(exc_info.value).lower(), (
            "Error message must mention 'url' for missing url"
        )

    def test_sse_is_sse_property(self) -> None:
        """is_sse returns True for sse transport."""
        cfg = MCPServerConfig(name="s", transport="sse", url="http://example.com")
        assert cfg.is_sse is True, "is_sse must be True for sse transport"

    def test_sse_is_stdio_property_false(self) -> None:
        """is_stdio returns False for sse transport."""
        cfg = MCPServerConfig(name="s", transport="sse", url="http://example.com")
        assert cfg.is_stdio is False, "is_stdio must be False for sse transport"

    def test_sse_headers_stored(self) -> None:
        """headers dict is stored for SSE transport."""
        headers = {"Authorization": "Bearer tok", "X-Custom": "val"}
        cfg = MCPServerConfig(name="s", transport="sse", url="http://x.com", headers=headers)
        assert cfg.headers == headers, "headers must be stored"

    def test_sse_timeout_defaults(self) -> None:
        """timeout_seconds and sse_read_timeout_seconds have expected defaults."""
        cfg = MCPServerConfig(name="s", transport="sse", url="http://x.com")
        assert cfg.timeout_seconds == 30.0, "timeout_seconds must default to 30.0"
        assert cfg.sse_read_timeout_seconds == 300.0, (
            "sse_read_timeout_seconds must default to 300.0"
        )


# ---------------------------------------------------------------------------
# MCPServerConfig — streamable-http validation
# ---------------------------------------------------------------------------


class TestMCPServerConfigStreamableHTTP:
    """Tests for streamable-http transport MCPServerConfig validation."""

    def test_valid_streamable_http_config(self) -> None:
        """Valid streamable-http config with url passes validation."""
        cfg = MCPServerConfig(name="s", transport="streamable-http", url="http://localhost:9000")
        assert cfg.url == "http://localhost:9000", "url must be stored"
        assert cfg.transport == "streamable-http", "transport must be 'streamable-http'"

    def test_streamable_http_requires_url(self) -> None:
        """Streamable-http without url raises ValueError."""
        with pytest.raises((ValueError, Exception)) as exc_info:
            MCPServerConfig(name="s", transport="streamable-http")
        assert "url" in str(exc_info.value).lower(), (
            "Error must mention 'url' for streamable-http without url"
        )

    def test_streamable_http_is_streamable_http_property(self) -> None:
        """is_streamable_http returns True for streamable-http transport."""
        cfg = MCPServerConfig(name="s", transport="streamable-http", url="http://x.com")
        assert cfg.is_streamable_http is True, (
            "is_streamable_http must be True for streamable-http transport"
        )

    def test_streamable_http_is_sse_false(self) -> None:
        """is_sse returns False for streamable-http transport."""
        cfg = MCPServerConfig(name="s", transport="streamable-http", url="http://x.com")
        assert cfg.is_sse is False, "is_sse must be False for streamable-http transport"


# ---------------------------------------------------------------------------
# MCPServerConfig — invalid transport
# ---------------------------------------------------------------------------


class TestMCPServerConfigInvalidTransport:
    """Tests for invalid transport type validation."""

    def test_invalid_transport_raises(self) -> None:
        """Unknown transport string raises ValueError."""
        with pytest.raises((ValueError, Exception)) as exc_info:
            MCPServerConfig(name="s", transport="websocket", command="npx")
        error_msg = str(exc_info.value).lower()
        assert "websocket" in error_msg or "transport" in error_msg, (
            "Error must mention the invalid transport name or 'transport'"
        )

    def test_invalid_transport_error_lists_allowed(self) -> None:
        """Error message for invalid transport lists the allowed values."""
        with pytest.raises((ValueError, Exception)) as exc_info:
            MCPServerConfig(name="s", transport="grpc")
        error_msg = str(exc_info.value)
        assert any(t in error_msg for t in ["stdio", "sse", "streamable-http"]), (
            "Error must list at least one allowed transport"
        )


# ---------------------------------------------------------------------------
# MCPServerConfig — common fields
# ---------------------------------------------------------------------------


class TestMCPServerConfigCommonFields:
    """Tests for fields common to all transport types."""

    def test_enabled_defaults_to_true(self) -> None:
        """enabled field defaults to True."""
        cfg = MCPServerConfig(name="s", transport="stdio", command="npx")
        assert cfg.enabled is True, "enabled must default to True"

    def test_enabled_can_be_false(self) -> None:
        """enabled can be set to False."""
        cfg = MCPServerConfig(name="s", transport="stdio", command="npx", enabled=False)
        assert cfg.enabled is False, "enabled=False must be stored"

    def test_description_defaults_empty(self) -> None:
        """description defaults to empty string."""
        cfg = MCPServerConfig(name="s", transport="stdio", command="npx")
        assert cfg.description == "", "description must default to empty string"

    def test_tags_defaults_empty(self) -> None:
        """tags defaults to empty list."""
        cfg = MCPServerConfig(name="s", transport="stdio", command="npx")
        assert cfg.tags == [], "tags must default to empty list"

    def test_tags_stored(self) -> None:
        """tags list is stored correctly."""
        cfg = MCPServerConfig(
            name="s", transport="stdio", command="npx", tags=["search", "external"]
        )
        assert cfg.tags == ["search", "external"], "tags must be stored as-is"


# ---------------------------------------------------------------------------
# load_mcp_configs_from_list — inline v2.0.0 format
# ---------------------------------------------------------------------------


class TestLoadMCPConfigsFromList:
    """Tests for :func:`load_mcp_configs_from_list`.

    This is the only supported loader in v2.0.0 — MCP servers are defined
    inline on each team config under the top-level ``mcp_servers: []`` array.
    """

    def test_empty_list_returns_empty_list(self) -> None:
        """load_mcp_configs_from_list returns empty list for empty input."""
        assert load_mcp_configs_from_list([]) == []

    def test_valid_stdio_config_loaded(self) -> None:
        configs = load_mcp_configs_from_list(
            [
                {
                    "name": "my-server",
                    "transport": "stdio",
                    "command": "npx",
                    "args": ["-y", "mcp-server"],
                }
            ]
        )
        assert len(configs) == 1
        assert configs[0].name == "my-server"
        assert configs[0].command == "npx"

    def test_valid_sse_config_loaded(self) -> None:
        configs = load_mcp_configs_from_list(
            [{"name": "sse-server", "transport": "sse", "url": "http://localhost:8080/sse"}]
        )
        assert len(configs) == 1
        assert configs[0].transport == "sse"
        assert configs[0].url == "http://localhost:8080/sse"

    def test_valid_streamable_http_config_loaded(self) -> None:
        configs = load_mcp_configs_from_list(
            [
                {
                    "name": "http-server",
                    "transport": "streamable-http",
                    "url": "http://localhost:9000",
                }
            ]
        )
        assert len(configs) == 1
        assert configs[0].transport == "streamable-http"

    def test_disabled_server_skipped(self) -> None:
        configs = load_mcp_configs_from_list(
            [
                {"name": "on", "transport": "stdio", "command": "npx", "enabled": True},
                {"name": "off", "transport": "stdio", "command": "node", "enabled": False},
            ]
        )
        assert len(configs) == 1
        assert configs[0].name == "on"

    def test_all_disabled_returns_empty_list(self) -> None:
        configs = load_mcp_configs_from_list(
            [{"name": "s", "transport": "stdio", "command": "npx", "enabled": False}]
        )
        assert configs == []

    def test_multiple_servers_loaded(self) -> None:
        configs = load_mcp_configs_from_list(
            [
                {"name": "s1", "transport": "stdio", "command": "npx"},
                {"name": "s2", "transport": "sse", "url": "http://localhost:8080"},
            ]
        )
        assert {c.name for c in configs} == {"s1", "s2"}

    def test_invalid_server_config_raises_configuration_error(self) -> None:
        with pytest.raises(ConfigurationError) as exc_info:
            load_mcp_configs_from_list(
                [
                    {"name": "bad-server", "transport": "stdio"}  # missing command
                ]
            )
        assert "bad-server" in str(exc_info.value), (
            "ConfigurationError must mention the offending server name"
        )


# ---------------------------------------------------------------------------
# load_mcp_configs_from_list — env var interpolation
# ---------------------------------------------------------------------------


class TestLoadMCPConfigsEnvInterpolation:
    """Environment variable interpolation in ``load_mcp_configs_from_list``.

    Inline configs preserve the same ``${VAR}`` substitution rules the
    deprecated file loader used, so these tests exercise url / env / headers
    interpolation at the inline-array boundary.
    """

    def test_env_var_interpolated_in_url(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """${ENV_VAR} placeholders in url are replaced with env values."""
        monkeypatch.setenv("MCP_TEST_HOST", "myhost.example.com")
        configs = load_mcp_configs_from_list(
            [{"name": "s", "transport": "sse", "url": "http://${MCP_TEST_HOST}/sse"}]
        )
        assert configs[0].url == "http://myhost.example.com/sse"

    def test_env_var_interpolated_in_env_dict(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """${ENV_VAR} placeholders in env dict values are replaced."""
        monkeypatch.setenv("MY_DB_URL", "postgresql://localhost/mydb")
        configs = load_mcp_configs_from_list(
            [
                {
                    "name": "s",
                    "transport": "stdio",
                    "command": "npx",
                    "env": {"DB_URL": "${MY_DB_URL}"},
                }
            ]
        )
        assert configs[0].env["DB_URL"] == "postgresql://localhost/mydb"

    def test_unresolved_env_var_becomes_empty_string(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Unresolved ${MISSING_VAR} placeholders become empty string."""
        monkeypatch.delenv("MISSING_MCP_VAR", raising=False)
        configs = load_mcp_configs_from_list(
            [{"name": "s", "transport": "sse", "url": "http://host/${MISSING_MCP_VAR}/sse"}]
        )
        assert configs[0].url == "http://host//sse"

    def test_env_var_interpolated_in_headers(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """${ENV_VAR} in headers dict values is replaced."""
        monkeypatch.setenv("MY_API_KEY", "secret-key-123")
        configs = load_mcp_configs_from_list(
            [
                {
                    "name": "s",
                    "transport": "sse",
                    "url": "http://example.com",
                    "headers": {"X-API-Key": "${MY_API_KEY}"},
                }
            ]
        )
        assert configs[0].headers["X-API-Key"] == "secret-key-123"
