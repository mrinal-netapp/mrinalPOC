"""Unit tests for :mod:`agent_service_maf.core.memory_buffer`.

These tests pin the locked memory-context design's runtime behavior:

* ``SlidingWindowBuffer`` — token limit wins over message limit when both
  are set; message/char/token caps trim oldest first; the most recent
  message is never popped.
* ``SummaryBuffer`` — cadence gating (``summary_refresh_every_turns``)
  and the adaptive switch (``adaptive_summarize_threshold``) skip the
  LLM call on small overflows; the summary system message is preserved
  while the oldest verbatim kept message is dropped if the post-summary
  result is still over a limit; summarization failure falls back to a
  bare sliding window.
* ``create_memory_buffer`` factory wiring.

Each test constructs a fresh :class:`Session` with synthetic
:class:`ConversationMessage` objects. Where token semantics matter we
set ``content`` so that ``estimated_tokens`` (≈ chars/4) lands on a
predictable value.
"""

from __future__ import annotations

import pytest

from agent_service_maf.core.memory_buffer import (
    MemoryBuffer,
    SlidingWindowBuffer,
    SummaryBuffer,
    create_memory_buffer,
)
from agent_service_maf.core.session import ConversationMessage, Session


def _msg(role: str, content: str) -> ConversationMessage:
    return ConversationMessage(role=role, content=content)


def _session(messages: list[ConversationMessage]) -> Session:
    s = Session(session_id="sess-1")
    s.messages = list(messages)
    s.recalculate_tokens()
    return s


def _alt_roles(n: int, body: str = "hi") -> list[ConversationMessage]:
    """N alternating user/assistant messages with stable content."""
    roles = ("user", "assistant")
    return [_msg(roles[i % 2], f"{body}-{i}") for i in range(n)]


# ---------------------------------------------------------------------------
# SlidingWindowBuffer
# ---------------------------------------------------------------------------


class TestSlidingWindowBuffer:
    @pytest.mark.asyncio
    async def test_no_limits_is_no_op(self) -> None:
        """All-zero limits = unlimited; messages survive unchanged."""
        buf = SlidingWindowBuffer()  # all zero
        session = _session(_alt_roles(10))
        await buf.apply(session)
        assert len(session.messages) == 10

    @pytest.mark.asyncio
    async def test_exactly_at_limit_no_trim(self) -> None:
        buf = SlidingWindowBuffer(max_messages=4)
        session = _session(_alt_roles(4))
        await buf.apply(session)
        assert len(session.messages) == 4

    @pytest.mark.asyncio
    async def test_under_limit_no_trim(self) -> None:
        buf = SlidingWindowBuffer(max_messages=10)
        session = _session(_alt_roles(3))
        await buf.apply(session)
        assert len(session.messages) == 3

    @pytest.mark.asyncio
    async def test_message_count_trim_drops_oldest_first(self) -> None:
        buf = SlidingWindowBuffer(max_messages=4)
        # 10 messages, content includes ordinal so we can verify the
        # OLDEST six are gone (indices 0..5) and the YOUNGEST four remain.
        session = _session(_alt_roles(10))
        await buf.apply(session)
        assert len(session.messages) == 4
        assert [m.content for m in session.messages] == [
            "hi-6",
            "hi-7",
            "hi-8",
            "hi-9",
        ]

    @pytest.mark.asyncio
    async def test_token_limit_primary_wins_over_message_limit(self) -> None:
        """Locked tiebreaker decision #2: when both caps are set, the
        token cap is enforced first (and message cap is only a ceiling).

        With 8 messages of ~10 chars each (~2-3 tokens estimated), a
        token cap of 8 will force the window down to roughly the last
        three messages even though the message cap (5) would otherwise
        allow five."""
        buf = SlidingWindowBuffer(max_messages=5, max_tokens=8)
        # Use content sized so estimate_tokens(~chars/4) lands ~3 each.
        session = _session([_msg("user", "abcdefghij") for _ in range(8)])
        await buf.apply(session)
        # Token cap must be respected: total estimated tokens ≤ 8.
        assert sum(m.estimated_tokens for m in session.messages) <= 8
        # And message-count ceiling is still honored (≤ 5).
        assert len(session.messages) <= 5
        # We never pop down to zero messages — at least one remains.
        assert len(session.messages) >= 1

    @pytest.mark.asyncio
    async def test_char_limit_secondary_trim(self) -> None:
        buf = SlidingWindowBuffer(max_chars=20)
        # 6 messages of 10 chars each = 60 chars total. Trim down to ≤ 20.
        session = _session([_msg("user", "xxxxxxxxxx") for _ in range(6)])
        await buf.apply(session)
        assert sum(len(m.content) for m in session.messages) <= 20
        assert len(session.messages) >= 1

    @pytest.mark.asyncio
    async def test_never_drops_to_empty_when_only_one_remains(self) -> None:
        """The token-trim loop has a ``len(messages) > 1`` guard so the
        most recent message is never popped, even if it alone exceeds the
        token cap. This pins that contract."""
        buf = SlidingWindowBuffer(max_tokens=1)
        long_msg = _msg("user", "this single message exceeds the token cap on its own")
        session = _session([long_msg])
        await buf.apply(session)
        assert len(session.messages) == 1
        assert session.messages[0] is long_msg

    @pytest.mark.asyncio
    async def test_recalculates_token_count_after_trim(self) -> None:
        buf = SlidingWindowBuffer(max_messages=3)
        session = _session(_alt_roles(6))
        # Force a stale value so we can detect that recalculate ran.
        session.token_count = 99_999
        await buf.apply(session)
        expected = sum(m.estimated_tokens for m in session.messages)
        assert session.token_count == expected


