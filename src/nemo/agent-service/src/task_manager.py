"""Async task tracking for /invoke/async. Task state stored in Redis with TTL."""

import asyncio
import json
import uuid
import zlib

from observability_client_runtime import get_logger
from redis.asyncio import Redis

logger = get_logger()

_REDIS_OP_TIMEOUT = 10


class TaskManager:
    def __init__(
        self,
        redis: Redis,
        result_ttl: int = 3600,
        running_ttl: int = 600,
    ):
        self._redis = redis
        self._result_ttl = result_ttl
        self._running_ttl = running_ttl

    @staticmethod
    def _compress_result(result: dict) -> bytes:
        return zlib.compress(json.dumps(result).encode(), level=1)

    @staticmethod
    def _decompress_result(data: bytes) -> dict:
        return json.loads(zlib.decompress(data))

    async def create_task(self, project_id: str, agent_id: str) -> str:
        task_id = str(uuid.uuid4())
        key = f"task:{task_id}"
        await asyncio.wait_for(
            self._redis.hset(
                key,
                mapping={
                    "status": "running",
                    "project_id": project_id,
                    "agent_id": agent_id,
                },
            ),
            timeout=_REDIS_OP_TIMEOUT,
        )
        await asyncio.wait_for(
            self._redis.expire(key, self._running_ttl),
            timeout=_REDIS_OP_TIMEOUT,
        )
        logger.info("Task %s created for agent %s (ttl=%ds)", task_id, agent_id, self._running_ttl)
        return task_id

    async def complete_task(self, task_id: str, result: dict) -> None:
        key = f"task:{task_id}"
        await asyncio.wait_for(
            self._redis.hset(
                key,
                mapping={
                    "status": "completed",
                    "result": self._compress_result(result),
                },
            ),
            timeout=_REDIS_OP_TIMEOUT,
        )
        await asyncio.wait_for(
            self._redis.expire(key, self._result_ttl),
            timeout=_REDIS_OP_TIMEOUT,
        )
        logger.info("Task %s completed", task_id)

    async def fail_task(self, task_id: str, error: str) -> None:
        key = f"task:{task_id}"
        await asyncio.wait_for(
            self._redis.hset(
                key,
                mapping={"status": "failed", "error": error},
            ),
            timeout=_REDIS_OP_TIMEOUT,
        )
        await asyncio.wait_for(
            self._redis.expire(key, self._result_ttl),
            timeout=_REDIS_OP_TIMEOUT,
        )
        logger.info("Task %s failed: %s", task_id, error)

    async def get_task(self, task_id: str) -> dict | None:
        data = await asyncio.wait_for(
            self._redis.hgetall(f"task:{task_id}"),
            timeout=_REDIS_OP_TIMEOUT,
        )
        if not data:
            return None
        result: dict[str, object] = {}
        for k, v in data.items():
            key_str = k.decode() if isinstance(k, bytes) else k
            if key_str == "result":
                try:
                    result[key_str] = self._decompress_result(v)
                except Exception:
                    try:
                        val = v.decode() if isinstance(v, bytes) else v
                        result[key_str] = json.loads(val)
                    except (json.JSONDecodeError, TypeError):
                        result[key_str] = v.decode() if isinstance(v, bytes) else v
            else:
                result[key_str] = v.decode() if isinstance(v, bytes) else v
        return result
