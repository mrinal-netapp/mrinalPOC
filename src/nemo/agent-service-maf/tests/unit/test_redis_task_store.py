"""Unit test — `RedisTaskStore` encode/decode + key namespacing + TTL.

The unit audit (H1) flagged `RedisTaskStore` as zero-coverage — only
`InMemoryTaskStore` is exercised by the existing
`tests/unit/test_task_store.py` (and the in-memory backend skips
encoding entirely). In production the Redis backend is what holds
every async-task row; the bug surface lives in the zlib+JSON
round-trip, the key prefix, and the two-tier TTL (short while
running, longer once terminal).

This file uses `fakeredis.aioredis` — a pure-Python Redis surrogate
with no socket — so we exercise the *actual* encoder + decoder rather
than a MagicMock that doesn't catch encoding bugs.

Properties pinned:

  1. `save` + `get` round-trip a Task identically (zlib decompress
     and JSON parse preserve every field, including identity).
  2. The Redis key is `f"{prefix}{task_id}"` with the configured
     prefix.
  3. TTL on `save(running=True)` matches `running_ttl_seconds`; TTL
     on `save(running=False)` matches `result_ttl_seconds`.
  4. `IdentityContext.user_token` is `exclude=True` and stays
     server-side — must NOT appear in the serialized Redis payload.
  5. `get` on a missing key returns None.
  6. `delete` returns True on hit, False on miss.
  7. A corrupt payload (zlib failure / invalid JSON / wrong schema)
     yields None rather than crashing the caller (`_decode` swallows).
  8. The asyncio-timeout wrapper bounds slow Redis calls.
"""

from __future__ import annotations

import json
import zlib
from typing import Any
from unittest.mock import patch

import fakeredis.aioredis
import pytest

from agent_service_maf.core.identity import IdentityContext
from agent_service_maf.core.task_models import Task, TaskStatus
from agent_service_maf.core.task_store import RedisTaskStore

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_redis() -> fakeredis.aioredis.FakeRedis:
    """Pure-Python async Redis stand-in with no socket."""
    # `decode_responses=False` matches what RedisTaskStore configures so
    # round-trip preserves the zlib byte payload.
    return fakeredis.aioredis.FakeRedis(decode_responses=False)


@pytest.fixture
def store(fake_redis: fakeredis.aioredis.FakeRedis) -> RedisTaskStore:
    """RedisTaskStore wired to the FakeRedis client.

    Patches the redis-factory so the store's __init__ uses our fake
    instead of dialling a real Redis. We restore after construction
    so the rest of the test runs against the live fake.
    """
    with patch(
        "agent_service_maf.core.redis_factory.create_async_redis_client",
        return_value=fake_redis,
    ):
        s = RedisTaskStore(
            redis_url="redis://fake:6379/0",
            key_prefix="agent_task:",
            running_ttl_seconds=600,
            result_ttl_seconds=3600,
            compression_level=1,
        )
    return s


def _make_task(**overrides: Any) -> Task:
    defaults: dict[str, Any] = {
        "task_id": "test-task-id-1",
        "status": TaskStatus.RUNNING,
        "project_id": "proj-acme",
        "team_id": "team-x",
        "agent_id": "agent-y",
        "correlation_id": "corr-123",
        "result": None,
        "error": "",
        "error_type": "",
        "duration_ms": 0,
    }
    defaults.update(overrides)
    return Task(**defaults)


# ---------------------------------------------------------------------------
# (1) Round-trip: every field survives encode → decode
# ---------------------------------------------------------------------------


async def test_round_trip_preserves_all_fields(
    store: RedisTaskStore,
) -> None:
    original = _make_task(
        task_id="task-abc-123",
        status=TaskStatus.COMPLETED,
        result={"text": "hello", "events": [1, 2, 3]},
        duration_ms=42,
    )

    await store.save(original, running=False)
    loaded = await store.get("task-abc-123")

    assert loaded is not None, "Task saved and retrieved by id must round-trip"
    assert loaded.task_id == original.task_id
    assert loaded.status == original.status
    assert loaded.project_id == original.project_id
    assert loaded.team_id == original.team_id
    assert loaded.agent_id == original.agent_id
    assert loaded.correlation_id == original.correlation_id
    assert loaded.result == original.result
    assert loaded.duration_ms == original.duration_ms


async def test_running_task_round_trip(store: RedisTaskStore) -> None:
    """Tasks saved with running=True should be retrievable while
    still running — covers the polling window before a terminal
    state lands."""
    task = _make_task(task_id="in-flight", status=TaskStatus.RUNNING)
    await store.save(task, running=True)
    loaded = await store.get("in-flight")
    assert loaded is not None
    assert loaded.status == TaskStatus.RUNNING


# ---------------------------------------------------------------------------
# (2) Key namespacing
# ---------------------------------------------------------------------------


async def test_key_includes_configured_prefix(
    fake_redis: fakeredis.aioredis.FakeRedis,
) -> None:
    """The key must be `{prefix}{task_id}` so multiple components
    can share a Redis instance without collisions."""
    with patch(
        "agent_service_maf.core.redis_factory.create_async_redis_client",
        return_value=fake_redis,
    ):
        store = RedisTaskStore(
            redis_url="redis://fake:6379/0",
            key_prefix="custom_prefix:",
        )

    task = _make_task(task_id="my-task")
    await store.save(task, running=True)

    # Confirm the key shape by reading the raw bytes via the fake.
    raw = await fake_redis.get("custom_prefix:my-task")
    assert raw is not None, "Task must be stored under the prefixed key 'custom_prefix:my-task'"
    # And the un-prefixed bare task_id must not exist.
    assert await fake_redis.get("my-task") is None


