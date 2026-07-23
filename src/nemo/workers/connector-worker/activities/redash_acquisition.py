"""API connector acquisition activity.

Dispatches by provider (currently: redash). Follows the same pattern as
activities/metrics.py (AcquireMetrics).
"""
import json
from observability_client_runtime import get_logger
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

import pyarrow as pa
import pyarrow.parquet as pq
from temporalio import activity

from .activity_logging import log_activity_start, log_activity_result
from .credentials import resolve_credential
from .s3_helpers import acquisition_artifact_key_prefix
from .redash_client import RedashClient, RedashAuthError

logger = get_logger()


_REDASH_TYPE_TO_PA = {
    "integer": pa.int64(),
    "float": pa.float64(),
    "boolean": pa.bool_(),
    "string": pa.string(),
    "date": pa.string(),       # Redash returns ISO-8601 strings
    "datetime": pa.string(),   # Redash returns ISO-8601 strings
}


def _slug(name: str, fallback: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_]+", "_", name or "").strip("_").lower()
    return slug or fallback


def _quote_identifier(table: str, ds_type: str = "") -> str:
    """Quote a table identifier for ad-hoc SELECT.

    Redash schema responses already include the schema-qualified name (e.g.
    ``public.users`` or ``users``). We split on dots and double-quote each part,
    which works for PostgreSQL/Redshift/Snowflake/Trino/Presto/BigQuery dialects
    that accept double quotes. MySQL uses backticks; switch on ds_type.
    """
    parts = [p for p in str(table).split(".") if p]
    if not parts:
        return f'"{table}"'
    quote_char = "`" if ds_type.lower() in ("mysql", "mariadb") else '"'
    return ".".join(f"{quote_char}{p.replace(quote_char, quote_char * 2)}{quote_char}" for p in parts)


def _query_result_to_table(query_result: Dict[str, Any]) -> Optional[pa.Table]:
    """Convert a Redash query_result body into a typed PyArrow Table.

    Returns None when the result has no columns (treat as no-op).
    """
    data = query_result.get("data") or {}
    columns = data.get("columns") or []
    rows = data.get("rows") or []
    if not columns:
        return None

    fields: List[pa.Field] = []
    for col in columns:
        col_name = col.get("name") or col.get("friendly_name") or "col"
        col_type = (col.get("type") or "string").lower()
        pa_type = _REDASH_TYPE_TO_PA.get(col_type, pa.string())
        fields.append(pa.field(col_name, pa_type))
    schema = pa.schema(fields)

    column_arrays: List[pa.Array] = []
    for field in schema:
        values = [row.get(field.name) for row in rows]
        try:
            column_arrays.append(pa.array(values, type=field.type))
        except (pa.ArrowInvalid, pa.ArrowTypeError):
            column_arrays.append(pa.array([None if v is None else str(v) for v in values], type=pa.string()))
            schema = schema.set(schema.get_field_index(field.name), pa.field(field.name, pa.string()))

    return pa.Table.from_arrays(column_arrays, schema=schema)


def _default_store_root() -> str:
    p = (os.environ.get("NEMO_DEFAULT_STORE_ROOT") or "").strip()
    if not p:
        raise RuntimeError(
            "NEMO_DEFAULT_STORE_ROOT is not set. The worker requires a locally "
            "mounted POSIX volume for all data access."
        )
    return p


def _posix_path(key: str) -> Path:
    return Path(_default_store_root()) / key


@activity.defn(name="AcquireFromAPI")
async def acquire_from_api(input: Dict[str, Any]) -> Dict[str, Any]:
    """Acquire data from an API-based connector. Dispatches by provider."""
    log_activity_start(input)

    provider = input.get("provider", "")
    if provider == "redash":
        return await _acquire_redash(input)
    raise ValueError(f"Unknown API provider: {provider}. Available: ['redash']")


