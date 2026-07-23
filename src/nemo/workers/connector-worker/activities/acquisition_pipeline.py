"""Streaming acquisition pipeline activities.

Replaces the monolithic AcquireFromObjectStore activity (kept as a fallback)
with four small activities chained by data_acquisition.go:

    DiscoverObjectStoreItems - producer; lists S3 source and XADDs items + EOF
    AcquireBatch         - one of N parallel consumers; XREADGROUP -> copy -> XACK
    FinalizeAcquisition  - aggregates per-batch manifests, writes facet, GCs Redis
    CleanupAcquisitionStream - safety net for cancel/timeout (workflow.Go handler)
    RegisterVolumeFiles  - POSIX mount walk; writes filelist.json (volume-backed acquisition)

See docs/design/stream-pipeline.md for the full design.
"""
from __future__ import annotations

import json
from observability_client_runtime import get_logger
import os
import random
import shutil
from datetime import datetime, timezone
from pathlib import Path
import socket
import tempfile
import time
import urllib.request
from typing import Any, Dict, Iterable, List, Optional, Tuple

from temporalio import activity

from .activity_logging import log_activity_start, log_activity_result
from .credentials import resolve_credential, _get_service_account_token
from .s3_helpers import (
    acquisition_artifact_key_prefix,
    copy_object_with_backoff,
    get_external_s3_client,
    get_internal_s3_client,
    log_list_params,
    matches_any_pattern,
    parse_glob_patterns,
    relative_key_under_prefix,
    resolve_acquisition_dest,
    same_cluster_as_worker,
)
from .workflow_progress import WorkflowProgressReporter
from streaming import DirQueue, build_job_stream
from streaming.redis_stream import track_eof_seen_redis_failures as _track_eof_seen_redis_failures

logger = get_logger()

DEFAULT_BATCH_SIZE = 500
DEFAULT_MAX_BATCHES_PER_ACTIVITY = 8
DEFAULT_BLOCK_MS = 500
DEFAULT_RECLAIM_IDLE_MS = 300_000  # 5 min
DEFAULT_EMPTY_READS_AFTER_EOF = 3
_JITTER_FRACTION = 0.3  # +-30% jitter on poll timeouts


def _jittered_ms(base_ms: int) -> int:
    """Return *base_ms* perturbed by +-_JITTER_FRACTION (uniform)."""
    lo = base_ms * (1 - _JITTER_FRACTION)
    hi = base_ms * (1 + _JITTER_FRACTION)
    return max(1, int(random.uniform(lo, hi)))


def _jittered_seconds(base_s: float) -> float:
    """Return *base_s* perturbed by +-_JITTER_FRACTION (uniform)."""
    lo = base_s * (1 - _JITTER_FRACTION)
    hi = base_s * (1 + _JITTER_FRACTION)
    return max(0.1, random.uniform(lo, hi))


MANIFEST_KEY_TEMPLATE = "_acquisition/manifests/{set_id}.json"
RESULT_KEY = "_acquisition/result.json"
DEFAULT_CONFIG_SERVICE_URL = "http://config-service:3000"


def _activity_workflow_context() -> Tuple[str, str]:
    """Returns (workflow_id, workflow_run_id) from Temporal activity info.

    Activities derive both from activity.info() instead of receiving them in input
    so workflow callers don't have to keep them in sync (finding #22).
    """
    try:
        info = activity.info()
        return info.workflow_id or "", info.workflow_run_id or ""
    except Exception:
        return "", ""


def _default_store_root() -> str:
    """Return the default app-scoped PVC mount root. Raises if not configured."""
    p = (os.environ.get("NEMO_DEFAULT_STORE_ROOT") or "").strip()
    if not p:
        raise RuntimeError(
            "NEMO_DEFAULT_STORE_ROOT is not set. The worker requires a locally "
            "mounted POSIX volume for all data access."
        )
    return p


def _posix_path(key: str) -> Path:
    return Path(_default_store_root()) / key


def _put_json(key: str, payload: Dict[str, Any]) -> None:
    body = json.dumps(payload, separators=(",", ":"), default=str).encode("utf-8")
    p = _posix_path(key)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_bytes(body)
    tmp.rename(p)


def _read_json(key: str) -> Optional[Dict[str, Any]]:
    p = _posix_path(key)
    if not p.is_file():
        logger.debug("posix read %s: not found", p)
        return None
    try:
        return json.loads(p.read_bytes())
    except Exception as exc:
        logger.warning("manifest %s is not valid JSON: %s", p, exc)
        return None


def _list_manifest_keys(prefix: str) -> List[str]:
    base = _posix_path(prefix)
    if not base.is_dir():
        return []
    keys: List[str] = []
    for p in sorted(base.rglob("*")):
        if p.is_file():
            keys.append(str(p.relative_to(Path(_default_store_root()))))
    return keys


def _consumer_name() -> str:
    """Stable per-pod name for the Redis consumer group; XAUTOCLAIM uses it
    to reclaim items from dead pods after min_idle_ms."""
    try:
        host = socket.gethostname()
    except Exception:
        host = "connector-worker"
    pid = os.getpid()
    return f"{host}-{pid}"


@activity.defn(name="DiscoverObjectStoreItems")
def discover_object_store_items(input: dict) -> dict:
    """List the source and XADD discovered items into the per-job Redis stream.

    Idempotent on retry:
    - if EOF was already written by a previous attempt, return cached totals
    - otherwise resume listing from JobStream.last_produced_key() so we don't
      re-emit items consumers may already be acking
    """
    log_activity_start(input)
    workflow_id, run_id = _activity_workflow_context()
    if not workflow_id or not run_id:
        raise RuntimeError("DiscoverObjectStoreItems requires a Temporal activity context (workflow_id+run_id)")

    config = input["connectorConfig"]
    project_id = input.get("projectID") or input.get("projectId") or ""
    credential_id = input.get("credentialID") or input.get("credentialId") or ""
    config_service_url = input.get("configServiceURL") or os.environ.get("CONFIG_SERVICE_URL") or DEFAULT_CONFIG_SERVICE_URL
    file_include_pattern = input.get("fileIncludePattern") or input.get("file_include_pattern") or ""
    file_glob = file_include_pattern or input.get("fileGlob", "")
    file_exclude_pattern = input.get("fileExcludePattern", "")
    max_file_size = int(input.get("maxFileSize") or input.get("max_file_size") or 0)
    modified_after_dt = _parse_iso8601(input.get("modifiedAfter") or input.get("modified_after"))

    bucket = config.get("bucket", "")
    prefix = (config.get("prefix") or "").strip()
    if not bucket:
        raise ValueError("DiscoverObjectStoreItems: connectorConfig.bucket is required")

    include_patterns = parse_glob_patterns(file_glob)
    exclude_patterns = parse_glob_patterns(file_exclude_pattern)

    js = build_job_stream(workflow_id, run_id)
    if not js.ping():
        raise RuntimeError(
            f"DiscoverObjectStoreItems: Redis unreachable for stream {js.stream_key} "
            "(check ACQ_REDIS_SENTINEL_URL / ACQ_REDIS_URL)"
        )
    js.ensure_group()

    if js.is_complete():
        state = js.get_state()
        result = {
            "streamKey": js.stream_key,
            "totalDiscovered": int(state.get("produced", "0") or 0),
            "filesFiltered": int(state.get("filtered", "0") or 0),
            "eof": True,
            "resumed": "from_eof",
        }
        log_activity_result(result)
        return result

    resume_after = js.last_produced_key()

    creds = resolve_credential(config_service_url, project_id, credential_id)
    ext_s3 = get_external_s3_client(creds, config)

    activity.heartbeat("listing-source")
    progress = WorkflowProgressReporter(workflow_id)
    if progress.url:
        progress.post(
            "discovering", 1.0, 0, 0, "Listing source",
            extra={"streamKey": js.stream_key, "_force": True},
        )

    list_kwargs: Dict[str, Any] = {"Bucket": bucket, "Prefix": prefix}
    if resume_after:
        list_kwargs["StartAfter"] = resume_after
        logger.info(
            "[DiscoverObjectStoreItems] Resuming from last_produced_key=%s (stream=%s)",
            resume_after, js.stream_key,
        )
    log_list_params("DiscoverObjectStoreItems", config, dict(list_kwargs, MaxKeys=1000))

    paginator = ext_s3.get_paginator("list_objects_v2")
    total_listed = 0
    total_filtered = 0
    page_num = 0

    def _iter_filtered_items() -> Iterable[Dict[str, Any]]:
        nonlocal total_listed, total_filtered, page_num
        for page in paginator.paginate(**list_kwargs):
            page_num += 1
            activity.heartbeat(f"listing-source page={page_num}")
            contents = page.get("Contents", []) or []
            for obj in contents:
                total_listed += 1
                key = obj["Key"]
                size = int(obj.get("Size") or 0)
                filename = key.rsplit("/", 1)[-1] if "/" in key else key
                if not filename:
                    continue
                if include_patterns and not matches_any_pattern(filename, include_patterns):
                    total_filtered += 1
                    continue
                if exclude_patterns and matches_any_pattern(filename, exclude_patterns):
                    total_filtered += 1
                    continue
                if max_file_size > 0 and size > max_file_size:
                    total_filtered += 1
                    continue
                last_modified_dt = obj.get("LastModified")
                if modified_after_dt is not None and last_modified_dt is not None:
                    if last_modified_dt < modified_after_dt:
                        total_filtered += 1
                        continue
                last_modified_iso = last_modified_dt.isoformat() if last_modified_dt else ""
                yield {
                    "key": key,
                    "uri": f"s3://{bucket}/{key}",
                    "relative_path": relative_key_under_prefix(prefix, key),
                    "size": size,
                    "last_modified": last_modified_iso,
                    "metadata": "",
                }
            if progress.url:
                progress.post(
                    "discovering",
                    min(1.0 + 0.5 * page_num, 9.0),
                    total_listed,
                    0,
                    f"Listed {total_listed} keys",
                    extra={
                        "filesDiscovered": total_listed - total_filtered,
                        "filesFiltered": total_filtered,
                        "pagesScanned": page_num,
                    },
                )

    produced = js.produce(_iter_filtered_items())
    if not js.update_state(
        produced=produced,
        listed=total_listed,
        filtered=total_filtered,
        bucket=bucket,
        prefix=prefix,
    ):
        raise RuntimeError("DiscoverObjectStoreItems: update_state after produce failed")
    js.mark_eof()

    result = {
        "streamKey": js.stream_key,
        "totalDiscovered": produced,
        "filesFiltered": total_filtered,
        "filesListed": total_listed,
        "eof": True,
    }
    if progress.url:
        progress.post(
            "discovered", 9.5, produced, 0,
            f"Discovered {produced} items",
            extra={"filesDiscovered": produced, "filesFiltered": total_filtered, "_force": True},
        )
    log_activity_result(result)
    return result


