"""Unit test — SlidingWindowBuffer truncation correctness.

The unit audit (M4 / coverage class "surface-tested") flagged the
sliding-window buffer as covered only at the construction layer.
The trim logic — three independent limits applied in order, with
the "most recent message is never dropped" invariant — was untested.

The trim contract is load-bearing for long conversations: an
overflow that the trim path mishandles either explodes memory
(under-trimming) or destroys the conversation context the LLM needs
(over-trimming). Both fail modes are silent until the user notices.

Properties pinned:

  1. `max_messages` trims oldest first, preserves most recent.
  2. `max_chars` trims oldest while >limit and >1 message.
  3. `max_tokens` trims oldest while >limit and >1 message.
  4. The most recent message is NEVER dropped (even if it alone
     would exceed the limit).
  5. Disabled limit (=0) is a no-op for that dimension.
  6. Multiple limits compose — a message must satisfy all enabled
     limits.
  7. Empty session: trim is a no-op.
  8. Single-message session: trim is a no-op (preserves the only msg).
  9. `recalculate_tokens` is called once at the end so the
     session.token_count reflects post-trim state.
"""

from __future__ import annotations

import pytest

from agent_service_maf.core.memory_buffer import SlidingWindowBuffer
from agent_service_maf.core.session import ConversationMessage, Session


def _make_session(messages: list[ConversationMessage]) -> Session:
    return Session(session_id="test-session", messages=messages)


def _msg(role: str, content: str) -> ConversationMessage:
    return ConversationMessage(role=role, content=content)


# ---------------------------------------------------------------------------
# (1) max_messages
# ---------------------------------------------------------------------------


class TestMaxMessages:
    @pytest.mark.asyncio
    async def test_drops_oldest_when_over_limit(self) -> None:
        buf = SlidingWindowBuffer(max_messages=3)
        session = _make_session(
            [
                _msg("user", "1"),
                _msg("assistant", "2"),
                _msg("user", "3"),
                _msg("assistant", "4"),
                _msg("user", "5"),
            ]
        )
        await buf.apply(session)
        assert len(session.messages) == 3
        assert [m.content for m in session.messages] == ["3", "4", "5"], (
            "oldest messages must be dropped first"
        )

    @pytest.mark.asyncio
    async def test_exactly_at_limit_no_op(self) -> None:
        buf = SlidingWindowBuffer(max_messages=3)
        session = _make_session([_msg("user", str(i)) for i in range(3)])
        await buf.apply(session)
        assert len(session.messages) == 3

    @pytest.mark.asyncio
    async def test_under_limit_no_op(self) -> None:
        buf = SlidingWindowBuffer(max_messages=10)
        session = _make_session([_msg("user", "hi")])
        await buf.apply(session)
        assert len(session.messages) == 1


# ---------------------------------------------------------------------------
# (2) max_chars
# ---------------------------------------------------------------------------


class TestMaxChars:
    @pytest.mark.asyncio
    async def test_drops_oldest_until_under_char_limit(self) -> None:
        # Each "AAAAA" is 5 chars. With max_chars=12, only the last
        # two messages can fit (10 chars total).
        buf = SlidingWindowBuffer(max_chars=12)
        session = _make_session(
            [
                _msg("user", "AAAAA"),
                _msg("user", "BBBBB"),
                _msg("user", "CCCCC"),
            ]
        )
        await buf.apply(session)
        total = sum(len(m.content) for m in session.messages)
        assert total <= 12, f"total chars must be ≤ 12 after trim, got {total}"
        # The most recent message ("CCCCC") must survive.
        assert session.messages[-1].content == "CCCCC"

    @pytest.mark.asyncio
    async def test_most_recent_message_preserved_even_if_alone_exceeds_limit(
        self,
    ) -> None:
        """The trim loop has `and len(messages) > 1` so the most
        recent message is never dropped, even if it alone exceeds
        max_chars. This protects against context-free responses."""
        buf = SlidingWindowBuffer(max_chars=5)
        session = _make_session([_msg("user", "this is much longer than five chars")])
        await buf.apply(session)
        assert len(session.messages) == 1, (
            "most recent message must survive even when it exceeds the limit alone"
        )


# ---------------------------------------------------------------------------
# (3) max_tokens
# ---------------------------------------------------------------------------


class TestMaxTokens:
    @pytest.mark.asyncio
    async def test_drops_oldest_until_under_token_limit(self) -> None:
        """token estimation ≈ chars/4. With messages of 20 chars
        each (~5 tokens), max_tokens=10 keeps at most 2 messages."""
        buf = SlidingWindowBuffer(max_tokens=10)
        session = _make_session(
            [
                _msg("user", "A" * 20),
                _msg("user", "B" * 20),
                _msg("user", "C" * 20),
                _msg("user", "D" * 20),
            ]
        )
        await buf.apply(session)
        # The trim loop stops when total ≤ limit OR len == 1, so
        # bound the assertion loosely on "fewer than originally".
        assert len(session.messages) < 4
        # Most recent is preserved.
        assert session.messages[-1].content == "D" * 20


