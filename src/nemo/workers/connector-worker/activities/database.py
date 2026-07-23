"""Database connector activities: test, discover, acquire, preview.

User SQL is executed directly against Postgres/MySQL via native drivers. No DuckDB
attach and no SQL rewriting — the user's fully qualified names (e.g. "nemo"."data_sets")
work as-is in their database.
"""
from observability_client_runtime import get_logger
import os
import shutil
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pyarrow as pa
from temporalio import activity

from .credentials import resolve_credential
from .activity_logging import log_activity_start, log_activity_result
from .workflow_progress import WorkflowProgressReporter

logger = get_logger()

# Minimal identifier check for watermark column (alphanumeric + underscore)
_IDENTIFIER_RE = __import__("re").compile(r"^[a-zA-Z_][a-zA-Z0-9_.]*$")


def _sanitize_identifier(name: str) -> str:
    if not _IDENTIFIER_RE.match(name):
        raise ValueError(f"Invalid identifier for watermark column: {name!r}")
    return name


def _sanitize_watermark_value(value: str) -> str:
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


from .db_connection import connect_postgres, connect_mysql


def _run_query(
    config: Dict[str, Any],
    creds: Dict[str, str],
    sql: str,
    timeout_ms: int = 30000,
) -> Tuple[List[str], List[tuple]]:
    """Execute SQL on Postgres or MySQL; return (column_names, rows). No SQL rewriting."""
    db_type = config.get("database_type") or config.get("provider") or "postgresql"
    if db_type == "postgresql":
        conn = connect_postgres(config, creds, timeout_ms)
    else:
        conn = connect_mysql(config, creds)
    try:
        with conn.cursor() as cur:
            if db_type == "mysql":
                cur.execute(f"SET max_execution_time = {timeout_ms}")
            cur.execute(sql)
            columns = [d[0] for d in cur.description] if cur.description else []
            rows = cur.fetchall()
        return columns, rows
    finally:
        conn.close()


def _rows_to_parquet(columns: List[str], rows: List[tuple], path: Path) -> None:
    """Write (columns, rows) to a Parquet file using PyArrow. Schema is inferred from data."""
    if not rows:
        if not columns:
            columns = []
        empty = pa.Table.from_pydict(
            {c: pa.array([], type=pa.string()) for c in columns},
        )
        pa.parquet.write_table(empty, str(path))
        return
    table = pa.Table.from_pylist([dict(zip(columns, row)) for row in rows])
    pa.parquet.write_table(table, str(path))


def _default_store_root() -> str:
    p = (os.environ.get("NEMO_DEFAULT_STORE_ROOT") or "").strip()
    if not p:
        raise RuntimeError(
            "NEMO_DEFAULT_STORE_ROOT is not set. The worker requires a locally "
            "mounted POSIX volume for all data access."
        )
    return p


def _posix_path_from_s3(s3_path: str) -> Path:
    """Convert an s3://<bucket>/<key> path to the equivalent POSIX mount path."""
    parts = s3_path.replace("s3://", "").split("/", 1)
    key = parts[1] if len(parts) > 1 else ""
    return Path(_default_store_root()) / key


def _posix_base_from_output(output_spec: str) -> Path:
    """Dataset output root: POSIX ``/projects/...`` or legacy ``s3://bucket/key``."""
    spec = (output_spec or "").strip().rstrip("/")
    if spec.startswith("s3://"):
        return _posix_path_from_s3(spec)
    return Path(_default_store_root()) / spec.lstrip("/")


@activity.defn(name="TestDatabaseConnection")
def test_database_connection(input: dict) -> dict:
    log_activity_start(input)
    config = input["connectorConfig"]
    creds = resolve_credential(
        input["configServiceURL"], input["projectID"], input["credentialID"]
    )
    try:
        _run_query(config, creds, "SELECT 1", timeout_ms=10000)
        result = {"success": True, "message": "Connection successful"}
        log_activity_result(result)
        return result
    except Exception as e:
        result = {"success": False, "message": str(e)}
        log_activity_result(result, error=e)
        return result


