#!/usr/bin/env python3
"""
Analytics MCP Server — platform-wide agent surface for project datasets.

Delegates all queries to analytics-engine over HTTP, forwarding the user's
JWT for tenant isolation. The engine enforces SQL policy (AST validation,
namespace closure, statement timeout). This shim adds MCP tool definitions,
prompt instructions, and truncation visibility.
"""

import json
import os
import argparse
from typing import Any

import httpx
import uvicorn
from fastmcp import FastMCP, Context
from fastmcp.server.dependencies import get_http_request
from observability_client_runtime import configure_observability_minimal, get_logger
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route, Mount

logger = get_logger()

ANALYTICS_ENGINE_URL = os.environ.get(
    "ANALYTICS_ENGINE_URL", "http://analytics-engine:5000"
)
MAX_ROWS = int(os.environ.get("MAX_ROWS", "500"))
MAX_RESPONSE_BYTES = int(os.environ.get("MAX_RESPONSE_BYTES", str(5 * 1024 * 1024)))
REQUEST_TIMEOUT_S = int(os.environ.get("REQUEST_TIMEOUT_S", "65"))


def _build_headers() -> dict[str, str]:
    """Extract forwarded identity headers from the incoming MCP HTTP request.

    The agent-service injects Authorization, X-Project-ID, and X-User-ID via
    Agno's header_provider; the Bifrost gateway forwards them per its
    extra_headers config.
    """
    headers: dict[str, str] = {}
    try:
        request = get_http_request()
        for name, canonical in (
            ("authorization", "Authorization"),
            ("x-project-id", "X-Project-ID"),
            ("x-user-id", "X-User-ID"),
        ):
            val = request.headers.get(name, "")
            if val:
                headers[canonical] = val
    except Exception:
        pass
    return headers


def _engine_error_detail(resp: httpx.Response) -> str:
    """Extract a human-readable rejection reason from analytics-engine."""
    try:
        body = resp.json()
        detail = body.get("error", body.get("detail", ""))
        if isinstance(detail, str) and detail.strip():
            if detail.startswith("query rejected:"):
                return detail
            return f"Query rejected: {detail}"
    except Exception:
        pass
    text = (resp.text or "").strip()
    return text if text else ""


def _call_engine(
    path: str,
    payload: dict[str, Any],
    extra_headers: dict[str, str],
) -> dict[str, Any]:
    """Call analytics-engine and return the parsed JSON response."""
    url = f"{ANALYTICS_ENGINE_URL}{path}"
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    headers.update(extra_headers)

    logger.info("Engine call: %s headers=%s", path, list(headers.keys()))
    with httpx.Client(timeout=REQUEST_TIMEOUT_S) as client:
        resp = client.post(url, json=payload, headers=headers)

    if resp.status_code == 401:
        return {"error": "Authentication required — your session may have expired.", "status": 401}
    if resp.status_code == 403:
        detail = _engine_error_detail(resp)
        return {"error": detail or "Access denied — you do not have permission for this operation.", "status": 403}
    if resp.status_code == 429:
        return {"error": "Too many requests — the analytics engine is busy. Please retry shortly.", "status": 429}
    if resp.status_code >= 400:
        try:
            body = resp.json()
            detail = body.get("detail", body.get("error", resp.text))
        except Exception:
            detail = resp.text
        return {"error": f"Engine error ({resp.status_code}): {detail}", "status": resp.status_code}

    return resp.json()


