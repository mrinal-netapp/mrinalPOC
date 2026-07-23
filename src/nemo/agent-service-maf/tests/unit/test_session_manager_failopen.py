"""Unit tests for SessionManager fail-open semantics.

Verifies the request-scoped ``memory_degraded`` flag flips whenever the
underlying store raises, without ever propagating the exception to the
caller. This is the contract relied on by route handlers to stamp
``InvokeResponse.memory_degraded = True``.
"""

from __future__ import annotations

import contextvars
from typing import Any

import pytest

from agent_service_maf.core.session import (
    ConversationMessage,
    Session,
    SessionManager,
    memory_degraded,
    reset_memory_degraded,
)
from agent_service_maf.core.session_store import InMemorySessionStore, SessionStore


class _FailingStore(SessionStore):
    """Mock store where every operation raises a configurable exception."""

    def __init__(self, exc: Exception | None = None) -> None:
        self.exc = exc or RuntimeError("store offline")

    async def get(self, session_id: str) -> Session | None:
        raise self.exc

    async def save(self, session: Session) -> None:
        raise self.exc

    async def delete(self, session_id: str) -> bool:
        raise self.exc

    async def list_ids(self) -> list[str]:
        raise self.exc

    async def list_for_user(
        self,
        *,
        scope: Any,
        project_id: str,
        anchor: str,
        user_id: str,
    ) -> list:
        raise self.exc

    async def rename(self, session_id: str, name: str) -> bool:
        raise self.exc

    async def close(self) -> None:
        return None


def _isolated_context() -> contextvars.Context:
    """Fresh ContextVar scope so the test does not leak the flag."""
    ctx = contextvars.copy_context()
    ctx.run(reset_memory_degraded)
    return ctx


@pytest.fixture(autouse=True)
def _reset_flag() -> None:
    """Ensure no prior test leaves the flag flipped."""
    reset_memory_degraded()


class TestMarkDegradedHelper:
    def test_default_is_false(self) -> None:
        assert memory_degraded() is False

    def test_reset(self) -> None:
        from agent_service_maf.core.session import mark_memory_degraded

        mark_memory_degraded()
        assert memory_degraded() is True
        reset_memory_degraded()
        assert memory_degraded() is False


class TestSessionManagerFailOpen:
    async def test_get_or_create_returns_fresh_session_when_store_fails(self) -> None:
        sm = SessionManager(store=_FailingStore())
        session = await sm.get_or_create("team:p:t:u:s1")
        assert session.session_id == "team:p:t:u:s1"
        assert session.messages == []
        assert memory_degraded() is True

    async def test_get_returns_none_when_store_fails(self) -> None:
        sm = SessionManager(store=_FailingStore())
        assert await sm.get("team:p:t:u:s1") is None
        assert memory_degraded() is True

    async def test_append_message_swallows_store_failure(self) -> None:
        sm = SessionManager(store=_FailingStore())
        # Must not raise — fail-open.
        await sm.append_message(
            "team:p:t:u:s1",
            ConversationMessage(role="user", content="hi"),
        )
        assert memory_degraded() is True

    async def test_get_history_returns_empty_on_failure(self) -> None:
        sm = SessionManager(store=_FailingStore())
        assert await sm.get_history("team:p:t:u:s1") == []
        assert memory_degraded() is True

    async def test_clear_session_returns_false_on_failure(self) -> None:
        sm = SessionManager(store=_FailingStore())
        assert await sm.clear_session("team:p:t:u:s1") is False
        assert memory_degraded() is True

    async def test_list_for_user_returns_empty_on_failure(self) -> None:
        sm = SessionManager(store=_FailingStore())
        result = await sm.list_for_user(
            scope="team",
            project_id="p",
            anchor="t",
            user_id="u",
        )
        assert result == []
        assert memory_degraded() is True

    async def test_rename_session_returns_false_on_failure(self) -> None:
        sm = SessionManager(store=_FailingStore())
        assert await sm.rename_session("team:p:t:u:s1", "name") is False
        assert memory_degraded() is True

    async def test_happy_path_does_not_set_flag(self) -> None:
        sm = SessionManager(store=InMemorySessionStore())
        await sm.append_message(
            "team:p:t:u:s1",
            ConversationMessage(role="user", content="hi"),
        )
        assert memory_degraded() is False


class TestSessionManagerBudgetCaps:
    async def test_message_cap_enforced(self) -> None:
        sm = SessionManager(
            store=InMemorySessionStore(),
            max_session_messages=3,
        )
        for i in range(10):
            await sm.append_message(
                "team:p:t:u:s1",
                ConversationMessage(role="user", content=f"msg-{i}"),
            )
        history = await sm.get_history("team:p:t:u:s1")
        assert len(history) == 3
        # Most recent must be preserved.
        assert history[-1].content == "msg-9"

    async def test_byte_cap_truncates_oldest(self) -> None:
        sm = SessionManager(
            store=InMemorySessionStore(),
            max_session_bytes=400,  # ~3 messages of ~120 bytes each
        )
        for i in range(20):
            await sm.append_message(
                "team:p:t:u:s1",
                ConversationMessage(role="user", content="x" * 50),
            )
        history = await sm.get_history("team:p:t:u:s1")
        # Most recent message is preserved; older ones dropped.
        assert len(history) < 20
        assert len(history) >= 1

    async def test_per_user_session_cap_evicts_oldest(self) -> None:
        sm = SessionManager(
            store=InMemorySessionStore(),
            max_sessions_per_user=2,
        )
        # Create 3 sessions for the same user; the oldest should be evicted
        # when the 3rd is first written.
        import asyncio

        for i in range(3):
            await sm.append_message(
                f"team:p:t:u:s{i}",
                ConversationMessage(role="user", content=f"msg-{i}"),
            )
            await asyncio.sleep(0.005)
        summaries = await sm.list_for_user(
            scope="team",
            project_id="p",
            anchor="t",
            user_id="u",
        )
        assert len(summaries) == 2
        ids = {s.session_id for s in summaries}
        assert "s0" not in ids  # oldest evicted
        assert "s2" in ids  # newest preserved
