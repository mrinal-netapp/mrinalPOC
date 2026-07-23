"""Backward-compat shim: re-exports from observability_client_runtime.enums."""
from observability_client_runtime.enums.log_levels import (  # noqa: F401
    LogLevel,
    LEVEL_RANK,
    VALID_MIN_LOG_LEVEL_KEYS,
    LOG_EVENT_LOGGER_METHODS,
    DEFAULT_ALWAYS_KEEP_LEVELS,
    normalize_level_name,
)

__all__ = (
    "LogLevel",
    "LEVEL_RANK",
    "VALID_MIN_LOG_LEVEL_KEYS",
    "LOG_EVENT_LOGGER_METHODS",
    "DEFAULT_ALWAYS_KEEP_LEVELS",
    "normalize_level_name",
)
