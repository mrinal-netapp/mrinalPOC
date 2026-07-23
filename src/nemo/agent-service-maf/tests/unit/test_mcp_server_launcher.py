"""Unit tests for the MCP-server launcher's bind-host resolution.

Covers the security-relevant default: the SSE bind host is loopback
(``127.0.0.1``) unless an operator explicitly opts in to a wider bind
via ``AGENT_MCP_SERVER__SSE_HOST``. The launcher exposes admin-like
tool invocation, so the default must never be ``0.0.0.0``.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from agent_service_maf.interface_layer.protocols.mcp_server import (
    _DEFAULT_SSE_HOST,
    _resolve_sse_host,
)


class TestResolveSseHost:
    """Tests for :func:`_resolve_sse_host` precedence + default."""

    def test_default_is_loopback(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """With no env var and no config override → ``127.0.0.1``."""
        monkeypatch.delenv("AGENT_MCP_SERVER__SSE_HOST", raising=False)
        config = SimpleNamespace(mcp_server=SimpleNamespace())
        assert _resolve_sse_host(config) == _DEFAULT_SSE_HOST == "127.0.0.1"

    def test_env_var_overrides_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """``AGENT_MCP_SERVER__SSE_HOST`` wins over the loopback default."""
        monkeypatch.setenv("AGENT_MCP_SERVER__SSE_HOST", "192.168.1.50")
        config = SimpleNamespace(mcp_server=SimpleNamespace())
        assert _resolve_sse_host(config) == "192.168.1.50"

    def test_env_var_overrides_config_value(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Env var wins over a ``config.mcp_server.sse_host`` value."""
        monkeypatch.setenv("AGENT_MCP_SERVER__SSE_HOST", "10.0.0.1")
        config = SimpleNamespace(mcp_server=SimpleNamespace(sse_host="172.16.0.1"))
        assert _resolve_sse_host(config) == "10.0.0.1"

    def test_config_host_used_when_env_absent(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """When the env var is unset, the JSON-config value takes over."""
        monkeypatch.delenv("AGENT_MCP_SERVER__SSE_HOST", raising=False)
        config = SimpleNamespace(mcp_server=SimpleNamespace(sse_host="172.16.0.1"))
        assert _resolve_sse_host(config) == "172.16.0.1"

    def test_empty_env_var_falls_through_to_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Whitespace-only env var must NOT pin the bind to ``""`` —
        treat it as unset and fall through to the next tier."""
        monkeypatch.setenv("AGENT_MCP_SERVER__SSE_HOST", "   ")
        config = SimpleNamespace(mcp_server=SimpleNamespace())
        assert _resolve_sse_host(config) == _DEFAULT_SSE_HOST

    def test_missing_mcp_server_section_uses_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """An AgentConfig that doesn't carry an ``mcp_server`` section
        (extras-allow but unset) still resolves cleanly to the default,
        not an AttributeError."""
        monkeypatch.delenv("AGENT_MCP_SERVER__SSE_HOST", raising=False)
        config = SimpleNamespace()  # no .mcp_server at all
        assert _resolve_sse_host(config) == _DEFAULT_SSE_HOST

    def test_explicit_all_interfaces_opt_in_is_honored(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """When an operator deliberately sets ``0.0.0.0``, the resolver
        honors it (the warning is emitted at call-time in
        ``run_mcp_server``; this helper is non-judgmental about the
        chosen value)."""
        monkeypatch.setenv("AGENT_MCP_SERVER__SSE_HOST", "0.0.0.0")
        config = SimpleNamespace(mcp_server=SimpleNamespace())
        assert _resolve_sse_host(config) == "0.0.0.0"
