"""Unit tests for the MCP server adapter (exposes agents AS MCP tools).

Covers:
- _resolve_sse_host: env → config → loopback-default precedence (security default)
- MCPServerAdapter._handle_tool_call: framework resolution + response/error shaping
- MCPServerAdapter.create_server: tool-definition building
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent_service_maf.interface_layer.protocols import mcp_server as mod
from agent_service_maf.interface_layer.protocols.mcp_server import (
    _DEFAULT_SSE_HOST,
    MCPServerAdapter,
    _resolve_sse_host,
)

_ENV = "AGENT_MCP_SERVER__SSE_HOST"


# ---------------------------------------------------------------------------
# _resolve_sse_host — bind-host precedence (loopback default is a security knob)
# ---------------------------------------------------------------------------


class TestResolveSseHost:
    def test_env_var_takes_precedence_over_config(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(_ENV, "0.0.0.0")
        cfg = SimpleNamespace(mcp_server=SimpleNamespace(sse_host="10.0.0.1"))
        assert _resolve_sse_host(cfg) == "0.0.0.0"

    def test_config_used_when_no_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(_ENV, raising=False)
        cfg = SimpleNamespace(mcp_server=SimpleNamespace(sse_host="10.0.0.1"))
        assert _resolve_sse_host(cfg) == "10.0.0.1"

    def test_loopback_default_when_neither_set(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(_ENV, raising=False)
        cfg = SimpleNamespace(mcp_server=SimpleNamespace(sse_host=None))
        assert _resolve_sse_host(cfg) == _DEFAULT_SSE_HOST == "127.0.0.1"

    def test_default_when_config_section_missing(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(_ENV, raising=False)
        assert _resolve_sse_host(SimpleNamespace()) == _DEFAULT_SSE_HOST

    def test_whitespace_env_is_ignored_falls_through_to_config(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(_ENV, "   ")
        cfg = SimpleNamespace(mcp_server=SimpleNamespace(sse_host="10.0.0.1"))
        assert _resolve_sse_host(cfg) == "10.0.0.1"


# ---------------------------------------------------------------------------
# MCPServerAdapter._handle_tool_call
# ---------------------------------------------------------------------------


def _adapter(
    invoke_return: object = None, invoke_side_effect: Exception | None = None
) -> MCPServerAdapter:
    service = MagicMock()
    if invoke_side_effect is not None:
        service.invoke = AsyncMock(side_effect=invoke_side_effect)
    else:
        service.invoke = AsyncMock(return_value=invoke_return)
    return MCPServerAdapter(agent_service=service, config=MagicMock())


def _response(
    output: str = "hi",
    agent_id: str = "a1",
    duration_ms: int = 12,
    usage: object = None,
    artifacts: object = None,
) -> SimpleNamespace:
    return SimpleNamespace(
        output=output,
        agent_id=agent_id,
        duration_ms=duration_ms,
        usage=usage,
        artifacts=artifacts,
    )


class TestHandleToolCall:
    @pytest.mark.asyncio
    async def test_per_framework_tool_name_sets_framework(self) -> None:
        adapter = _adapter(_response())
        out = await adapter._handle_tool_call("invoke_maf", {"input": "hello"}, ["maf", "echo"])
        call = adapter._service.invoke.call_args
        assert call.kwargs["config_overrides"]["agent"]["framework"] == "maf"
        assert call.kwargs["input_text"] == "hello"
        assert call.kwargs["agent_id"] == "default"
        assert call.kwargs["metadata"] == {"source": "mcp", "tool_name": "invoke_maf"}
        payload = json.loads(out[0].text)
        assert payload["output"] == "hi"
        assert payload["agent_id"] == "a1"
        assert payload["duration_ms"] == 12

    @pytest.mark.asyncio
    async def test_invoke_agent_uses_explicit_framework_arg(self) -> None:
        adapter = _adapter(_response())
        await adapter._handle_tool_call(
            "invoke_agent", {"input": "x", "framework": "echo"}, ["echo"]
        )
        call = adapter._service.invoke.call_args
        assert call.kwargs["config_overrides"]["agent"]["framework"] == "echo"

    @pytest.mark.asyncio
    async def test_invoke_agent_without_framework_leaves_overrides_untouched(self) -> None:
        adapter = _adapter(_response())
        await adapter._handle_tool_call("invoke_agent", {"input": "x"}, ["echo"])
        call = adapter._service.invoke.call_args
        assert "agent" not in call.kwargs["config_overrides"]

    @pytest.mark.asyncio
    async def test_agent_id_forwarded(self) -> None:
        adapter = _adapter(_response())
        await adapter._handle_tool_call(
            "invoke_maf", {"input": "x", "agent_id": "billing"}, ["maf"]
        )
        assert adapter._service.invoke.call_args.kwargs["agent_id"] == "billing"

    @pytest.mark.asyncio
    async def test_usage_and_artifacts_included_when_present(self) -> None:
        usage = MagicMock()
        usage.model_dump = MagicMock(return_value={"tokens": 5})
        adapter = _adapter(_response(usage=usage, artifacts=[{"k": "v"}]))
        out = await adapter._handle_tool_call("invoke_maf", {"input": "x"}, ["maf"])
        payload = json.loads(out[0].text)
        assert payload["usage"] == {"tokens": 5}
        assert payload["artifacts"] == [{"k": "v"}]

    @pytest.mark.asyncio
    async def test_no_usage_or_artifacts_keys_when_absent(self) -> None:
        adapter = _adapter(_response(usage=None, artifacts=None))
        out = await adapter._handle_tool_call("invoke_maf", {"input": "x"}, ["maf"])
        payload = json.loads(out[0].text)
        assert "usage" not in payload
        assert "artifacts" not in payload

    @pytest.mark.asyncio
    async def test_exception_returned_as_error_json_not_raised(self) -> None:
        adapter = _adapter(invoke_side_effect=RuntimeError("boom"))
        out = await adapter._handle_tool_call("invoke_maf", {"input": "x"}, ["maf"])
        payload = json.loads(out[0].text)
        assert payload["error"] == "boom"
        assert payload["error_type"] == "RuntimeError"


# ---------------------------------------------------------------------------
# MCPServerAdapter.create_server
# ---------------------------------------------------------------------------


class TestCreateServer:
    @pytest.mark.asyncio
    async def test_builds_per_framework_and_generic_tools(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            mod.FrameworkRegistry, "list_frameworks", staticmethod(lambda: ["maf", "echo"])
        )
        adapter = MCPServerAdapter(
            agent_service=MagicMock(),
            config=SimpleNamespace(mcp_server=SimpleNamespace(server_name="test-mcp")),
        )
        server = await adapter.create_server()
        assert server is adapter._server
        assert server is not None