def create_server() -> FastMCP:
    mcp = FastMCP(
        name="analytics-datasets-mcp",
        instructions=(
            "SQL analytics on project datasets backed by DuckDB + Iceberg catalog.\n"
            "\n"
            "CONTEXT: Your project identity is automatically propagated via HTTP\n"
            "headers. The `project_id` tool parameter is optional — if omitted, it\n"
            "is inferred from your session context. You may still pass it explicitly.\n"
            "\n"
            "WORKFLOW:\n"
            "1. Call list_datasets() to discover tables in the project.\n"
            "2. Call describe_table(table) to see column names and types.\n"
            "3. Call execute_query(sql) for analytical queries including JOINs.\n"
            "\n"
            "RULES:\n"
            f"- Results are capped at {MAX_ROWS} rows. Always use LIMIT for exploration.\n"
            "- When results are truncated, a 'truncated' flag is set in the response.\n"
            "- Only SELECT queries are allowed. DDL/DML is rejected.\n"
            "- All table references must be in your project's namespace.\n"
            "- Use fully-qualified names: iceberg.\"<namespace>\".\"<table>\".\n"
            "- For aggregations, use clear column aliases for chart rendering.\n"
            "\n"
            "PII NOTE: Datasets may contain personally identifiable information.\n"
            "Handle PII responsibly — do not reproduce raw PII values in responses\n"
            "unless the user explicitly requests specific records."
        ),
    )

    @mcp.tool(name="list_datasets")
    async def list_datasets(project_id: str = "", ctx: Context = None) -> str:
        """List all datasets (tables) available in the project.

        Args:
            project_id: Optional — auto-inferred from session context when omitted.
        """
        hdrs = _build_headers()
        if project_id and "X-Project-ID" not in hdrs:
            hdrs["X-Project-ID"] = project_id
        result = _call_engine("/api/v1/agent/datasets", {}, hdrs)
        return json.dumps(result, indent=2, default=str)

    @mcp.tool(name="describe_table")
    async def describe_table(table: str, project_id: str = "", ctx: Context = None) -> str:
        """Describe columns and types of a dataset table.

        Args:
            table: The table name (without namespace prefix).
            project_id: Optional — auto-inferred from session context when omitted.
        """
        hdrs = _build_headers()
        if project_id and "X-Project-ID" not in hdrs:
            hdrs["X-Project-ID"] = project_id
        result = _call_engine("/api/v1/agent/describe", {"table": table}, hdrs)
        return json.dumps(result, indent=2, default=str)

    @mcp.tool(name="execute_query")
    async def execute_query(sql: str, project_id: str = "", ctx: Context = None) -> str:
        """Execute a read-only SQL query (DuckDB dialect) on project datasets.

        Supports JOINs, aggregations, window functions, CTEs.
        All table references must be within the project namespace.
        Results are capped; use LIMIT for exploration.

        Args:
            sql: The SQL SELECT query to execute.
            project_id: Optional — auto-inferred from session context when omitted.
        """
        hdrs = _build_headers()
        if project_id and "X-Project-ID" not in hdrs:
            hdrs["X-Project-ID"] = project_id
        result = _call_engine("/api/v1/agent/query", {"query": sql}, hdrs)
        if "error" in result:
            return json.dumps(result, indent=2)

        response_text = json.dumps(result, indent=2, default=str)
        if len(response_text) > MAX_RESPONSE_BYTES:
            return json.dumps({
                "error": f"Response too large ({len(response_text)} bytes). "
                         f"Use LIMIT or narrow your SELECT columns.",
                "truncated": True,
            }, indent=2)
        return response_text

    @mcp.tool(name="preview_dataset")
    async def preview_dataset(table: str, limit: int = 50, project_id: str = "", ctx: Context = None) -> str:
        """Preview rows from a dataset table with optional limit.

        Args:
            table: The table name.
            limit: Number of rows to return (max 500).
            project_id: Optional — auto-inferred from session context when omitted.
        """
        hdrs = _build_headers()
        if project_id and "X-Project-ID" not in hdrs:
            hdrs["X-Project-ID"] = project_id
        if limit > MAX_ROWS:
            limit = MAX_ROWS
        result = _call_engine("/api/v1/agent/preview", {"table": table, "limit": limit}, hdrs)
        return json.dumps(result, indent=2, default=str)

    @mcp.tool(name="dataset_stats")
    async def dataset_stats(table: str, project_id: str = "", ctx: Context = None) -> str:
        """Get per-column statistics (min, max, count, nulls, etc.) for a dataset.

        Args:
            table: The table name.
            project_id: Optional — auto-inferred from session context when omitted.
        """
        hdrs = _build_headers()
        if project_id and "X-Project-ID" not in hdrs:
            hdrs["X-Project-ID"] = project_id
        result = _call_engine("/api/v1/agent/stats", {"table": table}, hdrs)
        return json.dumps(result, indent=2, default=str)

    @mcp.tool(name="dataset_histogram")
    async def dataset_histogram(table: str, column: str, project_id: str = "", ctx: Context = None) -> str:
        """Get histogram data for a specific column of a dataset.

        Args:
            table: The table name.
            column: The column to create a histogram for.
            project_id: Optional — auto-inferred from session context when omitted.
        """
        hdrs = _build_headers()
        if project_id and "X-Project-ID" not in hdrs:
            hdrs["X-Project-ID"] = project_id
        result = _call_engine("/api/v1/agent/histogram", {"table": table, "column": column}, hdrs)
        return json.dumps(result, indent=2, default=str)

    return mcp


