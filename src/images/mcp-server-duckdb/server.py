#!/usr/bin/env python3
"""
DuckDB Iceberg MCP Server with automatic OAuth2 token refresh.

Replaces mcp-server-motherduck for Iceberg catalog use cases where DuckDB's
extension does not auto-refresh OAuth2 tokens (causing HTTP 401 after expiry).

Token refresh strategy (three layers of protection):
  1. Proactive  — background timer re-ATTACHes before token expires
  2. Pre-query  — checks freshness before each tool call
  3. Reactive   — catches HTTP 401, refreshes, and retries once

Only the Iceberg catalog attachment is cycled during refresh.  The DuckDB
process, in-memory state, loaded extensions, and S3 settings all persist.
"""

import argparse
import json
import os
import threading
import time
import urllib.parse
import urllib.request
from typing import Any, Optional

import duckdb
from fastmcp import FastMCP
from observability_client_runtime import configure_observability_minimal, get_logger

logger = get_logger()


# ---------------------------------------------------------------------------
# Configuration (all from environment)
# ---------------------------------------------------------------------------
class Config:
    WAREHOUSE_NAME: str = os.environ.get("WAREHOUSE_NAME", "nemo")
    LAKEKEEPER_CATALOG_URL: str = os.environ.get(
        "LAKEKEEPER_CATALOG_URL", "http://lakekeeper:8181/catalog"
    )
    KEYCLOAK_TOKEN_URL: str = os.environ.get("KEYCLOAK_TOKEN_URL", "")
    CLIENT_ID: str = os.environ.get("LAKEKEEPER_CLIENT_ID", "")
    CLIENT_SECRET: str = os.environ.get("LAKEKEEPER_CLIENT_SECRET", "")
    OAUTH2_SCOPE: str = os.environ.get("OAUTH2_SCOPE", "openid profile email")
    S3_ENDPOINT: str = os.environ.get("S3_ENDPOINT", "")
    S3_ACCESS_KEY: str = os.environ.get("S3_ACCESS_KEY", "")
    S3_SECRET_KEY: str = os.environ.get("S3_SECRET_KEY", "")
    MAX_ROWS: int = int(os.environ.get("MAX_ROWS", "500"))
    EXTENSION_DIR: str = os.environ.get(
        "DUCKDB_EXTENSION_DIR", "/opt/duckdb/extensions"
    )
    REFRESH_MARGIN_S: int = int(os.environ.get("TOKEN_REFRESH_MARGIN_SECONDS", "60"))


