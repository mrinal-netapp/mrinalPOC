"""Temporal activity worker for dataset processing.

Registers ProcessDatasetFiles, MergeDatasetResults, and ReprocessDatasetPii
activities on the dataset-processing task queue.
"""

import asyncio
import json
import os
import signal
import time
from datetime import timedelta
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, Optional

from observability_client_runtime import bind_context, clear_context, get_logger
from temporalio import activity
from temporalio.client import Client
from temporalio.worker import Worker

from processing.config import Config
from processing.files import process_file_set, merge_results
from processing.pii import reprocess_pii, reprocess_pii_file_set, merge_pii_results
from shared.work_planning import create_work_plan
from shared.temporal_readiness import start_watchdog, wait_for_temporal


def _bind_activity_context(**extra: str) -> None:
    """Bind workflow/activity fields plus optional extras into the observability context.

    Called at the start of each activity so every log line in that activity
    automatically carries workflow_id, activity_id, activity_type, and any
    caller-supplied fields (e.g. dataset_id, set_id).
    """
    try:
        if activity.in_activity():
            info = activity.info()
            bind_context(
                activity_id=info.activity_id or "",
                activity_type=info.activity_type or "",
                workflow_id=info.workflow_id or "",
                **extra,
            )
        elif extra:
            bind_context(**extra)
    except Exception:
        pass


logger = get_logger()

_PROGRESS_POST_INTERVAL_SEC = 5.0


def _graceful_shutdown_timeout() -> timedelta:
    raw = (os.environ.get("TEMPORAL_GRACEFUL_SHUTDOWN_TIMEOUT") or "90s").strip().lower().rstrip("s")
    try:
        return timedelta(seconds=int(raw))
    except ValueError:
        return timedelta(seconds=90)


def _post_workflow_progress(
    workflow_id: str,
    workflow_engine_url: str,
    phase: str,
    percentage: float,
    current: int,
    total: int,
    message: str = "",
    extra: Optional[Dict[str, Any]] = None,
    unit_id: Optional[str] = None,
) -> None:
    """POST progress to the workflow-engine in-memory store for UI polling."""
    url = f"{workflow_engine_url.rstrip('/')}/api/v1/workflows/{workflow_id}/progress"
    payload = {
        "phase": phase,
        "percentage": percentage,
        "current": current,
        "total": total,
        "message": message or (f"{phase}: {current}/{total}" if total else phase),
        "extra": extra or {},
    }
    if unit_id:
        payload["unitId"] = unit_id
    try:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            url, data=data, headers={"Content-Type": "application/json"}, method="POST"
        )
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:
        logger.debug("Failed to POST progress to workflow-engine: %s", e)


