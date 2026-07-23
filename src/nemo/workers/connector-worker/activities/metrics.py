"""Metrics acquisition activity: dispatches to the appropriate metrics adapter.

Registered as "AcquireMetrics" on the connector-operations queue.
Called by the Go DataAcquisitionWorkflow's "metrics" branch.
"""
import json
from observability_client_runtime import get_logger
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Dict

from temporalio import activity

from adapters.metric_table_schemas import (
    COLLECTOR_METRIC_CATEGORIES,
    SUPPORTED_METRIC_CATEGORIES,
    normalize_metric_categories,
    valid_metric_categories,
)
from .activity_logging import log_activity_start, log_activity_result
from .s3_helpers import acquisition_artifact_key_prefix

logger = get_logger()


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


_VALID_METRIC_CATEGORIES = {
    provider: valid_metric_categories(provider)
    for provider in SUPPORTED_METRIC_CATEGORIES
}


def _extract_metric_categories(resource_selector: Any) -> set:
    """Pull the set of `category` values out of a resourceSelector list.

    The workflow-engine routes here only when the selector contains category
    entries, but we re-validate fail-closed because this is the boundary that
    actually reads the value.
    """
    if not isinstance(resource_selector, list):
        return set()
    out: set = set()
    for entry in resource_selector:
        if isinstance(entry, dict) and "category" in entry:
            cat = entry.get("category")
            if isinstance(cat, str) and cat:
                out.add(cat)
    return out