async def _acquire_redash(input: Dict[str, Any]) -> Dict[str, Any]:
    """Fetch queries, dashboards, and data sources from Redash; write as Parquet."""
    connection_info = input.get("connectionInfo", {})
    project_id = input.get("projectID", "")
    dataset_id = input.get("datasetID", "")
    credential_id = input.get("credentialId", "") or connection_info.get("credential_id", "")
    config_service_url = input.get("configServiceURL", "")

    base_url = connection_info.get("base_url", "")
    if not base_url:
        raise ValueError("base_url is required in connectionInfo for Redash acquisition")

    include_query_results = connection_info.get("include_query_results", True)
    include_dashboards = connection_info.get("include_dashboards", True)
    include_data_sources = connection_info.get("include_data_sources", True)
    max_result_rows = int(connection_info.get("max_result_rows", 10_000))
    verify_tls = connection_info.get("verify_tls", True) is not False

    # Resolve credential
    creds: Dict[str, str] = {}
    if credential_id and config_service_url:
        creds = resolve_credential(config_service_url, project_id, credential_id)

    api_key = creds.get("api_key", "")
    if not api_key:
        raise ValueError("Credential must contain 'api_key' for Redash connector")

    client = RedashClient(base_url, api_key, max_result_rows=max_result_rows, verify_tls=verify_tls)

    # Fine-grained resource filtering via resourceSelector
    resource_selector = input.get("resourceSelector") or []
    allowed_query_ids = None
    allowed_dashboard_slugs = None
    allowed_datasource_ids = None
    allowed_tables: List[tuple] = []  # list of (data_source_id, table_name)
    if resource_selector:
        allowed_query_ids = {r["query_id"] for r in resource_selector if "query_id" in r}
        allowed_dashboard_slugs = {r["dashboard_slug"] for r in resource_selector if "dashboard_slug" in r}
        # Tables: entries that have BOTH data_source_id and table -> execute SELECT *.
        # Bare data_source_id entries (no table) -> request datasource metadata only.
        allowed_tables = [
            (int(r["data_source_id"]), str(r["table"]))
            for r in resource_selector
            if "data_source_id" in r and r.get("table")
        ]
        allowed_datasource_ids = {
            r["data_source_id"] for r in resource_selector
            if "data_source_id" in r and not r.get("table")
        }
        logger.info(
            "[AcquireFromAPI/redash] resourceSelector active: queries=%s dashboards=%s "
            "datasources=%s tables=%s",
            allowed_query_ids or "all",
            allowed_dashboard_slugs or "all",
            allowed_datasource_ids or "all",
            allowed_tables or "none",
        )

    run_id = activity.info().workflow_run_id[:8] if hasattr(activity.info(), "workflow_run_id") else "local"
    output_dir = os.path.join(tempfile.gettempdir(), "api-acq", project_id, dataset_id, run_id)
    os.makedirs(output_dir, exist_ok=True)

    total_rows = 0
    query_execution_mode = bool(allowed_query_ids) or bool(allowed_tables)

    if allowed_query_ids:
        # User picked specific queries: execute each one and write its result rows
        # as a typed Parquet table. The dataset's data IS the query output.
        activity.heartbeat("executing-queries")
        logger.info(
            "[AcquireFromAPI/redash] Query-execution mode for %d selected queries",
            len(allowed_query_ids),
        )
        max_age_sec = int(connection_info.get("query_max_age_seconds", 0))
        poll_timeout = float(connection_info.get("query_poll_timeout_seconds", 600))

        for idx, qid in enumerate(sorted(allowed_query_ids)):
            activity.heartbeat(f"executing-query-{qid}")
            try:
                meta = client.get_query(qid) or {}
                qname = meta.get("name", f"query_{qid}")
                logger.info("[AcquireFromAPI/redash] Executing query id=%s name=%r", qid, qname)
                result = client.execute_query(
                    qid,
                    max_age=max_age_sec,
                    poll_timeout=poll_timeout,
                    heartbeat=activity.heartbeat,
                )
                if not result:
                    logger.warning(
                        "[AcquireFromAPI/redash] Query %s returned no result (cap exceeded or empty)", qid,
                    )
                    continue
                table = _query_result_to_table(result)
                if table is None:
                    logger.warning("[AcquireFromAPI/redash] Query %s returned no columns; skipping", qid)
                    continue
                file_name = f"query_{qid}_{_slug(qname, str(qid))}.parquet"
                out_path = os.path.join(output_dir, file_name)
                pq.write_table(table, out_path)
                total_rows += table.num_rows
                logger.info(
                    "[AcquireFromAPI/redash] Query %s wrote %d rows / %d cols -> %s",
                    qid, table.num_rows, table.num_columns, file_name,
                )
            except Exception as exc:
                logger.exception(
                    "[AcquireFromAPI/redash] Failed to execute query %s: %s", qid, exc,
                )
                if idx == 0 and len(allowed_query_ids) == 1:
                    raise

    if allowed_tables:
        # User picked tables under data sources: run SELECT * against each and
        # write the rows as a typed Parquet file (one per (data_source_id, table)).
        activity.heartbeat("executing-tables")
        max_age_sec = int(connection_info.get("query_max_age_seconds", 0))
        poll_timeout = float(connection_info.get("query_poll_timeout_seconds", 600))
        ds_type_cache: Dict[int, str] = {}

        try:
            for s in client.list_data_sources():
                ds_type_cache[int(s["id"])] = (s.get("type") or "").lower()
        except Exception as exc:
            logger.warning("[AcquireFromAPI/redash] Could not pre-fetch data source types: %s", exc)

        logger.info(
            "[AcquireFromAPI/redash] Table-execution mode for %d selected tables",
            len(allowed_tables),
        )

        for idx, (ds_id, tbl_name) in enumerate(allowed_tables):
            activity.heartbeat(f"executing-table-{ds_id}-{_slug(tbl_name, 'tbl')}")
            ds_type = ds_type_cache.get(ds_id, "")
            quoted = _quote_identifier(tbl_name, ds_type)
            sql = f"SELECT * FROM {quoted} LIMIT {max_result_rows}"
            logger.info(
                "[AcquireFromAPI/redash] Running ad-hoc on ds=%s table=%r sql=%s",
                ds_id, tbl_name, sql,
            )
            try:
                result = client.execute_sql(
                    data_source_id=ds_id,
                    sql=sql,
                    max_age=max_age_sec,
                    poll_timeout=poll_timeout,
                    heartbeat=activity.heartbeat,
                )
                if not result:
                    logger.warning(
                        "[AcquireFromAPI/redash] Table ds=%s %r returned no result", ds_id, tbl_name,
                    )
                    continue
                table_pa = _query_result_to_table(result)
                if table_pa is None:
                    logger.warning(
                        "[AcquireFromAPI/redash] Table ds=%s %r returned no columns; skipping",
                        ds_id, tbl_name,
                    )
                    continue
                file_name = f"ds{ds_id}_{_slug(tbl_name, 'table')}.parquet"
                out_path = os.path.join(output_dir, file_name)
                pq.write_table(table_pa, out_path)
                total_rows += table_pa.num_rows
                logger.info(
                    "[AcquireFromAPI/redash] Table ds=%s %r wrote %d rows / %d cols -> %s",
                    ds_id, tbl_name, table_pa.num_rows, table_pa.num_columns, file_name,
                )
            except Exception as exc:
                logger.exception(
                    "[AcquireFromAPI/redash] Failed to acquire ds=%s table=%r: %s",
                    ds_id, tbl_name, exc,
                )
                if idx == 0 and len(allowed_tables) == 1:
                    raise

    if not query_execution_mode:
        # Legacy / catalog mode: emit metadata about every query (and optionally a
        # JSON blob of cached results) so the dataset can serve as a Redash catalog.
        activity.heartbeat("fetching-queries")
        logger.info("[AcquireFromAPI/redash] Fetching queries from %s", base_url)
        queries = client.list_queries()
        logger.info("[AcquireFromAPI/redash] Found %d queries", len(queries))

        query_records: List[Dict[str, Any]] = []
        result_records: List[Dict[str, Any]] = []

        for i, q in enumerate(queries):
            if q.get("is_archived", False):
                continue
            query_records.append({
                "id": q.get("id"),
                "name": q.get("name", ""),
                "query_sql": q.get("query", ""),
                "data_source_id": q.get("data_source_id"),
                "schedule": json.dumps(q.get("schedule")) if q.get("schedule") else None,
                "created_at": q.get("created_at", ""),
                "updated_at": q.get("updated_at", ""),
                "tags": json.dumps(q.get("tags", [])),
            })

            if include_query_results and q.get("id"):
                try:
                    result = client.get_query_result(q["id"])
                    if result:
                        rows = result.get("data", {}).get("rows", [])
                        result_records.append({
                            "query_id": q["id"],
                            "query_name": q.get("name", ""),
                            "row_count": len(rows),
                            "columns_json": json.dumps(result.get("data", {}).get("columns", [])),
                            "result_json": json.dumps(rows),
                        })
                except Exception as exc:
                    logger.warning(
                        "[AcquireFromAPI/redash] Skipping result for query %d: %s",
                        q["id"], exc,
                    )

            if (i + 1) % 50 == 0:
                activity.heartbeat(f"queries-{i + 1}/{len(queries)}")

        if query_records:
            queries_path = os.path.join(output_dir, "queries.parquet")
            table = pa.Table.from_pylist(query_records)
            pq.write_table(table, queries_path)
            total_rows += len(query_records)

        if result_records:
            results_path = os.path.join(output_dir, "query_results.parquet")
            table = pa.Table.from_pylist(result_records)
            pq.write_table(table, results_path)
            total_rows += len(result_records)

    # --- Dashboards ---
    # When resourceSelector is in effect, only emit dashboards if any were picked.
    dashboards_requested = (
        include_dashboards if not resource_selector else bool(allowed_dashboard_slugs)
    )
    if dashboards_requested:
        activity.heartbeat("fetching-dashboards")
        logger.info("[AcquireFromAPI/redash] Fetching dashboards")
        dashboards = client.list_dashboards()
        dashboard_records: List[Dict[str, Any]] = []

        for i, d in enumerate(dashboards):
            if d.get("is_archived", False):
                continue
            slug = d.get("slug", "")
            if allowed_dashboard_slugs is not None and slug not in allowed_dashboard_slugs:
                continue
            detail = None
            if slug:
                try:
                    detail = client.get_dashboard(slug)
                except Exception as exc:
                    logger.warning(
                        "[AcquireFromAPI/redash] Skipping dashboard %s: %s", slug, exc
                    )
            widgets_json = json.dumps(detail.get("widgets", [])) if detail else "[]"
            dashboard_records.append({
                "id": d.get("id"),
                "slug": slug,
                "name": d.get("name", ""),
                "widgets_json": widgets_json,
                "created_at": d.get("created_at", ""),
                "updated_at": d.get("updated_at", ""),
            })
            if (i + 1) % 20 == 0:
                activity.heartbeat(f"dashboards-{i + 1}/{len(dashboards)}")

        if dashboard_records:
            dashboards_path = os.path.join(output_dir, "dashboards.parquet")
            table = pa.Table.from_pylist(dashboard_records)
            pq.write_table(table, dashboards_path)
            total_rows += len(dashboard_records)

    # --- Data Sources ---
    # When resourceSelector is in effect, only emit data sources if any were picked.
    data_sources_requested = (
        include_data_sources if not resource_selector else bool(allowed_datasource_ids)
    )
    if data_sources_requested:
        activity.heartbeat("fetching-data-sources")
        logger.info("[AcquireFromAPI/redash] Fetching data sources")
        try:
            sources = client.list_data_sources()
            source_records = [
                {
                    "id": s.get("id"),
                    "name": s.get("name", ""),
                    "type": s.get("type", ""),
                    "options_json": json.dumps(s.get("options", {})),
                    "created_at": s.get("created_at", ""),
                }
                for s in sources
                if allowed_datasource_ids is None or s.get("id") in allowed_datasource_ids
            ]
            if source_records:
                sources_path = os.path.join(output_dir, "data_sources.parquet")
                table = pa.Table.from_pylist(source_records)
                pq.write_table(table, sources_path)
                total_rows += len(source_records)
        except Exception as exc:
            logger.warning("[AcquireFromAPI/redash] Failed to fetch data sources: %s", exc)

    # --- Move files to POSIX volume ---
    activity.heartbeat("storing-files")
    out_prefix = f"projects/{project_id}/datasets/{dataset_id}/data"
    stored_files: List[Dict[str, Any]] = []

    for filename in os.listdir(output_dir):
        if not filename.endswith(".parquet"):
            continue
        local_path = os.path.join(output_dir, filename)
        dest_key = f"{out_prefix}/{run_id}/{filename}"
        dest_path = _posix_path(dest_key)
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(local_path, str(dest_path))
        file_size = dest_path.stat().st_size
        stored_files.append({
            "key": dest_key,
            "size": file_size,
            "format": "parquet",
        })
        logger.info("Stored %s -> %s (%d bytes)", filename, dest_path, file_size)

    # Write filelist manifest (under dataset artifact root, sibling of data_files/)
    artifact_prefix = acquisition_artifact_key_prefix(input)
    filelist_key = f"{artifact_prefix}/_acquisition/filelist.json"
    filelist_path = _posix_path(filelist_key)
    filelist_path.parent.mkdir(parents=True, exist_ok=True)
    filelist_path.write_text(json.dumps({
        "files": stored_files,
        "totalFiles": len(stored_files),
        "source": "api",
        "provider": "redash",
    }, separators=(",", ":"), default=str))

    # Cleanup temp dir
    shutil.rmtree(output_dir, ignore_errors=True)

    logger.info(
        "[AcquireFromAPI/redash] Complete: mode=%s total_rows=%d files=%d dashboards=%s data_sources=%s",
        "execute" if query_execution_mode else "catalog",
        total_rows,
        len(stored_files),
        dashboards_requested,
        data_sources_requested,
    )

    final_result = {
        "rowCount": total_rows,
        "filesCopied": float(len(stored_files)),
        "fileListKey": filelist_key,
    }
    log_activity_result(final_result)
    return final_result