@activity.defn(name="DiscoverSourceItems")
def discover_source_items(input: dict) -> dict:
    """Backward-compat alias for DiscoverObjectStoreItems."""
    return discover_object_store_items(input)


@activity.defn(name="AcquireBatch")
def acquire_batch(input: dict) -> dict:
    """One of N parallel consumers. Drains a bounded budget from the stream
    and copies each item into the dataset prefix. Returns a WorkUnitResult."""
    log_activity_start(input)
    workflow_id, run_id = _activity_workflow_context()
    if not workflow_id or not run_id:
        raise RuntimeError("AcquireBatch requires a Temporal activity context (workflow_id+run_id)")

    set_id = input.get("setId") or input.get("set_id") or "acq-s0"
    config = input["connectorConfig"]
    project_id = input.get("projectID") or input.get("projectId") or ""
    credential_id = input.get("credentialID") or input.get("credentialId") or ""
    config_service_url = input.get("configServiceURL") or os.environ.get("CONFIG_SERVICE_URL") or DEFAULT_CONFIG_SERVICE_URL

    batch_size = int(os.environ.get("ACQ_BATCH_SIZE", str(DEFAULT_BATCH_SIZE)))
    max_batches = int(os.environ.get("ACQ_MAX_BATCHES_PER_ACTIVITY", str(DEFAULT_MAX_BATCHES_PER_ACTIVITY)))
    block_ms = int(os.environ.get("ACQ_BLOCK_MS", str(DEFAULT_BLOCK_MS)))
    reclaim_idle_ms = int(os.environ.get("ACQ_RECLAIM_IDLE_MS", str(DEFAULT_RECLAIM_IDLE_MS)))
    empty_reads_limit = int(os.environ.get("ACQ_EMPTY_READS_AFTER_EOF", str(DEFAULT_EMPTY_READS_AFTER_EOF)))

    bucket = config.get("bucket", "")
    prefix = (config.get("prefix") or "").strip()
    out_bucket, out_prefix = resolve_acquisition_dest(input)
    artifact_prefix = acquisition_artifact_key_prefix(input)

    js = build_job_stream(workflow_id, run_id)
    js.ensure_group()
    consumer = _consumer_name() + f"-{set_id}"

    creds = resolve_credential(config_service_url, project_id, credential_id)
    ext_s3 = get_external_s3_client(creds, config)
    int_s3 = get_internal_s3_client()

    use_server_side = same_cluster_as_worker(config.get("endpoint"))
    if use_server_side and not out_bucket:
        raise ValueError(
            "outputBucket is required when outputPath is POSIX-style and the connector "
            "uses same-cluster server-side copy"
        )
    startup_jitter = random.uniform(0, 0.5)
    logger.info(
        "[AcquireBatch] set=%s consumer=%s mode=%s stream=%s budget=%dx%d startup_jitter=%.2fs",
        set_id, consumer,
        "server-side-copy" if use_server_side else "download+upload",
        js.stream_key, max_batches, batch_size, startup_jitter,
    )
    time.sleep(startup_jitter)

    started_at = time.time()
    copied = 0
    bytes_copied = 0
    error_count = 0
    eof_reached = False
    items_acquired: List[Dict[str, Any]] = []
    last_error: Optional[str] = None
    consecutive_empty = 0

    def _process_chunk(entries: List[Tuple[str, Dict[str, str]]]) -> None:
        nonlocal copied, bytes_copied, error_count, eof_reached, last_error
        ack_ids: List[str] = []
        for stream_id, fields in entries:
            if fields.get("eof") == "1":
                eof_reached = True
                ack_ids.append(stream_id)
                continue
            key = fields.get("key", "")
            try:
                size = int(fields.get("size") or 0)
            except ValueError:
                size = 0
            if not key:
                ack_ids.append(stream_id)
                continue
            rel = relative_key_under_prefix(prefix, key)
            dest_key = f"{out_prefix}/{rel}" if out_prefix else rel
            dest_key = "/".join(p for p in dest_key.split("/") if p)
            t0 = time.time()
            try:
                if use_server_side:
                    copy_object_with_backoff(
                        int_s3, out_bucket, dest_key,
                        {"Bucket": bucket, "Key": key},
                        label=f"AcquireBatch:{set_id}",
                    )
                else:
                    dest_path = _posix_path(dest_key)
                    dest_path.parent.mkdir(parents=True, exist_ok=True)
                    with tempfile.NamedTemporaryFile() as tmp:
                        ext_s3.download_fileobj(bucket, key, tmp)
                        tmp.flush()
                        shutil.copy2(tmp.name, str(dest_path))
                duration_ms = int((time.time() - t0) * 1000)
                copied += 1
                bytes_copied += size
                items_acquired.append({
                    "key": key,
                    "size": size,
                    "destKey": dest_key,
                    "durationMs": duration_ms,
                })
                ack_ids.append(stream_id)
                # Heartbeat carries minimal info -- progress is reported per-unit by the workflow.
                activity.heartbeat(f"copying-{set_id}-{copied}")
            except Exception as exc:
                error_count += 1
                last_error = str(exc)
                logger.warning(
                    "[AcquireBatch] set=%s key=%s copy failed (left pending for reclaim): %s",
                    set_id, key, exc,
                )
                # Don't ack on failure -- another consumer can XAUTOCLAIM it.
        if ack_ids:
            js.ack(ack_ids)

    # Crash recovery first (XAUTOCLAIM idle items from dead consumers).
    try:
        reclaimed = js.claim_pending(consumer, min_idle_ms=reclaim_idle_ms, count=batch_size)
        if reclaimed:
            logger.info(
                "[AcquireBatch] set=%s reclaimed %d pending items from dead consumers",
                set_id, len(reclaimed),
            )
            _process_chunk(reclaimed)
    except Exception as exc:
        logger.warning("[AcquireBatch] reclaim ignored: %s", exc)

    eof_seen_redis_failures = [0]
    last_round_idx = -1

    for round_idx in range(max_batches):
        last_round_idx = round_idx
        entries = js.consume(consumer, count=batch_size, block_ms=_jittered_ms(block_ms))
        if not entries:
            consecutive_empty += 1
            ge = js.get_eof_seen()
            _track_eof_seen_redis_failures(ge, eof_seen_redis_failures)
            if ge is True and consecutive_empty >= empty_reads_limit:
                logger.info(
                    "[AcquireBatch] set=%s exiting after %d empty reads post-EOF",
                    set_id, consecutive_empty,
                )
                break
            continue
        consecutive_empty = 0
        eof_seen_redis_failures[0] = 0
        _process_chunk(entries)
        if eof_reached:
            # Still drain anything else briefly so other consumers don't have
            # to reclaim items we already saw the EOF for.
            tail = js.consume(consumer, count=batch_size, block_ms=_jittered_ms(200))
            if tail:
                _process_chunk(tail)
            break

    final_eof = js.get_eof_seen()
    _track_eof_seen_redis_failures(final_eof, eof_seen_redis_failures)
    if final_eof is not True:
        logger.warning(
            "[AcquireBatch] set=%s exiting on budget without confirmed EOF "
            "(max_batches=%d, last_round=%d, get_eof_seen=%r)",
            set_id, max_batches, last_round_idx, final_eof,
        )

    duration_ms = int((time.time() - started_at) * 1000)
    if not js.increment_state(copied=copied, bytes=bytes_copied, errors=error_count):
        logger.warning("[AcquireBatch] set=%s increment_state failed (Redis)", set_id)

    manifest_key = MANIFEST_KEY_TEMPLATE.format(set_id=set_id)
    full_manifest_key = f"{artifact_prefix}/{manifest_key}" if artifact_prefix else manifest_key
    full_manifest_key = "/".join(p for p in full_manifest_key.split("/") if p)
    manifest_payload = {
        "setId": set_id,
        "consumer": consumer,
        "filesCopied": copied,
        "bytesCopied": bytes_copied,
        "errorCount": error_count,
        "durationMs": duration_ms,
        "items": items_acquired,
        "lastError": last_error,
    }
    _put_json(full_manifest_key, manifest_payload)

    status = "success"
    if error_count > 0 and copied == 0:
        status = "error"

    output_path = f"s3://{out_bucket}/{full_manifest_key}" if out_bucket else full_manifest_key
    result = {
        "setId": set_id,
        "status": status,
        "fileCount": copied,
        "outputPath": output_path,
        "extra": {
            "bytesCopied": bytes_copied,
            "errorCount": error_count,
            "durationMs": duration_ms,
            "consumer": consumer,
        },
    }
    if last_error and status == "error":
        result["error"] = last_error
    log_activity_result(result)
    return result


