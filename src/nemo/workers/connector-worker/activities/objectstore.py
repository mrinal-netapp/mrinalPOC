"""Object store connector activities: test, list, acquire (legacy), preview.

The legacy `AcquireFromObjectStore` activity remains here as a fallback used
when ACQ_USE_PIPELINE=false. The streaming pipeline lives in
`acquisition_pipeline.py` and shares S3 helpers via `s3_helpers.py`.
"""
from observability_client_runtime import get_logger
import os
import shutil
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import pyarrow.parquet as pq
from temporalio import activity

from .credentials import resolve_credential
from .activity_logging import log_activity_start, log_activity_result
from .workflow_progress import WorkflowProgressReporter
from .s3_helpers import (
    copy_object_with_backoff as _copy_object_with_backoff,
    get_external_s3_client as _get_external_s3_client,
    get_internal_s3_client as _get_internal_s3_client,
    log_list_params as _log_list_params,
    matches_any_pattern as _matches_any_pattern,
    parse_glob_patterns as _parse_glob_patterns,
    relative_key_under_prefix as _relative_key_under_prefix,
    same_cluster_as_worker as _same_cluster_as_worker,
    resolve_acquisition_dest as _resolve_acquisition_dest,
)

logger = get_logger()


def _parse_iso8601_utc(ts: Optional[str]) -> Optional[datetime]:
    """Parse an ISO-8601 string into a timezone-aware UTC datetime. None on empty/invalid."""
    if not ts or not isinstance(ts, str):
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _is_gcs_objectstore(config: Dict[str, Any]) -> bool:
    return (config.get("provider") or "").strip().lower() == "gcs"


def _test_gcs_objectstore_connection(creds: Dict[str, str], config: Dict[str, Any]) -> dict:
    """GCS path for objectstore connectors (service account JSON, not boto3)."""
    from .gcs_acquisition import _gcs_client

    project_id = str(config.get("project_id", "") or "")
    bucket = (config.get("bucket") or "").strip()

    try:
        client = _gcs_client(creds, project_id)
    except json.JSONDecodeError as e:
        return {"success": False, "message": f"Invalid service account JSON: {e}"}
    except ValueError as e:
        return {"success": False, "message": str(e)}

    try:
        if bucket:
            gcs_bucket = client.bucket(bucket)
            if not gcs_bucket.exists():
                return {
                    "success": False,
                    "message": f"Bucket '{bucket}' not found or access denied.",
                }
            return {"success": True, "message": "Connection successful"}

        names: List[str] = [b.name for b in client.list_buckets()]
        return {
            "success": True,
            "message": f"Connection successful; {len(names)} bucket(s) found.",
            "buckets": names,
        }
    except Exception as e:
        err_str = str(e)
        if "has not been used" in err_str or "is not enabled" in err_str or "accessNotConfigured" in err_str:
            return {
                "success": False,
                "message": "Cloud Storage API is not enabled for this project. "
                "Enable it at console.cloud.google.com/apis",
            }
        return {"success": False, "message": err_str}


@activity.defn(name="TestObjectStoreConnection")
def test_objectstore_connection(input: dict) -> dict:
    log_activity_start(input)
    config = input["connectorConfig"]
    creds = resolve_credential(
        input["configServiceURL"], input["projectID"], input["credentialID"]
    )

    if _is_gcs_objectstore(config):
        try:
            result = _test_gcs_objectstore_connection(creds, config)
            log_activity_result(result)
            return result
        except Exception as e:
            result = {"success": False, "message": str(e)}
            log_activity_result(result, error=e)
            return result

    try:
        s3 = _get_external_s3_client(creds, config)
        bucket = (config.get("bucket") or "").strip()
        if bucket:
            s3.head_bucket(Bucket=bucket)
            result = {"success": True, "message": "Connection successful"}
        else:
            # No bucket provided: list buckets to verify connection and return names for UI
            resp = s3.list_buckets()
            names = [b["Name"] for b in resp.get("Buckets", [])]
            result = {
                "success": True,
                "message": f"Connection successful; {len(names)} bucket(s) found.",
                "buckets": names,
            }
        log_activity_result(result)
        return result
    except Exception as e:
        result = {"success": False, "message": str(e)}
        log_activity_result(result, error=e)
        return result


