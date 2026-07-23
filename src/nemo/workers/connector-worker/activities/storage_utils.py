"""Utility activities for dataset path cleanup (e.g. ClearDatasetPath for overwrite mode).

All internal data access uses the locally mounted POSIX volume
(NEMO_DEFAULT_STORE_ROOT).
"""
from observability_client_runtime import get_logger
import os
import shutil
from pathlib import Path

from temporalio import activity

from .activity_logging import log_activity_start, log_activity_result

logger = get_logger()


def _default_store_root() -> str:
    """Return the default app-scoped PVC mount root.  Raises if not configured."""
    p = (os.environ.get("NEMO_DEFAULT_STORE_ROOT") or "").strip()
    if not p:
        raise RuntimeError(
            "NEMO_DEFAULT_STORE_ROOT is not set. The worker requires a locally "
            "mounted POSIX volume for all data access."
        )
    return p


@activity.defn(name="ClearDatasetPath")
def clear_dataset_path(input: dict) -> dict:
    log_activity_start(input)
    raw = (
        (input.get("outputPath") or input.get("output_path") or "").strip()
        or (input.get("s3Path") or input.get("s3_path") or "").strip()
    )
    if not raw:
        raise ValueError("outputPath (or legacy s3Path) is required")
    if raw.startswith("s3://"):
        parts = raw.replace("s3://", "").split("/", 1)
        prefix = parts[1] if len(parts) > 1 else ""
    else:
        prefix = raw.strip("/")

    mount = _default_store_root()
    target = Path(mount) / prefix
    deleted = 0
    if target.is_dir():
        for f in target.rglob("*"):
            if f.is_file():
                f.unlink()
                deleted += 1
        shutil.rmtree(target, ignore_errors=True)
    result = {"deletedCount": deleted}
    log_activity_result(result)
    logger.info("Cleared %s files from %s", deleted, target)
    return result
