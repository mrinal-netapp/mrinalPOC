"""Unit tests for the gateway-backed SummaryBuffer (Phase 3 MEM-3.5).

Covers the contract enforced by :func:`_build_summarize_fn` in
``core/team_loader.py``:

- Happy path: gateway returns content → SummaryBuffer replaces oldest
  messages with one system summary.
- Timeout: gateway takes longer than ``summarizer_timeout_seconds`` →
  SummaryBuffer falls back to sliding-window trim.
- Gateway exception: any error propagates so SummaryBuffer's own catch
  handles it (same sliding-window fallback).
- Empty gateway content: helper synthesizes a deterministic basic summary
  rather than emitting an empty system message.
"""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from agent_service_maf.core.memory_buffer import SummaryBuffer
from agent_service_maf.core.session import ConversationMessage, Session
from agent_service_maf.core.team_loader import _build_summarize_fn


def _msg(role: str, content: str) -> ConversationMessage:
    return ConversationMessage(role=role, content=content)


def _populated_session(n: int = 10) -> Session:
    s = Session(session_id="team:p:t:u:s1")
    for i in range(n):
        s.messages.append(_msg("user" if i % 2 == 0 else "assistant", f"msg-{i}"))
    return s


class TestBuildSummarizeFn:
    async def test_happy_path_returns_gateway_content(self) -> None:
        gateway = MagicMock()
        gateway.complete = AsyncMock(
            return_value=MagicMock(content="Compressed summary text"),
        )
        fn = _build_summarize_fn(
            gateway=gateway,
            model="azure/m",
            timeout_seconds=5,
            max_tokens=128,
        )

        out = await fn([_msg("user", "hello"), _msg("assistant", "hi back")])
        assert out == "Compressed summary text"
        gateway.complete.assert_awaited_once()

    async def test_timeout_raises_so_buffer_falls_back(self) -> None:
        async def slow_complete(**_kw: Any) -> Any:
            await asyncio.sleep(1.0)
            return MagicMock(content="never")

        gateway = MagicMock()
        gateway.complete = slow_complete  # type: ignore[assignment]
        fn = _build_summarize_fn(
            gateway=gateway,
            model="m",
            timeout_seconds=0.05,
            max_tokens=128,
        )

        with pytest.raises(asyncio.TimeoutError):
            await fn([_msg("user", "hi")])

    async def test_gateway_exception_propagates(self) -> None:
        gateway = MagicMock()
        gateway.complete = AsyncMock(side_effect=RuntimeError("gateway down"))
        fn = _build_summarize_fn(
            gateway=gateway,
            model="m",
            timeout_seconds=5,
            max_tokens=128,
        )

        with pytest.raises(RuntimeError, match="gateway down"):
            await fn([_msg("user", "hi")])

    async def test_empty_content_falls_back_to_basic_summary(self) -> None:
        gateway = MagicMock()
        gateway.complete = AsyncMock(return_value=MagicMock(content="   "))
        fn = _build_summarize_fn(
            gateway=gateway,
            model="m",
            timeout_seconds=5,
            max_tokens=128,
        )

        msgs = [_msg("user", "first message"), _msg("assistant", "reply")]
        out = await fn(msgs)
        # Basic-summary marker -- "Previous conversation (N messages" is its
        # signature opening line.
        assert "Previous conversation" in out
        assert "messages" in out

    async def test_truncates_very_long_messages_in_prompt(self) -> None:
        """The helper must not blow the prompt out when messages are huge."""
        gateway = MagicMock()
        gateway.complete = AsyncMock(return_value=MagicMock(content="ok"))
        fn = _build_summarize_fn(
            gateway=gateway,
            model="m",
            timeout_seconds=5,
            max_tokens=128,
        )

        big_content = "x" * 50_000
        await fn([_msg("user", big_content)])
        # The transcript handed to the gateway must be < big_content's length.
        call_messages = gateway.complete.await_args.kwargs["messages"]
        transcript = call_messages[1]["content"]
        assert len(transcript) < len(big_content)
        assert "..." in transcript


