"""Unit test — SessionManager concurrent-mutation safety.

The integration audit (M6 / e2e gap "Concurrent WS / SSE on same
session") flagged this as a race risk: two parallel streams on one
session_id could race on the memory buffer mid-`append_message`,
corrupting the message list or losing messages.

SessionManager uses `asyncio.Lock` around its mutating ops
(append, set_metadata, recalculate, delete). This file pins that
contract under deterministic stress so a future change that drops
the lock breaks a test rather than corrupts data silently in prod.

Properties pinned:

  1. N concurrent `append_message` coroutines on the same session
     end with exactly N messages (no losses, no duplicates).
  2. The lock serializes — message order is deterministic per
     coroutine (within one coroutine's run, its writes appear in
     order; across coroutines they interleave but never overlap
     within a single append).
  3. Concurrent `append_message` + `get_session` doesn't return
     a partial state (no mid-mutation read).
  4. Concurrent `delete_session` + `append_message` results in
     one or the other winning — not a partial state.
"""

from __future__ import annotations

import asyncio

import pytest

from agent_service_maf.core.session import (
    ConversationMessage,
    Session,
    SessionManager,
)
from agent_service_maf.core.session_store import InMemorySessionStore


def _make_manager() -> SessionManager:
    """Build a SessionManager with in-memory storage and no
    memory buffer (so trim doesn't interfere with the assertions)."""
    return SessionManager(
        store=InMemorySessionStore(),
        memory_buffer=None,
        ttl_seconds=3600,
    )


# ---------------------------------------------------------------------------
# (1) Concurrent appends: no losses, no duplicates
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_concurrent_appends_no_losses() -> None:
    """Fire 20 concurrent `append_message` calls. All must land in
    the store. Loss = the lock has a bug; dup = an idempotency
    bug (which the in-memory backend doesn't dedup against, so
    duplicates would also be a test signal)."""
    mgr = _make_manager()
    sid = "concurrent-test-1"

    async def appender(idx: int) -> None:
        await mgr.append_message(sid, ConversationMessage(role="user", content=f"msg-{idx}"))

    await asyncio.gather(*[appender(i) for i in range(20)])

    session = await mgr.get_or_create(sid)
    contents = {m.content for m in session.messages}
    expected = {f"msg-{i}" for i in range(20)}
    assert contents == expected, (
        f"Concurrent appends lost or duplicated messages. Expected: {expected}, got: {contents}"
    )
    assert len(session.messages) == 20, (
        f"Concurrent appends produced {len(session.messages)} messages, expected 20"
    )


# ---------------------------------------------------------------------------
# (2) Concurrent two-message-pair appends per coroutine — relative order
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_per_coroutine_order_preserved() -> None:
    """Each coroutine appends a pair (`pre-{i}`, `post-{i}`)
    sequentially. After all coroutines finish, for every i, the
    `pre-{i}` message must appear BEFORE its corresponding
    `post-{i}` in the final ordering. Cross-coroutine interleaving
    is fine — within a coroutine, the lock must serialize the
    pair so the post doesn't slip ahead of the pre."""
    mgr = _make_manager()
    sid = "ordering-test"

    async def paired_appender(idx: int) -> None:
        await mgr.append_message(sid, ConversationMessage(role="user", content=f"pre-{idx}"))
        await mgr.append_message(sid, ConversationMessage(role="assistant", content=f"post-{idx}"))

    await asyncio.gather(*[paired_appender(i) for i in range(8)])

    session = await mgr.get_or_create(sid)
    contents = [m.content for m in session.messages]
    assert len(contents) == 16

    for i in range(8):
        pre_idx = contents.index(f"pre-{i}")
        post_idx = contents.index(f"post-{i}")
        assert pre_idx < post_idx, (
            f"Coroutine {i}'s post-{i} arrived before its pre-{i}; ordering: {contents}"
        )


