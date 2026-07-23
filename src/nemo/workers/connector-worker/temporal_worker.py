"""Temporal activity worker for connector operations."""
import asyncio
import os
import signal
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

from observability_client_runtime import get_logger
from temporalio import activity
from temporalio.client import Client
from temporalio.worker import Worker

from activities.database import (
    test_database_connection,
    discover_database_schema,
    acquire_from_database,
    preview_database,
)
from activities.objectstore import (
    test_objectstore_connection,
    list_objectstore_files,
    acquire_from_objectstore,
    preview_objectstore,
)
from activities.acquisition_pipeline import (
    discover_object_store_items,
    discover_source_items,
    discover_volume_files,
    acquire_batch,
    finalize_acquisition,
    cleanup_acquisition_stream,
    register_volume_files,
    list_volume_directory,
    scan_volume,
    mark_stream_eof,
    register_batch,
    finalize_registration,
)
from activities.explorer import explorer_action, resolve_resource, test_provider_connection
from activities.cloud_test import test_cloud_connection
from activities.storage_utils import clear_dataset_path
from activities.metrics import acquire_metrics
from activities.redash_acquisition import acquire_from_api
from activities.gcs_acquisition import acquire_from_gcs

# Shared Temporal-readiness helper: avoids the gRPC-channel-up but
# namespace-not-ready race that wedges the Rust core's heartbeat probe.
# See shared/temporal_readiness.py for the failure-mode walkthrough.
from shared.temporal_readiness import start_watchdog, wait_for_temporal


def _graceful_shutdown_timeout() -> timedelta:
    raw = (os.environ.get("TEMPORAL_GRACEFUL_SHUTDOWN_TIMEOUT") or "90s").strip().lower().rstrip("s")
    try:
        return timedelta(seconds=int(raw))
    except ValueError:
        return timedelta(seconds=90)


logger = get_logger()


async def main():
    from observability_client_runtime import configure_observability_minimal
    configure_observability_minimal(
        log_file_path=os.getenv(
            "AGENT_STUDIO_OBSERVABILITY_LOG_FILE_PATH", "../../App_Logs/connector-worker.jsonl"
        ),
        log_level=os.getenv("LOG_LEVEL", "info"),
        otlp_traces_endpoint=os.getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"),
        metrics_service_name=os.getenv("OTEL_SERVICE_NAME", "connector-worker"),
        prometheus_metrics_port=int(p) if (p := os.getenv("AGENT_STUDIO_OBSERVABILITY_PROMETHEUS_METRICS_PORT")) else None,
    )

    temporal_address = os.environ.get("TEMPORAL_ADDRESS", "temporal:7233")
    temporal_namespace = os.environ.get("TEMPORAL_NAMESPACE", "default")
    task_queue = os.environ.get("TASK_QUEUE", "connector-operations")
    # Default 8: tuned for the streaming acquisition pipeline (Phase 1b).
    # Lower in resource-constrained overlays.
    max_concurrent = int(os.environ.get("MAX_CONCURRENT_ACTIVITIES", "8"))

    logger.info(
        "Starting connector worker: address=%s, namespace=%s, queue=%s, max_concurrent=%d",
        temporal_address, temporal_namespace, task_queue, max_concurrent,
    )

    # Gate Worker construction on Temporal namespace describability — see
    # shared/temporal_readiness.py for the rationale. Bare Client.connect
    # returns as soon as the gRPC channel is up, which can be before
    # Temporal's namespace service is loaded; the Rust core's later
    # heartbeat probe then wedges the poller permanently.
    client = await wait_for_temporal(temporal_address, temporal_namespace)

    worker = Worker(
        client,
        task_queue=task_queue,
        graceful_shutdown_timeout=_graceful_shutdown_timeout(),
        activities=[
            test_database_connection,
            discover_database_schema,
            acquire_from_database,
            preview_database,
            test_objectstore_connection,
            list_objectstore_files,
            acquire_from_objectstore,  # Legacy: kept as fallback when ACQ_USE_PIPELINE=false
            preview_objectstore,
            # Streaming acquisition pipeline
            discover_object_store_items,
            discover_source_items,  # backward-compat alias
            discover_volume_files,
            acquire_batch,
            finalize_acquisition,
            cleanup_acquisition_stream,
            clear_dataset_path,
            register_volume_files,
            list_volume_directory,
            scan_volume,
            mark_stream_eof,
            register_batch,
            finalize_registration,
            explorer_action,
            resolve_resource,
            test_provider_connection,
            test_cloud_connection,
            acquire_metrics,
            acquire_from_api,
            acquire_from_gcs,
        ],
        activity_executor=ThreadPoolExecutor(max_workers=max_concurrent),
        max_concurrent_activities=max_concurrent,
    )

    # Crash on persistent post-startup Temporal unreachability so K8s
    # cycles the pod cleanly through wait_for_temporal again on restart.
    start_watchdog(client, temporal_namespace)

    shutdown_event = asyncio.Event()

    def _request_shutdown(sig: signal.Signals) -> None:
        logger.info("Received %s — stopping activity polling and draining in-flight activities...", sig.name)
        shutdown_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _request_shutdown, sig)

    logger.info("Connector worker started, polling for activities...")
    async with worker:
        await shutdown_event.wait()
        logger.info("Initiating graceful shutdown (timeout=%s)...", _graceful_shutdown_timeout())
    logger.info("Connector worker shut down cleanly.")


if __name__ == "__main__":
    asyncio.run(main())