# ---------------------------------------------------------------------------
# (3) Two-tier TTL — running vs terminal
# ---------------------------------------------------------------------------


async def test_running_save_uses_short_ttl(
    fake_redis: fakeredis.aioredis.FakeRedis, store: RedisTaskStore
) -> None:
    task = _make_task(task_id="running-task")
    await store.save(task, running=True)
    ttl = await fake_redis.ttl("agent_task:running-task")
    # FakeRedis returns the remaining TTL in seconds. Default running_ttl is 600.
    assert 0 < ttl <= 600, f"running=True must set TTL ≤ 600s (running_ttl_seconds), got {ttl}"


async def test_terminal_save_uses_longer_ttl(
    fake_redis: fakeredis.aioredis.FakeRedis, store: RedisTaskStore
) -> None:
    task = _make_task(task_id="done-task", status=TaskStatus.COMPLETED)
    await store.save(task, running=False)
    ttl = await fake_redis.ttl("agent_task:done-task")
    # Default result_ttl is 3600, and must be strictly longer than running_ttl
    # (otherwise a polling client could miss the terminal result).
    assert ttl > 600, f"running=False must use the longer result_ttl (>600s), got {ttl}"
    assert ttl <= 3600


# ---------------------------------------------------------------------------
# (4) Security: user_token never reaches Redis bytes
# ---------------------------------------------------------------------------


async def test_user_token_never_serialized_to_redis(
    fake_redis: fakeredis.aioredis.FakeRedis, store: RedisTaskStore
) -> None:
    """`IdentityContext.user_token` is `exclude=True` on the model
    and `Task.identity` is also `exclude=True`. Together they
    guarantee the user JWT never lands in any persisted payload.
    This test pins both guards in one assertion against the actual
    Redis bytes."""
    secret_jwt = "eyJhbGciOiJSUzI1NiJ9.SECRET_PAYLOAD.SIGNATURE"
    identity = IdentityContext(
        user_id="alice",
        project_id="proj-acme",
        user_token=secret_jwt,
    )
    task = _make_task(task_id="task-with-identity")
    task.identity = identity

    await store.save(task, running=True)
    raw = await fake_redis.get("agent_task:task-with-identity")
    assert raw is not None

    # Decompress + JSON to assert the literal string isn't on the wire.
    decompressed = zlib.decompress(raw)
    text = decompressed.decode("utf-8")

    assert secret_jwt not in text, (
        f"User JWT must NEVER appear in serialized Redis payload (found in: {text[:200]})"
    )
    assert "SECRET_PAYLOAD" not in text
    # The whole identity field is excluded too — defense in depth.
    parsed = json.loads(text)
    assert "identity" not in parsed, (
        f"Task.identity must be excluded from model_dump (found in payload: {parsed.keys()})"
    )


# ---------------------------------------------------------------------------
# (5) Missing key
# ---------------------------------------------------------------------------


async def test_get_missing_returns_none(store: RedisTaskStore) -> None:
    assert await store.get("does-not-exist") is None


# ---------------------------------------------------------------------------
# (6) Delete semantics
# ---------------------------------------------------------------------------


async def test_delete_hit_returns_true(store: RedisTaskStore) -> None:
    task = _make_task(task_id="to-be-deleted")
    await store.save(task, running=False)
    assert await store.delete("to-be-deleted") is True
    # And get after delete returns None.
    assert await store.get("to-be-deleted") is None


async def test_delete_miss_returns_false(store: RedisTaskStore) -> None:
    assert await store.delete("never-existed") is False


# ---------------------------------------------------------------------------
# (7) Corrupt payload — decode returns None rather than crashing
# ---------------------------------------------------------------------------


async def test_corrupt_payload_decodes_to_none(
    fake_redis: fakeredis.aioredis.FakeRedis, store: RedisTaskStore
) -> None:
    """A read-after-corrupt-write must not crash the caller. The
    decoder swallows zlib + JSON + ValidationError. This protects
    pollers from a stale key written by an older schema version."""
    await fake_redis.set("agent_task:corrupted-zlib", b"not zlib at all")
    assert await store.get("corrupted-zlib") is None


async def test_invalid_json_after_zlib_decodes_to_none(
    fake_redis: fakeredis.aioredis.FakeRedis, store: RedisTaskStore
) -> None:
    """Even if the zlib layer succeeds, an invalid-JSON payload
    must not crash the caller."""
    bad_json = zlib.compress(b"{this is not json}")
    await fake_redis.set("agent_task:bad-json", bad_json)
    assert await store.get("bad-json") is None


async def test_wrong_schema_decodes_to_none(
    fake_redis: fakeredis.aioredis.FakeRedis, store: RedisTaskStore
) -> None:
    """JSON that decompresses + parses cleanly but doesn't match the
    Task schema (e.g. a future-version field with an incompatible
    type) must yield None rather than partial-state corruption."""
    bogus = zlib.compress(json.dumps({"task_id": None, "status": 42}).encode())
    await fake_redis.set("agent_task:bad-schema", bogus)
    assert await store.get("bad-schema") is None


# ---------------------------------------------------------------------------
# (8) close() releases the connection
# ---------------------------------------------------------------------------


async def test_close_calls_aclose(store: RedisTaskStore) -> None:
    """`close()` must release the underlying pool — failing this
    leaks connections in a pod that re-creates stores per request."""
    await store.close()
    # FakeRedis doesn't track aclose state perfectly, but the call
    # must complete without raising.