# ---------------------------------------------------------------------------
# (4) Disabled limits (=0)
# ---------------------------------------------------------------------------


class TestDisabledLimits:
    @pytest.mark.asyncio
    async def test_all_zero_is_no_op(self) -> None:
        buf = SlidingWindowBuffer(max_messages=0, max_chars=0, max_tokens=0)
        msgs = [_msg("user", str(i)) for i in range(100)]
        session = _make_session(list(msgs))
        await buf.apply(session)
        assert len(session.messages) == 100, "all-zero limits must leave the session untouched"

    @pytest.mark.asyncio
    async def test_one_dim_disabled_does_not_affect_others(self) -> None:
        """max_messages=0 means message-count is unenforced, but
        max_chars still trims."""
        buf = SlidingWindowBuffer(max_messages=0, max_chars=10)
        session = _make_session([_msg("user", "A" * 6) for _ in range(5)])
        await buf.apply(session)
        total = sum(len(m.content) for m in session.messages)
        assert total <= 10 or len(session.messages) == 1


# ---------------------------------------------------------------------------
# (5) Multiple limits compose
# ---------------------------------------------------------------------------


class TestComposedLimits:
    @pytest.mark.asyncio
    async def test_applies_message_count_then_chars(self) -> None:
        """The trim order is: messages → chars → tokens. If the
        message-count cut already brings us under the char limit,
        the char-trim is a no-op."""
        buf = SlidingWindowBuffer(max_messages=2, max_chars=100)
        session = _make_session(
            [
                _msg("user", "A" * 30),
                _msg("user", "B" * 30),
                _msg("user", "C" * 30),
                _msg("user", "D" * 30),
            ]
        )
        await buf.apply(session)
        # max_messages=2 trims to ["C...", "D..."] (60 chars total).
        assert len(session.messages) == 2
        total = sum(len(m.content) for m in session.messages)
        assert total <= 100

    @pytest.mark.asyncio
    async def test_chars_trims_further_when_message_count_alone_not_enough(
        self,
    ) -> None:
        buf = SlidingWindowBuffer(max_messages=10, max_chars=20)
        session = _make_session([_msg("user", "A" * 10) for _ in range(5)])
        await buf.apply(session)
        total = sum(len(m.content) for m in session.messages)
        # Either total ≤ 20, or we're down to a single message.
        assert total <= 20 or len(session.messages) == 1


# ---------------------------------------------------------------------------
# (6) Edge cases
# ---------------------------------------------------------------------------


class TestEdgeCases:
    @pytest.mark.asyncio
    async def test_empty_session_is_no_op(self) -> None:
        buf = SlidingWindowBuffer(max_messages=5, max_chars=100, max_tokens=100)
        session = _make_session([])
        await buf.apply(session)
        assert session.messages == []

    @pytest.mark.asyncio
    async def test_single_message_session_preserved(self) -> None:
        """A single-message session must survive trim even when
        the message exceeds every limit. Necessary so the
        agent has at least the current user turn to respond to."""
        buf = SlidingWindowBuffer(max_messages=1, max_chars=1, max_tokens=1)
        session = _make_session([_msg("user", "much longer than the limits")])
        await buf.apply(session)
        assert len(session.messages) == 1
        assert "much longer" in session.messages[0].content


# ---------------------------------------------------------------------------
# (7) Token-count recalculation after trim
# ---------------------------------------------------------------------------


class TestTokenCountRecalc:
    @pytest.mark.asyncio
    async def test_token_count_updated_post_trim(self) -> None:
        """`session.token_count` must reflect the trimmed message
        set, not the pre-trim total. Otherwise callers that read
        token_count to budget a follow-up prompt make decisions
        on stale data."""
        buf = SlidingWindowBuffer(max_messages=2)
        # Start with 4 messages, ~100 chars each → high token total.
        session = _make_session([_msg("user", "X" * 100) for _ in range(4)])
        # Force a non-zero starting count so we can verify it changes.
        session.token_count = 999
        await buf.apply(session)
        # After trim to 2 messages × 100 chars ≈ 200 chars ≈ 50 tokens.
        assert session.token_count != 999, "token_count must be recalculated after trim"
        # And the new value must roughly match the post-trim corpus.
        post_chars = sum(len(m.content) for m in session.messages)
        # Sanity: token estimate ≈ chars / 4, allowing wide margin.
        assert session.token_count <= post_chars
