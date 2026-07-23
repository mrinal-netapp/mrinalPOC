"""Memory buffer strategies for conversation history management.

Provides two buffer strategies:

- :class:`SlidingWindowBuffer` (``chat_memory_buffer``) — drops oldest messages
  when the window limit is exceeded. Supports limits by message count,
  character length, and/or estimated token count.

- :class:`SummaryBuffer` (``chat_summary_memory_buffer``) — when the window
  overflows, summarizes the oldest messages into a single system-level summary
  message, preserving context while freeing space. Requires a summarization
  function (typically backed by an LLM gateway call).

Both strategies are pluggable via the :class:`MemoryBuffer` ABC. The
:class:`~agent_service_maf.core.session.SessionManager` delegates all
trimming logic to the configured buffer.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable

import structlog

from agent_service_maf.core.session import ConversationMessage, Session

logger = structlog.get_logger(__name__)


class MemoryBuffer(ABC):
    """Abstract base for memory buffer strategies.

    A buffer receives a :class:`Session` and trims or transforms its
    ``messages`` list to stay within configured limits. The session's
    ``token_count`` field is updated after trimming.
    """

    @abstractmethod
    async def apply(self, session: Session) -> None:
        """Trim or transform the session's message history in-place.

        Args:
            session: The session to trim. Mutates ``session.messages``
                and ``session.token_count`` directly.
        """

    @staticmethod
    def _total_chars(messages: list[ConversationMessage]) -> int:
        """Sum of character lengths across all messages."""
        return sum(len(m.content) for m in messages)

    @staticmethod
    def _total_tokens(messages: list[ConversationMessage]) -> int:
        """Sum of estimated tokens across all messages."""
        return sum(m.estimated_tokens for m in messages)


# ---------------------------------------------------------------------------
# Sliding Window Buffer (chat_memory_buffer)
# ---------------------------------------------------------------------------


class SlidingWindowBuffer(MemoryBuffer):
    """Sliding window — drops oldest messages when limits are exceeded.

    Supports three independent limits (all optional). Enforcement order:

    1. **Token count** (``max_tokens``) — when set, this is the **primary**
       cap. Per the locked tiebreaker rule, the token limit wins over the
       message limit because tokens are the truer cost signal.
    2. **Message count** (``max_messages``) — applied only when ``max_tokens``
       is unset (0). Otherwise it's a fallback ceiling.
    3. **Character length** (``max_chars``) — secondary cap, always applied
       when set.

    When any limit is exceeded, the oldest messages are dropped until the
    session is within all active limits. The most recent message is never
    dropped.

    A limit value of 0 means that limit is disabled.

    Args:
        max_messages: Maximum message count (0 = unlimited). Ignored as
            the primary cap when ``max_tokens > 0``; still enforced as a
            ceiling.
        max_chars: Maximum total character length (0 = unlimited).
        max_tokens: Maximum estimated token count (0 = unlimited). When
            set, WINS over ``max_messages`` per the tiebreaker.

    Example:
        >>> buf = SlidingWindowBuffer(max_messages=50, max_tokens=4096)
        >>> await buf.apply(session)
    """

    def __init__(
        self,
        max_messages: int = 0,
        max_chars: int = 0,
        max_tokens: int = 0,
    ) -> None:
        self._max_messages = max_messages
        self._max_chars = max_chars
        self._max_tokens = max_tokens

    async def apply(self, session: Session) -> None:
        """Trim oldest messages to satisfy all configured limits."""
        # Tiebreaker (locked decision #2): when both max_tokens AND
        # max_messages are set, max_tokens wins. We still enforce
        # max_messages as a ceiling so an unbounded-token-but-bounded-msg
        # config doesn't silently let the window grow without limit.
        token_is_primary = self._max_tokens > 0

        # 1. Trim by token count (PRIMARY when set)
        if self._max_tokens > 0:
            while (
                self._total_tokens(session.messages) > self._max_tokens
                and len(session.messages) > 1
            ):
                session.messages.pop(0)

        # 2. Trim by message count (PRIMARY when token limit is unset;
        #    otherwise SECONDARY ceiling)
        if self._max_messages > 0 and len(session.messages) > self._max_messages:
            dropped = len(session.messages) - self._max_messages
            session.messages = session.messages[-self._max_messages :]
            logger.debug(
                "Sliding window: trimmed by message count",
                session_id=session.session_id,
                dropped=dropped,
                limit=self._max_messages,
                token_is_primary=token_is_primary,
            )

        # 3. Trim by character length (always applied when set)
        if self._max_chars > 0:
            while (
                self._total_chars(session.messages) > self._max_chars and len(session.messages) > 1
            ):
                session.messages.pop(0)

        session.recalculate_tokens()


# ---------------------------------------------------------------------------
# Summary Buffer (chat_summary_memory_buffer)
# ---------------------------------------------------------------------------

#: Type for the summarization function. Receives a list of messages to
#: summarize and returns a summary string.
SummarizeFn = Callable[
    [list[ConversationMessage]],
    Awaitable[str],
]


class SummaryBuffer(MemoryBuffer):
    """Summary buffer — summarizes overflow messages instead of dropping them.

    Maintains a sliding window of recent messages. When the window overflows,
    the oldest messages are summarized into a single ``system`` message that
    replaces them. This preserves long-term context while keeping the active
    history within limits.

    Supports three independent limits (same as :class:`SlidingWindowBuffer`):
    message count, character length, and token count.

    The summary is generated by calling a user-provided async function
    (typically backed by an LLM gateway call).

    Args:
        summarize_fn: Async function that takes a list of messages and
            returns a summary string. If ``None``, falls back to simple
            sliding window trimming (no summarization).
        max_messages: Maximum message count (0 = unlimited).
        max_chars: Maximum total character length (0 = unlimited).
        max_tokens: Maximum estimated token count (0 = unlimited).
        summary_prefix: Prefix for the summary message content.

    Example:
        >>> async def summarize(msgs):
        ...     return f"Summary of {len(msgs)} messages..."
        >>> buf = SummaryBuffer(summarize_fn=summarize, max_messages=20)
        >>> await buf.apply(session)
    """

    def __init__(
        self,
        summarize_fn: SummarizeFn | None = None,
        max_messages: int = 0,
        max_chars: int = 0,
        max_tokens: int = 0,
        summary_prefix: str = "[Conversation Summary] ",
        summary_refresh_every_turns: int = 0,
        adaptive_summarize_threshold: float = 0.0,
    ) -> None:
        self._summarize_fn = summarize_fn
        self._max_messages = max_messages
        self._max_chars = max_chars
        self._max_tokens = max_tokens
        self._summary_prefix = summary_prefix
        # Cadence gating: don't summarize on every overflow. Track the
        # length of `messages` at the time the last summary was written
        # so we can refuse to re-summarize until N new messages have
        # accumulated. Stored on the session via metadata so it survives
        # restart (sessions are persisted; this buffer instance is not).
        self._refresh_every_turns = max(0, int(summary_refresh_every_turns))
        # Adaptive switch: trim instead of summarize when overflow ratio
        # is below this threshold. 0.0 = always summarize (legacy
        # behavior). Mirrors agent-service's hybrid path.
        self._adaptive_threshold = max(0.0, min(1.0, float(adaptive_summarize_threshold)))

    def _is_over_limit(self, messages: list[ConversationMessage]) -> bool:
        """Check if any configured limit is exceeded."""
        if self._max_messages > 0 and len(messages) > self._max_messages:
            return True
        if self._max_chars > 0 and self._total_chars(messages) > self._max_chars:
            return True
        return bool(self._max_tokens > 0 and self._total_tokens(messages) > self._max_tokens)

    def _overflow_ratio(self, messages: list[ConversationMessage]) -> float:
        """Compute the worst-case overflow ratio across all active limits.

        Returns the max of (excess / limit) across whichever of
        ``max_messages`` / ``max_chars`` / ``max_tokens`` are set. Returns
        ``0.0`` when nothing is over a limit. Used by the adaptive
        summarize decision: small ratio → cheap trim; large ratio → pay
        for the summarizer.
        """
        ratios: list[float] = []
        if self._max_messages > 0 and len(messages) > self._max_messages:
            ratios.append((len(messages) - self._max_messages) / self._max_messages)
        if self._max_chars > 0:
            chars = self._total_chars(messages)
            if chars > self._max_chars:
                ratios.append((chars - self._max_chars) / self._max_chars)
        if self._max_tokens > 0:
            tokens = self._total_tokens(messages)
            if tokens > self._max_tokens:
                ratios.append((tokens - self._max_tokens) / self._max_tokens)
        return max(ratios) if ratios else 0.0

    def _should_summarize_now(self, session: Session) -> bool:
        """Cadence gate: should the summarizer run on this overflow?

        Returns ``True`` when refresh-cadence is unset (always summarize)
        or when enough new messages have accumulated since the last
        summary. ``False`` means "skip the LLM call, just trim."

        We track the previous summary point in ``session.metadata`` so it
        survives across in-process buffer reconstruction.
        """
        if self._refresh_every_turns <= 0:
            return True
        metadata = getattr(session, "metadata", None) or {}
        last_len = int(metadata.get("summary_at_message_count", 0))
        # We want to summarize when at least N new messages have been
        # appended since the last summary point. Use the CURRENT message
        # count as the proxy for "turns" (1 turn ≈ 2-4 messages depending
        # on tool calls; counting messages is the conservative side —
        # more frequent refreshes for tool-heavy sessions).
        return (len(session.messages) - last_len) >= self._refresh_every_turns

    @staticmethod
    def _mark_summary_written(session: Session) -> None:
        """Record the message-count at which the latest summary was written."""
        metadata = getattr(session, "metadata", None)
        if metadata is None:
            try:
                session.metadata = {}
            except Exception:
                return
            metadata = session.metadata
        metadata["summary_at_message_count"] = len(session.messages)

    async def apply(self, session: Session) -> None:
        """Summarize overflow messages, keeping recent ones intact."""
        if not self._is_over_limit(session.messages):
            session.recalculate_tokens()
            return

        if len(session.messages) <= 1:
            session.recalculate_tokens()
            return

        # Adaptive switch: when overflow is small AND a threshold is set,
        # just trim instead of paying for an LLM summarization call.
        # Preserves the cost optimization the legacy
        # `contextStrategy='hybrid'` path provided in agent-service.
        if self._adaptive_threshold > 0.0:
            overflow = self._overflow_ratio(session.messages)
            if overflow < self._adaptive_threshold:
                logger.debug(
                    "SummaryBuffer adaptive: overflow below threshold, trimming instead",
                    session_id=session.session_id,
                    overflow_ratio=round(overflow, 3),
                    threshold=self._adaptive_threshold,
                )
                await self._fallback_to_window(session)
                return

        # Cadence gating: don't summarize on every overflow. Trim until
        # the next scheduled refresh tick.
        if not self._should_summarize_now(session):
            logger.debug(
                "SummaryBuffer cadence: refresh window not reached, trimming",
                session_id=session.session_id,
                refresh_every=self._refresh_every_turns,
            )
            await self._fallback_to_window(session)
            return

        # Determine how many recent messages to keep. Budget one slot for
        # the summary message we're about to prepend so the final window
        # ([summary, *recent]) fits inside ``max_messages``; otherwise the
        # post-summary trim below would pop the summary itself (it lives
        # at index 0).
        msg_cap = max(self._max_messages - 1, 1) if self._max_messages > 0 else 0

        keep_count = 1
        recent = session.messages[-keep_count:]
        while keep_count < len(session.messages):
            candidate = session.messages[-(keep_count + 1) :]
            if msg_cap > 0 and len(candidate) > msg_cap:
                break
            if self._max_chars > 0 and self._total_chars(candidate) > self._max_chars:
                break
            if self._max_tokens > 0 and self._total_tokens(candidate) > self._max_tokens:
                break
            keep_count += 1
            recent = candidate

        # Messages to summarize (everything before the kept window)
        to_summarize = session.messages[: len(session.messages) - keep_count]

        if not to_summarize:
            session.recalculate_tokens()
            return

        # Generate summary
        if self._summarize_fn is not None:
            try:
                summary_text = await self._summarize_fn(to_summarize)
            except Exception as exc:
                logger.warning(
                    "Summarization failed, falling back to sliding window trim",
                    session_id=session.session_id,
                    error=str(exc),
                    messages_to_summarize=len(to_summarize),
                )
                # Fallback: just drop the old messages
                session.messages = recent
                session.recalculate_tokens()
                return
        else:
            # No summarize function — build a basic text summary
            summary_text = self._basic_summary(to_summarize)

        summary_msg = ConversationMessage(
            role="system",
            content=f"{self._summary_prefix}{summary_text}",
            metadata={"is_summary": True, "summarized_count": len(to_summarize)},
        )

        session.messages = [summary_msg, *recent]
        # Record the summary checkpoint so cadence gating can refuse to
        # re-summarize until N more messages have accumulated.
        self._mark_summary_written(session)

        logger.info(
            "Summarized conversation history",
            session_id=session.session_id,
            summarized_count=len(to_summarize),
            kept_count=len(recent),
            summary_tokens=summary_msg.estimated_tokens,
        )

        # If the summary's own chars/tokens still push us over a budget,
        # drop the OLDEST kept message (index 1) instead of the summary
        # (index 0). The summary carries condensed long-term context and
        # must survive; we'd rather lose one verbatim recent turn.
        if self._is_over_limit(session.messages) and len(session.messages) > 1:
            logger.debug(
                "Post-summary still over limit, trimming oldest kept message",
                session_id=session.session_id,
            )
            while self._is_over_limit(session.messages) and len(session.messages) > 1:
                # Index 0 is the summary; index 1 is the oldest verbatim
                # message. Pop index 1 unless the summary is the only
                # thing left.
                drop_idx = 1 if len(session.messages) >= 2 else 0
                session.messages.pop(drop_idx)

        session.recalculate_tokens()

    async def _fallback_to_window(self, session: Session) -> None:
        """Drop oldest messages until under all configured limits.

        Used by the adaptive switch (small overflows skip the LLM call)
        and the cadence gate (within-window overflows skip the LLM call).
        Mirrors :class:`SlidingWindowBuffer.apply` semantics but inline
        here so SummaryBuffer doesn't need to compose another buffer.
        """
        # Token limit primary if set (locked tiebreaker decision #2)
        if self._max_tokens > 0:
            while (
                self._total_tokens(session.messages) > self._max_tokens
                and len(session.messages) > 1
            ):
                session.messages.pop(0)
        if self._max_messages > 0 and len(session.messages) > self._max_messages:
            session.messages = session.messages[-self._max_messages :]
        if self._max_chars > 0:
            while (
                self._total_chars(session.messages) > self._max_chars and len(session.messages) > 1
            ):
                session.messages.pop(0)
        session.recalculate_tokens()

    @staticmethod
    def _basic_summary(messages: list[ConversationMessage]) -> str:
        """Generate a simple text summary without LLM.

        Extracts key information: message count, roles, and a preview
        of the first and last messages.
        """
        count = len(messages)
        roles = {}
        for m in messages:
            roles[m.role] = roles.get(m.role, 0) + 1
        role_summary = ", ".join(f"{r}: {c}" for r, c in sorted(roles.items()))

        first_preview = messages[0].content[:100] if messages else ""
        last_preview = messages[-1].content[:100] if messages else ""

        total_chars = sum(len(m.content) for m in messages)

        return (
            f"Previous conversation ({count} messages, "
            f"{total_chars} chars, {role_summary}). "
            f'Started with: "{first_preview}..." '
            f'Ended with: "{last_preview}..."'
        )


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def create_memory_buffer(
    buffer_type: str = "sliding_window",
    max_messages: int = 0,
    max_chars: int = 0,
    max_tokens: int = 0,
    summarize_fn: SummarizeFn | None = None,
    summary_prefix: str = "[Conversation Summary] ",
    summary_refresh_every_turns: int = 0,
    adaptive_summarize_threshold: float = 0.0,
) -> MemoryBuffer:
    """Create a memory buffer from configuration.

    Args:
        buffer_type: ``"sliding_window"`` or ``"summary"``.
        max_messages: Max message count (0 = unlimited).
        max_chars: Max total character length (0 = unlimited).
        max_tokens: Max estimated token count (0 = unlimited). When set,
            WINS over ``max_messages`` per the tiebreaker rule.
        summarize_fn: Async summarization function (only for ``"summary"`` type).
        summary_prefix: Prefix for summary messages.
        summary_refresh_every_turns: SummaryBuffer cadence gating (skip
            LLM calls until N new messages have accumulated since the
            last summary). 0 = always summarize on overflow.
        adaptive_summarize_threshold: SummaryBuffer adaptive switch.
            When 0 < threshold ≤ 1, the buffer trims (cheap) instead of
            summarizing (LLM call) on small overflows. 0 = always
            summarize. Mirrors agent-service's hybrid behavior.

    Returns:
        A :class:`MemoryBuffer` implementation.

    Raises:
        ValueError: If buffer_type is not recognised.
    """
    if buffer_type == "sliding_window":
        return SlidingWindowBuffer(
            max_messages=max_messages,
            max_chars=max_chars,
            max_tokens=max_tokens,
        )
    elif buffer_type == "summary":
        return SummaryBuffer(
            summarize_fn=summarize_fn,
            max_messages=max_messages,
            max_chars=max_chars,
            max_tokens=max_tokens,
            summary_prefix=summary_prefix,
            summary_refresh_every_turns=summary_refresh_every_turns,
            adaptive_summarize_threshold=adaptive_summarize_threshold,
        )
    else:
        raise ValueError(
            f"Unknown memory buffer type: '{buffer_type}'. "
            f"Supported types: 'sliding_window', 'summary'."
        )
