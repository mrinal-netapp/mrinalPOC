"""Unit test — `RedisSessionStore` round-trip + cross-scope isolation.

The unit audit (H2) flagged `RedisSessionStore` as zero-coverage
(lines 575-1005, ~430 LOC). `InMemorySessionStore` is exercised by
the existing test_session_store.py; the Redis backend — which holds
*every* session in multi-instance prod — was completely unverified
at unit tier.

This test uses `fakeredis.aioredis` to exercise the real encoder +
key-namespacing + index-set + meta-hash + TTL pipeline, mirroring
the pattern from test_redis_task_store.py.

Properties pinned:

  1. `save` + `get` round-trip a Session identically — every field
     survives zlib+JSON+pipeline.
  2. The three keys land under the configured prefixes
     (`agent_session:`, `agent_session_meta:`, `agent_session_index:`).
  3. The index-set key includes scope/project_id/anchor/user_id so
     two users in the same project don't share an index entry.
  4. `delete` removes session+meta and SREMs the index entry —
     orphan index keys are how prod data leaks across scopes.
  5. `list_for_user` only returns sessions for the matching index
     tuple. Cross-tenant: user A in project X cannot see user B's
     sessions in project Y.
  6. TTL refreshed on every save (running window).
  7. Corrupt payload decodes to None — defensive against schema
     drift across versions.
"""

from __future__ import annotations

from unittest.mock import patch

import fakeredis.aioredis
import pytest

from agent_service_maf.core.session import (
    ConversationMessage,
    Session,
)
from agent_service_maf.core.session_store import RedisSessionStore

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_redis() -> fakeredis.aioredis.FakeRedis:
    return fakeredis.aioredis.FakeRedis(decode_responses=False)


@pytest.fixture
def store(fake_redis: fakeredis.aioredis.FakeRedis) -> RedisSessionStore:
    with patch(
        "agent_service_maf.core.redis_factory.create_async_redis_client",
        return_value=fake_redis,
    ):
        return RedisSessionStore(
            redis_url="redis://fake:6379/0",
            key_prefix="agent_session:",
            index_prefix="agent_session_index:",
            meta_prefix="agent_session_meta:",
            ttl_seconds=3600,
            compression_level=1,
        )


def _make_session(scoped_id: str, *, messages: int = 1) -> Session:
    return Session(
        session_id=scoped_id,
        messages=[ConversationMessage(role="user", content=f"hi-{i}") for i in range(messages)],
        metadata={"hint": "test"},
        token_count=42,
    )


# Phase-2 scoped session id format: {scope}:{project_id}:{anchor}:{user_id}:{raw_id}
def _scoped(
    scope: str = "team",
    project_id: str = "proj-A",
    anchor: str = "team-x",
    user_id: str = "alice",
    raw: str = "sess-1",
) -> str:
    return f"{scope}:{project_id}:{anchor}:{user_id}:{raw}"


# ---------------------------------------------------------------------------
# (1) Round-trip
# ---------------------------------------------------------------------------


async def test_round_trip_preserves_session_fields(
    store: RedisSessionStore,
) -> None:
    sid = _scoped(raw="round-trip")
    original = _make_session(sid, messages=3)

    await store.save(original)
    loaded = await store.get(sid)

    assert loaded is not None
    assert loaded.session_id == original.session_id
    assert len(loaded.messages) == 3
    assert [m.content for m in loaded.messages] == ["hi-0", "hi-1", "hi-2"]
    assert loaded.metadata == {"hint": "test"}
    assert loaded.token_count == 42


# ---------------------------------------------------------------------------
# (2) Key namespacing
# ---------------------------------------------------------------------------


async def test_save_writes_three_keys_under_configured_prefixes(
    fake_redis: fakeredis.aioredis.FakeRedis, store: RedisSessionStore
) -> None:
    sid = _scoped(scope="team", project_id="P", anchor="T", user_id="u1", raw="r")
    await store.save(_make_session(sid))

    # Session blob
    assert await fake_redis.get(f"agent_session:{sid}") is not None
    # Meta hash
    meta = await fake_redis.hgetall(f"agent_session_meta:{sid}")
    assert meta, "meta hash must be written next to the session blob"
    # Index set
    index_members = await fake_redis.smembers("agent_session_index:team:P:T:u1")
    decoded = {m.decode("utf-8") if isinstance(m, bytes) else m for m in index_members}
    assert sid in decoded, (
        f"index set 'agent_session_index:team:P:T:u1' must contain the scoped id, got: {decoded}"
    )


