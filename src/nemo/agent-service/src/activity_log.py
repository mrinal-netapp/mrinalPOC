"""Structured [activity] logs for debugging agent-service flows."""

from __future__ import annotations

from typing import Any

from observability_client_runtime import Logger
from starlette.requests import Request


def _safe(v: Any, max_len: int = 160) -> str:
    if v is None:
        return "None"
    s = str(v)
    if len(s) > max_len:
        return s[: max_len - 3] + "..."
    return s


def activity(logger: Logger, event: str, **fields: Any) -> None:
    """Log one line: [activity] <event> | k=v ..."""
    if not fields:
        logger.info("[activity] %s", event)
        return
    parts = " ".join(f"{k}={_safe(v)}" for k, v in fields.items())
    logger.info("[activity] %s | %s", event, parts)


def request_id(request: Request) -> str:
    """Request id from middleware (X-Request-ID) or '-'."""
    return getattr(request.state, "request_id", None) or "-"