@activity.defn(name="DiscoverDatabaseSchema")
def discover_database_schema(input: dict) -> dict:
    log_activity_start(input)
    config = input["connectorConfig"]
    creds = resolve_credential(
        input["configServiceURL"], input["projectID"], input["credentialID"]
    )
    schema_filter = config.get("schema", "public")
    db_type = config.get("database_type") or config.get("provider") or "postgresql"

    # Standard information_schema queries — run directly, no rewriting
    if db_type == "postgresql":
        tables_sql = (
            "SELECT table_schema, table_name FROM information_schema.tables "
            "WHERE table_schema = %s ORDER BY table_name"
        )
        cols_sql = (
            "SELECT column_name, data_type, is_nullable "
            "FROM information_schema.columns "
            "WHERE table_schema = %s AND table_name = %s ORDER BY ordinal_position"
        )
    else:
        tables_sql = (
            "SELECT table_schema, table_name FROM information_schema.tables "
            "WHERE table_schema = %s ORDER BY table_name"
        )
        cols_sql = (
            "SELECT column_name, data_type, is_nullable "
            "FROM information_schema.columns "
            "WHERE table_schema = %s AND table_name = %s ORDER BY ordinal_position"
        )

    conn = connect_postgres(config, creds, 60000) if db_type == "postgresql" else connect_mysql(config, creds)
    try:
        schemas: Dict[str, List[Dict]] = {}
        with conn.cursor() as cur:
            cur.execute(tables_sql, (schema_filter,))
            for tbl_schema, tbl_name in cur.fetchall():
                cur.execute(cols_sql, (tbl_schema, tbl_name))
                cols = cur.fetchall()
                table_info = {
                    "name": tbl_name,
                    "columns": [
                        {"name": c[0], "type": c[1], "nullable": c[2] == "YES"}
                        for c in cols
                    ],
                }
                schemas.setdefault(tbl_schema, []).append(table_info)
        result = {"schemas": schemas}
        log_activity_result(result)
        return result
    finally:
        conn.close()


def _parse_database_from_sql_comment(sql: str) -> str | None:
    """If SQL starts with '-- Database: <name>', return that database name for connection fallback."""
    sql = (sql or "").strip()
    prefix = "-- Database:"
    if sql.lower().startswith(prefix.lower()):
        rest = sql[len(prefix) :].strip()
        first_line = rest.split("\n")[0].strip()
        if first_line:
            return first_line
    return None


def _effective_db_config(input: dict, sql_query: str = "") -> dict:
    """Build config for DB connection: connectorConfig + overlay from workflow (dataset sourceDatabase/sourceSchema).
    Fallback: if workflow did not pass database, parse from SQL comment '-- Database: <name>' when present."""
    config = dict(input.get("connectorConfig") or {})
    if input.get("database"):
        config["database"] = input["database"]
    elif sql_query:
        db_from_sql = _parse_database_from_sql_comment(sql_query)
        if db_from_sql:
            config["database"] = db_from_sql
            logger.info("Using database from SQL comment: %s", db_from_sql)
    if input.get("schema"):
        config["schema"] = input["schema"]
    return config