class _WorkflowProgressReporter:
    """Throttled progress reporter that POSTs to the workflow-engine for live UI updates."""

    def __init__(
        self,
        workflow_id: str,
        workflow_engine_url: Optional[str] = None,
        unit_id: Optional[str] = None,
    ):
        self.workflow_id = workflow_id
        self.url = (workflow_engine_url or os.environ.get("WORKFLOW_ENGINE_URL") or "").strip()
        self.unit_id = unit_id or ""
        self._last_post_time = 0.0

    def post(
        self,
        phase: str,
        percentage: float,
        current: int,
        total: int,
        message: str = "",
        extra: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not self.url:
            return
        now = time.monotonic()
        if now - self._last_post_time < _PROGRESS_POST_INTERVAL_SEC:
            return
        self._last_post_time = now
        _post_workflow_progress(
            self.workflow_id,
            self.url,
            phase=phase,
            percentage=percentage,
            current=current,
            total=total,
            message=message,
            extra=extra,
            unit_id=self.unit_id or None,
        )


def _dataset_overall_percentage(phase: str, phase_pct: float) -> float:
    """Map dataset import phase + phase percentage to overall 0-100%."""
    if phase == "processing":
        return min(5.0 + 75.0 * (phase_pct / 100.0), 80.0)
    if phase == "writing_parquet":
        return 82.0
    if phase in ("aggregating", "merging"):
        return min(85.0 + 10.0 * (phase_pct / 100.0), 95.0)
    return min(phase_pct, 99.0)


@activity.defn(name="ProcessDatasetFiles")
def process_dataset_files(input: dict) -> dict:
    dataset_id = input.get("dataset_id", "?")
    set_id = input.get("set_id", "?")
    _bind_activity_context(dataset_id=dataset_id, set_id=set_id)
    logger.info(
        "Activity ProcessDatasetFiles started: dataset_id=%s set_id=%s manifest_s3_key=%s",
        dataset_id, set_id, input.get("manifest_s3_key", ""),
    )
    config = Config.from_dict(input)
    config.validate()
    activity.heartbeat("initializing")

    workflow_id = input.get("workflow_id") or ""
    set_id = input.get("set_id", "s0")
    reporter = (
        _WorkflowProgressReporter(workflow_id, unit_id=set_id) if workflow_id else None
    )

    def workflow_progress_callback(phase: str, phase_pct: float, current: int, total: int, extra: Dict[str, Any]) -> None:
        if not reporter or not reporter.url:
            return
        overall = _dataset_overall_percentage(phase, phase_pct)
        reporter.post(phase, overall, current, total, extra=extra)

    return process_file_set(
        config,
        heartbeat_callback=activity.heartbeat,
        workflow_progress_callback=workflow_progress_callback,
    )


@activity.defn(name="MergeDatasetResults")
def merge_dataset_results(input: dict) -> dict:
    dataset_id = input.get("dataset_id", "?")
    _bind_activity_context(dataset_id=dataset_id, phase="merge")
    logger.info(
        "Activity MergeDatasetResults started: dataset_id=%s job_output_prefix=%s",
        dataset_id, input.get("job_output_prefix", ""),
    )
    config = Config.from_dict(input)
    activity.heartbeat("merging")

    workflow_id = input.get("workflow_id") or ""
    reporter = _WorkflowProgressReporter(workflow_id) if workflow_id else None

    def workflow_progress_callback(phase: str, phase_pct: float, current: int, total: int, extra: Dict[str, Any]) -> None:
        if not reporter or not reporter.url:
            return
        overall = _dataset_overall_percentage(phase, phase_pct)
        reporter.post(phase, overall, current, total, extra=extra)

    return merge_results(
        config,
        heartbeat_callback=activity.heartbeat,
        workflow_progress_callback=workflow_progress_callback,
    )


@activity.defn(name="ReprocessDatasetPii")
def reprocess_dataset_pii(input: dict) -> dict:
    dataset_id = input.get("dataset_id", "?")
    _bind_activity_context(dataset_id=dataset_id, phase="reprocess-pii")
    logger.info("Activity ReprocessDatasetPii started: dataset_id=%s", dataset_id)
    config = Config.from_dict(input)
    activity.heartbeat("reprocessing-pii")

    workflow_id = input.get("workflow_id") or ""
    reporter = _WorkflowProgressReporter(workflow_id) if workflow_id else None

    def workflow_progress_callback(phase: str, phase_pct: float, current: int, total: int, extra: Dict[str, Any]) -> None:
        if not reporter or not reporter.url:
            return
        reporter.post(phase, phase_pct, current, total, extra=extra or {})

    return reprocess_pii(
        config,
        heartbeat_callback=activity.heartbeat,
        workflow_progress_callback=workflow_progress_callback,
    )


@activity.defn(name="ReprocessPiiFiles")
def reprocess_pii_files(input: dict) -> dict:
    dataset_id = input.get("dataset_id", "?")
    set_id = input.get("set_id", "?")
    _bind_activity_context(dataset_id=dataset_id, set_id=set_id)
    logger.info(
        "Activity ReprocessPiiFiles started: dataset_id=%s set_id=%s",
        dataset_id, set_id,
    )
    config = Config.from_dict(input)
    activity.heartbeat("starting-pii-reprocess")

    return reprocess_pii_file_set(
        config,
        heartbeat_callback=activity.heartbeat,
    )


@activity.defn(name="MergePiiResults")
def merge_pii_results_activity(input: dict) -> dict:
    dataset_id = input.get("dataset_id", "?")
    _bind_activity_context(dataset_id=dataset_id, phase="merge-pii")
    logger.info(
        "Activity MergePiiResults started: dataset_id=%s job_output_prefix=%s",
        dataset_id, input.get("job_output_prefix", ""),
    )
    config = Config.from_dict(input)
    activity.heartbeat("merging-pii")

    return merge_pii_results(
        config,
        heartbeat_callback=activity.heartbeat,
    )


def _warmup_pii_models():
    """Preload PII/ML models at worker startup so they are cached once and not re-downloaded per task."""
    logger.info("Warming up PII and sensitivity models (load once at startup)...")
    try:
        from analyzers.pii import _get_analyzer
        _get_analyzer()
        logger.info("PII text analyzer (Presidio/GLiNER) warmed up")
    except Exception as e:
        logger.warning("PII text analyzer warmup failed (non-fatal): %s", e)
    try:
        from analyzers.image_pii import _get_ocr_engine
        _get_ocr_engine()
        logger.info("PII image analyzer warmed up")
    except Exception as e:
        logger.debug("PII image analyzer warmup skipped: %s", e)
    try:
        from analyzers.sensitivity import _get_classifier
        _get_classifier()
        logger.info("Sensitivity classifier (CLIP) warmed up")
    except Exception as e:
        logger.debug("Sensitivity classifier warmup skipped: %s", e)
    logger.info("Model warmup complete; models will be reused for all tasks.")


async def main():
    from observability_client_runtime import configure_observability_minimal
    configure_observability_minimal(
        log_file_path=os.getenv(
            "AGENT_STUDIO_OBSERVABILITY_LOG_FILE_PATH", "../../App_Logs/dataset-processor.jsonl"
        ),
        log_level=os.getenv("LOG_LEVEL", "info"),
        otlp_traces_endpoint=os.getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"),
        metrics_service_name=os.getenv("OTEL_SERVICE_NAME", "dataset-processor"),
        prometheus_metrics_port=int(p) if (p := os.getenv("AGENT_STUDIO_OBSERVABILITY_PROMETHEUS_METRICS_PORT")) else None,
    )

    temporal_address = os.environ.get("TEMPORAL_ADDRESS", "temporal:7233")
    temporal_namespace = os.environ.get("TEMPORAL_NAMESPACE", "default")
    task_queue = os.environ.get("TASK_QUEUE", "dataset-processing")
    max_concurrent = int(os.environ.get("MAX_CONCURRENT_ACTIVITIES", "2"))

    logger.info(
        "Starting dataset worker: address=%s, namespace=%s, queue=%s, max_concurrent=%d",
        temporal_address, temporal_namespace, task_queue, max_concurrent,
    )

    _warmup_pii_models()

    # See shared/temporal_readiness.py for why this replaces a bare
    # Client.connect — the Rust core's heartbeat probe races namespace
    # startup, leaving the worker dead-alive with zero pollers in
    # Temporal. Verified on sks6316.
    client = await wait_for_temporal(temporal_address, temporal_namespace)

    worker = Worker(
        client,
        task_queue=task_queue,
        graceful_shutdown_timeout=_graceful_shutdown_timeout(),
        activities=[process_dataset_files, merge_dataset_results, reprocess_dataset_pii, reprocess_pii_files, merge_pii_results_activity, create_work_plan],
        activity_executor=ThreadPoolExecutor(max_workers=max_concurrent),
        max_concurrent_activities=max_concurrent,
    )

    # Crash on persistent post-startup Temporal unreachability so K8s
    # restart cycles the pod cleanly through wait_for_temporal again.
    start_watchdog(client, temporal_namespace)

    shutdown_event = asyncio.Event()

    def _request_shutdown(sig: signal.Signals) -> None:
        logger.info("Received %s — stopping activity polling and draining in-flight activities...", sig.name)
        shutdown_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _request_shutdown, sig)

    logger.info(f"Worker listening on queue: {task_queue}")
    async with worker:
        await shutdown_event.wait()
        logger.info("Initiating graceful shutdown (timeout=%s)...", _graceful_shutdown_timeout())
    logger.info("Dataset worker shut down cleanly.")


if __name__ == "__main__":
    asyncio.run(main())