# ---------------------------------------------------------------------------
# Catalog lifecycle manager
# ---------------------------------------------------------------------------
class CatalogManager:
    """Manages DuckDB connection and Iceberg catalog with token refresh."""

    def __init__(self, cfg: Config):
        self._cfg = cfg
        self._conn = self._init_connection()
        self._lock = threading.Lock()
        self._attached = False
        self._token_fetched_at: float = 0
        self._token_lifetime: int = 300  # updated after first probe
        self._lifetime_probed = False
        self._refresh_timer: Optional[threading.Timer] = None

    # -- connection setup (one-time) ----------------------------------------

    def _init_connection(self) -> duckdb.DuckDBPyConnection:
        conn = duckdb.connect(":memory:")
        conn.execute(f"SET extension_directory='{self._cfg.EXTENSION_DIR}'")
        conn.execute("SET autoinstall_known_extensions=false")
        conn.execute("SET autoload_known_extensions=false")
        conn.execute("LOAD avro")
        conn.execute("LOAD iceberg")
        conn.execute("LOAD httpfs")

        if self._cfg.S3_ENDPOINT:
            host = (
                self._cfg.S3_ENDPOINT.replace("https://", "").replace("http://", "")
            )
            conn.execute(f"SET s3_endpoint='{host}'")
            conn.execute(f"SET s3_access_key_id='{self._cfg.S3_ACCESS_KEY}'")
            conn.execute(f"SET s3_secret_access_key='{self._cfg.S3_SECRET_KEY}'")
            conn.execute("SET s3_url_style='path'")
            conn.execute("SET s3_use_ssl=false")

        logger.info("DuckDB connection ready (extensions + S3 configured)")
        return conn

    # -- token lifetime probe -----------------------------------------------

    def _probe_token_lifetime(self) -> int:
        """Fetch a throwaway token to read its ``expires_in`` value.

        Called once; the result is cached because the Keycloak realm config
        does not change at runtime.
        """
        if self._lifetime_probed:
            return self._token_lifetime
        if not self._cfg.KEYCLOAK_TOKEN_URL:
            return 300

        params: dict[str, str] = {
            "grant_type": "client_credentials",
            "client_id": self._cfg.CLIENT_ID,
            "client_secret": self._cfg.CLIENT_SECRET,
        }
        if self._cfg.OAUTH2_SCOPE:
            params["scope"] = self._cfg.OAUTH2_SCOPE

        try:
            data = urllib.parse.urlencode(params).encode()
            req = urllib.request.Request(
                self._cfg.KEYCLOAK_TOKEN_URL,
                data=data,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            resp = urllib.request.urlopen(req, timeout=10)
            body = json.loads(resp.read().decode())
            lifetime = int(body.get("expires_in", 300))
            logger.info(f"Token lifetime probed: {lifetime}s")
            self._token_lifetime = lifetime
            self._lifetime_probed = True
            return lifetime
        except Exception as exc:
            logger.warning(f"Token probe failed ({exc}); assuming 300s")
            return 300

    # -- catalog attach / detach --------------------------------------------

    def _attach_catalog(self) -> None:
        """(Re-)attach the Iceberg catalog.  **Must** be called with ``_lock`` held."""
        if self._attached:
            try:
                self._conn.execute("DETACH iceberg")
            except Exception:
                pass
            self._attached = False

        try:
            self._conn.execute("DROP SECRET IF EXISTS lakekeeper_secret")
        except Exception:
            pass

        scope_clause = (
            f"OAUTH2_SCOPE '{self._cfg.OAUTH2_SCOPE}',"
            if self._cfg.OAUTH2_SCOPE
            else ""
        )
        self._conn.execute(
            f"CREATE SECRET lakekeeper_secret ("
            f"  TYPE ICEBERG,"
            f"  CLIENT_ID '{self._cfg.CLIENT_ID}',"
            f"  CLIENT_SECRET '{self._cfg.CLIENT_SECRET}',"
            f"  {scope_clause}"
            f"  OAUTH2_SERVER_URI '{self._cfg.KEYCLOAK_TOKEN_URL}'"
            f")"
        )

        self._conn.execute(
            f"ATTACH '{self._cfg.WAREHOUSE_NAME}' AS iceberg ("
            f"  TYPE ICEBERG,"
            f"  ENDPOINT '{self._cfg.LAKEKEEPER_CATALOG_URL}',"
            f"  SECRET lakekeeper_secret,"
            f"  SUPPORT_NESTED_NAMESPACES true"
            f")"
        )
        self._attached = True

        lifetime = self._probe_token_lifetime()
        self._token_fetched_at = time.monotonic()

        refresh_in = max(lifetime - self._cfg.REFRESH_MARGIN_S, 30)
        logger.info(
            f"Catalog attached (token valid {lifetime}s, next refresh in {refresh_in}s)"
        )
        self._schedule_refresh(refresh_in)

    # -- proactive background refresh ---------------------------------------

    def _schedule_refresh(self, delay_s: int) -> None:
        if self._refresh_timer is not None:
            self._refresh_timer.cancel()
        self._refresh_timer = threading.Timer(delay_s, self._background_refresh)
        self._refresh_timer.daemon = True
        self._refresh_timer.start()

    def _background_refresh(self) -> None:
        try:
            with self._lock:
                if self._token_remaining() > self._cfg.REFRESH_MARGIN_S:
                    # Already refreshed by a pre-query check; just reschedule.
                    delay = max(
                        int(self._token_remaining()) - self._cfg.REFRESH_MARGIN_S, 30
                    )
                    self._schedule_refresh(delay)
                    return
                logger.info("Background token refresh starting")
                self._attach_catalog()
            logger.info("Background token refresh completed")
        except Exception as exc:
            logger.error(f"Background refresh failed: {exc}; retrying in 30s")
            self._schedule_refresh(30)

    # -- pre-query freshness check ------------------------------------------

    def _token_remaining(self) -> float:
        return (self._token_fetched_at + self._token_lifetime) - time.monotonic()

    def _ensure_fresh(self) -> None:
        if self._token_remaining() < self._cfg.REFRESH_MARGIN_S:
            with self._lock:
                if self._token_remaining() < self._cfg.REFRESH_MARGIN_S:
                    logger.info(
                        f"Pre-query refresh (token has {self._token_remaining():.0f}s left)"
                    )
                    self._attach_catalog()

    # -- public API ---------------------------------------------------------

    def initialize(self) -> None:
        """Perform the initial catalog attachment (called once at startup)."""
        with self._lock:
            self._attach_catalog()

    @staticmethod
    def _is_auth_error(exc: Exception) -> bool:
        msg = str(exc).lower()
        return "401" in msg or "unauthorized" in msg

    def query(self, sql: str) -> dict[str, Any]:
        """Execute *sql* and return a structured result dict.

        Handles token refresh transparently:
        * pre-check before execution
        * automatic retry on HTTP 401
        """
        self._ensure_fresh()
        with self._lock:
            return self._query_locked(sql, is_retry=False)

    def _query_locked(self, sql: str, *, is_retry: bool) -> dict[str, Any]:
        """Inner query executor.  Must be called with ``_lock`` held."""
        try:
            cur = self._conn.execute(sql)

            columns = [d[0] for d in cur.description] if cur.description else []
            col_types = [str(d[1]) for d in cur.description] if cur.description else []

            raw = cur.fetchmany(self._cfg.MAX_ROWS + 1)
            truncated = len(raw) > self._cfg.MAX_ROWS
            if truncated:
                raw = raw[: self._cfg.MAX_ROWS]
            rows = [list(r) for r in raw]

            result: dict[str, Any] = {
                "success": True,
                "columns": columns,
                "columnTypes": col_types,
                "rows": rows,
                "rowCount": len(rows),
            }
            if truncated:
                result["truncated"] = True
                result["warning"] = (
                    f"Results limited to {self._cfg.MAX_ROWS} rows."
                )
            return result

        except Exception as exc:
            if not is_retry and self._is_auth_error(exc):
                logger.warning(f"Auth error on query, refreshing token: {exc}")
                self._attach_catalog()
                return self._query_locked(sql, is_retry=True)
            return {
                "success": False,
                "error": str(exc),
                "errorType": type(exc).__name__,
            }


# ---------------------------------------------------------------------------
# MCP tool definitions
# ---------------------------------------------------------------------------
def create_server(catalog: CatalogManager) -> FastMCP:
    mcp = FastMCP(
        name="duckdb-iceberg-mcp",
        instructions=(
            "SQL analytics server backed by DuckDB with an attached Iceberg catalog. "
            "Tables are accessible as iceberg.<namespace>.<table>. "
            "Always call list_tables first to discover available tables. "
            "Use execute_query for SQL queries; results are capped at MAX_ROWS rows. "
            "If a query may return many rows, use LIMIT or aggregation."
        ),
    )

    @mcp.tool(name="execute_query")
    def execute_query(sql: str) -> str:
        """Execute a SQL query (DuckDB dialect) and return JSON results."""
        result = catalog.query(sql)
        if not result.get("success", True):
            raise ValueError(json.dumps(result, indent=2, default=str))
        return json.dumps(result, indent=2, default=str)

    @mcp.tool(name="list_databases")
    def list_databases() -> str:
        """List all attached databases."""
        result = catalog.query(
            "SELECT database_name, type FROM duckdb_databases()"
        )
        return json.dumps(result, indent=2, default=str)

    @mcp.tool(name="list_tables")
    def list_tables(
        database: str | None = None, schema: str | None = None
    ) -> str:
        """List tables and views, optionally filtered by database and/or schema."""
        result = catalog.query("SHOW ALL TABLES")
        if result.get("success") and (database or schema):
            cols = result.get("columns", [])
            filtered = []
            for row in result.get("rows", []):
                rd = dict(zip(cols, row))
                if database and rd.get("database") != database:
                    continue
                if schema and rd.get("schema") != schema:
                    continue
                filtered.append(row)
            result["rows"] = filtered
            result["rowCount"] = len(filtered)

        # Iceberg catalog tables have lazy schema loading — SHOW ALL TABLES
        # returns placeholder column_names=["__"] / column_types=["UNKNOWN"].
        # Enrich those rows with real schema via DESCRIBE.
        if result.get("success"):
            cols = result.get("columns", [])
            cn_idx = cols.index("column_names") if "column_names" in cols else -1
            ct_idx = cols.index("column_types") if "column_types" in cols else -1
            if cn_idx >= 0 and ct_idx >= 0:
                db_idx = cols.index("database") if "database" in cols else -1
                sch_idx = cols.index("schema") if "schema" in cols else -1
                name_idx = cols.index("name") if "name" in cols else -1
                if db_idx >= 0 and sch_idx >= 0 and name_idx >= 0:
                    for row in result.get("rows", []):
                        if row[cn_idx] != ["__"] or row[ct_idx] != ["UNKNOWN"]:
                            continue
                        desc = catalog.query(
                            f'DESCRIBE "{row[db_idx]}"."{row[sch_idx]}"."{row[name_idx]}"'
                        )
                        if not desc.get("success"):
                            continue
                        dcols = desc.get("columns", [])
                        drows = desc.get("rows", [])
                        ni = dcols.index("column_name") if "column_name" in dcols else -1
                        ti = dcols.index("column_type") if "column_type" in dcols else -1
                        if ni >= 0 and ti >= 0:
                            row[cn_idx] = [r[ni] for r in drows]
                            row[ct_idx] = [r[ti] for r in drows]

        return json.dumps(result, indent=2, default=str)

    @mcp.tool(name="list_columns")
    def list_columns(
        table: str, database: str | None = None, schema: str | None = None
    ) -> str:
        """Describe columns of a table including types."""
        qualified = table
        if schema:
            qualified = f'"{schema}".{qualified}'
        if database:
            qualified = f'"{database}".{qualified}'
        result = catalog.query(f"DESCRIBE {qualified}")
        return json.dumps(result, indent=2, default=str)

    return mcp


# ---------------------------------------------------------------------------
# Entry-point
# ---------------------------------------------------------------------------
def main() -> None:
    configure_observability_minimal(
        log_file_path=os.getenv(
            "AGENT_STUDIO_OBSERVABILITY_LOG_FILE_PATH", "../../App_Logs/mcp-server-duckdb.jsonl"
        ),
        log_level=os.getenv("LOG_LEVEL", "info"),
        otlp_traces_endpoint=os.getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"),
        metrics_service_name=os.getenv("OTEL_SERVICE_NAME", "mcp-server-duckdb"),
        prometheus_metrics_port=int(p) if (p := os.getenv("AGENT_STUDIO_OBSERVABILITY_PROMETHEUS_METRICS_PORT")) else None,
    )

    parser = argparse.ArgumentParser(description="DuckDB Iceberg MCP Server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument(
        "--transport",
        default="streamable-http",
        choices=["streamable-http", "stdio"],
    )
    args = parser.parse_args()

    cfg = Config()
    catalog = CatalogManager(cfg)
    logger.info("Attaching Iceberg catalog …")
    catalog.initialize()

    server = create_server(catalog)
    logger.info(f"MCP server starting on {args.host}:{args.port} ({args.transport})")
    server.run(transport=args.transport, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