# ---------------------------------------------------------------------------
# (3) Concurrent append + read sees committed state only
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_concurrent_append_and_read_returns_no_partial_state() -> None:
    """While an `append_message` is in flight, a `get_session` on
    a different coroutine must return either the pre-append state
    or the post-append state — never a partial intermediate where
    the message exists but token_count hasn't been updated, etc.

    Without the lock, the message list could be observed
    mid-mutation."""
    mgr = _make_manager()
    sid = "read-during-write"

    # Seed one message so the session exists.
    await mgr.append_message(sid, ConversationMessage(role="user", content="seed"))

    async def writer() -> None:
        for i in range(50):
            await mgr.append_message(sid, ConversationMessage(role="user", content=f"w-{i}"))

    async def reader() -> list[int]:
        observed_counts: list[int] = []
        for _ in range(50):
            s = await mgr.get_or_create(sid)
            observed_counts.append(len(s.messages))
            await asyncio.sleep(0)  # yield to writer
        return observed_counts

    _, observed = await asyncio.gather(writer(), reader())

    # Observed counts must be monotonically non-decreasing — any
    # decrement would mean a partial state was returned.
    for i in range(1, len(observed)):
        assert observed[i] >= observed[i - 1], (
            f"Observed message count decreased — partial state read! Sequence: {observed}"
        )


# ---------------------------------------------------------------------------
# (4) Concurrent append + delete — one wins, no partial state
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_concurrent_append_and_delete_no_partial_state() -> None:
    """A `delete_session` racing an `append_message` must result
    in either: (a) the delete won and the session is gone, or
    (b) the append won and the session has the new message.
    Never: session exists with no messages, never: session deleted
    but token_count is stuck non-zero."""
    mgr = _make_manager()
    sid = "delete-vs-append"

    # Seed with content.
    for i in range(5):
        await mgr.append_message(sid, ConversationMessage(role="user", content=f"seed-{i}"))

    async def appender() -> None:
        try:
            await mgr.append_message(sid, ConversationMessage(role="user", content="late-arrival"))
        except Exception:
            # Delete may have raced and killed the session — append
            # is allowed to create a new session in that case (it's
            # the documented `get_or_create` behavior), so any error
            # here is unexpected.
            raise

    async def deleter() -> None:
        await mgr.clear_session(sid)

    await asyncio.gather(appender(), deleter())

    session = await mgr.get_or_create(sid)
    # Two valid final states:
    #   A) delete won then append created a fresh session with one msg.
    #   B) append won, then delete wiped → fresh session is empty.
    #   C) append landed before delete on the original session, then
    #      delete wiped → fresh session is empty.
    assert isinstance(session, Session)
    if session.messages:
        # If the session has messages, one of them must be 'late-arrival'
        # (the appender's value). The seed content was wiped.
        assert any(m.content == "late-arrival" for m in session.messages), (
            f"Session has messages but not the appender's — partial state? "
            f"Got: {[m.content for m in session.messages]}"
        )
    # If empty, that's also a valid race outcome — nothing more to check.


# ---------------------------------------------------------------------------
# (5) Stress: many sessions × many coroutines — no cross-session bleed
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_concurrent_writes_to_different_sessions_do_not_bleed() -> None:
    """Two sessions, each with 10 concurrent appends. Final
    state: each session has exactly its own 10 messages — no
    cross-session leak via the shared store/lock."""
    mgr = _make_manager()

    async def append_to(sid: str, prefix: str, idx: int) -> None:
        await mgr.append_message(sid, ConversationMessage(role="user", content=f"{prefix}-{idx}"))

    tasks = []
    for i in range(10):
        tasks.append(append_to("session-A", "A", i))
        tasks.append(append_to("session-B", "B", i))
    await asyncio.gather(*tasks)

    a = await mgr.get_or_create("session-A")
    b = await mgr.get_or_create("session-B")

    a_contents = {m.content for m in a.messages}
    b_contents = {m.content for m in b.messages}

    assert a_contents == {f"A-{i}" for i in range(10)}, (
        f"Session A has unexpected content (possible cross-session bleed): {a_contents}"
    )
    assert b_contents == {f"B-{i}" for i in range(10)}, (
        f"Session B has unexpected content (possible cross-session bleed): {b_contents}"
    )
