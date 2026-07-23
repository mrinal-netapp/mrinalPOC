"""E2E tests for MCP tool integration.

Tests MCP tool discovery and invocation through the mock MCP server.
These tests verify the MCP mock server is accessible and functional.
"""

from __future__ import annotations

import httpx
import pytest


@pytest.mark.e2e
class TestMCPE2E:
    """E2E tests for MCP tool integration."""

    async def test_mock_mcp_health(self, mcp_url: str) -> None:
        """Mock MCP server health check succeeds."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{mcp_url}/health")

        assert response.status_code == 200, (
            f"Expected 200 from mock MCP health, got {response.status_code}"
        )
        data = response.json()
        assert data["status"] == "ok", f"Expected 'ok' status (§5.8.2), got '{data['status']}'"

    async def test_mock_mcp_tool_discovery(self, mcp_url: str) -> None:
        """Mock MCP server lists available tools."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(f"{mcp_url}/tools")

        assert response.status_code == 200, (
            f"Expected 200 from MCP tools list, got {response.status_code}"
        )
        data = response.json()
        assert "tools" in data, "Response must contain 'tools' field"
        assert data["total"] == 3, f"Expected 3 mock tools, got {data['total']}"

        tool_names = {t["name"] for t in data["tools"]}
        expected_tools = {"calculator", "echo", "file_reader"}
        assert tool_names == expected_tools, f"Expected tools {expected_tools}, got {tool_names}"

    async def test_mock_mcp_calculator_tool(self, mcp_url: str) -> None:
        """Mock MCP calculator tool returns correct result."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(
                f"{mcp_url}/mcp",
                json={
                    "jsonrpc": "2.0",
                    "method": "tools/call",
                    "params": {
                        "name": "calculator",
                        "arguments": {"expression": "2 + 2"},
                    },
                    "id": "test-calc-1",
                },
            )

        assert response.status_code == 200, (
            f"Expected 200 from calculator tool, got {response.status_code}"
        )
        data = response.json()
        assert "result" in data, "Response must contain 'result' field"
        content = data["result"]["content"]
        assert len(content) > 0, "Calculator result must have content"
        assert "4" in content[0]["text"], (
            f"Calculator result should contain '4', got: {content[0]['text']}"
        )

    async def test_mock_mcp_echo_tool(self, mcp_url: str) -> None:
        """Mock MCP echo tool returns the input message."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(
                f"{mcp_url}/mcp",
                json={
                    "jsonrpc": "2.0",
                    "method": "tools/call",
                    "params": {
                        "name": "echo",
                        "arguments": {"message": "Hello E2E!"},
                    },
                    "id": "test-echo-1",
                },
            )

        assert response.status_code == 200, (
            f"Expected 200 from echo tool, got {response.status_code}"
        )
        data = response.json()
        content = data["result"]["content"]
        assert "Hello E2E!" in content[0]["text"], (
            f"Echo result should contain 'Hello E2E!', got: {content[0]['text']}"
        )

    async def test_mock_mcp_file_reader_tool(self, mcp_url: str) -> None:
        """Mock MCP file_reader tool returns mock content."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(
                f"{mcp_url}/mcp",
                json={
                    "jsonrpc": "2.0",
                    "method": "tools/call",
                    "params": {
                        "name": "file_reader",
                        "arguments": {"path": "test.txt"},
                    },
                    "id": "test-file-1",
                },
            )

        assert response.status_code == 200, (
            f"Expected 200 from file_reader tool, got {response.status_code}"
        )
        data = response.json()
        content = data["result"]["content"]
        assert "test.txt" in content[0]["text"], (
            f"File reader result should reference the path, got: {content[0]['text']}"
        )

    async def test_mock_mcp_initialize(self, mcp_url: str) -> None:
        """Mock MCP server responds to initialize method."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(
                f"{mcp_url}/mcp",
                json={
                    "jsonrpc": "2.0",
                    "method": "initialize",
                    "params": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {},
                        "clientInfo": {
                            "name": "e2e-test",
                            "version": "0.1.0",
                        },
                    },
                    "id": "test-init-1",
                },
            )

        assert response.status_code == 200, (
            f"Expected 200 from MCP initialize, got {response.status_code}"
        )
        data = response.json()
        assert "result" in data, "Initialize response must contain 'result'"
        result = data["result"]
        assert "serverInfo" in result, "Initialize result must contain 'serverInfo'"
        assert result["serverInfo"]["name"] == "mock-mcp-server", (
            f"Expected server name 'mock-mcp-server', got '{result['serverInfo']['name']}'"
        )

    async def test_mock_mcp_tools_list(self, mcp_url: str) -> None:
        """Mock MCP server responds to tools/list JSON-RPC method."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(
                f"{mcp_url}/mcp",
                json={
                    "jsonrpc": "2.0",
                    "method": "tools/list",
                    "params": {},
                    "id": "test-list-1",
                },
            )

        assert response.status_code == 200, (
            f"Expected 200 from tools/list, got {response.status_code}"
        )
        data = response.json()
        tools = data["result"]["tools"]
        assert len(tools) == 3, f"Expected 3 tools, got {len(tools)}"

    async def test_mock_mcp_unknown_tool_returns_error(self, mcp_url: str) -> None:
        """Calling an unknown tool returns an error result."""
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.post(
                f"{mcp_url}/mcp",
                json={
                    "jsonrpc": "2.0",
                    "method": "tools/call",
                    "params": {
                        "name": "nonexistent_tool",
                        "arguments": {},
                    },
                    "id": "test-unknown-1",
                },
            )

        assert response.status_code == 200, (
            f"Expected 200 (JSON-RPC error is in body), got {response.status_code}"
        )
        data = response.json()
        result = data["result"]
        assert result["isError"] is True, "Unknown tool call should have isError=True"