@activity.defn(name="FinalizeAcquisition")
def finalize_acquisition(input: dict) -> dict:
    """Aggregate per-batch manifests, write acquisition_result.json, write the
    acquisition facet, GC Redis, and DELETE the transient progress entry."""
    log_activity_start(input)
    workflow_id, run_id = _activity_workflow_context()

    project_id = input.get("projectID") or input.get("projectId") or ""
    dataset_id = input.get("datasetID") or input.get("datasetId") or ""
    config_service_url = input.get("configServiceURL") or os.environ.get("CONFIG_SERVICE_URL") or DEFAULT_CONFIG_SERVICE_URL
    workflow_engine_url = input.get("workflowEngineURL") or os.environ.get("WORKFLOW_ENGINE_URL") or ""
    scatter_error = bool(input.get("scatterError"))
    started_at_iso = input.get("startedAt") or ""
    consumer_count = int(input.get("consumerCount") or 0)
    files_discovered = int(input.get("filesDiscovered") or 0)
    files_filtered = int(input.get("filesFiltered") or 0)
    source_endpoint = input.get("sourceEndpoint") or ""
    source_bucket = input.get("sourceBucket") or ""
    source_prefix = input.get("sourcePrefix") or ""

    _dest_bucket, _data_files_prefix = resolve_acquisition_dest(input)
    artifact_prefix = acquisition_artifact_key_prefix(input)
    manifests_prefix = f"{artifact_prefix}/_acquisition/manifests/" if artifact_prefix else "_acquisition/manifests/"

    manifest_keys = _list_manifest_keys(manifests_prefix)

    files_copied = 0
    total_bytes = 0
    error_count = 0
    consumer_count_seen = 0
    duration_ms_max = 0
    per_unit: List[Dict[str, Any]] = []
    all_files: List[Dict[str, Any]] = []
    for key in manifest_keys:
        manifest = _read_json(key)
        if not manifest:
            continue
        files_copied += int(manifest.get("filesCopied") or 0)
        total_bytes += int(manifest.get("bytesCopied") or 0)
        error_count += int(manifest.get("errorCount") or 0)
        consumer_count_seen += 1
        duration_ms_max = max(duration_ms_max, int(manifest.get("durationMs") or 0))
        per_unit.append({
            "setId": manifest.get("setId"),
            "filesCopied": int(manifest.get("filesCopied") or 0),
            "bytesCopied": int(manifest.get("bytesCopied") or 0),
            "errorCount": int(manifest.get("errorCount") or 0),
            "durationMs": int(manifest.get("durationMs") or 0),
        })
        for item in manifest.get("items") or []:
            dk = item.get("destKey") or item.get("dest_key")
            if not dk:
                continue
            try:
                sz = int(item.get("size") or 0)
            except (TypeError, ValueError):
                sz = 0
            all_files.append({"key": dk, "size": sz})
    if consumer_count == 0:
        consumer_count = consumer_count_seen

    filelist_key = f"{artifact_prefix}/_acquisition/filelist.json" if artifact_prefix else "_acquisition/filelist.json"
    filelist_key = "/".join(p for p in filelist_key.split("/") if p)
    try:
        _put_json(filelist_key, {
            "files": all_files,
            "totalFiles": len(all_files),
            "source": "objectstore",
        })
    except Exception as exc:
        logger.warning("[FinalizeAcquisition] failed to write filelist %s: %s", filelist_key, exc)

    duration_sec = round(duration_ms_max / 1000.0, 2) if duration_ms_max else 0.0
    throughput_mbps = 0.0
    if duration_sec > 0:
        throughput_mbps = round((total_bytes / duration_sec) / (1024 * 1024), 2)

    completed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    summary: Dict[str, Any] = {
        "filesDiscovered": files_discovered,
        "filesFiltered": files_filtered,
        "filesCopied": files_copied,
        "totalBytes": total_bytes,
        "errorCount": error_count,
        "consumerCount": consumer_count,
        "durationSec": duration_sec,
        "throughputMBps": throughput_mbps,
        "sourceEndpoint": source_endpoint,
        "sourceBucket": source_bucket,
        "sourcePrefix": source_prefix,
        "completedAt": completed_at,
        "startedAt": started_at_iso,
    }

    result_key = f"{artifact_prefix}/{RESULT_KEY}" if artifact_prefix else RESULT_KEY
    result_key = "/".join(p for p in result_key.split("/") if p)
    try:
        _put_json(result_key, {**summary, "perUnit": per_unit, "scatterError": scatter_error})
    except Exception as exc:
        logger.warning("[FinalizeAcquisition] failed to write %s: %s", result_key, exc)

    if scatter_error:
        facet_state = "failed"
    elif error_count > 0:
        facet_state = "errored"
    else:
        facet_state = "ready"

    if project_id and dataset_id and config_service_url:
        try:
            _put_facet(
                config_service_url, project_id, dataset_id,
                state=facet_state, job_id=None, summary=summary,
            )
        except Exception as exc:
            logger.warning("[FinalizeAcquisition] facet update failed: %s", exc)

    if workflow_engine_url and workflow_id:
        try:
            _delete_progress(workflow_engine_url, workflow_id)
        except Exception as exc:
            logger.debug("[FinalizeAcquisition] DELETE progress ignored: %s", exc)

    if workflow_id and run_id:
        try:
            js = build_job_stream(workflow_id, run_id)
            js.destroy()
        except Exception as exc:
            logger.debug("[FinalizeAcquisition] JobStream.destroy ignored: %s", exc)

    out = {
        "filesCopied": files_copied,
        "totalBytes": total_bytes,
        "errorCount": error_count,
        "consumerCount": consumer_count,
        "durationSec": duration_sec,
        "throughputMBps": throughput_mbps,
        "facetState": facet_state,
        "resultKey": result_key,
        "fileListKey": filelist_key,
    }
    log_activity_result(out)
    return out


@activity.defn(name="CleanupAcquisitionStream")
def cleanup_acquisition_stream(input: dict) -> dict:
    """Lightweight tear-down used by data_acquisition.go's workflow.Go cancel handler.

    Honors workflow_id/run_id passed in input (the cleanup goroutine runs in
    a disconnected context where activity.info() may not have a useful workflow context).
    """
    log_activity_start(input)
    workflow_id = input.get("workflowId") or input.get("workflow_id") or ""
    run_id = input.get("runId") or input.get("run_id") or ""
    if not workflow_id or not run_id:
        # Fall back to activity context if caller omitted them.
        workflow_id, run_id = _activity_workflow_context()
    if not workflow_id or not run_id:
        out = {"destroyed": False, "reason": "missing workflow_id/run_id"}
        log_activity_result(out)
        return out

    try:
        js = build_job_stream(workflow_id, run_id)
        dq = DirQueue(js.client, workflow_id, run_id)
        dq.cleanup()
        js.destroy()
        out = {"destroyed": True, "streamKey": js.stream_key}
    except Exception as exc:
        out = {"destroyed": False, "error": str(exc)}
    log_activity_result(out)
    return out