# ---------------------------------------------------------------------------
# (3) Cross-scope index isolation
# ---------------------------------------------------------------------------


async def test_two_users_same_project_have_separate_index_sets(
    fake_redis: fakeredis.aioredis.FakeRedis, store: RedisSessionStore
) -> None:
    """user alice@P and user bob@P must each have their own index set;
    smembers on one must not return the other's sessions."""
    sid_alice = _scoped(project_id="P", user_id="alice", raw="a1")
    sid_bob = _scoped(project_id="P", user_id="bob", raw="b1")
    await store.save(_make_session(sid_alice))
    await store.save(_make_session(sid_bob))

    alice_idx = await fake_redis.smembers("agent_session_index:team:P:team-x:alice")
    bob_idx = await fake_redis.smembers("agent_session_index:team:P:team-x:bob")

    alice_decoded = {m.decode("utf-8") if isinstance(m, bytes) else m for m in alice_idx}
    bob_decoded = {m.decode("utf-8") if isinstance(m, bytes) else m for m in bob_idx}

    assert sid_alice in alice_decoded
    assert sid_alice not in bob_decoded, (
        "Bob's index must NOT contain Alice's session — this would be a tenant-leak bug"
    )
    assert sid_bob in bob_decoded
    assert sid_bob not in alice_decoded


async def test_same_user_in_different_projects_have_separate_index_sets(
    fake_redis: fakeredis.aioredis.FakeRedis, store: RedisSessionStore
) -> None:
    """The same user_id under project A vs project B must be indexed
    separately. If they collapsed to one index, project-scope leakage
    would be one missing scope-check away."""
    sid_a = _scoped(project_id="proj-A", user_id="alice", raw="a")
    sid_b = _scoped(project_id="proj-B", user_id="alice", raw="b")
    await store.save(_make_session(sid_a))
    await store.save(_make_session(sid_b))

    a_idx = await fake_redis.smembers("agent_session_index:team:proj-A:team-x:alice")
    b_idx = await fake_redis.smembers("agent_session_index:team:proj-B:team-x:alice")

    a_decoded = {m.decode("utf-8") if isinstance(m, bytes) else m for m in a_idx}
    b_decoded = {m.decode("utf-8") if isinstance(m, bytes) else m for m in b_idx}

    assert sid_a in a_decoded and sid_a not in b_decoded
    assert sid_b in b_decoded and sid_b not in a_decoded


# ---------------------------------------------------------------------------
# (4) Delete semantics
# ---------------------------------------------------------------------------


async def test_delete_removes_session_meta_and_index_entry(
    fake_redis: fakeredis.aioredis.FakeRedis, store: RedisSessionStore
) -> None:
    sid = _scoped(raw="to-delete")
    await store.save(_make_session(sid))

    assert await store.delete(sid) is True
    # All three keys gone.
    assert await fake_redis.get(f"agent_session:{sid}") is None
    assert await fake_redis.hgetall(f"agent_session_meta:{sid}") == {}
    members = await fake_redis.smembers("agent_session_index:team:proj-A:team-x:alice")
    assert sid not in {m.decode("utf-8") if isinstance(m, bytes) else m for m in members}, (
        "delete must SREM the scoped id from the per-user index set"
    )


async def test_delete_miss_returns_false(store: RedisSessionStore) -> None:
    assert await store.delete(_scoped(raw="never-existed")) is False


# ---------------------------------------------------------------------------
# (5) list_for_user — cross-tenant
# ---------------------------------------------------------------------------


