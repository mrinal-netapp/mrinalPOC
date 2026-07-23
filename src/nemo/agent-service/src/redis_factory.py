"""Build async Redis clients for Sentinel HA vs direct URL (standalone).

Keep construction in one place so lifespan, health checks, and one-off clients
(e.g. post-invocation session writes) use the same topology.
"""
from __future__ import annotations

from observability_client_runtime import get_logger
from redis.asyncio import Redis

from .config import Settings

logger = get_logger()


def create_async_redis_client(settings: Settings) -> Redis:
    """Return a Redis client matching REDIS_SENTINEL_* vs REDIS_URL configuration."""
    if settings.REDIS_SENTINEL_URL:
        from redis.asyncio.sentinel import Sentinel

        sentinel_hosts: list[tuple[str, int]] = []
        for host in settings.REDIS_SENTINEL_URL.split(","):
            host = host.strip()
            if not host:
                continue
            if ":" in host:
                h, p = host.rsplit(":", 1)
                sentinel_hosts.append((h, int(p)))
            else:
                sentinel_hosts.append((host, 26379))
        sentinel = Sentinel(
            sentinel_hosts,
            socket_timeout=5,
            socket_connect_timeout=10,
        )
        client = sentinel.master_for(
            settings.REDIS_SENTINEL_MASTER,
            db=settings.REDIS_DB,
            password=settings.REDIS_PASSWORD or None,
            decode_responses=False,
            socket_timeout=10,
            socket_connect_timeout=10,
            retry_on_timeout=True,
            health_check_interval=0,
        )
        logger.info(
            "Redis client via Sentinel: master=%s sentinels=%s db=%d",
            settings.REDIS_SENTINEL_MASTER,
            sentinel_hosts,
            settings.REDIS_DB,
        )
        return client

    client = Redis.from_url(
        settings.REDIS_URL,
        decode_responses=False,
        socket_timeout=10,
        socket_connect_timeout=10,
        retry_on_timeout=True,
        health_check_interval=0,
    )
    logger.info(
        "Redis client from URL (socket_timeout=10s, health_check_interval=disabled): %s",
        settings.REDIS_URL,
    )
    return client
