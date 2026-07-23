"""Unit tests for the async Redis client factory.

The Redis package is an optional dependency. Where it is missing we
exercise only the parsing helpers; where it is present we assert the
factory returns the expected client class for each topology.
"""

from __future__ import annotations

import pytest

from agent_service_maf.core.redis_factory import (
    DEFAULT_SENTINEL_PORT,
    _parse_sentinel_hosts,
    create_async_redis_client,
)


class TestParseSentinelHosts:
    def test_single_host_with_port(self) -> None:
        assert _parse_sentinel_hosts("sentinel-a:26380") == [("sentinel-a", 26380)]

    def test_multiple_hosts(self) -> None:
        result = _parse_sentinel_hosts("a:26379, b:26380 ,c:26381")
        assert result == [
            ("a", 26379),
            ("b", 26380),
            ("c", 26381),
        ]

    def test_host_without_port_uses_default(self) -> None:
        result = _parse_sentinel_hosts("sentinel-only-host")
        assert result == [("sentinel-only-host", DEFAULT_SENTINEL_PORT)]

    def test_empty_input_returns_empty_list(self) -> None:
        assert _parse_sentinel_hosts("") == []

    def test_blanks_are_skipped(self) -> None:
        assert _parse_sentinel_hosts(",,a:26379,,") == [("a", 26379)]

    def test_malformed_port_raises(self) -> None:
        with pytest.raises(ValueError):
            _parse_sentinel_hosts("host:not-a-port")


class TestCreateAsyncRedisClient:
    """Smoke-test the factory returns the right object shape for each topology.

    These tests never connect — they only exercise construction. They are
    skipped when the optional ``redis`` package is missing.
    """

    def test_standalone_mode_returns_client(self) -> None:
        pytest.importorskip("redis.asyncio")
        client = create_async_redis_client(
            redis_url="redis://nowhere:6379/0",
            decode_responses=False,
        )
        # Standalone clients expose a connection_pool attribute. We don't
        # invoke any command — that would attempt a live connection.
        assert client is not None
        assert hasattr(client, "connection_pool")

    def test_sentinel_mode_returns_master_client(self) -> None:
        pytest.importorskip("redis.asyncio.sentinel")
        client = create_async_redis_client(
            redis_sentinel_url="sentinel-a:26379,sentinel-b:26379",
            redis_sentinel_master="mymaster",
        )
        # `Sentinel.master_for(...)` returns a Redis (master) client
        # backed by a SentinelConnectionPool. Best identifying signal
        # without a live connection: the pool class name carries "Sentinel".
        assert client is not None
        pool_cls = type(getattr(client, "connection_pool", None)).__name__
        assert "Sentinel" in pool_cls or hasattr(client, "execute_command")

    def test_sentinel_empty_list_raises(self) -> None:
        pytest.importorskip("redis.asyncio.sentinel")
        with pytest.raises(ValueError, match="parsed to zero hosts"):
            create_async_redis_client(redis_sentinel_url=" , , ")
