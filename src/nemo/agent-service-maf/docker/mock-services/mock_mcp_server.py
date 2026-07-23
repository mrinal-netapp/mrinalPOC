"""Mock MCP server for E2E testing.

Implements a basic MCP-compatible protocol with predictable tool responses.
Exposes tools: calculator, echo, file_reader.

Runs as an HTTP/SSE server that responds to MCP protocol messages.
Also supports a simple REST API for test verification.

Endpoints:
    POST /mcp  -- MCP JSON-RPC endpoint
    GET  /sse  -- SSE transport for MCP
    GET  /tools -- List available tools (REST, for test verification)
    GET  /health -- Health check
"""

from __future__ import annotations

import json
import math
import time
import uuid
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI(title="Mock MCP Server", version="0.1.0")

# Tool definitions matching MCP protocol.
_TOOLS: list[dict[str, Any]] = [
    {
        "name": "calculator",
        "description": "Evaluate a mathematical expression and return the result.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "expression": {
                    "type": "string",
                    "description": "Mathematical expression to evaluate (e.g., '2 + 2')",
                }
            },
            "required": ["expression"],
        },
    },
    {
        "name": "echo",
        "description": "Echo back the provided message.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "message": {
                    "type": "string",
                    "description": "The message to echo back",
                }
            },
            "required": ["message"],
        },
    },
    {
        "name": "file_reader",
        "description": "Read the contents of a file by path (mock: returns predictable content).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "The file path to read",
                }
            },
            "required": ["path"],
        },
    },
]

# Request history for assertions.
_call_history: list[dict[str, Any]] = []


def _safe_eval_expression(expression: str) -> str:
    """Safely evaluate a simple mathematical expression.

    Only supports basic arithmetic (+, -, *, /, **) with numbers.

    Args:
        expression: Mathematical expression string.

    Returns:
        String representation of the result.
    """
    # Allow only safe characters for math evaluation.
    allowed = set("0123456789+-*/().% ")
    if not all(c in allowed for c in expression):
        return f"Error: unsafe expression '{expression}'"
    try:
        result = eval(expression, {"__builtins__": {}}, {"math": math})  # noqa: S307
        return str(result)
    except Exception as exc:
        return f"Error evaluating '{expression}': {exc}"


def _execute_tool(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Execute a mock tool and return the result.

    Args:
        name: Tool name.
        arguments: Tool arguments.

    Returns:
        MCP tool result dict.
    """
    _call_history.append(
        {
            "timestamp": time.time(),
            "tool": name,
            "arguments": arguments,
        }
    )

    if name == "calculator":
        expression = arguments.get("expression", "0")
        result = _safe_eval_expression(expression)
        return {
            "content": [{"type": "text", "text": f"Result: {result}"}],
            "isError": False,
        }

    if name == "echo":
        message = arguments.get("message", "")
        return {
            "content": [{"type": "text", "text": f"Echo: {message}"}],
            "isError": False,
        }

    if name == "file_reader":
        path = arguments.get("path", "unknown")
        return {
            "content": [
                {"type": "text", "text": f"Mock content of '{path}': Hello from mock MCP!"}
            ],
            "isError": False,
        }

    return {
        "content": [{"type": "text", "text": f"Unknown tool: {name}"}],
        "isError": True,
    }


def _handle_jsonrpc(body: dict[str, Any]) -> dict[str, Any]:
    """Handle a JSON-RPC MCP request.

    Args:
        body: The JSON-RPC request body.

    Returns:
        JSON-RPC response dict.
    """
    method = body.get("method", "")
    params = body.get("params", {})
    request_id = body.get("id", str(uuid.uuid4()))

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {
                    "tools": {"listChanged": False},
                },
                "serverInfo": {
                    "name": "mock-mcp-server",
                    "version": "0.1.0",
                },
            },
        }

    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {"tools": _TOOLS},
        }

    if method == "tools/call":
        tool_name = params.get("name", "")
        arguments = params.get("arguments", {})
        result = _execute_tool(tool_name, arguments)
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": result,
        }

    if method == "notifications/initialized":
        # Notification, no response needed but return acknowledgment.
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {},
        }

    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {
            "code": -32601,
            "message": f"Method not found: {method}",
        },
    }


@app.post("/mcp")
async def mcp_endpoint(request: Request) -> JSONResponse:
    """MCP JSON-RPC endpoint.

    Args:
        request: The incoming MCP request.

    Returns:
        JSON-RPC response.
    """
    body = await request.json()
    response = _handle_jsonrpc(body)
    return JSONResponse(content=response)


@app.get("/sse")
async def mcp_sse(request: Request) -> StreamingResponse:
    """SSE transport endpoint for MCP.

    Sends an initial endpoint message then waits.

    Args:
        request: The incoming request.

    Returns:
        SSE stream.
    """

    async def generate_sse() -> Any:  # noqa: ANN401
        # Send the MCP SSE endpoint info.
        endpoint_msg = json.dumps(
            {
                "type": "endpoint",
                "url": "/mcp",
            }
        )
        yield f"event: endpoint\ndata: {endpoint_msg}\n\n"

        # Keep connection alive with periodic pings.
        import asyncio

        for _ in range(600):
            await asyncio.sleep(1)
            yield ": ping\n\n"

    return StreamingResponse(
        generate_sse(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


@app.get("/tools")
async def list_tools() -> JSONResponse:
    """List available tools (REST endpoint for test verification).

    Returns:
        List of tool definitions.
    """
    return JSONResponse(content={"tools": _TOOLS, "total": len(_TOOLS)})


@app.get("/call-history")
async def get_call_history() -> JSONResponse:
    """Return tool call history for test assertions.

    Returns:
        JSON array of tool call records.
    """
    return JSONResponse(content={"calls": _call_history, "total": len(_call_history)})


@app.delete("/call-history")
async def clear_call_history() -> JSONResponse:
    """Clear tool call history.

    Returns:
        Confirmation message.
    """
    _call_history.clear()
    return JSONResponse(content={"status": "cleared"})


@app.get("/health")
async def health_check() -> JSONResponse:
    """Health check endpoint.

    Returns:
        Health status.
    """
    return JSONResponse(content={"status": "healthy", "service": "mock-mcp"})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8080, log_level="info")
