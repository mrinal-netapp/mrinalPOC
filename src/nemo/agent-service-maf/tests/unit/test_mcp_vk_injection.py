"""Unit tests — per-project VK stamped onto MCP server configs.

Bifrost's aggregated ``/mcp`` proxy has no master key; it authenticates
with the same per-project virtual key as chat completions. The team
loader stamps that VK as an ``Authorization: Bearer`` header on every
Bifrost-routed (URL-based) MCP server before handing the configs to the
``MCPManager``. Without it, ``connect()`` to ``/mcp`` is rejected with
401 and every MCP-backed agent fails at run time.

These tests pin the pure helper :func:`_inject_project_vk_into_mcp_servers`.
"""

from __future__ import annotations

from agent_service_maf.core.team_loader import _inject_project_vk_into_mcp_servers

VK = "sk-bf-project-virtual-key-123"


def test_network_server_without_auth_gets_bearer() -> None:
    """A URL-based server with no auth header gains ``Authorization: Bearer <vk>``."""
    servers = [
        {
            "name": "weather",
            "transport": "streamable-http",
            "url": "http://bifrost/mcp",
            "gateway_server_name": "projXY_weather",
        }
    ]

    out = _inject_project_vk_into_mcp_servers(servers, VK)

    assert out[0]["headers"]["Authorization"] == f"Bearer {VK}"


def test_stdio_server_untouched() -> None:
    """A stdio server (no ``url``) must never receive the gateway VK."""
    servers = [
        {
            "name": "fs",
            "transport": "stdio",
            "command": "npx",
            "args": ["-y", "server-filesystem"],
        }
    ]

    out = _inject_project_vk_into_mcp_servers(servers, VK)

    assert "headers" not in out[0] or "Authorization" not in out[0].get("headers", {})


def test_existing_authorization_header_preserved() -> None:
    """An operator-supplied ``Authorization`` header is never overwritten."""
    servers = [
        {
            "name": "custom",
            "transport": "streamable-http",
            "url": "http://elsewhere/mcp",
            "headers": {"Authorization": "Bearer operator-token"},
        }
    ]

    out = _inject_project_vk_into_mcp_servers(servers, VK)

    assert out[0]["headers"]["Authorization"] == "Bearer operator-token"


def test_existing_authorization_header_case_insensitive() -> None:
    """A lowercased ``authorization`` header still counts as pre-set auth."""
    servers = [
        {
            "name": "custom",
            "transport": "sse",
            "url": "http://elsewhere/mcp",
            "headers": {"authorization": "Bearer operator-token"},
        }
    ]

    out = _inject_project_vk_into_mcp_servers(servers, VK)

    assert out[0]["headers"] == {"authorization": "Bearer operator-token"}
    assert "Authorization" not in out[0]["headers"]


def test_other_headers_preserved_when_injecting() -> None:
    """Existing non-auth headers survive alongside the injected bearer."""
    servers = [
        {
            "name": "weather",
            "transport": "streamable-http",
            "url": "http://bifrost/mcp",
            "headers": {"X-Trace": "abc"},
        }
    ]

    out = _inject_project_vk_into_mcp_servers(servers, VK)

    assert out[0]["headers"]["X-Trace"] == "abc"
    assert out[0]["headers"]["Authorization"] == f"Bearer {VK}"


def test_original_dicts_not_mutated() -> None:
    """The helper returns copies; the caller's source dicts stay pristine."""
    servers = [
        {
            "name": "weather",
            "transport": "streamable-http",
            "url": "http://bifrost/mcp",
        }
    ]

    _inject_project_vk_into_mcp_servers(servers, VK)

    assert "headers" not in servers[0], "source dict must not be mutated in place"


def test_mixed_list_only_network_servers_patched() -> None:
    """A mix of stdio + network servers: only the network ones get the VK."""
    servers = [
        {"name": "fs", "transport": "stdio", "command": "npx"},
        {
            "name": "weather",
            "transport": "streamable-http",
            "url": "http://bifrost/mcp",
        },
    ]

    out = _inject_project_vk_into_mcp_servers(servers, VK)

    assert "headers" not in out[0]
    assert out[1]["headers"]["Authorization"] == f"Bearer {VK}"


PROJECT_ID = "projx3stlz05"


def test_project_id_stamped_alongside_vk() -> None:
    """When ``project_id`` is given, a VK-injected server also gets X-Project-ID.

    Platform MCP servers that enforce tenant isolation (analytics-datasets)
    reject requests with no project context (HTTP 403). Bifrost forwards the
    connection-scoped ``X-Project-ID`` per the client allowlist.
    """
    servers = [
        {
            "name": "analytics_datasets_mcp",
            "transport": "streamable-http",
            "url": "http://bifrost/mcp",
        }
    ]

    out = _inject_project_vk_into_mcp_servers(servers, VK, project_id=PROJECT_ID)

    assert out[0]["headers"]["Authorization"] == f"Bearer {VK}"
    assert out[0]["headers"]["X-Project-ID"] == PROJECT_ID


def test_project_id_omitted_when_not_supplied() -> None:
    """Backward-compat: without ``project_id`` no X-Project-ID is added."""
    servers = [
        {
            "name": "weather",
            "transport": "streamable-http",
            "url": "http://bifrost/mcp",
        }
    ]

    out = _inject_project_vk_into_mcp_servers(servers, VK)

    assert "X-Project-ID" not in out[0]["headers"]


def test_project_id_not_leaked_to_operator_auth_server() -> None:
    """Operator-auth (external) servers stay untouched — no project leak."""
    servers = [
        {
            "name": "custom",
            "transport": "streamable-http",
            "url": "http://elsewhere/mcp",
            "headers": {"Authorization": "Bearer operator-token"},
        }
    ]

    out = _inject_project_vk_into_mcp_servers(servers, VK, project_id=PROJECT_ID)

    assert out[0]["headers"] == {"Authorization": "Bearer operator-token"}
    assert "X-Project-ID" not in out[0]["headers"]


def test_stdio_server_never_gets_project_id() -> None:
    """stdio servers (no ``url``) receive neither the VK nor X-Project-ID."""
    servers = [
        {"name": "fs", "transport": "stdio", "command": "npx"},
    ]

    out = _inject_project_vk_into_mcp_servers(servers, VK, project_id=PROJECT_ID)

    assert "headers" not in out[0] or "X-Project-ID" not in out[0].get("headers", {})
