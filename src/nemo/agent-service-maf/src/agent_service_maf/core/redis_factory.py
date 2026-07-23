"""Async Redis client factory supporting Sentinel HA or standalone URL.

Centralises Redis client construction so that every store
(:class:`~agent_service_maf.core.session_store.RedisSessionStore`,
:class:`~agent_service_maf.core.task_store.RedisTaskStore`, ...) uses the
same connection policy, the same Sentinel discovery rules, and the same
per-op socket timeouts.

Two construction modes:

- **Standalone** -- a single ``redis://...`` URL. Used for dev and small
  deployments. Wraps :func:`redis.asyncio.from_url`.
- **Sentinel** -- when ``redis_sentinel_url`` is non-empty, the value is
  parsed as a comma-separated list of ``host:port`` entries (port defaults
  to ``26379``) and the returned client is the live master discovered by
  :class:`redis.asyncio.sentinel.Sentinel`. The master client survives
  failover transparently.

In both modes the returned client has ``retry_on_timeout=True`` and matching
socket / connect timeouts, so individual ops can be wrapped with
``asyncio.wait_for(..., timeout=...)`` for a hard ceiling without losing
in-band retry semantics.

Example::

    from agent_service_maf.core.redis_factory import create_async_redis_client

    client = create_async_redis_client(
        redis_url="redis://localhost:6379/0",
        decode_responses=False,
    )
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import structlog

if TYPE_CHECKING:  # pragma: no cover - import only for typing
    pass

logger = structlog.get_logger(__name__)

#: Default Sentinel port if ``host:port`` parsing yields only a host.
DEFAULT_SENTINEL_PORT = 26379


def _parse_sentinel_hosts(value: str) -> list[tuple[str, int]]:
    """Parse a comma-separated ``host[:port]`` list into ``(host, port)`` tuples.

    Whitespace is stripped around each entry. Entries with no port use
    :data:`DEFAULT_SENTINEL_PORT`. Empty entries are skipped.

    Args:
        value: Comma-separated sentinel string.

    Returns:
        List of ``(host, port)`` tuples in the order they appeared. Empty
        list if ``value`` contained no usable entries.

    Raises:
        ValueError: If a port component cannot be parsed as an int.
    """
    hosts: list[tuple[str, int]] = []
    for raw in value.split(","):
        entry = raw.strip()
        if not entry:
            continue
        if ":" in entry:
            host, port_str = entry.rsplit(":", 1)
            hosts.append((host.strip(), int(port_str)))
        else:
            hosts.append((entry, DEFAULT_SENTINEL_PORT))
    return hosts


def create_async_redis_client(
    *,
    redis_url: str = "redis://localhost:6379/0",
    redis_sentinel_url: str = "",
    redis_sentinel_master: str = "mymaster",
    redis_db: int = 0,
    redis_password: str = "",
    socket_timeout: float = 10.0,
    socket_connect_timeout: float = 10.0,
    decode_responses: bool = False,
) -> Any:  # noqa: ANN401 — return type is redis.asyncio.Redis but redis is optional
    """Return an ``asyncio.Redis`` client wired for the chosen topology.

    The ``redis`` package is imported lazily so applications that don't use
    a Redis store don't have to install it.

    Args:
        redis_url: Standalone Redis URL. Used only when
            ``redis_sentinel_url`` is empty.
        redis_sentinel_url: Comma-separated ``host[:port]`` list of Sentinels.
            When non-empty, the returned client is the discovered master.
        redis_sentinel_master: Sentinel master service name. Only consulted
            in Sentinel mode.
        redis_db: Redis logical DB index. Applies to Sentinel mode (URL
            already encodes the DB).
        redis_password: Optional AUTH password. Recommended via env var,
            never via JSON config.
        socket_timeout: Per-op socket read timeout (seconds). Bounds how
            long any single command can block waiting on Redis to respond
            on an established connection.
        socket_connect_timeout: TCP connect timeout (seconds). Bounds how
            long a new connection can take to establish.
        decode_responses: When ``False`` (default), values are returned
            as ``bytes``. Stores that zlib-compress their payloads MUST
            use ``False`` so the raw bytes round-trip cleanly.

    Returns:
        An async Redis client. In Sentinel mode it is the live master
        object returned by ``Sentinel.master_for(...)``; in standalone
        mode it is the ``from_url`` client.

    Raises:
        ImportError: If the ``redis`` package is not installed.
        ValueError: If ``redis_sentinel_url`` is malformed (e.g., a port
            that is not an integer).
    """
    try:
        import redis.asyncio as aioredis
    except ImportError as exc:  # pragma: no cover - documented contract
        raise ImportError(
            "Redis client requires the 'redis' package. Install it with: pip install redis[hiredis]"
        ) from exc

    if redis_sentinel_url:
        from redis.asyncio.sentinel import Sentinel

        hosts = _parse_sentinel_hosts(redis_sentinel_url)
        if not hosts:
            raise ValueError(f"redis_sentinel_url={redis_sentinel_url!r} parsed to zero hosts")
        logger.info(
            "redis_factory_sentinel_mode",
            host_count=len(hosts),
            master=redis_sentinel_master,
            db=redis_db,
        )
        sentinel = Sentinel(
            hosts,
            socket_timeout=socket_timeout,
            socket_connect_timeout=socket_connect_timeout,
        )
        return sentinel.master_for(
            redis_sentinel_master,
            db=redis_db,
            password=redis_password or None,
            decode_responses=decode_responses,
            socket_timeout=socket_timeout,
            socket_connect_timeout=socket_connect_timeout,
            retry_on_timeout=True,
            health_check_interval=0,
        )

    logger.info(
        "redis_factory_standalone_mode",
        url=redis_url,
        decode_responses=decode_responses,
    )
    return aioredis.from_url(
        redis_url,
        password=redis_password or None,
        decode_responses=decode_responses,
        socket_timeout=socket_timeout,
        socket_connect_timeout=socket_connect_timeout,
        retry_on_timeout=True,
        health_check_interval=0,
    )