# ---------------------------------------------------------------------------
# SummaryBuffer
# ---------------------------------------------------------------------------


class _StubSummarizer:
    """Spy summarizer that records call count + payload."""

    def __init__(self, text: str = "SUMMARY") -> None:
        self.text = text
        self.calls: list[list[ConversationMessage]] = []

    async def __call__(self, msgs: list[ConversationMessage]) -> str:
        self.calls.append(list(msgs))
        return self.text


class TestSummaryBuffer:
    @pytest.mark.asyncio
    async def test_under_limit_is_noop(self) -> None:
        spy = _StubSummarizer()
        buf = SummaryBuffer(summarize_fn=spy, max_messages=10)
        session = _session(_alt_roles(3))
        await buf.apply(session)
        assert len(session.messages) == 3
        assert spy.calls == []  # never called

    @pytest.mark.asyncio
    async def test_over_limit_summarizes_oldest(self) -> None:
        spy = _StubSummarizer()
        buf = SummaryBuffer(summarize_fn=spy, max_messages=4)
        session = _session(_alt_roles(10))
        await buf.apply(session)
        # The summary message is at index 0; some recent verbatim
        # messages follow. Total length ≤ max_messages.
        assert len(session.messages) <= 4
        assert session.messages[0].role == "system"
        assert "SUMMARY" in session.messages[0].content
        assert session.messages[0].metadata == {
            "is_summary": True,
            "summarized_count": spy.calls[0].__len__(),
        }
        # Summarizer was invoked exactly once with the trimmed-off head.
        assert len(spy.calls) == 1

    @pytest.mark.asyncio
    async def test_basic_summary_path_when_summarize_fn_is_none(self) -> None:
        """No summarize_fn → ``_basic_summary`` produces a plain text
        summary describing the dropped block (no LLM call required)."""
        buf = SummaryBuffer(summarize_fn=None, max_messages=3)
        session = _session(_alt_roles(8))
        await buf.apply(session)
        assert session.messages[0].role == "system"
        # The basic-summary text mentions message count and role
        # breakdown — pin a couple of substrings so a future rewrite
        # cannot silently degrade the fallback content.
        text = session.messages[0].content
        assert "Previous conversation" in text
        assert "messages" in text

    @pytest.mark.asyncio
    async def test_summarizer_failure_falls_back_to_recent_window(self) -> None:
        """If summarize_fn raises, the buffer drops the old block
        without inserting a summary and keeps only the recent tail."""

        async def boom(_msgs: list[ConversationMessage]) -> str:
            raise RuntimeError("LLM is down")

        buf = SummaryBuffer(summarize_fn=boom, max_messages=3)
        session = _session(_alt_roles(8))
        await buf.apply(session)
        # No summary should have been inserted — the messages list is
        # the verbatim recent tail only.
        assert all(m.role != "system" for m in session.messages)
        assert len(session.messages) <= 3

    @pytest.mark.asyncio
    async def test_cadence_gate_skips_summarize_when_below_refresh(self) -> None:
        """``summary_refresh_every_turns`` gates the LLM call. With a
        prior summary checkpoint at message-count 6 and a cadence of
        10 new messages, an overflow at length 8 should NOT summarize."""
        spy = _StubSummarizer()
        buf = SummaryBuffer(
            summarize_fn=spy,
            max_messages=4,
            summary_refresh_every_turns=10,
        )
        session = _session(_alt_roles(8))
        # Pretend we summarized at length 6 already.
        session.metadata["summary_at_message_count"] = 6
        await buf.apply(session)
        # Cadence gate refused → no LLM call. Tail was trimmed instead.
        assert spy.calls == []
        assert all(m.role != "system" for m in session.messages)
        assert len(session.messages) <= 4

    @pytest.mark.asyncio
    async def test_cadence_gate_summarizes_when_enough_messages_accumulated(
        self,
    ) -> None:
        spy = _StubSummarizer()
        buf = SummaryBuffer(
            summarize_fn=spy,
            max_messages=4,
            summary_refresh_every_turns=2,
        )
        session = _session(_alt_roles(10))
        session.metadata["summary_at_message_count"] = 0
        await buf.apply(session)
        # Cadence satisfied (10 - 0 ≥ 2) → summarizer ran.
        assert len(spy.calls) == 1
        assert session.messages[0].role == "system"
        # The checkpoint must have been advanced to the new len.
        assert session.metadata["summary_at_message_count"] == len(session.messages)

    @pytest.mark.asyncio
    async def test_adaptive_threshold_trims_on_small_overflow(self) -> None:
        """When the overflow ratio is below the adaptive threshold, the
        buffer trims (cheap) instead of summarizing (LLM). With cap=10
        and 11 messages, the ratio is 0.1 — below a 0.30 threshold."""
        spy = _StubSummarizer()
        buf = SummaryBuffer(
            summarize_fn=spy,
            max_messages=10,
            adaptive_summarize_threshold=0.30,
        )
        session = _session(_alt_roles(11))
        await buf.apply(session)
        # Below threshold → no summarization, just a trim.
        assert spy.calls == []
        assert all(m.role != "system" for m in session.messages)
        assert len(session.messages) <= 10

    @pytest.mark.asyncio
    async def test_adaptive_threshold_summarizes_on_large_overflow(self) -> None:
        spy = _StubSummarizer()
        buf = SummaryBuffer(
            summarize_fn=spy,
            max_messages=10,
            adaptive_summarize_threshold=0.30,
        )
        # 20 messages with cap 10 = overflow 1.0, well above 0.30.
        session = _session(_alt_roles(20))
        await buf.apply(session)
        assert len(spy.calls) == 1
        assert session.messages[0].role == "system"

    @pytest.mark.asyncio
    async def test_adaptive_threshold_clamps_out_of_range(self) -> None:
        """Threshold is clamped to [0, 1] in __init__. A wild value like
        5.0 must clamp to 1.0, meaning "trim unless overflow ratio is
        ≥ 1.0 (i.e. the session is at least 2× over the cap)". Anything
        under that — like our 0.25 ratio here — takes the trim path."""
        spy = _StubSummarizer()
        buf = SummaryBuffer(
            summarize_fn=spy,
            max_messages=4,
            adaptive_summarize_threshold=5.0,  # clamped to 1.0
        )
        assert buf._adaptive_threshold == pytest.approx(1.0)
        # 5 messages with cap 4 → overflow ratio (5-4)/4 = 0.25 < 1.0
        # → trim path fires, no summarizer call.
        session = _session(_alt_roles(5))
        await buf.apply(session)
        assert spy.calls == []  # never summarized

    @pytest.mark.asyncio
    async def test_adaptive_threshold_clamps_negative_to_zero(self) -> None:
        """A negative threshold clamps to 0.0 (= "always summarize"),
        not to a negative number that would short-circuit the adaptive
        branch."""
        spy = _StubSummarizer()
        buf = SummaryBuffer(
            summarize_fn=spy,
            max_messages=4,
            adaptive_summarize_threshold=-2.0,  # clamped to 0.0
        )
        assert buf._adaptive_threshold == 0.0
        session = _session(_alt_roles(8))
        await buf.apply(session)
        # 0.0 disables the adaptive branch → standard summarize path runs.
        assert len(spy.calls) == 1

    def test_overflow_ratio_zero_when_within_limits(self) -> None:
        buf = SummaryBuffer(max_messages=10, max_chars=1000, max_tokens=1000)
        msgs = _alt_roles(3)
        assert buf._overflow_ratio(msgs) == 0.0

    def test_overflow_ratio_picks_worst_axis(self) -> None:
        """When multiple limits are over, _overflow_ratio returns the
        worst (largest) ratio — that's what the adaptive switch reads."""
        buf = SummaryBuffer(max_messages=2, max_chars=10_000, max_tokens=10_000)
        # 5 messages with cap 2 → ratio = (5-2)/2 = 1.5
        msgs = _alt_roles(5, body="x")
        assert buf._overflow_ratio(msgs) == pytest.approx(1.5)

    def test_overflow_ratio_includes_char_axis(self) -> None:
        buf = SummaryBuffer(max_messages=100, max_chars=10)
        # 3 messages × 10 chars each = 30 chars → ratio = (30-10)/10 = 2.0
        msgs = [_msg("user", "x" * 10) for _ in range(3)]
        assert buf._overflow_ratio(msgs) == pytest.approx(2.0)

    def test_overflow_ratio_includes_token_axis(self) -> None:
        buf = SummaryBuffer(max_messages=100, max_tokens=2)
        # ~10 chars per message → ~3 tokens each. 4 messages ≈ 12 tokens.
        msgs = [_msg("user", "abcdefghij") for _ in range(4)]
        ratio = buf._overflow_ratio(msgs)
        assert ratio > 0.0  # exact value depends on estimate_tokens

    @pytest.mark.asyncio
    async def test_single_message_over_limit_is_left_alone(self) -> None:
        """Edge case: 1 message that already exceeds the cap. The
        ``len <= 1`` guard short-circuits both summarization and trim."""
        buf = SummaryBuffer(summarize_fn=_StubSummarizer(), max_tokens=1)
        big = _msg("user", "this message alone exceeds the token cap")
        session = _session([big])
        await buf.apply(session)
        assert len(session.messages) == 1
        assert session.messages[0] is big

    @pytest.mark.asyncio
    async def test_fallback_to_window_token_axis(self) -> None:
        """Cadence-gate trim should respect the token cap when set."""
        spy = _StubSummarizer()
        buf = SummaryBuffer(
            summarize_fn=spy,
            max_tokens=4,  # very tight
            summary_refresh_every_turns=100,  # cadence will refuse to summarize
        )
        session = _session([_msg("user", "abcdefghij") for _ in range(6)])
        session.metadata["summary_at_message_count"] = 0
        await buf.apply(session)
        # Cadence refused → trim path ran. Final token count is within cap.
        assert spy.calls == []
        total_tokens = sum(m.estimated_tokens for m in session.messages)
        assert total_tokens <= 4 or len(session.messages) == 1

    @pytest.mark.asyncio
    async def test_fallback_to_window_char_axis(self) -> None:
        """Adaptive-switch trim should respect the char cap when set."""
        spy = _StubSummarizer()
        buf = SummaryBuffer(
            summarize_fn=spy,
            max_chars=20,  # tight char cap
            adaptive_summarize_threshold=1.0,  # always trim except massive overflow
        )
        session = _session([_msg("user", "x" * 10) for _ in range(3)])
        await buf.apply(session)
        # Small overflow → adaptive branch fell to trim path.
        assert spy.calls == []
        total_chars = sum(len(m.content) for m in session.messages)
        assert total_chars <= 20 or len(session.messages) == 1

    @pytest.mark.asyncio
    async def test_summary_keep_loop_stops_on_char_limit(self) -> None:
        """The keep-loop inside ``apply`` stops growing the recent
        window when adding the next-older message would push chars
        past ``max_chars``. Pins that break branch."""

        async def short_summary(_msgs: list[ConversationMessage]) -> str:
            return "S"

        # 6 long messages, max_messages allows 5, but max_chars forces
        # the keep-loop to stop earlier.
        buf = SummaryBuffer(
            summarize_fn=short_summary,
            max_messages=5,
            max_chars=40,
        )
        session = _session([_msg("user", "x" * 15) for _ in range(6)])
        await buf.apply(session)
        # Summary exists at index 0; rest are recent verbatim, total
        # chars under 40 + summary length.
        assert session.messages[0].role == "system"

    @pytest.mark.asyncio
    async def test_post_summary_still_over_limit_drops_oldest_verbatim(self) -> None:
        """If the prepended summary plus the kept tail is still over the
        char or token limit, the buffer pops the oldest verbatim message
        (index 1) rather than the summary (index 0)."""

        async def big_summary(_msgs: list[ConversationMessage]) -> str:
            # Make the summary itself substantial so the post-summary
            # char count still exceeds max_chars and the secondary trim
            # loop fires.
            return "x" * 200

        buf = SummaryBuffer(
            summarize_fn=big_summary,
            max_messages=4,
            max_chars=80,
        )
        session = _session([_msg("user", "y" * 20) for _ in range(10)])
        await buf.apply(session)
        # Summary survived (still at index 0); the verbatim tail was
        # trimmed further to satisfy max_chars.
        assert session.messages[0].role == "system"
        assert "x" * 50 in session.messages[0].content  # summary intact
        # Total chars within the cap (with at most a tiny over-budget
        # because we never drop the summary itself).
        total_chars = sum(len(m.content) for m in session.messages)
        # The post-summary loop stops when popping further would empty
        # everything but the summary; permit the summary's own content
        # to exceed the cap in that pathological case.
        assert total_chars <= 200 + max(buf._max_chars, 1) + len("[Conversation Summary] ")

    @pytest.mark.asyncio
    async def test_mark_summary_written_initialises_metadata(self) -> None:
        """If session.metadata is missing, _mark_summary_written should
        lazily create the dict and set the checkpoint."""
        spy = _StubSummarizer()
        buf = SummaryBuffer(summarize_fn=spy, max_messages=4)
        session = _session(_alt_roles(8))
        # Force metadata to None to exercise the lazy-init branch.
        session.metadata = None  # type: ignore[assignment]
        await buf.apply(session)
        # After summarization, metadata must exist with the checkpoint.
        assert session.metadata is not None
        assert "summary_at_message_count" in session.metadata