def _parse_volume_watermark(ts: str) -> Optional[datetime]:
    if not ts or not isinstance(ts, str):
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


def _parse_iso8601(ts: Optional[str]) -> Optional[datetime]:
    """Parse an ISO-8601 string into a timezone-aware datetime (UTC). Returns None on empty/invalid."""
    if not ts or not isinstance(ts, str):
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        return None


@activity.defn(name="RegisterVolumeFiles")
def register_volume_files(input: Dict[str, Any]) -> Dict[str, Any]:
    """Walk mount_path, apply glob filters and mtime watermark, write filelist.json to output bucket."""
    log_activity_start(input)
    mount_path = (input.get("mountPath") or input.get("mount_path") or "").strip()
    out_bucket = (input.get("outputBucket") or input.get("output_bucket") or "").strip()
    artifact_prefix = acquisition_artifact_key_prefix(input)
    file_include = (
        input.get("fileIncludePattern")
        or input.get("file_include_pattern")
        or input.get("fileGlob")
        or input.get("file_glob")
        or ""
    ).strip()
    file_exclude = (input.get("fileExclude") or input.get("file_exclude") or input.get("fileExcludePattern") or input.get("file_exclude_pattern") or "").strip()
    last_mtime_watermark = (input.get("lastMtimeWatermark") or input.get("last_mtime_watermark") or "").strip()
    max_file_size = int(input.get("maxFileSize") or input.get("max_file_size") or 0)
    modified_after_dt = _parse_iso8601(input.get("modifiedAfter") or input.get("modified_after"))

    if not mount_path or not out_bucket:
        out = {"error": "mountPath and outputBucket are required"}
        log_activity_result(out)
        return out

    include_patterns = parse_glob_patterns(file_include)
    exclude_patterns = parse_glob_patterns(file_exclude)
    watermark_dt = _parse_volume_watermark(last_mtime_watermark) if last_mtime_watermark else None

    files: List[Dict[str, Any]] = []
    max_mtime: Optional[datetime] = None

    for root, _dirs, filenames in os.walk(mount_path):
        parts = root.replace("\\", "/").split("/")
        if ".sgwtmp" in parts:
            continue
        for fname in filenames:
            if include_patterns and not matches_any_pattern(fname, include_patterns):
                continue
            if exclude_patterns and matches_any_pattern(fname, exclude_patterns):
                continue
            full = os.path.join(root, fname)
            try:
                st = os.stat(full)
            except OSError as exc:
                logger.debug("stat failed %s: %s", full, exc)
                continue
            if max_file_size > 0 and st.st_size > max_file_size:
                continue
            file_mtime = datetime.fromtimestamp(st.st_mtime, tz=timezone.utc)
            if watermark_dt and file_mtime <= watermark_dt:
                continue
            if modified_after_dt is not None and file_mtime < modified_after_dt:
                continue
            files.append(
                {
                    "local_path": full,
                    "size": int(st.st_size),
                    "lastModified": file_mtime.isoformat(),
                }
            )
            if max_mtime is None or file_mtime > max_mtime:
                max_mtime = file_mtime

    filelist_key = f"{artifact_prefix}/_acquisition/filelist.json" if artifact_prefix else "_acquisition/filelist.json"
    filelist_key = "/".join(p for p in filelist_key.split("/") if p)

    _put_json(filelist_key, {
        "files": files,
        "totalFiles": len(files),
        "source": "volume",
        "mountPath": mount_path,
    })

    result = {
        "fileCount": len(files),
        "fileListKey": filelist_key,
        "maxMtime": max_mtime.isoformat() if max_mtime else "",
    }
    log_activity_result(result)
    return result


_BROWSE_DIR_LIMIT = 200
_BROWSE_FILE_LIMIT = 500
_BROWSE_MAX_ENTRIES = 1000
_BROWSE_SCAN_DEADLINE_S = 10


@activity.defn(name="ListVolumeDirectory")
def list_volume_directory(input: Dict[str, Any]) -> Dict[str, Any]:
    """List the contents of a single directory on a mounted volume.

    Stops scanning as soon as enough entries are collected OR a time
    deadline is hit, whichever comes first.  This avoids timing out on
    directories with millions of files where even iterating the kernel
    dirent stream takes too long.
    """
    log_activity_start(input)
    volume_id = (input.get("volumeId") or "").strip()
    mount_path = (input.get("mountPath") or "").strip()
    sub_path = (input.get("subPath") or "").strip().strip("/")

    if not volume_id and not mount_path:
        out: Dict[str, Any] = {"error": "volumeId or mountPath is required", "entries": [], "mountPath": "", "subPath": sub_path}
        log_activity_result(out)
        return out

    if not mount_path:
        mount_path = f"/mnt/pvcs/{volume_id}"

    target = os.path.join(mount_path, sub_path) if sub_path else mount_path

    if not os.path.isdir(target):
        out = {"error": f"path does not exist or is not a directory: {target}", "entries": [], "mountPath": mount_path, "subPath": sub_path}
        log_activity_result(out)
        return out

    dirs: List[Dict[str, Any]] = []
    files: List[Dict[str, Any]] = []
    scanned = 0
    hit_deadline = False
    deadline = time.monotonic() + _BROWSE_SCAN_DEADLINE_S
    dirs_full = len(dirs) >= _BROWSE_DIR_LIMIT
    files_full = len(files) >= _BROWSE_FILE_LIMIT

    try:
        with os.scandir(target) as it:
            for entry in it:
                if dirs_full and files_full:
                    break

                if scanned % 2000 == 0 and scanned > 0:
                    if time.monotonic() >= deadline:
                        hit_deadline = True
                        break

                if entry.name.startswith(".") or entry.name == ".sgwtmp":
                    continue
                scanned += 1

                try:
                    is_dir = entry.is_dir(follow_symlinks=True)
                except OSError:
                    continue

                if is_dir:
                    if not dirs_full:
                        rel = os.path.join(sub_path, entry.name) if sub_path else entry.name
                        dirs.append({
                            "name": entry.name,
                            "path": rel,
                            "type": "directory",
                            "size": 0,
                            "lastModified": "",
                        })
                        dirs_full = len(dirs) >= _BROWSE_DIR_LIMIT
                else:
                    if not files_full:
                        rel = os.path.join(sub_path, entry.name) if sub_path else entry.name
                        try:
                            st = entry.stat(follow_symlinks=True)
                            files.append({
                                "name": entry.name,
                                "path": rel,
                                "type": "file",
                                "size": int(st.st_size),
                                "lastModified": datetime.fromtimestamp(st.st_mtime, tz=timezone.utc).isoformat(),
                            })
                        except OSError:
                            pass
                        files_full = len(files) >= _BROWSE_FILE_LIMIT
    except PermissionError as exc:
        out = {"error": f"permission denied: {exc}", "entries": [], "mountPath": mount_path, "subPath": sub_path}
        log_activity_result(out)
        return out
    except OSError as exc:
        out = {"error": f"failed to list directory: {exc}", "entries": [], "mountPath": mount_path, "subPath": sub_path}
        log_activity_result(out)
        return out

    dirs.sort(key=lambda e: e["name"].lower())
    files.sort(key=lambda e: e["name"].lower())

    combined = dirs + files
    truncated = dirs_full or files_full or hit_deadline

    result: Dict[str, Any] = {
        "entries": combined,
        "mountPath": mount_path,
        "subPath": sub_path,
        "totalDirCount": len(dirs),
        "totalFileCount": len(files),
        "scannedEntries": scanned,
        "truncated": truncated,
    }
    if hit_deadline:
        logger.info(
            "[ListVolumeDirectory] hit %ds scan deadline after %d entries "
            "(dirs=%d, files=%d) for %s",
            _BROWSE_SCAN_DEADLINE_S, scanned, len(dirs), len(files), target,
        )
    log_activity_result(result)
    return result


# Maximum number of distinct file-type entries returned in scan_result.file_type_stats.
# We keep the top-N by count to avoid unbounded payloads on pathological inputs.
_SCAN_MAX_FILE_TYPES = 50