@activity.defn(name="AcquireFromDatabase")
def acquire_from_database(input: dict) -> dict:
    log_activity_start(input)
    sql_query = (input["sqlQuery"] or "").strip().rstrip(";")
    config = _effective_db_config(input, sql_query)
    creds = resolve_credential(
        input["configServiceURL"], input["projectID"], input["credentialID"]
    )
    output_spec = (
        (input.get("outputPath") or input.get("output_path") or "").strip()
        or (input.get("outputS3Path") or input.get("output_s3_path") or "").strip()
    )
    if not output_spec:
        raise ValueError("outputPath (or legacy outputS3Path) is required")
    timeout_secs = input.get("timeoutSecs", 300)
    write_mode = input.get("writeMode", "append")
    watermark_col = input.get("watermarkCol")
    last_watermark = input.get("lastWatermark")
    max_rows = input.get("maxRows")

    activity.heartbeat("connecting")
    workflow_id = input.get("workflowID") or input.get("workflow_id") or ""
    progress = WorkflowProgressReporter(workflow_id)
    if progress.url:
        progress.post("connecting", 5.0, 0, 0, "Connecting to database")

    # Optional wrapper: we only add a standard outer SELECT for incremental/limit. User SQL unchanged.
    if write_mode == "incremental" and watermark_col and last_watermark:
        safe_col = _sanitize_identifier(watermark_col)
        safe_val = _sanitize_watermark_value(last_watermark)
        query = f"SELECT * FROM ({sql_query}) AS _q WHERE {safe_col} > {safe_val}"
    elif max_rows and write_mode != "incremental":
        query = f"SELECT * FROM ({sql_query}) AS _q LIMIT {int(max_rows)}"
    else:
        query = sql_query

    activity.heartbeat("executing-query")
    if progress.url:
        progress.post("executing-query", 20.0, 0, 0, "Executing query")

    # Run query in a thread so we can send heartbeats during long-running queries
    query_result: Optional[Tuple[List[str], List[tuple]]] = None
    query_error: Optional[Exception] = None

    def run_query():
        nonlocal query_result, query_error
        try:
            query_result = _run_query(config, creds, query, timeout_ms=timeout_secs * 1000)
        except Exception as e:
            query_error = e

    thread = threading.Thread(target=run_query, daemon=True)
    thread.start()
    heartbeat_interval_sec = 120  # stay well under 5-min activity heartbeat timeout
    while thread.is_alive():
        thread.join(timeout=heartbeat_interval_sec)
        if thread.is_alive():
            activity.heartbeat("executing-query")
            if progress.url:
                progress.post("executing-query", 25.0, 0, 0, "Executing query")
    if query_error is not None:
        raise query_error
    if query_result is None:
        raise RuntimeError("Query completed but no result returned")
    columns, rows = query_result

    with tempfile.TemporaryDirectory() as tmp_dir:
        local_path = Path(tmp_dir) / "output.parquet"
        _rows_to_parquet(columns, rows, local_path)
        file_size = local_path.stat().st_size
        row_count = len(rows)

        new_watermark = None
        if watermark_col and row_count > 0 and watermark_col in columns:
            col_idx = columns.index(watermark_col)
            new_watermark = str(max(row[col_idx] for row in rows if row[col_idx] is not None))

        activity.heartbeat("writing")
        if progress.url:
            progress.post("writing", 90.0, row_count, row_count, "Writing output", extra={"rowCount": row_count})
        dest_path = _posix_base_from_output(output_spec) / "output.parquet"
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(local_path), str(dest_path))

    result = {
        "rowCount": row_count,
        "fileSizeBytes": file_size,
        "newWatermarkValue": new_watermark,
    }
    log_activity_result(result)
    return result


@activity.defn(name="PreviewDatabase")
def preview_database(input: dict) -> dict:
    log_activity_start(input)
    sql_query = (input["sqlQuery"] or "").strip().rstrip(";")
    config = _effective_db_config(input, sql_query)
    creds = resolve_credential(
        input["configServiceURL"], input["projectID"], input["credentialID"]
    )
    # Simple wrapper: limit to 100 rows. User SQL is unchanged.
    query = f"SELECT * FROM ({sql_query}) AS _q LIMIT 100"

    columns, rows = _run_query(config, creds, query, timeout_ms=30000)
    out = {
        "columns": columns,
        "rows": [dict(zip(columns, row)) for row in rows],
        "rowCount": len(rows),
    }
    log_activity_result(out)
    return out