class TestSummaryBufferWithGateway:
    """SummaryBuffer end-to-end with the gateway-backed summarizer."""

    async def test_buffer_invokes_gateway_on_overflow(self) -> None:
        """When over the message cap, SummaryBuffer must call the gateway-backed fn."""
        gateway = MagicMock()
        gateway.complete = AsyncMock(
            return_value=MagicMock(content="Older chat compressed."),
        )
        fn = _build_summarize_fn(
            gateway=gateway,
            model="m",
            timeout_seconds=5,
            max_tokens=128,
        )
        buf = SummaryBuffer(summarize_fn=fn, max_messages=5)
        session = _populated_session(10)
        await buf.apply(session)

        gateway.complete.assert_awaited_once()
        # Session message count must respect the cap regardless of the
        # post-summary trim behaviour.
        assert len(session.messages) <= 5

    async def test_summary_message_survives_message_cap(self) -> None:
        """Regression: the summary system message must survive the post-trim.

        Previously the buffer set ``messages = [summary, *recent]`` where
        ``len(recent) == max_messages``. That produced ``max_messages + 1``
        entries; the post-summary trim then ``pop(0)``'d — silently
        removing the summary itself. The fix budgets one slot for the
        summary in the keep loop so the final window is exactly
        ``max_messages`` with the summary at index 0.
        """
        gateway = MagicMock()
        gateway.complete = AsyncMock(
            return_value=MagicMock(content="Older chat compressed."),
        )
        fn = _build_summarize_fn(
            gateway=gateway,
            model="m",
            timeout_seconds=5,
            max_tokens=128,
        )
        buf = SummaryBuffer(summarize_fn=fn, max_messages=4)
        session = _populated_session(10)
        await buf.apply(session)

        assert len(session.messages) <= 4
        assert session.messages[0].role == "system"
        assert session.messages[0].metadata.get("is_summary") is True
        assert session.messages[0].content.startswith("[Conversation Summary] ")
        # Recent messages preserved
        for m in session.messages[1:]:
            assert m.role != "system"

    async def test_summary_survives_when_char_budget_post_trims(self) -> None:
        """Even if the summary's own chars push us over ``max_chars``,
        the post-trim must pop the oldest *kept* message — not the
        summary at index 0."""
        gateway = MagicMock()
        # A summary text long enough to push char totals back over limit.
        gateway.complete = AsyncMock(
            return_value=MagicMock(content="x" * 500),
        )
        fn = _build_summarize_fn(
            gateway=gateway,
            model="m",
            timeout_seconds=5,
            max_tokens=128,
        )
        buf = SummaryBuffer(summarize_fn=fn, max_messages=4, max_chars=600)
        session = _populated_session(10)
        await buf.apply(session)

        # Summary still at index 0.
        assert session.messages[0].role == "system"
        assert session.messages[0].metadata.get("is_summary") is True

    async def test_buffer_falls_back_on_timeout(self) -> None:
        async def slow(**_kw: Any) -> Any:
            await asyncio.sleep(1.0)

        gateway = MagicMock()
        gateway.complete = slow  # type: ignore[assignment]
        fn = _build_summarize_fn(
            gateway=gateway,
            model="m",
            timeout_seconds=0.05,
            max_tokens=128,
        )
        buf = SummaryBuffer(summarize_fn=fn, max_messages=3)
        session = _populated_session(10)
        await buf.apply(session)

        # No summary message added; oldest dropped down to max_messages.
        assert all(m.role != "system" for m in session.messages)
        assert len(session.messages) <= 3

    async def test_buffer_falls_back_on_gateway_error(self) -> None:
        gateway = MagicMock()
        gateway.complete = AsyncMock(side_effect=ValueError("auth"))
        fn = _build_summarize_fn(
            gateway=gateway,
            model="m",
            timeout_seconds=5,
            max_tokens=128,
        )
        buf = SummaryBuffer(summarize_fn=fn, max_messages=3)
        session = _populated_session(10)
        await buf.apply(session)

        assert all(m.role != "system" for m in session.messages)
        assert len(session.messages) <= 3
