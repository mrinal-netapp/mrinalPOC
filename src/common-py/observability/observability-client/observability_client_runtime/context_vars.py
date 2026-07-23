"""
Re-exports of structlog context-variable helpers and type aliases.

Also exports :data:`Logger` — a type alias for the structlog bound-logger
returned by :func:`get_logger`.  Service code that needs to annotate a
``logger`` parameter should import this instead of importing structlog directly::

    from observability_client_runtime import Logger

    def my_func(logger: Logger) -> None:
        logger.info("hello")


Services should import these from ``observability_client_runtime`` rather than
from ``structlog.contextvars`` directly, keeping structlog an internal
implementation detail of the client library (same principle as Go services
never importing ``go.uber.org/zap`` directly).

Usage::

    from observability_client_runtime import bind_context, clear_context

    def my_activity(input: dict) -> dict:
        bind_context(workflow_id="wf-123", dataset_id=input["dataset_id"])
        ...
        clear_context()
"""
from __future__ import annotations

from typing import Any

import structlog
from structlog.contextvars import (
    bind_contextvars as _bind,
    clear_contextvars as _clear,
    get_contextvars as _get,
    unbind_contextvars as _unbind,
    reset_contextvars as _reset,
    merge_contextvars as _merge,
)

# Type alias for the structlog bound-logger returned by get_logger().
# Services that annotate logger parameters should use this instead of
# importing structlog or logging.Logger directly.
Logger = structlog.BoundLogger


def bind_context(**new_values: Any) -> None:
    """Bind key-value pairs into the current thread-/async-context.

    All subsequent log calls (via ``get_logger()``, ``log_event()``, or the
    stdlib bridge) will automatically include these fields until
    ``clear_context()`` or ``unbind_context()`` is called.

    Example::

        bind_context(workflow_id="wf-123", activity_type="ProcessFiles")
    """
    _bind(**new_values)


def clear_context() -> None:
    """Remove all bound context variables for the current context.

    Call at the end of an activity or request to prevent context leakage
    to unrelated work running on the same thread/coroutine later.
    """
    _clear()


def get_context() -> dict[str, Any]:
    """Return a copy of all currently bound context variables."""
    return _get()


def unbind_context(*keys: str) -> None:
    """Remove specific keys from the bound context without clearing all of it."""
    _unbind(*keys)


def reset_context(**new_values: Any) -> None:
    """Clear all existing context and bind ``new_values`` in one step."""
    _reset(**new_values)


def merge_context(event_dict: dict[str, Any]) -> dict[str, Any]:
    """Structlog processor: merge bound context vars into ``event_dict``.

    Can be placed in a custom processor chain if needed; normally not
    required because ``configure_observability_logging`` already includes it.
    """
    return _merge(None, None, event_dict)  # type: ignore[arg-type]