@activity.defn(name="AcquireMetrics")
async def acquire_metrics(input: Dict[str, Any]) -> Dict[str, Any]:
    """Acquire metrics from ONTAP, GCP (GCNV), or Azure (ANF) via the appropriate adapter.

    Provider IDs are the unified primary connector IDs (`ontap`, `gcp`); the
    metric-specific connectors were merged into the primary ones, and the
    metric-category selectors in the dataset's resourceSelector decide which
    Counter Manager / Cloud Monitoring streams to fetch.
    """
    log_activity_start(input)

    provider = input.get("provider", "")
    connection_info = input.get("connectionInfo", {})
    watermark = input.get("watermark")
    project_id = input.get("projectID", "")
    dataset_id = input.get("datasetID", "")
    credential_id = input.get("credentialId", "") or connection_info.get("credential_id", "")

    if not provider:
        raise ValueError("provider is required for metrics acquisition")

    # We import the metric collectors lazily so the top-level module stays
    # cheap and so there's no implicit registration in the explorer adapter
    # registry.
    from adapters.ontap_metrics_adapter import OntapMetricsAdapter
    from adapters.gcnv_metrics_adapter import GcnvMetricsAdapter
    from adapters.anf_metrics_adapter import AnfMetricsAdapter

    # Provider IDs are the unified primary connectors. The metric-specific
    # provider IDs (`ontap_metrics` / `gcnv_metrics`) have been removed.
    adapters = {
        "ontap": OntapMetricsAdapter(),
        "gcp": GcnvMetricsAdapter(),
        "azure_cloud": AnfMetricsAdapter(),
    }

    adapter = adapters.get(provider)
    if adapter is None:
        raise ValueError(
            f"AcquireMetrics: unsupported provider '{provider}'. "
            f"Supported providers: {sorted(adapters.keys())}"
        )

    # Fail-closed validation: AcquireMetrics MUST be invoked with a
    # resourceSelector whose entries identify metric categories. The
    # workflow-engine routes here based on the same shape, so a mismatch
    # here means a workflow bug, not user input.
    selector = input.get("resourceSelector")
    selected_categories = normalize_metric_categories(_extract_metric_categories(selector))
    if not selected_categories:
        raise ValueError(
            "AcquireMetrics: resourceSelector must contain at least one "
            "{category: ...} entry; got: %r" % (selector,)
        )
    valid = _VALID_METRIC_CATEGORIES.get(provider, set())
    invalid = selected_categories - valid
    if invalid:
        raise ValueError(
            f"AcquireMetrics: provider '{provider}' does not support metric "
            f"categories {sorted(invalid)}; valid categories are {sorted(valid)}"
        )

    collector_categories = selected_categories & COLLECTOR_METRIC_CATEGORIES.get(provider, set())
    pending_categories = selected_categories - collector_categories
    # Explorer may list categories before collectors exist (e.g. GCNV pool_metrics).
    # Fail fast here rather than calling the adapter or writing placeholder Parquet.
    if pending_categories:
        raise ValueError(
            f"AcquireMetrics: metric categories not implemented yet for provider "
            f"{provider!r}: {sorted(pending_categories)}"
        )

    run_id = activity.info().workflow_run_id[:8] if hasattr(activity.info(), "workflow_run_id") else "local"
    output_dir = os.path.join(tempfile.gettempdir(), "metrics", project_id, dataset_id, run_id)
    os.makedirs(output_dir, exist_ok=True)

    logger.info(
        "[AcquireMetrics] Starting: provider=%s project=%s dataset=%s credential=%s watermark=%s "
        "categories=%s",
        provider, project_id, dataset_id, credential_id, watermark,
        sorted(collector_categories),
    )
    logger.info("[AcquireMetrics] Raw connectionInfo keys: %s", list(connection_info.keys()))

    # Resolve credentials
    config_service_url = input.get("configServiceURL", "")
    if credential_id and config_service_url:
        from .credentials import resolve_credential
        logger.info("[AcquireMetrics] Resolving credential %s from %s", credential_id, config_service_url)
        creds = resolve_credential(config_service_url, project_id, credential_id)
        if creds:
            logger.info("[AcquireMetrics] Credential resolved, keys: %s", list(creds.keys()))
            connection_info = {**connection_info, **creds}
        else:
            logger.warning("[AcquireMetrics] Credential resolution returned empty/None")
    else:
        logger.info("[AcquireMetrics] Skipping credential resolution (credential_id=%s)", credential_id)

    # The unified ONTAP connector stores the cluster endpoint as `cluster_url`,
    # but OntapMetricsAdapter.acquire() expects `host`. Strip the scheme so the
    # adapter can build `https://{host}/api/...` itself.
    if provider == "ontap" and "cluster_url" in connection_info and "host" not in connection_info:
        url = connection_info["cluster_url"]
        if url.startswith("https://"):
            url = url[len("https://"):]
        elif url.startswith("http://"):
            url = url[len("http://"):]
        connection_info["host"] = url
        logger.info("[AcquireMetrics] Mapped cluster_url -> host=%s", url)

    adapter_selector = [{"category": c} for c in sorted(collector_categories)]
    connection_info["resourceSelector"] = adapter_selector
    logger.info("[AcquireMetrics] Passing resourceSelector to adapter: %s", adapter_selector)
    logger.info(
        "[AcquireMetrics] Dispatching to adapter: host=%s verify_tls=%s",
        connection_info.get("host", "?"), connection_info.get("verify_tls", "?"),
    )
    activity.heartbeat("adapter_start")
    # The adapter takes minutes on large fleets (one ONTAP REST call per
    # volume / aggregate, one Cloud Monitoring list_time_series per metric
    # type). Pass `activity.heartbeat` down so the adapter can ping Temporal
    # from inside its loops; otherwise the 60s HeartbeatTimeout fires before
    # the adapter returns and Temporal force-retries the activity.
    result = await adapter.acquire(
        connection_info=connection_info,
        watermark=watermark,
        output_path=output_dir,
        heartbeat=activity.heartbeat,
    )

    # Move Parquet files to the mounted POSIX volume. Heartbeat per file —
    # in a fresh 14-day backfill the volume_metrics parquet can be hundreds
    # of MB, and shutil.move across mounts can take a while.
    activity.heartbeat("store_files")
    out_prefix = f"projects/{project_id}/datasets/{dataset_id}/data"
    stored_files = []

    for filename in os.listdir(output_dir):
        if not filename.endswith(".parquet"):
            continue
        local_path = os.path.join(output_dir, filename)
        dest_key = f"{out_prefix}/{run_id}/{filename}"
        dest_path = _posix_path(dest_key)
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        activity.heartbeat(f"store_files:{filename}")
        shutil.move(local_path, str(dest_path))
        file_size = dest_path.stat().st_size
        stored_files.append({
            "key": dest_key,
            "size": file_size,
            "format": "parquet",
        })
        logger.info("Stored %s -> %s (%d bytes)", filename, dest_path, file_size)

    # Write file list manifest (under dataset artifact root, sibling of data_files/)
    artifact_prefix = acquisition_artifact_key_prefix(input)
    filelist_key = f"{artifact_prefix}/_acquisition/filelist.json"
    filelist_path = _posix_path(filelist_key)
    filelist_path.parent.mkdir(parents=True, exist_ok=True)
    filelist_path.write_text(json.dumps({
        "files": stored_files,
        "totalFiles": len(stored_files),
        "source": "metrics",
        "provider": provider,
    }, separators=(",", ":"), default=str))

    # Clean up temp dir
    shutil.rmtree(output_dir, ignore_errors=True)

    logger.info(
        "Metrics acquisition complete: provider=%s rows=%d files_stored=%d new_watermark=%s",
        provider, result.get("rowCount", 0), len(stored_files), result.get("newWatermarkValue"),
    )

    final_result = {
        "rowCount": result.get("rowCount", 0),
        "filesCopied": float(len(stored_files)),
        "fileListKey": filelist_key,
        "newWatermarkValue": result.get("newWatermarkValue", ""),
    }
    log_activity_result(final_result)
    return final_result
