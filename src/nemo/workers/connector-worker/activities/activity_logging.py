"""Structured logging for connector activities: workflow/activity context, request, and result."""
from observability_client_runtime import get_logger
from typing import Any, Dict, Optional

from observability_client_runtime import bind_context, clear_context
from temporalio import activity

logger = get_logger()

# Keys (at any level) whose values should be redacted in logs
_SECRET_KEYS = frozenset({
    "password", "secret", "token", "credentials", "secret_access_key",
    "aws_secret_access_key", "service_account_json", "access_key_id",
    "aws_access_key_id",
})


def _sanitize_value(key: str, value: Any) -> Any:
    key_lower = key.lower()
    if any(secret in key_lower for secret in _SECRET_KEYS):
        return "***"
    return value


def sanitize_for_log(obj: Any) -> Any:
    """Return a copy of obj safe for logging (redact secret-like keys)."""
    if obj is None or isinstance(obj, (bool, int, float)):
        return obj
    if isinstance(obj, str):
        return obj
    if isinstance(obj, dict):
        return {k: _sanitize_value(k, sanitize_for_log(v)) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [sanitize_for_log(x) for x in obj]
    return str(type(obj).__name__)


def get_activity_context() -> Dict[str, str]:
    """Return current activity context from Temporal (workflow_id, run_id, activity_type, etc.)."""
    try:
        info = activity.info()
        return {
            "workflow_id": info.workflow_id or "",
            "workflow_run_id": info.workflow_run_id or "",
            "activity_id": info.activity_id or "",
            "activity_type": info.activity_type or "",
        }
    except Exception:
        return {}


def log_activity_start(input_payload: dict) -> None:
    """Log that an activity has started, with workflow context and sanitized input.

    Also binds workflow/activity fields into the observability context so every
    subsequent log call within this activity automatically carries them.
    """
    ctx = get_activity_context()
    clear_context()
    bind_context(
        workflow_id=ctx.get("workflow_id", ""),
        activity_id=ctx.get("activity_id", ""),
        activity_type=ctx.get("activity_type", ""),
    )
    safe_input = sanitize_for_log(input_payload)
    logger.info(
        "Activity started | workflow_id=%s run_id=%s activity_type=%s activity_id=%s | request=%s",
        ctx.get("workflow_id"),
        ctx.get("workflow_run_id"),
        ctx.get("activity_type"),
        ctx.get("activity_id"),
        safe_input,
    )


def log_activity_result(result: Any, error: Optional[Exception] = None) -> None:
    """Log activity completion with result summary or error. Clears observability context."""
    ctx = get_activity_context()
    if error is not None:
        logger.warning(
            "Activity failed | workflow_id=%s run_id=%s activity_type=%s | error=%s",
            ctx.get("workflow_id"),
            ctx.get("workflow_run_id"),
            ctx.get("activity_type"),
            str(error),
        )
        clear_context()
        return
    # Result summary: avoid dumping huge payloads
    summary: Any = result
    if isinstance(result, dict):
        summary = {k: v for k, v in result.items() if k not in ("rows", "columns", "files", "schemas")}
        if "rows" in result and isinstance(result["rows"], list):
            summary["rowCount"] = len(result["rows"])
        if "files" in result and isinstance(result["files"], list):
            summary["fileCount"] = len(result["files"])
        if "schemas" in result and isinstance(result["schemas"], dict):
            summary["schemaCount"] = sum(len(t) for t in result["schemas"].values())
    logger.info(
        "Activity completed | workflow_id=%s run_id=%s activity_type=%s | result=%s",
        ctx.get("workflow_id"),
        ctx.get("workflow_run_id"),
        ctx.get("activity_type"),
        sanitize_for_log(summary),
    )
    clear_context()