async def test_list_for_user_only_returns_matching_index(
    store: RedisSessionStore,
) -> None:
    """`list_for_user(scope=..., project_id=..., anchor=..., user_id=...)`
    must only return sessions whose index tuple matches exactly. This
    is the headline tenant-isolation guarantee."""
    # alice in proj-A has 2 sessions; bob in proj-A has 1; alice in proj-B has 1.
    await store.save(_make_session(_scoped(project_id="proj-A", user_id="alice", raw="a1")))
    await store.save(_make_session(_scoped(project_id="proj-A", user_id="alice", raw="a2")))
    await store.save(_make_session(_scoped(project_id="proj-A", user_id="bob", raw="b1")))
    await store.save(_make_session(_scoped(project_id="proj-B", user_id="alice", raw="aP2")))

    alice_pA = await store.list_for_user(
        scope="team", project_id="proj-A", anchor="team-x", user_id="alice"
    )
    bob_pA = await store.list_for_user(
        scope="team", project_id="proj-A", anchor="team-x", user_id="bob"
    )
    alice_pB = await store.list_for_user(
        scope="team", project_id="proj-B", anchor="team-x", user_id="alice"
    )

    assert {s.session_id for s in alice_pA} == {"a1", "a2"}
    assert {s.session_id for s in bob_pA} == {"b1"}
    assert {s.session_id for s in alice_pB} == {"aP2"}


# ---------------------------------------------------------------------------
# (6) TTL refresh
# ---------------------------------------------------------------------------


async def test_save_sets_ttl_on_all_three_keys(
    fake_redis: fakeredis.aioredis.FakeRedis, store: RedisSessionStore
) -> None:
    """All three keys (session, meta, index) must carry the same TTL
    so a stale client polling after eviction doesn't see partial
    state."""
    sid = _scoped(raw="ttl-test")
    await store.save(_make_session(sid))

    session_ttl = await fake_redis.ttl(f"agent_session:{sid}")
    meta_ttl = await fake_redis.ttl(f"agent_session_meta:{sid}")
    index_ttl = await fake_redis.ttl("agent_session_index:team:proj-A:team-x:alice")

    # Default ttl_seconds=3600; allow a small margin for fakeredis timing.
    assert 0 < session_ttl <= 3600
    assert 0 < meta_ttl <= 3600
    assert 0 < index_ttl <= 3600


# ---------------------------------------------------------------------------
# (7) Corrupt-payload tolerance
# ---------------------------------------------------------------------------


async def test_corrupt_payload_decodes_to_none(
    fake_redis: fakeredis.aioredis.FakeRedis, store: RedisSessionStore
) -> None:
    sid = _scoped(raw="bad-zlib")
    await fake_redis.set(f"agent_session:{sid}", b"not zlib at all and not json either")
    # _try_decode swallows zlib.error + json.JSONDecodeError and returns None.
    # The store's get() then returns None rather than raising.
    result = await store.get(sid)
    assert result is None


async def test_legacy_plain_json_payload_decodes_successfully(
    fake_redis: fakeredis.aioredis.FakeRedis, store: RedisSessionStore
) -> None:
    """Pre-Phase-1 entries were stored as plain JSON (no zlib). The
    backward-compat fallback must read them too."""
    import json
    import time as _time

    sid = _scoped(raw="legacy-plain-json")
    legacy_payload = json.dumps(
        {
            "session_id": sid,
            "messages": [{"role": "user", "content": "legacy hi"}],
            "created_at": _time.time(),
            "last_accessed": _time.time(),
            "metadata": {},
            "token_count": 0,
        }
    ).encode("utf-8")
    await fake_redis.set(f"agent_session:{sid}", legacy_payload)

    loaded = await store.get(sid)
    assert loaded is not None, "Legacy plain-JSON payloads must still decode"
    assert loaded.session_id == sid
    assert len(loaded.messages) == 1


# ---------------------------------------------------------------------------
# (8) Rename
# ---------------------------------------------------------------------------


async def test_rename_returns_true_for_existing_session(
    fake_redis: fakeredis.aioredis.FakeRedis, store: RedisSessionStore
) -> None:
    sid = _scoped(raw="rename-test")
    await store.save(_make_session(sid))
    assert await store.rename(sid, "Friendly New Name") is True

    name = await fake_redis.hget(f"agent_session_meta:{sid}", "name")
    decoded = name.decode("utf-8") if isinstance(name, bytes) else name
    assert decoded == "Friendly New Name"


async def test_rename_returns_false_for_missing_session(
    store: RedisSessionStore,
) -> None:
    assert await store.rename(_scoped(raw="ghost"), "Doesn't matter") is False
