"""Redis-backed token-count cache.

Keyed by ``(tokenizer_family, sha256(content))`` so identical content
tokenized with the same encoding hits the cache regardless of which
model triggered the lookup.

Phase 2 — used by the heuristic-error calibration path and by the
real-tokenizer paths to amortize the per-call cost of
``anthropic.count_tokens`` (~50–150 ms RTT) and ``tiktoken`` (~1 ms
but still non-trivial for very long histories).
"""

from __future__ import annotations

import asyncio
import hashlib
from typing import Any

from observability_client_runtime import get_logger
from redis.asyncio import Redis

logger = get_logger()

_REDIS_OP_TIMEOUT = 2  # seconds; counter cache is best-effort


def _key(family: str, content: str) -> str:
    sha = hashlib.sha256(content.encode("utf-8")).hexdigest()
    return f"tok:{family}:{sha}"


class RedisTokenCountCache:
    """Best-effort Redis cache for tokenizer counts.

    Misses fall back to the underlying counter transparently; transient
    Redis errors degrade gracefully (counter is invoked directly).
    """

    def __init__(self, redis: Redis, ttl_seconds: int = 7 * 86400):
        self._redis = redis
        self._ttl = ttl_seconds

    async def get(self, family: str, content: str) -> int | None:
        if not content:
            return 0
        try:
            raw = await asyncio.wait_for(
                self._redis.get(_key(family, content)),
                timeout=_REDIS_OP_TIMEOUT,
            )
        except Exception:
            return None
        if raw is None:
            return None
        try:
            return int(raw)
        except (TypeError, ValueError):
            return None

    async def set(self, family: str, content: str, value: int) -> None:
        if not content:
            return
        try:
            await asyncio.wait_for(
                self._redis.set(_key(family, content), str(int(value)), ex=self._ttl),
                timeout=_REDIS_OP_TIMEOUT,
            )
        except Exception:
            # Cache miss is correctness-preserving; swallow.
            pass

    async def get_or_compute(
        self,
        family: str,
        content: str,
        compute: "callable[..., int]",
    ) -> int:
        """Async wrapper: cache or compute. Use when the underlying
        counter is cheap (heuristic/tiktoken). Don't use for the
        Anthropic remote counter — wrap that in its own async path."""
        cached = await self.get(family, content)
        if cached is not None:
            return cached
        value = compute(content)
        await self.set(family, content, value)
        return value
