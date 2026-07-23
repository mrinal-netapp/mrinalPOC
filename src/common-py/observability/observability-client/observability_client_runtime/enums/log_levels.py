"""Canonical log level strings and ordering for structlog processors and configuration."""
from __future__ import annotations

from enum import Enum


class LogLevel(str, Enum):
    """Stable level identifiers; values are the strings stored on log events and in JSON config."""

    DEBUG = "debug"
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"
    EXCEPTION = "exception"


# Rank for min_log_level filtering (lower = more verbose; events below floor are dropped)
_LEVEL_RANK_PAIRS: tuple[tuple[LogLevel, int], ...] = (
    (LogLevel.DEBUG, 10),
    (LogLevel.INFO, 20),
    (LogLevel.WARNING, 30),
    (LogLevel.ERROR, 40),
    (LogLevel.EXCEPTION, 40),
    (LogLevel.CRITICAL, 50),
)

LEVEL_RANK: dict[str, int] = {lvl.value: rank for lvl, rank in _LEVEL_RANK_PAIRS}
LEVEL_RANK["warn"] = LEVEL_RANK[LogLevel.WARNING.value]

VALID_MIN_LOG_LEVEL_KEYS: frozenset[str] = frozenset(LEVEL_RANK.keys())

DEFAULT_ALWAYS_KEEP_LEVELS: tuple[str, ...] = (
    LogLevel.ERROR.value,
    LogLevel.CRITICAL.value,
    LogLevel.EXCEPTION.value,
)

# After normalization, valid structlog bound-logger method names used by log_event
LOG_EVENT_LOGGER_METHODS: frozenset[str] = frozenset(
    (
        LogLevel.DEBUG.value,
        LogLevel.INFO.value,
        LogLevel.WARNING.value,
        LogLevel.ERROR.value,
        LogLevel.CRITICAL.value,
        LogLevel.EXCEPTION.value,
    )
)


def normalize_level_name(raw: str) -> str:
    """Lowercase; map ``warn`` → ``warning`` to match structlog / canonical levels."""
    s = raw.lower().strip()
    if s == "warn":
        return LogLevel.WARNING.value
    return s
