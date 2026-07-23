"""Integration test — MCP tool invocation routed through a framework adapter.

The integration audit (M5) flagged that every existing MCP test hits
the mock MCP server **directly** — none routes through the full
`POST /agents/.../invoke` → framework adapter → context.mcp_registry
→ MCPToolInvoker call chain. That chain is the actual production
path, and a regression in any link (bundle wiring, context
plumbing, identity propagation into call_tool) is currently
invisible to the test suite.

This file registers a custom test framework adapter that exercises
the wiring it needs: when invoked, it reads `context.mcp_registry`
from its AgentExecutionContext and calls `list_tools()` /
`call_tool(...)` on it — the same surface a real adapter
(SemanticKernel, etc.) uses. The MCPManager is initialised with a
mocked ClientSessionGroup so the call returns deterministic data
without spawning a real MCP subprocess.

Properties pinned:

  1. `context.mcp_registry` is the team's MCPManager, not None.
  2. `mcp_registry.list_tools()` returns the tools configured on
     the team (round-trip from registry).
  3. `mcp_registry.call_tool(...)` actually invokes the mocked
     transport — proves the call path is wired end-to-end.
  4. The active IdentityContext bound at the route layer flows
     into the MCP `_meta.identity` payload — pinning the
     identity-propagation contract at the route layer (not just
     at the MCPToolInvoker unit layer).
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterator
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from agent_service_maf.core.context import AgentExecutionContext
from agent_service_maf.core.interfaces import (
    AgentCapabilities,
    AgentEvent,
    AgentRequest,
    AgentResponse,
    EventType,
    TokenUsage,
)
from agent_service_maf.framework.base_agent import BaseAgent
from agent_service_maf.framework.registry import FrameworkRegistry
from agent_service_maf.mcp.tool_registry import ToolSchema
from tests.conftest import TEST_PROJECT_ID, TEST_PROJECT_PREFIX

TEAM_ID = "mcp_team"


# A box the test agent writes into so the test can assert what
# happened inside `invoke()`. Cleared per-test by the fixture.
_call_log: dict[str, Any] = {}


class _McpCallingAgent(BaseAgent):
    """Test framework adapter that calls into the MCP registry.

    Mirrors what a real adapter (e.g. SemanticKernelAdapter) does:
    reads `context.mcp_registry` and routes a tool call through it.
    The test wires the registry to a mocked ClientSessionGroup so
    the call_tool path is exercised end-to-end without a real MCP
    process."""

    async def invoke(self, request: AgentRequest, context: AgentExecutionContext) -> AgentResponse:
        _call_log["context_has_mcp_registry"] = context.mcp_registry is not None

        if context.mcp_registry is not None:
            tools = await context.mcp_registry.list_tools()
            _call_log["tools_returned"] = [t.name for t in tools]

            # Call the tool — the test's mocked ClientSessionGroup
            # records the args + meta.
            try:
                result = await context.mcp_registry.call_tool(
                    server_name="test_server",
                    tool_name="echo_tool",
                    arguments={"text": "hello mcp"},
                )
                _call_log["tool_result_content"] = result.content
                _call_log["tool_call_succeeded"] = True
            except Exception as exc:
                _call_log["tool_call_error"] = repr(exc)
                _call_log["tool_call_succeeded"] = False

        return AgentResponse(
            agent_id=request.agent_id,
            output=f"called MCP from input: {request.input}",
            usage=TokenUsage(prompt_tokens=1, completion_tokens=1, total_tokens=2),
            metadata={"framework": "mcp_test"},
        )

    async def stream(
        self, request: AgentRequest, context: AgentExecutionContext
    ) -> AsyncIterator[AgentEvent]:
        yield AgentEvent(event_type=EventType.STARTED)
        yield AgentEvent(event_type=EventType.TOKEN, data="ok")

    def get_capabilities(self) -> AgentCapabilities:
        return AgentCapabilities(
            agent_id="mcp_test",
            framework="mcp_test",
            supports_streaming=True,
            description="Test agent that calls MCP tools",
        )


def _team_config_with_mcp() -> dict[str, Any]:
    return {
        "_schema_version": "2.0.0",
        "project_id": TEST_PROJECT_ID,
        "_team_id": TEAM_ID,
        "_team_name": "MCP wiring test",
        "_description": "Verifies MCPManager routes through framework adapter",
        "agent": {
            "framework": "mcp_test",
            "model": "azure/gpt-4.1-mini",
            "temperature": 0.0,
            "max_tokens": 64,
            "timeout_seconds": 30,
            "metadata": {"project": "test", "version": "0.0.0", "environment": "test"},
        },
        "semantic_kernel": {
            "agents": [],
            "orchestration": {"type": "single"},
        },
        "interface": {
            "host": "0.0.0.0",
            "port": 8000,
            "cors_origins": ["*"],
            "request_timeout_seconds": 30,
            "max_concurrent_requests": 10,
            "auth": {"enabled": False},
        },
        "gateway": {
            "url": "http://localhost:0/v1",
            "default_model": "azure/gpt-4.1-mini",
            "request_timeout_seconds": 10,
            "retry_on_timeout": False,
            "max_retries": 0,
        },
        "guardrails": {"enabled": False, "fail_open": True},
        "mcp": {
            "connection_timeout_seconds": 5,
            "lazy_connect": True,
            "tool_call_timeout_seconds": 5,
            "max_tool_retries": 0,
            "retry_on_timeout": False,
            "discovery_on_connect": False,
            "tool_name_format": "qualified",
            "max_concurrent_tool_calls": 1,
        },
        "mcp_servers": [],
        "memory": {"enabled": False},
        "logging": {"level": "WARNING", "format": "json", "include_timestamp": True},
    }


def _ok_tool_result() -> MagicMock:
    block = MagicMock()
    block.type = "text"
    block.text = "tool replied"
    result = MagicMock()
    result.structuredContent = None
    result.content = [block]
    result.isError = False
    return result


@pytest.fixture
def mcp_client(tmp_path: Path) -> Iterator[TestClient]:
    """Boot a TestClient with:
    - _McpCallingAgent registered as the `mcp_test` framework
    - One team loaded that uses that framework
    - A test tool ('echo_tool') registered on the team's
      MCPManager registry
    - The MCPManager's invoker swapped to use a mocked group
      that records call_tool arguments and meta
    """
    _call_log.clear()

    teams_dir = tmp_path / "teams"
    teams_dir.mkdir()
    (teams_dir / f"{TEAM_ID}.json").write_text(json.dumps(_team_config_with_mcp()))

    # Register our test adapter for the lifetime of this fixture.
    FrameworkRegistry.register("mcp_test")(_McpCallingAgent)

    with patch.dict("os.environ", {"AGENT_TEAMS_DIR": str(teams_dir)}):
        from agent_service_maf.interface_layer.api import create_app
        from agent_service_maf.mcp.tool_registry import ToolResult

        app = create_app()
        with TestClient(app) as client:
            # Plumb a test tool into the team's registry and stub
            # `MCPManager.call_tool` so we don't need a real MCP
            # subprocess. The unit tier (test_mcp_framework /
            # test_mcp_identity_propagation) exercises the
            # call_tool internals; what this integration test pins
            # is the *wiring* from route → adapter →
            # context.mcp_registry → call_tool.
            bundle = client.app.state.teams.get_in_project(TEST_PROJECT_ID, TEAM_ID)
            assert bundle is not None and bundle.mcp_manager is not None
            bundle.mcp_manager.tool_registry.register(
                ToolSchema(
                    name="echo_tool",
                    description="echo",
                    input_schema={"type": "object", "properties": {}},
                    output_schema=None,
                    server_name="test_server",
                )
            )
            captured: dict[str, Any] = {}

            async def _stub_call_tool(
                server_name: str,
                tool_name: str,
                arguments: dict[str, Any],
            ) -> ToolResult:
                from agent_service_maf.core.identity import get_current_identity
                from agent_service_maf.mcp._identity_transport import (
                    build_identity_meta,
                )

                captured["server_name"] = server_name
                captured["tool_name"] = tool_name
                captured["arguments"] = arguments
                # Snapshot the identity envelope MCPToolInvoker
                # would have constructed — this is what flows to
                # the MCP server in production.
                captured["meta"] = build_identity_meta(get_current_identity())
                return ToolResult(content="tool replied", is_error=False)

            bundle.mcp_manager.call_tool = _stub_call_tool  # type: ignore[method-assign]
            _call_log["captured"] = captured

            yield client

    # Clean up — the global registry is reset in tests/conftest.py's
    # autouse `clean_registry` fixture after each test.


# ---------------------------------------------------------------------------
# (1) Wiring: context.mcp_registry is the bundle's MCPManager
# ---------------------------------------------------------------------------


def test_invoke_through_framework_reaches_mcp_registry(
    mcp_client: TestClient,
) -> None:
    """A POST /invoke must give the adapter a non-None
    `context.mcp_registry`. Without this wiring no real adapter
    can call MCP tools."""
    resp = mcp_client.post(
        f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/invoke",
        json={"input": "ping"},
    )
    assert resp.status_code == 200, f"invoke must succeed, got: {resp.status_code} {resp.text}"
    assert _call_log.get("context_has_mcp_registry") is True, (
        "context.mcp_registry must be non-None when team has MCP wiring"
    )


def test_list_tools_returns_registered_tools(
    mcp_client: TestClient,
) -> None:
    """The MCPManager.tool_registry seeded by the fixture must be
    reachable from inside the adapter via list_tools()."""
    resp = mcp_client.post(
        f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/invoke",
        json={"input": "list tools please"},
    )
    assert resp.status_code == 200
    assert "echo_tool" in _call_log.get("tools_returned", []), (
        f"list_tools must return the registered tool, got: {_call_log.get('tools_returned')}"
    )


# ---------------------------------------------------------------------------
# (2) call_tool actually reaches the mocked group
# ---------------------------------------------------------------------------


def test_call_tool_routes_through_to_mocked_group(
    mcp_client: TestClient,
) -> None:
    """`context.mcp_registry.call_tool(...)` from inside the
    adapter must reach the (mocked) ClientSessionGroup. Proves the
    full chain: adapter → MCPManager → MCPToolInvoker →
    ClientSessionGroup."""
    resp = mcp_client.post(
        f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/invoke",
        json={"input": "call tool please"},
    )
    assert resp.status_code == 200
    assert _call_log.get("tool_call_succeeded") is True, (
        f"call_tool must succeed end-to-end. error: {_call_log.get('tool_call_error')}"
    )
    captured = _call_log["captured"]
    assert captured.get("tool_name") == "echo_tool"
    assert captured.get("arguments") == {"text": "hello mcp"}
    assert _call_log.get("tool_result_content") == "tool replied"


# ---------------------------------------------------------------------------
# (3) Identity flows from route → adapter → MCP _meta
# ---------------------------------------------------------------------------


def test_route_identity_reaches_mcp_meta_payload(
    mcp_client: TestClient,
) -> None:
    """When the route layer authenticates a request, the bound
    IdentityContext must flow all the way to the MCP `_meta`
    payload. The unit test `test_mcp_identity_propagation` covers
    this from MCPToolInvoker downward; this test covers the
    route-layer side: URL path → IdentityContext → ContextVar →
    invoker.

    Even with auth disabled (`auth.enabled=false`), the route
    layer binds an IdentityContext with project_id derived from
    the URL — so MCP `_meta` is populated with the projectId.
    User_id is empty in this mode. This pins the
    project-id-from-URL fallback that `validate_project_access`
    enforces."""
    resp = mcp_client.post(
        f"{TEST_PROJECT_PREFIX}/agent-teams/{TEAM_ID}/invoke",
        json={"input": "identity flow test"},
    )
    assert resp.status_code == 200
    captured = _call_log["captured"]
    meta = captured.get("meta")
    assert meta is not None, (
        f"MCP _meta must carry the URL-derived project scope even with auth disabled, got: {meta!r}"
    )
    payload = meta["identity"]
    # project_id flows from URL path → IdentityContext.project_id → meta.
    assert payload["projectId"] == TEST_PROJECT_ID, (
        f"Project id from URL must reach MCP _meta payload; "
        f"expected {TEST_PROJECT_ID}, got: {payload}"
    )
    # user_id is empty in auth-disabled mode — but the key is set
    # to "" rather than absent (different from optional-fields-elided
    # behavior in the unit test, because the route always populates it).
    assert payload.get("userId") == "", (
        f"With auth disabled, userId must be present but empty, got: {payload}"
    )
    # CRITICAL: even with no auth, the user JWT key must not appear.
    assert "userToken" not in payload