# How often (in entries) ScanVolume emits a Temporal heartbeat. The Go-side
# HeartbeatTimeout is 2 minutes, so this is conservative enough to avoid
# heartbeat timeouts on slow NFS mounts.
_SCAN_HEARTBEAT_EVERY = 5000


def _scan_max_depth(scan_config: Dict[str, Any]) -> Optional[int]:
    """Translate a ScanConfig into an absolute max depth in directory levels.

    Returns None for unbounded (all_levels) and 0 for 'none' (caller should
    short-circuit before calling). Raises ValueError on invalid input.
    """
    if not scan_config:
        raise ValueError("scan_config is required")
    depth = scan_config.get("scan_depth")
    if depth == "none":
        return 0
    if depth == "all_levels":
        return None
    if depth == "top_2_levels":
        return 2
    if depth == "top_5_levels":
        return 5
    if depth == "custom":
        custom = scan_config.get("custom_depth")
        if not isinstance(custom, int) or custom < 1 or custom > 100:
            raise ValueError(
                "scan_config.custom_depth must be an integer between 1 and 100 when scan_depth='custom'"
            )
        return custom
    raise ValueError(f"unknown scan_depth: {depth!r}")


def _file_type_for(name: str) -> str:
    """Return a normalized lowercase file extension (e.g. '.pdf') or '<noext>'."""
    _, ext = os.path.splitext(name)
    if not ext:
        return "<noext>"
    return ext.lower()


@activity.defn(name="ScanVolume")
def scan_volume(input: Dict[str, Any]) -> Dict[str, Any]:
    """Walk a mounted volume up to the configured depth and produce aggregate stats.

    Returns a dict with the shape expected by config-service `scan_result`:
        {
          "completed_at": iso8601,
          "total_files": int,
          "total_folders": int,
          "total_size_bytes": int,
          "file_type_stats": [ {file_type, count}, ... ],
        }

    On unrecoverable errors, populates "error_message" and returns the partial
    result so the calling workflow can still post a scan_result back to
    config-service.
    """
    log_activity_start(input)

    mount_path = (input.get("mountPath") or "").strip()
    volume_name = (input.get("volumeName") or "").strip()
    data_source_id = (input.get("dataSourceId") or input.get("volumeId") or "").strip()
    scan_config = input.get("scanConfig") or {}

    if not mount_path:
        if not volume_name:
            volume_name = data_source_id
        mount_path = f"/mnt/pvcs/{volume_name}" if volume_name else ""

    if not mount_path or not os.path.isdir(mount_path):
        out: Dict[str, Any] = {
            "completed_at": datetime.now(tz=timezone.utc).isoformat(),
            "error_message": f"mount path does not exist or is not a directory: {mount_path}",
            "total_files": 0,
            "total_folders": 0,
            "total_size_bytes": 0,
            "file_type_stats": [],
        }
        log_activity_result(out)
        return out

    try:
        max_depth = _scan_max_depth(scan_config)
    except ValueError as exc:
        out = {
            "completed_at": datetime.now(tz=timezone.utc).isoformat(),
            "error_message": str(exc),
            "total_files": 0,
            "total_folders": 0,
            "total_size_bytes": 0,
            "file_type_stats": [],
        }
        log_activity_result(out)
        return out

    # `scan_depth='none'` should not normally reach this activity (config-service
    # short-circuits to scan_status='skipped'), but guard defensively.
    if max_depth == 0:
        out = {
            "completed_at": datetime.now(tz=timezone.utc).isoformat(),
            "total_files": 0,
            "total_folders": 0,
            "total_size_bytes": 0,
            "file_type_stats": [],
        }
        log_activity_result(out)
        return out

    total_files = 0
    total_folders = 0
    total_size = 0
    file_type_counts: Dict[str, int] = {}
    processed_entries = 0
    error_message: Optional[str] = None
    base_components = len([p for p in mount_path.split(os.sep) if p])

    def _heartbeat() -> None:
        try:
            activity.heartbeat(
                {
                    "files": total_files,
                    "folders": total_folders,
                    "bytes": total_size,
                }
            )
        except Exception:  # noqa: BLE001 - heartbeat best-effort
            pass

    try:
        for current_root, dirnames, filenames in os.walk(mount_path, followlinks=False):
            # Depth relative to mount_path. mount_path itself is depth 0; its
            # immediate children are depth 1.
            current_components = len([p for p in current_root.split(os.sep) if p])
            depth = current_components - base_components

            # Count subdirectories at the current depth BEFORE optionally
            # pruning traversal, so totals include the boundary directories
            # (the directories that would have been recursed into at
            # depth == max_depth).
            total_folders += len(dirnames)

            if max_depth is not None and depth >= max_depth:
                # At/beyond the configured max depth — stop recursing further.
                dirnames[:] = []
            for fname in filenames:
                if fname.startswith(".") or fname == ".sgwtmp":
                    continue
                processed_entries += 1
                fpath = os.path.join(current_root, fname)
                try:
                    st = os.stat(fpath, follow_symlinks=False)
                except OSError:
                    continue
                if not (st.st_mode & 0o170000) or (st.st_mode & 0o170000) != 0o100000:
                    # Skip non-regular files (sockets, devices, etc.)
                    if (st.st_mode & 0o170000) != 0o100000:
                        continue
                total_files += 1
                total_size += int(st.st_size)
                ftype = _file_type_for(fname)
                file_type_counts[ftype] = file_type_counts.get(ftype, 0) + 1

                if processed_entries % _SCAN_HEARTBEAT_EVERY == 0:
                    _heartbeat()
    except PermissionError as exc:
        error_message = f"permission denied during scan: {exc}"
    except OSError as exc:
        error_message = f"OS error during scan: {exc}"
    except Exception as exc:  # noqa: BLE001 - report any failure to caller
        error_message = f"unexpected error during scan: {exc}"

    file_type_stats = [
        {"file_type": ft, "count": cnt}
        for ft, cnt in sorted(file_type_counts.items(), key=lambda kv: kv[1], reverse=True)[:_SCAN_MAX_FILE_TYPES]
    ]

    result: Dict[str, Any] = {
        "completed_at": datetime.now(tz=timezone.utc).isoformat(),
        "total_files": total_files,
        "total_folders": total_folders,
        "total_size_bytes": total_size,
        "file_type_stats": file_type_stats,
    }
    if error_message:
        result["error_message"] = error_message

    logger.info(
        "[ScanVolume] mountPath=%s depth=%s files=%d folders=%d bytes=%d types=%d",
        mount_path,
        "unbounded" if max_depth is None else max_depth,
        total_files,
        total_folders,
        total_size,
        len(file_type_stats),
    )
    log_activity_result(result)
    return result


def _write_error_entry(
    out_prefix: str,
    worker_id: str,
    dir_path: str,
    entry_path: Optional[str],
    exc: Exception,
) -> None:
    """Append a single error record to a per-worker NDJSON error file."""
    errors_key = f"{out_prefix}/_acquisition/errors/discover-{worker_id}.json"
    errors_key = "/".join(p for p in errors_key.split("/") if p)
    p = _posix_path(errors_key)
    p.parent.mkdir(parents=True, exist_ok=True)
    record = json.dumps({
        "path": entry_path or dir_path,
        "dir": dir_path,
        "error": f"{type(exc).__name__}: {exc}",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }, separators=(",", ":"))
    try:
        with open(p, "a") as f:
            f.write(record + "\n")
    except Exception as write_exc:
        logger.debug("Failed to write error entry to %s: %s", p, write_exc)