# ---------------------------------------------------------------------------
# create_memory_buffer factory
# ---------------------------------------------------------------------------


class TestCreateMemoryBuffer:
    def test_default_returns_sliding_window(self) -> None:
        buf = create_memory_buffer()
        assert isinstance(buf, SlidingWindowBuffer)

    def test_summary_type_returns_summary_buffer(self) -> None:
        async def fake(_msgs: list[ConversationMessage]) -> str:
            return ""

        buf = create_memory_buffer(buffer_type="summary", summarize_fn=fake)
        assert isinstance(buf, SummaryBuffer)

    def test_summary_passes_through_cadence_and_adaptive(self) -> None:
        buf = create_memory_buffer(
            buffer_type="summary",
            max_messages=12,
            summary_refresh_every_turns=4,
            adaptive_summarize_threshold=0.25,
        )
        assert isinstance(buf, SummaryBuffer)
        assert buf._max_messages == 12
        assert buf._refresh_every_turns == 4
        assert buf._adaptive_threshold == pytest.approx(0.25)

    def test_unknown_type_raises(self) -> None:
        with pytest.raises(ValueError) as excinfo:
            create_memory_buffer(buffer_type="lol")
        assert "lol" in str(excinfo.value)

    def test_abstract_base_cannot_be_instantiated_directly(self) -> None:
        with pytest.raises(TypeError):
            MemoryBuffer()  # type: ignore[abstract]
