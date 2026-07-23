"""Centralized logging for the agent-service integration suites.

One named logger (``integration.http``) fans out to two handlers at different
levels, which is what implements the two-level scheme:

- stdout ``StreamHandler`` at ``INFO``  -> console + file
- ``FileHandler`` at ``DEBUG``           -> file only

So:

- ``log.info(...)``  -> console + file (SUITE/TEST banners, PASSED/FAILED,
  the ``RUN:`` header, and the ``[setup]``/``[cleanup]`` lines).
- ``log.debug(...)`` -> file only      (HTTP request/response JSON detail).

``configure_logging()`` is called once per session (from the agent-service
``conftest.py``). When ``WORK_DIR`` is set (by the Makefile targets) it creates
the per-run directory, attaches the ``FileHandler`` at ``<WORK_DIR>/<LOG_FILE>``,
and writes an ``env.property`` snapshot of the process environment.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import shutil
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    from lib.agent_service.streaming import StreamResult
    from lib.agent_service.websocket import WSResult

HTTP_LOGGER_NAME = "integration.http"
_DEFAULT_LOG_FILE = "run.log"
_MASK = "***MASKED***"
# Substrings (case-insensitive) that mark a key as secret-bearing.
_SECRET_HINTS = ("_API_KEY", "SECRET", "PASSWORD", "TOKEN", "_KEY")


@dataclass
class RunLogContext:
    """Result of :func:`configure_logging`."""

    enabled: bool = False
    work_dir: Path | None = None
    log_file: Path | None = None
    env_file: Path | None = None


def get_logger() -> logging.Logger:
    """Return the shared ``integration.http`` logger."""
    return logging.getLogger(HTTP_LOGGER_NAME)


class RunLogger:
    """Thin wrapper exposing the two log levels used across the suites.

    ``info`` -> console + file; ``debug`` -> file only (the console handler is
    set to ``INFO`` so it drops ``DEBUG`` records).
    """

    def __init__(self) -> None:
        self._logger = get_logger()

    def info(self, msg: str) -> None:
        self._logger.info(msg)

    def debug(self, msg: str) -> None:
        self._logger.debug(msg)


# Module-level singleton used by every suite: ``log.info`` / ``log.debug``.
log = RunLogger()


def _has_console_handler(logger: logging.Logger) -> bool:
    # FileHandler subclasses StreamHandler, so exclude it explicitly.
    return any(
        isinstance(h, logging.StreamHandler) and not isinstance(h, logging.FileHandler)
        for h in logger.handlers
    )


def configure_logging() -> RunLogContext:
    """Configure the shared logger; idempotent (safe to call once per session).

    Always ensures a single stdout ``StreamHandler`` at ``INFO``. When
    ``WORK_DIR`` is set, also creates the directory, attaches one ``FileHandler``
    at ``DEBUG`` to ``<WORK_DIR>/<LOG_FILE>`` (defaulting the filename to
    ``run.log``), and writes ``<WORK_DIR>/env.property``.
    """
    logger = get_logger()
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    fmt = logging.Formatter("%(message)s")

    if not _has_console_handler(logger):
        console = logging.StreamHandler(sys.stdout)
        console.setLevel(logging.INFO)
        console.setFormatter(fmt)
        logger.addHandler(console)

    work_dir_env = (os.environ.get("WORK_DIR") or "").strip()
    if not work_dir_env:
        return RunLogContext(enabled=False)

    work_dir = Path(work_dir_env)
    work_dir.mkdir(parents=True, exist_ok=True)
    log_name = (os.environ.get("LOG_FILE") or "").strip() or _DEFAULT_LOG_FILE
    log_path = work_dir / log_name
    env_path = work_dir / "env.property"

    if not any(isinstance(h, logging.FileHandler) for h in logger.handlers):
        file_handler = logging.FileHandler(log_path, mode="w", encoding="utf-8")
        file_handler.setLevel(logging.DEBUG)
        file_handler.setFormatter(fmt)
        logger.addHandler(file_handler)

    _write_env_property(env_path)
    return RunLogContext(
        enabled=True, work_dir=work_dir, log_file=log_path, env_file=env_path
    )


def _mask_obj(obj: object) -> object:
    """Recursively mask secret-bearing values in dict/list structures."""
    if isinstance(obj, dict):
        masked: dict[object, object] = {}
        for key, value in obj.items():
            if isinstance(key, str) and any(hint in key.upper() for hint in _SECRET_HINTS):
                masked[key] = _MASK
            else:
                masked[key] = _mask_obj(value)
        return masked
    if isinstance(obj, list):
        return [_mask_obj(v) for v in obj]
    return obj


def log_exchange(
    method: str, url: str, body: object | None, resp: httpx.Response
) -> None:
    """Log an HTTP request/response pair to the file only (``debug`` level)."""
    lines = ["", "  >> REQUEST", f"     {method.upper()} {url}"]
    if body is not None:
        lines.append("     Body:")
        try:
            body_text = json.dumps(_mask_obj(body), indent=2, default=str)
        except (TypeError, ValueError):
            body_text = str(body)
        lines.extend(f"       {line}" for line in body_text.splitlines())
    log.debug("\n".join(lines))

    resp_lines = ["", f"  << RESPONSE  HTTP {resp.status_code}"]
    if resp.text:
        try:
            resp_payload = _mask_obj(resp.json())
            resp_text = json.dumps(resp_payload, indent=2, default=str)
        except ValueError:
            resp_text = resp.text
        resp_lines.extend(f"     {line}" for line in resp_text.splitlines())
    else:
        resp_lines.append("     (empty body)")
    log.debug("\n".join(resp_lines))


def log_stream(
    method: str, url: str, body: object | None, result: "StreamResult"
) -> None:
    """Log a streaming (SSE) request/response pair to the file only (``debug``).

    Mirrors :func:`log_exchange` but for ``/invoke/stream`` endpoints: it dumps
    the request, the HTTP status + ``content-type`` header, one line per parsed
    SSE event (in order), and the decoded ``completed.metadata.invokeResponse``
    envelope. On a non-200 (a JSON error, not SSE) the raw body is shown.
    """
    lines = ["", "  >> REQUEST", f"     {method.upper()} {url}"]
    if body is not None:
        lines.append("     Body:")
        try:
            body_text = json.dumps(_mask_obj(body), indent=2, default=str)
        except (TypeError, ValueError):
            body_text = str(body)
        lines.extend(f"       {line}" for line in body_text.splitlines())
    log.debug("\n".join(lines))

    content_type = result.headers.get("content-type", "")
    resp_lines = [
        "",
        f"  << SSE RESPONSE  HTTP {result.status_code}",
        f"     Content-Type: {content_type}",
    ]
    if result.raw_non_sse_body is not None:
        resp_lines.append("     (non-SSE body)")
        resp_lines.extend(
            f"       {line}" for line in result.raw_non_sse_body.splitlines()
        )
        log.debug("\n".join(resp_lines))
        return

    resp_lines.append(f"     Events ({len(result.events)}):")
    for index, event in enumerate(result.events):
        summary = event.data.replace("\n", " ")
        if len(summary) > 120:
            summary = summary[:117] + "..."
        resp_lines.append(f"       [{index}] {event.event}  {summary}")

    completed = result.completed_event
    if completed is not None:
        invoke_response = None
        parsed = completed.data_json
        if isinstance(parsed, dict):
            metadata = parsed.get("metadata")
            if isinstance(metadata, dict):
                invoke_response = metadata.get("invokeResponse")
        resp_lines.append("     completed.metadata.invokeResponse:")
        try:
            ir_text = json.dumps(invoke_response, indent=2, default=str)
        except (TypeError, ValueError):
            ir_text = str(invoke_response)
        resp_lines.extend(f"       {line}" for line in ir_text.splitlines())
    log.debug("\n".join(resp_lines))


def log_ws(
    method: str, url: str, body: object | None, result: "WSResult"
) -> None:
    """Log a WebSocket invoke request/response to the file only (``debug``).

    Mirrors :func:`log_stream` but for the ``/ws`` endpoints: it dumps the
    request, the close code (and any connect error), one line per received WS
    frame in order, and the decoded ``completed.metadata.invokeResponse``.
    """
    lines = ["", "  >> WS REQUEST", f"     {method.upper()} {url}"]
    if body is not None:
        lines.append("     Body:")
        try:
            body_text = json.dumps(_mask_obj(body), indent=2, default=str)
        except (TypeError, ValueError):
            body_text = str(body)
        lines.extend(f"       {line}" for line in body_text.splitlines())
    log.debug("\n".join(lines))

    resp_lines = ["", f"  << WS RESPONSE  close_code={result.close_code}"]
    if result.connect_error:
        resp_lines.append(f"     connect_error: {result.connect_error}")
    resp_lines.append(f"     Frames ({len(result.events)}):")
    for index, event in enumerate(result.events):
        summary = event.data.replace("\n", " ")
        if len(summary) > 120:
            summary = summary[:117] + "..."
        resp_lines.append(f"       [{index}] {event.event}  {summary}")

    invoke_response = result.invoke_response
    if invoke_response is not None:
        resp_lines.append("     completed.metadata.invokeResponse:")
        try:
            ir_text = json.dumps(invoke_response, indent=2, default=str)
        except (TypeError, ValueError):
            ir_text = str(invoke_response)
        resp_lines.extend(f"       {line}" for line in ir_text.splitlines())
    log.debug("\n".join(resp_lines))


def copy_run_artifacts(
    ctx: RunLogContext, paths: Iterable[str | os.PathLike[str] | None]
) -> list[Path]:
    """Copy report artifacts (files or directories) into ``ctx.work_dir``.

    Each path may be a file (e.g. the HTML/JUnit reports) or a directory (e.g.
    the allure-results dir). Missing paths are skipped. Returns the list of
    destination paths actually copied. No-op when file logging is disabled.
    """
    if not ctx.enabled or ctx.work_dir is None:
        return []
    copied: list[Path] = []
    for path in paths:
        if not path:
            continue
        src = Path(path)
        dest = ctx.work_dir / src.name
        if src.is_file():
            shutil.copy2(src, dest)
            copied.append(dest)
        elif src.is_dir():
            shutil.copytree(src, dest, dirs_exist_ok=True)
            copied.append(dest)
    return copied


def run_footer_lines(ctx: RunLogContext) -> list[str]:
    """Plain-text footer pointing the user to the per-run log file.

    Returns an empty list when file logging is disabled (no ``WORK_DIR``). The
    caller applies any console coloring, so no ANSI codes are stored here.
    """
    if not ctx.enabled or ctx.log_file is None:
        return []
    return [
        f"Detailed logs written to: {ctx.log_file.resolve()}",
        "Check this file for the full request/response details.",
    ]


def log_banner(text: str, *, char: str = "-", width: int = 60) -> None:
    """Emit a bordered banner via ``info`` (console + file)."""
    bar = char * width
    log.info("")
    log.info(bar)
    log.info(f"  {text}")
    log.info(bar)


def _mask(key: str, value: str) -> str:
    """Mask secret-bearing values; pass everything else through verbatim."""
    upper = key.upper()
    if any(hint in upper for hint in _SECRET_HINTS):
        return _MASK
    return value


def _write_env_property(path: Path) -> None:
    """Write a sorted ``KEY=VALUE`` snapshot of the environment, secrets masked."""
    items = sorted(os.environ.items())
    masked_keys = [key for key, value in items if _mask(key, value) == _MASK]
    target = Path((os.environ.get("LOG_FILE") or "").strip() or _DEFAULT_LOG_FILE).stem
    header = [
        "# AgentStudio integration env snapshot",
        f"# target={target}",
        f"# generated={datetime.datetime.now().isoformat(timespec='seconds')}",
        f"# masked={', '.join(masked_keys)}",
    ]
    body = [f"{key}={_mask(key, value)}" for key, value in items]
    path.write_text("\n".join(header + body) + "\n", encoding="utf-8")