@activity.defn(name="DiscoverVolumeFiles")
def discover_volume_files(input: Dict[str, Any]) -> Dict[str, Any]:
    """Parallel BFS volume discovery via shared DirQueue -> items Redis stream.

    M parallel instances share a DirQueue (Redis List) and items stream.
    The first worker to start self-seeds the queue with the root mount path.
    Each worker pops one directory at a time, scans it with os.scandir,
    pushes subdirectories back, and emits file metadata via xadd_batch.
    Workers exit when the queue is drained and no other workers are active.
    EOF is NOT marked by workers -- the Go workflow marks EOF after all
    discovery futures resolve.
    """
    log_activity_start(input)
    workflow_id, run_id = _activity_workflow_context()
    if not workflow_id or not run_id:
        raise RuntimeError("DiscoverVolumeFiles requires a Temporal activity context")

    mount_path = (input.get("mountPath") or input.get("mount_path") or "").strip()
    artifact_prefix = acquisition_artifact_key_prefix(input)
    file_glob = (input.get("fileGlob") or input.get("file_glob") or "").strip()
    file_exclude = (input.get("fileExclude") or input.get("file_exclude") or "").strip()
    last_mtime_watermark = (input.get("lastMtimeWatermark") or input.get("last_mtime_watermark") or "").strip()
    worker_id = str(input.get("workerId") or input.get("worker_id") or "0")

    if not mount_path:
        raise ValueError("DiscoverVolumeFiles: mountPath is required")

    include_patterns = parse_glob_patterns(file_glob)
    exclude_patterns = parse_glob_patterns(file_exclude)
    watermark_dt = _parse_volume_watermark(last_mtime_watermark) if last_mtime_watermark else None

    js = build_job_stream(workflow_id, run_id)
    if not js.ping():
        raise RuntimeError(
            f"DiscoverVolumeFiles: Redis unreachable for stream {js.stream_key}"
        )
    js.ensure_group()

    dq = DirQueue(js.client, workflow_id, run_id)

    if js.client.hsetnx(js.state_key, "initialized", "1"):
        dq.seed([mount_path])
        logger.info(
            "[DiscoverVolumeFiles] worker=%s seeded DirQueue with root=%s",
            worker_id, mount_path,
        )

    startup_jitter = random.uniform(0, 1.0)
    logger.info(
        "[DiscoverVolumeFiles] worker=%s starting BFS: mount=%s stream=%s dirs_key=%s "
        "glob=%r exclude=%r watermark=%r startup_jitter=%.2fs",
        worker_id, mount_path, js.stream_key, dq.dirs_key,
        file_glob, file_exclude, last_mtime_watermark, startup_jitter,
    )
    time.sleep(startup_jitter)

    dirs_scanned = 0
    files_found = 0
    files_filtered = 0
    errors = 0
    empty_pops = 0

    BATCH_FLUSH_SIZE = 5000
    LOG_INTERVAL_DIRS = 100
    GREEDY_MAX_DEPTH = int(os.environ.get("ACQ_DISCOVER_GREEDY_DEPTH", "5"))
    GREEDY_MAX_ENTRIES = int(os.environ.get("ACQ_DISCOVER_GREEDY_ENTRIES", "10000"))
    brpop_base = float(os.environ.get("ACQ_DIRQUEUE_BRPOP_TIMEOUT_SEC", "1.0"))
    brpop_base = max(0.1, brpop_base)

    def _scan_dir_greedy(
        start_path: str,
        batch: List[Dict[str, Any]],
        depth: int,
    ) -> Tuple[int, int, int, int]:
        """Scan a directory and recurse into subdirs up to GREEDY_MAX_DEPTH levels.

        Subdirectories beyond the depth limit (or when the batch is large
        enough) are pushed to the shared DirQueue for other workers.
        Returns (dirs_scanned_local, files_found_local, files_filtered_local, errors_local).
        """
        nonlocal files_found, files_filtered, errors, dirs_scanned

        local_dirs = 0
        local_files = 0
        local_filtered = 0
        local_errors = 0
        child_dirs: List[str] = []

        try:
            for entry in os.scandir(start_path):
                try:
                    if entry.is_dir(follow_symlinks=False):
                        if ".sgwtmp" not in entry.path:
                            child_dirs.append(entry.path)
                    elif entry.is_file(follow_symlinks=False):
                        if include_patterns and not matches_any_pattern(entry.name, include_patterns):
                            files_filtered += 1
                            local_filtered += 1
                            continue
                        if exclude_patterns and matches_any_pattern(entry.name, exclude_patterns):
                            files_filtered += 1
                            local_filtered += 1
                            continue
                        st = entry.stat(follow_symlinks=False)
                        file_mtime = datetime.fromtimestamp(st.st_mtime, tz=timezone.utc)
                        if watermark_dt and file_mtime <= watermark_dt:
                            files_filtered += 1
                            local_filtered += 1
                            continue
                        batch.append({
                            "uri": f"file://{entry.path}",
                            "relative_path": os.path.relpath(entry.path, mount_path),
                            "size": str(st.st_size),
                            "last_modified": file_mtime.isoformat(),
                            "metadata": "",
                        })
                        files_found += 1
                        local_files += 1

                        if len(batch) >= BATCH_FLUSH_SIZE:
                            logger.info(
                                "[DiscoverVolumeFiles] worker=%s flushing mid-scan batch=%d "
                                "dir=%s total_files=%d",
                                worker_id, len(batch), start_path, files_found,
                            )
                            js.xadd_batch(batch)
                            batch.clear()
                            activity.heartbeat(
                                f"worker={worker_id} scanned={dirs_scanned} files={files_found}"
                            )
                except (PermissionError, OSError) as exc:
                    errors += 1
                    local_errors += 1
                    logger.warning(
                        "[DiscoverVolumeFiles] worker=%s entry error in %s: %s: %s",
                        worker_id, start_path, type(exc).__name__, exc,
                    )
                    _write_error_entry(artifact_prefix, worker_id, start_path, entry.path, exc)
        except (PermissionError, OSError) as exc:
            errors += 1
            local_errors += 1
            logger.warning(
                "[DiscoverVolumeFiles] worker=%s scandir error on %s: %s: %s",
                worker_id, start_path, type(exc).__name__, exc,
            )
            _write_error_entry(artifact_prefix, worker_id, start_path, None, exc)

        dirs_scanned += 1
        local_dirs += 1

        # Decide per child: recurse locally or push to shared queue.
        overflow_dirs: List[str] = []
        for child in child_dirs:
            can_recurse = (
                depth + 1 < GREEDY_MAX_DEPTH
                and len(batch) < GREEDY_MAX_ENTRIES
            )
            if can_recurse:
                cd, cf, cfl, ce = _scan_dir_greedy(child, batch, depth + 1)
                local_dirs += cd
                local_files += cf
                local_filtered += cfl
                local_errors += ce
            else:
                overflow_dirs.append(child)

        if overflow_dirs:
            dq.push_dirs(overflow_dirs)

        return local_dirs, local_files, local_filtered, local_errors

    while True:
        if activity.is_cancelled():
            logger.info(
                "[DiscoverVolumeFiles] worker=%s cancelled by workflow "
                "(scanned=%d, found=%d, filtered=%d, errors=%d)",
                worker_id, dirs_scanned, files_found, files_filtered, errors,
            )
            break

        dir_path = dq.pop(timeout_seconds=_jittered_seconds(brpop_base))
        if dir_path is None:
            empty_pops += 1
            activity.heartbeat(
                f"worker={worker_id} idle empty_pops={empty_pops} scanned={dirs_scanned}"
            )
            idle = dq.is_idle()
            if idle:
                logger.info(
                    "[DiscoverVolumeFiles] worker=%s exiting: queue drained and all idle "
                    "(scanned=%d dirs, found=%d files, filtered=%d, errors=%d, empty_pops=%d)",
                    worker_id, dirs_scanned, files_found, files_filtered, errors, empty_pops,
                )
                break
            if empty_pops % 5 == 1:
                logger.info(
                    "[DiscoverVolumeFiles] worker=%s pop returned None but not idle "
                    "(empty_pops=%d, scanned=%d, found=%d) -- other workers still active, waiting",
                    worker_id, empty_pops, dirs_scanned, files_found,
                )
            continue

        empty_pops = 0
        batch: List[Dict[str, Any]] = []
        try:
            iter_dirs, iter_files, _, _ = _scan_dir_greedy(dir_path, batch, depth=0)
        finally:
            dq.done_one()

        if batch:
            js.xadd_batch(batch)

        if dirs_scanned <= 3 or dirs_scanned % LOG_INTERVAL_DIRS == 0:
            logger.info(
                "[DiscoverVolumeFiles] worker=%s progress: scanned=%d dirs, found=%d files, "
                "filtered=%d, errors=%d, last_root=%s (iter_dirs=%d, iter_files=%d)",
                worker_id, dirs_scanned, files_found, files_filtered, errors,
                dir_path, iter_dirs, iter_files,
            )
        activity.heartbeat(
            f"worker={worker_id} scanned={dirs_scanned} files={files_found}"
        )

    result: Dict[str, Any] = {
        "totalDiscovered": files_found,
        "filesFiltered": files_filtered,
        "dirsScanned": dirs_scanned,
        "errors": errors,
        "workerId": worker_id,
    }
    if not js.increment_state(
        dirs_scanned=dirs_scanned,
        files_filtered=files_filtered,
        errors=errors,
    ):
        result["redisStateSyncFailed"] = True
    log_activity_result(result)
    return result


