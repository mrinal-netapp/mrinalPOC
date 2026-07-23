"""POST progress to the workflow-engine for live UI updates during long-running activities."""
import json
from observability_client_runtime import get_logger
import os
import time
import urllib.request
from typing import Any, Dict, Optional

logger = get_logger()

_PROGRESS_POST_INTERVAL_SEC = 5.0


def post_progress(
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
    """POST progress to the workflow-engine in-memory store.

    When unit_id is provided, the workflow-engine ProgressStore records the post
    against that unit slot (per-consumer/per-set), avoiding clobber of the
    aggregated job-level percentage.
    """
    if not workflow_id or not workflow_engine_url:
        return
    url = f"{workflow_engine_url.rstrip('/')}/api/v1/workflows/{workflow_id}/progress"
    payload: Dict[str, Any] = {
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
        logger.debug("Failed to POST progress: %s", e)


class WorkflowProgressReporter:
    """Throttled progress reporter for the workflow-engine progress API.

    Optional unit_id lets a single Python activity report progress against a
    specific unit slot (mirrors the kb-processor pattern). If unit_id is
    omitted, the post is treated as job-level by the ProgressStore.
    """

    def __init__(
        self,
        workflow_id: str,
        workflow_engine_url: Optional[str] = None,
        unit_id: Optional[str] = None,
    ):
        self.workflow_id = workflow_id or ""
        self.url = (workflow_engine_url or os.environ.get("WORKFLOW_ENGINE_URL") or "").strip()
        self.unit_id = unit_id or ""
        self._last_post = 0.0

    def post(
        self,
        phase: str,
        percentage: float,
        current: int,
        total: int,
        message: str = "",
        extra: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not self.workflow_id or not self.url:
            return
        now = time.monotonic()
        force = bool((extra or {}).get("_force"))
        if not force and now - self._last_post < _PROGRESS_POST_INTERVAL_SEC:
            return
        self._last_post = now
        clean_extra = {k: v for k, v in (extra or {}).items() if k != "_force"} or None
        post_progress(
            self.workflow_id, self.url,
            phase=phase, percentage=percentage, current=current, total=total,
            message=message, extra=clean_extra,
            unit_id=self.unit_id or None,
        )