@activity.defn(name="ListObjectStoreFiles")
def list_objectstore_files(input: dict) -> dict:
    log_activity_start(input)
    config = input["connectorConfig"]
    creds = resolve_credential(
        input["configServiceURL"], input["projectID"], input["credentialID"]
    )
    prefix = config.get("prefix", "")
    next_token = input.get("nextToken")

    s3 = _get_external_s3_client(creds, config)
    params: Dict[str, Any] = {"Bucket": config["bucket"], "Prefix": prefix, "MaxKeys": 1000}
    if next_token:
        params["ContinuationToken"] = next_token

    _log_list_params("ListObjectStoreFiles", config, params)
    resp = s3.list_objects_v2(**params)
    files = [
        {
            "key": obj["Key"],
            "size": obj["Size"],
            "lastModified": obj["LastModified"].isoformat(),
        }
        for obj in resp.get("Contents", [])
    ]

    result = {
        "files": files,
        "truncated": resp.get("IsTruncated", False),
        "nextToken": resp.get("NextContinuationToken"),
    }
    log_activity_result(result)
    return result


@activity.defn(name="AcquireFromObjectStore")
def acquire_from_objectstore(input: dict) -> dict:
    log_activity_start(input)
    config = input["connectorConfig"]
    bucket = config.get("bucket", "")
    prefix = config.get("prefix", "")
    output_dest = (
        (input.get("outputPath") or input.get("output_path") or "").strip()
        or (input.get("outputS3Path") or input.get("output_s3_path") or "").strip()
    )
    if not output_dest:
        raise ValueError("outputPath (or legacy outputS3Path) is required")
    file_include_pattern = input.get("fileIncludePattern") or input.get("file_include_pattern") or ""
    file_glob = file_include_pattern or input.get("fileGlob", "")
    file_exclude_pattern = input.get("fileExcludePattern", "")
    max_file_size = int(input.get("maxFileSize") or input.get("max_file_size") or 0)
    modified_after_dt = _parse_iso8601_utc(input.get("modifiedAfter") or input.get("modified_after"))

    include_patterns = _parse_glob_patterns(file_glob)
    exclude_patterns = _parse_glob_patterns(file_exclude_pattern)

    logger.info(
        "[AcquireFromObjectStore] CONFIG: endpoint=%s bucket=%s prefix=%s fileGlob=%s fileExcludePattern=%s maxFileSize=%d modifiedAfter=%s outputPath=%s",
        config.get("endpoint") if config.get("endpoint") else "(default/aws)",
        bucket, prefix, repr(file_glob), repr(file_exclude_pattern), max_file_size, repr(input.get("modifiedAfter") or input.get("modified_after")), output_dest,
    )

    creds = resolve_credential(
        input["configServiceURL"], input["projectID"], input["credentialID"]
    )

    activity.heartbeat("listing-files")
    workflow_id = input.get("workflowID") or input.get("workflow_id") or ""
    progress = WorkflowProgressReporter(workflow_id)
    if progress.url:
        progress.post("listing-files", 5.0, 0, 0, "Listing files")

    ext_s3 = _get_external_s3_client(creds, config)
    int_s3 = _get_internal_s3_client()

    list_params = {"Bucket": bucket, "Prefix": prefix, "MaxKeys": 1000}
    _log_list_params("AcquireFromObjectStore", config, list_params)

    paginator = ext_s3.get_paginator("list_objects_v2")
    pages = paginator.paginate(Bucket=bucket, Prefix=prefix)

    # Discover all keys (with logging); heartbeat each page to avoid timeout on large listings.
    # We capture Size and LastModified so the additional filters below can run without a
    # second LIST round-trip.
    all_keys: list = []
    page_num = 0
    for page in pages:
        page_num += 1
        activity.heartbeat(f"listing-files (page {page_num})")
        contents = page.get("Contents", [])
        for obj in contents:
            all_keys.append((obj["Key"], obj["Size"], obj.get("LastModified")))
        if progress.url:
            progress.post("listing-files", min(5.0 + 2.0 * page_num, 35.0), len(all_keys), 0, f"Listed {len(all_keys)} keys")
        logger.info(
            "[AcquireFromObjectStore] LIST page=%d keys_in_page=%d total_so_far=%d",
            page_num, len(contents), len(all_keys),
        )

    logger.info(
        "[AcquireFromObjectStore] DISCOVERED total keys=%d (bucket=%s prefix=%s)",
        len(all_keys), bucket, prefix,
    )

    # Apply file include/exclude/size/modified-after filters (glob patterns on filename only)
    keys_to_copy = []
    for k, sz, last_modified in all_keys:
        filename = k.rsplit("/", 1)[-1] if "/" in k else k
        if not filename:
            continue
        if include_patterns and not _matches_any_pattern(filename, include_patterns):
            continue
        if exclude_patterns and _matches_any_pattern(filename, exclude_patterns):
            continue
        if max_file_size > 0 and int(sz) > max_file_size:
            continue
        if modified_after_dt is not None and last_modified is not None:
            if last_modified < modified_after_dt:
                continue
        keys_to_copy.append((k, sz))

    logger.info(
        "[AcquireFromObjectStore] FILTER include=%s exclude=%s: before=%d after=%d",
        include_patterns or ["*"], exclude_patterns, len(all_keys), len(keys_to_copy),
    )

    if keys_to_copy:
        sample = keys_to_copy[:5]
        logger.info("[AcquireFromObjectStore] FILES TO COPY (sample): %s", [k for k, _ in sample])

    out_bucket, out_prefix = _resolve_acquisition_dest(input)

    use_server_side_copy = _same_cluster_as_worker(config.get("endpoint"))
    if use_server_side_copy and not out_bucket:
        raise ValueError(
            "outputBucket is required when outputPath is POSIX-style and using server-side copy"
        )
    if use_server_side_copy:
        logger.info(
            "[AcquireFromObjectStore] Using server-side CopyObject (same S3 endpoint as worker); "
            "internal_endpoint=%s connector_endpoint=%s",
            os.environ.get("S3_ENDPOINT"),
            config.get("endpoint"),
        )
    else:
        logger.info(
            "[AcquireFromObjectStore] Using download+upload (connector endpoint differs from worker S3 or unset)"
        )

    total_to_copy = len(keys_to_copy)
    copied = 0
    total_bytes = 0
    for key, size in keys_to_copy:
        activity.heartbeat(f"copying-{copied}")
        if progress.url and total_to_copy:
            pct = 40.0 + 50.0 * (copied / total_to_copy)
            progress.post("copying", min(pct, 89.0), copied, total_to_copy, f"Copying file {copied + 1}/{total_to_copy}", extra={"filesCopied": copied, "totalFiles": total_to_copy})

        rel = _relative_key_under_prefix(prefix, key)
        dest_key = f"{out_prefix}/{rel}" if out_prefix else rel
        dest_key = "/".join(p for p in dest_key.split("/") if p)

        if use_server_side_copy:
            copy_source = {"Bucket": bucket, "Key": key}
            _copy_object_with_backoff(int_s3, out_bucket, dest_key, copy_source)
        else:
            mount = os.environ.get("NEMO_DEFAULT_STORE_ROOT", "").strip()
            if not mount:
                raise RuntimeError("NEMO_DEFAULT_STORE_ROOT is not set")
            dest_path = Path(mount) / dest_key
            dest_path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile() as tmp:
                ext_s3.download_fileobj(bucket, key, tmp)
                tmp.flush()
                shutil.copy2(tmp.name, str(dest_path))

        copied += 1
        total_bytes += size
        # Light stagger to reduce gateway thundering herd on very large batches
        if copied % 200 == 0:
            time.sleep(0.05)

    result = {"filesCopied": copied, "totalBytes": total_bytes}
    logger.info(
        "[AcquireFromObjectStore] DONE copied=%d totalBytes=%d dest=%s",
        copied, total_bytes, output_dest,
    )
    log_activity_result(result)
    return result


@activity.defn(name="PreviewObjectStore")
def preview_objectstore(input: dict) -> dict:
    log_activity_start(input)
    config = input["connectorConfig"]
    creds = resolve_credential(
        input["configServiceURL"], input["projectID"], input["credentialID"]
    )

    ext_s3 = _get_external_s3_client(creds, config)
    prefix = config.get("prefix", "")
    preview_params = {"Bucket": config["bucket"], "Prefix": prefix, "MaxKeys": 10}
    _log_list_params("PreviewObjectStore", config, preview_params)

    resp = ext_s3.list_objects_v2(**preview_params)
    files = [
        {"key": obj["Key"], "size": obj["Size"]}
        for obj in resp.get("Contents", [])
    ]

    preview_rows = []
    columns = []
    for f in files:
        if f["key"].endswith(".parquet"):
            with tempfile.NamedTemporaryFile(suffix=".parquet") as tmp:
                ext_s3.download_file(config["bucket"], f["key"], tmp.name)
                table = pq.read_table(tmp.name)
                columns = table.column_names
                preview_rows = table.slice(0, min(100, table.num_rows)).to_pydict()
            break

    result = {"files": files, "columns": columns, "rows": preview_rows}
    log_activity_result(result)
    return result