@activity.defn(name="MarkStreamEOF")
def mark_stream_eof(input: Dict[str, Any]) -> Dict[str, Any]:
    """Lightweight activity that marks EOF on the items stream.

    Called by the Go workflow after all discovery futures resolve, ensuring
    RegisterBatch consumers eventually drain and exit.
    """
    log_activity_start(input)
    workflow_id, run_id = _activity_workflow_context()
    if not workflow_id or not run_id:
        raise RuntimeError("MarkStreamEOF requires a Temporal activity context")

    js = build_job_stream(workflow_id, run_id)
    pre_stats = js.stats()
    state = js.get_state()
    logger.info(
        "[MarkStreamEOF] marking EOF on stream=%s pre_stats=%s state=%s",
        js.stream_key, pre_stats, state,
    )
    js.mark_eof()
    logger.info("[MarkStreamEOF] EOF marked on stream=%s", js.stream_key)

    result = {"streamKey": js.stream_key, "eof": True}
    log_activity_result(result)
    return result


@activity.defn(name="RegisterBatch")
def register_batch(input: Dict[str, Any]) -> Dict[str, Any]:
    """Source-agnostic Redis stream consumer -> Parquet partition writer.

    Reads from the items stream via XREADGROUP and writes file metadata
    to a Parquet partition. Zero-copy: no data is read or copied.
    Drains until EOF -- does NOT exit on empty reads before EOF.
    """
    log_activity_start(input)
    workflow_id, run_id = _activity_workflow_context()
    if not workflow_id or not run_id:
        raise RuntimeError("RegisterBatch requires a Temporal activity context")

    set_id = input.get("setId") or input.get("set_id") or "reg-s0"
    artifact_prefix = acquisition_artifact_key_prefix(input)

    batch_size = int(os.environ.get("ACQ_BATCH_SIZE", str(DEFAULT_BATCH_SIZE)))
    block_ms = int(os.environ.get("ACQ_BLOCK_MS", str(DEFAULT_BLOCK_MS)))
    reclaim_idle_ms = int(os.environ.get("ACQ_RECLAIM_IDLE_MS", str(DEFAULT_RECLAIM_IDLE_MS)))
    empty_reads_limit = int(os.environ.get("ACQ_EMPTY_READS_AFTER_EOF", str(DEFAULT_EMPTY_READS_AFTER_EOF)))

    js = build_job_stream(workflow_id, run_id)
    js.ensure_group()
    consumer = _consumer_name() + f"-{set_id}"

    startup_jitter = random.uniform(0, 0.5)
    logger.info(
        "[RegisterBatch] set=%s consumer=%s stream=%s batch_size=%d block_ms=%d "
        "empty_reads_limit=%d eof_already=%s startup_jitter=%.2fs",
        set_id, consumer, js.stream_key, batch_size, block_ms,
        empty_reads_limit, js.get_eof_seen(), startup_jitter,
    )
    time.sleep(startup_jitter)

    import pyarrow as pa
    import pyarrow.parquet as pq

    schema = pa.schema([
        pa.field("uri", pa.string()),
        pa.field("relative_path", pa.string()),
        pa.field("size", pa.int64()),
        pa.field("last_modified", pa.timestamp("us", tz="UTC")),
        pa.field("metadata", pa.string()),
    ])

    partition_key = (
        f"{artifact_prefix}/_acquisition/partitions/part-{set_id}.parquet"
        if artifact_prefix
        else f"_acquisition/partitions/part-{set_id}.parquet"
    )
    partition_key = "/".join(p for p in partition_key.split("/") if p)
    partition_path = _posix_path(partition_key)
    partition_path.parent.mkdir(parents=True, exist_ok=True)

    ROW_GROUP_SIZE = 100_000
    started_at = time.time()
    file_count = 0
    total_size = 0
    max_mtime = ""
    eof_reached = False
    consecutive_empty = 0
    row_buffer: List[Dict[str, Any]] = []
    writer: Optional[pq.ParquetWriter] = None

    def _flush_rows():
        nonlocal writer, row_buffer
        if not row_buffer:
            return
        uris = []
        rel_paths = []
        sizes = []
        mtimes = []
        metas = []
        for r in row_buffer:
            uris.append(r["uri"])
            rel_paths.append(r["relative_path"])
            sizes.append(r["size"])
            mtimes.append(r["last_modified"])
            metas.append(r["metadata"])

        table = pa.table({
            "uri": pa.array(uris, type=pa.string()),
            "relative_path": pa.array(rel_paths, type=pa.string()),
            "size": pa.array(sizes, type=pa.int64()),
            "last_modified": pa.array(
                [_parse_iso_timestamp(m) for m in mtimes],
                type=pa.timestamp("us", tz="UTC"),
            ),
            "metadata": pa.array(metas, type=pa.string()),
        })
        if writer is None:
            writer = pq.ParquetWriter(str(partition_path), schema)
        writer.write_table(table)
        row_buffer.clear()

    def _process_entries(entries: List[Tuple[str, Dict[str, str]]]) -> None:
        nonlocal file_count, total_size, max_mtime, eof_reached
        ack_ids: List[str] = []
        for stream_id, fields in entries:
            if fields.get("eof") == "1":
                eof_reached = True
                ack_ids.append(stream_id)
                continue
            uri = fields.get("uri", "")
            if not uri:
                ack_ids.append(stream_id)
                continue
            try:
                size = int(fields.get("size") or 0)
            except ValueError:
                size = 0
            last_modified = fields.get("last_modified", "")
            if last_modified and (not max_mtime or last_modified > max_mtime):
                max_mtime = last_modified

            row_buffer.append({
                "uri": uri,
                "relative_path": fields.get("relative_path", ""),
                "size": size,
                "last_modified": last_modified,
                "metadata": fields.get("metadata", ""),
            })
            file_count += 1
            total_size += size
            ack_ids.append(stream_id)

            if len(row_buffer) >= ROW_GROUP_SIZE:
                _flush_rows()

        if ack_ids:
            js.ack(ack_ids)

    try:
        reclaimed = js.claim_pending(consumer, min_idle_ms=reclaim_idle_ms, count=batch_size)
        if reclaimed:
            logger.info(
                "[RegisterBatch] set=%s reclaimed %d pending items",
                set_id, len(reclaimed),
            )
            _process_entries(reclaimed)
    except Exception as exc:
        logger.warning("[RegisterBatch] reclaim ignored: %s", exc)

    consume_rounds = 0
    LOG_INTERVAL_ROUNDS = 50
    eof_seen_redis_failures = [0]

    while True:
        if activity.is_cancelled():
            logger.info(
                "[RegisterBatch] set=%s cancelled by workflow "
                "(rounds=%d, registered=%d files, %d bytes)",
                set_id, consume_rounds, file_count, total_size,
            )
            break

        consume_rounds += 1
        entries = js.consume(consumer, count=batch_size, block_ms=_jittered_ms(block_ms))
        if not entries:
            consecutive_empty += 1
            activity.heartbeat(f"registering-{set_id}-{file_count}")
            ge = js.get_eof_seen()
            _track_eof_seen_redis_failures(ge, eof_seen_redis_failures)
            if ge is True and consecutive_empty >= empty_reads_limit:
                logger.info(
                    "[RegisterBatch] set=%s exiting after %d empty reads post-EOF "
                    "(rounds=%d, registered=%d files, %d bytes)",
                    set_id, consecutive_empty, consume_rounds, file_count, total_size,
                )
                break
            if consecutive_empty % 10 == 1:
                stream_stats = js.stats()
                logger.info(
                    "[RegisterBatch] set=%s empty read #%d (eof=%s, round=%d, "
                    "registered=%d files) stream_stats=%s",
                    set_id, consecutive_empty, ge, consume_rounds,
                    file_count, stream_stats,
                )
            continue
        if consecutive_empty > 0:
            logger.info(
                "[RegisterBatch] set=%s resumed after %d empty reads, got %d entries",
                set_id, consecutive_empty, len(entries),
            )
        consecutive_empty = 0
        eof_seen_redis_failures[0] = 0
        _process_entries(entries)
        activity.heartbeat(f"registering-{set_id}-{file_count}")
        if consume_rounds <= 3 or consume_rounds % LOG_INTERVAL_ROUNDS == 0:
            logger.info(
                "[RegisterBatch] set=%s progress: round=%d registered=%d files "
                "(%d bytes) eof_reached=%s",
                set_id, consume_rounds, file_count, total_size, eof_reached,
            )
        if eof_reached:
            logger.info(
                "[RegisterBatch] set=%s EOF sentinel received at round=%d "
                "(registered=%d files), draining tail",
                set_id, consume_rounds, file_count,
            )
            tail = js.consume(consumer, count=batch_size, block_ms=_jittered_ms(200))
            if tail:
                logger.info(
                    "[RegisterBatch] set=%s drained %d tail entries after EOF",
                    set_id, len(tail),
                )
                _process_entries(tail)
            break

    logger.info(
        "[RegisterBatch] set=%s consume loop done: rounds=%d registered=%d files "
        "(%d bytes) eof_reached=%s, flushing Parquet",
        set_id, consume_rounds, file_count, total_size, eof_reached,
    )
    _flush_rows()
    if writer is not None:
        writer.close()
        logger.info(
            "[RegisterBatch] set=%s Parquet written to %s",
            set_id, partition_path,
        )

    duration_ms = int((time.time() - started_at) * 1000)

    manifest_key = (
        f"{artifact_prefix}/_acquisition/manifests/{set_id}.json"
        if artifact_prefix
        else f"_acquisition/manifests/{set_id}.json"
    )
    manifest_key = "/".join(p for p in manifest_key.split("/") if p)
    manifest_payload = {
        "setId": set_id,
        "consumer": consumer,
        "fileCount": file_count,
        "totalSize": total_size,
        "maxMtime": max_mtime,
        "durationMs": duration_ms,
        "partitionKey": partition_key,
    }
    _put_json(manifest_key, manifest_payload)

    result: Dict[str, Any] = {
        "setId": set_id,
        "status": "success",
        "fileCount": file_count,
        "totalSize": total_size,
        "maxMtime": max_mtime,
        "durationMs": duration_ms,
        "partitionKey": partition_key,
    }
    log_activity_result(result)
    return result


