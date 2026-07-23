"""Pluggable task persistence backends for the async-invoke pattern.

Defines :class:`TaskStore` and two implementations:

- :class:`InMemoryTaskStore` -- default, no external dependencies. Suitable for
  dev and single-instance deployments. Tasks are lost on process restart.
- :class:`RedisTaskStore` -- production. Stores tasks as zlib-compressed JSON
  with a two-tier TTL (short while running, longer once terminal) so a crashed
  worker does not leak ``running`` task hashes forever.

The backend is selected by ``tasks.backend`` config (``"memory"`` or
``"redis"``). Use :func:`create_task_store` rather than instantiating the
implementations directly so config-driven selection stays centralized.
"""

from __future__ import annotations

import asyncio
import json
import zlib
from abc import ABC, abstractmethod
from typing import Any

import structlog

from agent_service_maf.core.task_models import Task

logger = structlog.get_logger(__name__)

# Per-operation timeout (seconds) for Redis calls. Bounds the worst-case
# blocking time for submit / poll if Redis becomes slow or unreachable.
_REDIS_OP_TIMEOUT = 10


class TaskStore(ABC):
    """Abstract interface for task persistence.

    All methods are async to support both in-memory and networked backends.
    Implementations must be safe for use from a single asyncio event loop.
    """

    @abstractmethod
    async def save(self, task: Task, *, running: bool) -> None:
        """Persist a task.

        Args:
            task: The task to persist.
            running: ``True`` while the task is still in flight (applies the
                short TTL on backends that support it); ``False`` once
                terminal so polling clients have time to fetch the result
                (applies the longer TTL).
        """

    @abstractmethod
    async def get(self, task_id: str) -> Task | None:
        """Retrieve a task by id. Returns ``None`` if unknown or expired."""

    @abstractmethod
    async def delete(self, task_id: str) -> bool:
        """Delete a task. Returns ``True`` if it existed."""

    @abstractmethod
    async def close(self) -> None:
        """Release any backend resources (connections, pools, in-memory state)."""


# ---------------------------------------------------------------------------
# In-memory backend
# ---------------------------------------------------------------------------


class InMemoryTaskStore(TaskStore):
    """In-memory task store backed by a dict.

    Suitable for dev / single instance deployments. Tasks live for the
    lifetime of the process. Does NOT implement TTL -- entries persist until
    the process exits or the caller deletes them. Adequate for short-lived
    dev sessions.

    Save / get deep-copy the :class:`Task` so concurrent mutators (e.g.
    ``mark_completed`` on the runner side racing with ``mark_cancelled``
    on the cancel side) cannot share the in-memory object reference.
    The Redis backend serializes through zlib+JSON and so naturally
    produces a fresh ``Task`` on each ``get``; this mirrors that
    behavior so the terminal-state monotonicity guards in
    :class:`~agent_service_maf.core.task_manager.TaskManager` are
    meaningful for the memory backend as well.
    """

    def __init__(self) -> None:
        self._tasks: dict[str, Task] = {}

    async def save(self, task: Task, *, running: bool) -> None:
        # The `running` flag is ignored: in-memory storage has no TTL.
        _ = running
        self._tasks[task.task_id] = task.model_copy(deep=True)

    async def get(self, task_id: str) -> Task | None:
        stored = self._tasks.get(task_id)
        if stored is None:
            return None
        return stored.model_copy(deep=True)

    async def delete(self, task_id: str) -> bool:
        return self._tasks.pop(task_id, None) is not None

    async def close(self) -> None:
        self._tasks.clear()


# ---------------------------------------------------------------------------
# Redis backend
# ---------------------------------------------------------------------------