async def _health(request: Request) -> JSONResponse:
    return JSONResponse({"status": "ok"})


class _KubernetesHealthMiddleware(BaseHTTPMiddleware):
    """Serve /health and /healthz before the MCP sub-app.

    FastMCP's HTTP stack mounted at ``/`` can answer before Starlette's
    ``Route("/health")``, which breaks Kubernetes probes with 404. Middleware
    runs first and is deterministic.
    """

    async def dispatch(self, request: Request, call_next):
        if request.method == "GET":
            p = request.url.path.rstrip("/") or "/"
            if p in ("/health", "/healthz"):
                return JSONResponse({"status": "ok"})
        return await call_next(request)


def create_app() -> Starlette:
    """Build the ASGI app with health endpoint for Kubernetes probes."""
    server = create_server()
    # Stateless streamable-HTTP: no per-session ``Mcp-Session-Id`` is minted
    # or required, so every tool call is self-contained. This is required when
    # fronted by the Bifrost gateway, whose chat-completion tool-execution path
    # issues ``tools/call`` without reusing a transport session id (a stateful
    # server rejects those with "Bad Request: Missing session ID"). ``json_response``
    # returns a plain JSON body instead of an SSE stream for these discrete,
    # non-streaming tool results.
    mcp_app = server.http_app(path="/mcp", stateless_http=True, json_response=True)
    return Starlette(
        middleware=[Middleware(_KubernetesHealthMiddleware)],
        routes=[
            Route("/health", _health, methods=["GET"]),
            Route("/healthz", _health, methods=["GET"]),
            Mount("/", app=mcp_app),
        ],
        lifespan=mcp_app.lifespan,
    )


def main() -> None:
    configure_observability_minimal(
        log_file_path=os.getenv(
            "AGENT_STUDIO_OBSERVABILITY_LOG_FILE_PATH", "../../App_Logs/mcp-server-analytics.jsonl"
        ),
        log_level=os.getenv("LOG_LEVEL", "info"),
        otlp_traces_endpoint=os.getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"),
        metrics_service_name=os.getenv("OTEL_SERVICE_NAME", "mcp-server-analytics"),
        prometheus_metrics_port=int(p) if (p := os.getenv("AGENT_STUDIO_OBSERVABILITY_PROMETHEUS_METRICS_PORT")) else None,
    )

    parser = argparse.ArgumentParser(description="Analytics Datasets MCP Server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument(
        "--transport",
        default="streamable-http",
        choices=["streamable-http", "stdio"],
    )
    args = parser.parse_args()

    if args.transport == "stdio":
        server = create_server()
        server.run(transport="stdio")
    else:
        logger.info(f"Analytics MCP server starting on {args.host}:{args.port}")
        app = create_app()
        uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