@activity.defn(name="FinalizeRegistration")
def finalize_registration(input: Dict[str, Any]) -> Dict[str, Any]:
    """Aggregate per-batch manifests, write manifest.json + errors.json, GC Redis."""
    log_activity_start(input)
    workflow_id, run_id = _activity_workflow_context()

    artifact_prefix = acquisition_artifact_key_prefix(input)
    project_id = input.get("projectID") or input.get("projectId") or ""
    dataset_id = input.get("datasetID") or input.get("datasetId") or ""
    source_type = input.get("sourceType") or "volume"
    config_service_url = input.get("configServiceURL") or os.environ.get("CONFIG_SERVICE_URL") or DEFAULT_CONFIG_SERVICE_URL
    workflow_engine_url = input.get("workflowEngineURL") or os.environ.get("WORKFLOW_ENGINE_URL") or ""
    files_discovered = int(input.get("filesDiscovered") or 0)
    files_filtered = int(input.get("filesFiltered") or 0)
    source_meta = input.get("source") or {}

    manifests_prefix = f"{artifact_prefix}/_acquisition/manifests/" if artifact_prefix else "_acquisition/manifests/"
    manifest_keys = _list_manifest_keys(manifests_prefix)

    total_files = 0
    total_size = 0
    global_max_mtime = ""
    duration_ms_max = 0
    partition_keys: List[str] = []

    for key in manifest_keys:
        manifest = _read_json(key)
        if not manifest:
            continue
        total_files += int(manifest.get("fileCount") or 0)
        total_size += int(manifest.get("totalSize") or 0)
        duration_ms_max = max(duration_ms_max, int(manifest.get("durationMs") or 0))
        mtime = manifest.get("maxMtime") or ""
        if mtime and (not global_max_mtime or mtime > global_max_mtime):
            global_max_mtime = mtime
        pk = manifest.get("partitionKey")
        if pk:
            partition_keys.append(pk)

    errors_prefix = f"{artifact_prefix}/_acquisition/errors/" if artifact_prefix else "_acquisition/errors/"
    errors_dir = _posix_path(errors_prefix)
    all_errors: List[Dict[str, Any]] = []
    if errors_dir.is_dir():
        for err_file in sorted(errors_dir.rglob("*.json")):
            try:
                for line in err_file.read_text().strip().splitlines():
                    line = line.strip()
                    if line:
                        all_errors.append(json.loads(line))
            except Exception as exc:
                logger.debug("Failed to read error file %s: %s", err_file, exc)

    total_errors = len(all_errors)
    errors_key = f"{artifact_prefix}/_acquisition/errors.json" if artifact_prefix else "_acquisition/errors.json"
    errors_key = "/".join(p for p in errors_key.split("/") if p)
    try:
        _put_json(errors_key, {"totalErrors": total_errors, "errors": all_errors})
    except Exception as exc:
        logger.warning("[FinalizeRegistration] failed to write errors.json: %s", exc)

    manifest_json_key = f"{artifact_prefix}/_acquisition/manifest.json" if artifact_prefix else "_acquisition/manifest.json"
    manifest_json_key = "/".join(p for p in manifest_json_key.split("/") if p)
    manifest_data: Dict[str, Any] = {
        "format": "parquet-partitioned",
        "sourceType": source_type,
        "source": source_meta,
        "partitions": partition_keys,
        "totalFiles": total_files,
        "totalSize": total_size,
        "maxMtime": global_max_mtime,
        "filesDiscovered": files_discovered,
        "filesFiltered": files_filtered,
        "totalErrors": total_errors,
        "errorsFile": "errors.json",
    }
    try:
        _put_json(manifest_json_key, manifest_data)
    except Exception as exc:
        logger.warning("[FinalizeRegistration] failed to write manifest.json: %s", exc)

    if total_errors > 0 and total_files == 0:
        facet_state = "failed"
    elif total_errors > 0:
        facet_state = "errored"
    else:
        facet_state = "ready"

    completed_at = datetime.now(timezone.utc).isoformat()
    started_at = input.get("startedAt") or ""
    consumer_count = int(input.get("consumerCount") or 0)

    duration_sec = 0.0
    if started_at:
        try:
            t0 = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
            duration_sec = (datetime.now(timezone.utc) - t0).total_seconds()
        except Exception:
            pass

    summary: Dict[str, Any] = {
        "totalFiles": total_files,
        "totalSize": total_size,
        "totalErrors": total_errors,
        "maxMtime": global_max_mtime,
        "filesDiscovered": files_discovered,
        "filesFiltered": files_filtered,
        "filesCopied": total_files,
        "totalBytes": total_size,
        "errorCount": total_errors,
        "consumerCount": consumer_count,
        "durationSec": duration_sec,
        "completedAt": completed_at,
        "startedAt": started_at,
        "sourceType": source_type,
        "mountPath": source_meta.get("mountPath", ""),
    }
    if project_id and dataset_id and config_service_url:
        try:
            _put_facet(
                config_service_url, project_id, dataset_id,
                state=facet_state, job_id=None, summary=summary,
            )
        except Exception as exc:
            logger.warning("[FinalizeRegistration] facet update failed: %s", exc)

    if workflow_engine_url and workflow_id:
        try:
            _delete_progress(workflow_engine_url, workflow_id)
        except Exception as exc:
            logger.debug("[FinalizeRegistration] DELETE progress ignored: %s", exc)

    if workflow_id and run_id:
        try:
            js = build_job_stream(workflow_id, run_id)
            dq = DirQueue(js.client, workflow_id, run_id)
            dq.cleanup()
            js.destroy()
        except Exception as exc:
            logger.debug("[FinalizeRegistration] cleanup ignored: %s", exc)

    result: Dict[str, Any] = {
        "fileCount": total_files,
        "totalSize": total_size,
        "totalErrors": total_errors,
        "maxMtime": global_max_mtime,
        "facetState": facet_state,
        "manifestKey": manifest_json_key,
    }
    log_activity_result(result)
    return result


def _parse_iso_timestamp(s: str) -> Any:
    """Parse an ISO 8601 timestamp string to a datetime for pyarrow."""
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def _put_facet(
    config_service_url: str,
    project_id: str,
    dataset_id: str,
    *,
    state: str,
    job_id: Optional[str],
    summary: Dict[str, Any],
    error_message: Optional[str] = None,
) -> None:
    """PUT /api/v1/projects/<p>/datasets/<d>/facets/acquisition."""
    base = (config_service_url or "").rstrip("/")
    url = f"{base}/api/v1/projects/{project_id}/datasets/{dataset_id}/facets/acquisition"
    payload: Dict[str, Any] = {"state": state, "summary": summary}
    if job_id is not None:
        payload["jobId"] = job_id
    if error_message:
        payload["errorMessage"] = error_message
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    token = _get_service_account_token()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        url, data=data, headers=headers, method="PUT",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        if resp.status >= 300:
            raise RuntimeError(f"facet PUT returned status {resp.status}")


def _delete_progress(workflow_engine_url: str, workflow_id: str) -> None:
    base = (workflow_engine_url or "").rstrip("/")
    url = f"{base}/api/v1/workflows/{workflow_id}/progress"
    req = urllib.request.Request(url, method="DELETE")
    with urllib.request.urlopen(req, timeout=10) as resp:
        if resp.status >= 400 and resp.status != 404:
            raise RuntimeError(f"DELETE progress returned status {resp.status}")