class RedisTaskStore(TaskStore):
    """Redis-backed task store with two-tier TTL and zlib-compressed payloads.

    Key scheme: ``{prefix}{task_id}`` (default prefix ``agent_task:``).
    Values are stored as zlib-compressed JSON to keep result payloads small --
    InvokeResponses can include long-form output, trace_steps, and citations.

    Args:
        redis_url: Standalone Redis URL (used when no Sentinel is set).
        redis_sentinel_url: Comma-separated ``host[:port]`` Sentinel list.
            Non-empty switches the client to master-discovery mode for HA.
        redis_sentinel_master: Sentinel master service name (only used when
            ``redis_sentinel_url`` is non-empty).
        redis_password: Optional Redis AUTH password.
        key_prefix: Prefix for all task keys.
        running_ttl_seconds: TTL for tasks still in flight. Short by design --
            a crashed worker self-cleans within this window.
        result_ttl_seconds: TTL once the task reaches a terminal state.
        compression_level: zlib level (1 fast, 9 thorough). Default 1 matches
            the POC and is a good fit for JSON-shaped payloads.

    Raises:
        ImportError: If the ``redis`` package is not installed.
    """

    def __init__(
        self,
        redis_url: str = "redis://localhost:6379/0",
        *,
        redis_sentinel_url: str = "",
        redis_sentinel_master: str = "mymaster",
        redis_password: str = "",
        key_prefix: str = "agent_task:",
        running_ttl_seconds: int = 600,
        result_ttl_seconds: int = 3600,
        compression_level: int = 1,
    ) -> None:
        # Route through the shared factory so task storage gets the same
        # connection policy (socket timeout, ``retry_on_timeout``, Sentinel
        # master-discovery) that :class:`RedisSessionStore` already uses.
        # ``decode_responses=False`` is mandatory here: payloads are zlib-
        # compressed bytes and must round-trip without UTF-8 decode.
        from agent_service_maf.core.redis_factory import create_async_redis_client

        self._redis = create_async_redis_client(
            redis_url=redis_url,
            redis_sentinel_url=redis_sentinel_url,
            redis_sentinel_master=redis_sentinel_master,
            redis_password=redis_password,
            decode_responses=False,
        )
        self._prefix = key_prefix
        self._running_ttl = running_ttl_seconds
        self._result_ttl = result_ttl_seconds
        self._level = compression_level
        logger.info(
            "Redis task store initialized",
            url=redis_url,
            sentinel=bool(redis_sentinel_url),
            prefix=key_prefix,
            running_ttl=running_ttl_seconds,
            result_ttl=result_ttl_seconds,
        )

    def _key(self, task_id: str) -> str:
        return f"{self._prefix}{task_id}"

    def _encode(self, task: Task) -> bytes:
        payload: dict[str, Any] = task.model_dump(mode="json")
        return zlib.compress(json.dumps(payload).encode("utf-8"), level=self._level)

    def _decode(self, raw: bytes) -> Task | None:
        try:
            data = json.loads(zlib.decompress(raw))
            return Task.model_validate(data)
        except (zlib.error, json.JSONDecodeError, ValueError) as exc:
            logger.warning("Failed to decode task from Redis", error=str(exc))
            return None

    async def save(self, task: Task, *, running: bool) -> None:
        ttl = self._running_ttl if running else self._result_ttl
        await asyncio.wait_for(
            self._redis.set(self._key(task.task_id), self._encode(task), ex=ttl),
            timeout=_REDIS_OP_TIMEOUT,
        )

    async def get(self, task_id: str) -> Task | None:
        raw = await asyncio.wait_for(
            self._redis.get(self._key(task_id)),
            timeout=_REDIS_OP_TIMEOUT,
        )
        if raw is None:
            return None
        return self._decode(raw)

    async def delete(self, task_id: str) -> bool:
        deleted = await asyncio.wait_for(
            self._redis.delete(self._key(task_id)),
            timeout=_REDIS_OP_TIMEOUT,
        )
        return bool(deleted)

    async def close(self) -> None:
        await self._redis.aclose()
        logger.info("Redis task store closed")


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def create_task_store(
    backend: str = "memory",
    redis_url: str = "redis://localhost:6379/0",
    *,
    redis_sentinel_url: str = "",
    redis_sentinel_master: str = "mymaster",
    redis_password: str = "",
    key_prefix: str = "agent_task:",
    running_ttl_seconds: int = 600,
    result_ttl_seconds: int = 3600,
    compression_level: int = 1,
) -> TaskStore:
    """Create a task store from config.

    Args:
        backend: ``"memory"`` or ``"redis"``.
        redis_url: Standalone Redis URL (Redis backend only).
        redis_sentinel_url: Comma-separated Sentinel host list. Non-empty
            switches to master-discovery mode (Redis backend only).
        redis_sentinel_master: Sentinel master service name (Redis only).
        redis_password: Optional Redis AUTH password (Redis only).
        key_prefix: Key prefix (Redis only).
        running_ttl_seconds: TTL while running (Redis only).
        result_ttl_seconds: TTL once terminal (Redis only).
        compression_level: zlib compression level (Redis only).

    Returns:
        A :class:`TaskStore` implementation.

    Raises:
        ValueError: If ``backend`` is not recognised.
        ImportError: If ``"redis"`` backend is selected but the package is
            not installed.
    """
    if backend == "memory":
        return InMemoryTaskStore()
    if backend == "redis":
        return RedisTaskStore(
            redis_url=redis_url,
            redis_sentinel_url=redis_sentinel_url,
            redis_sentinel_master=redis_sentinel_master,
            redis_password=redis_password,
            key_prefix=key_prefix,
            running_ttl_seconds=running_ttl_seconds,
            result_ttl_seconds=result_ttl_seconds,
            compression_level=compression_level,
        )
    raise ValueError(f"Unknown task storage backend: '{backend}'. Supported: 'memory', 'redis'.")
