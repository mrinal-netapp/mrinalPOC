"""Session management for conversation memory.

Provides session storage with TTL-based expiry, token-level budgets,
and pluggable persistence backends (in-memory or Redis).

Token counting uses a fast approximation (chars / 4) to avoid
importing a tokenizer library. This is accurate within ~10% for
English text and good enough for budget enforcement.

This module also exposes :func:`memory_degraded` /
:func:`mark_memory_degraded` -- a request-scoped ``ContextVar`` flag that
session-store operations flip whenever they hit an error. The route
handler reads the flag after the invocation completes and stamps it on
:class:`~agent_service_maf.interface_layer.models.InvokeResponse`, giving
clients a stable contract for "your conversation history was not loaded".
"""

from __future__ import annotations

import asyncio
import contextvars
import time
from dataclasses import dataclass, field
from typing import Any

import structlog
from pydantic import Field

from agent_service_maf.core._base_model import CamelCaseModel

logger = structlog.get_logger(__name__)

# ---------------------------------------------------------------------------
# Fail-open observability: per-request memory_degraded flag
# ---------------------------------------------------------------------------

_memory_degraded_var: contextvars.ContextVar[bool] = contextvars.ContextVar(
    "memory_degraded",
    default=False,
)


def mark_memory_degraded() -> None:
    """Flip the current request's ``memory_degraded`` flag to True.

    Called by :class:`SessionManager` when an underlying store op fails
    (timeout, decode error, network error). Idempotent. Safe to call
    from any async task spawned by the request.
    """
    _memory_degraded_var.set(True)


def memory_degraded() -> bool:
    """Return the current request's ``memory_degraded`` flag value.

    The route handler reads this after running the agent to decide
    whether to stamp :class:`~agent_service_maf.interface_layer.models.InvokeResponse.memory_degraded`.
    """
    return _memory_degraded_var.get()


def reset_memory_degraded() -> None:
    """Reset the flag to False. Call at the start of a request handler."""
    _memory_degraded_var.set(False)


# ---------------------------------------------------------------------------
# Approximate token counting (no external tokenizer dependency)
# ---------------------------------------------------------------------------

_CHARS_PER_TOKEN = 4  # Conservative estimate — 1 token ≈ 4 chars for English


def estimate_tokens(text: str) -> int:
    """Estimate token count from character length.

    Uses the approximation 1 token ≈ 4 characters, which is within ~10%
    for English text across GPT/Claude tokenizers.

    Args:
        text: The text to estimate tokens for.

    Returns:
        Estimated token count (always >= 1 for non-empty text).
    """
    if not text:
        return 0
    return max(1, len(text) // _CHARS_PER_TOKEN)


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


class ConversationMessage(CamelCaseModel):
    """A single message in a conversation session.

    Wire shape per §5.6.2. Inherits from
    :class:`~agent_service_maf.interface_layer._base_model.CamelCaseModel`
    so JSON serialization emits ``camelCase`` (``tokensActual``,
    ``timestamp``).

    Carries two token counts:

    - :attr:`estimated_tokens` -- always set, derived from character length
      as a cheap approximation (1 token ≈ 4 chars).
    - :attr:`tokens_actual` -- ``None`` by default, set by the route handler
      after an LLM call when the gateway returned a real ``TokenUsage``.

    The ``metadata`` field is typed as
    :class:`AssistantMessageMetadata` (assistant messages only). The
    actual class is imported lazily inside the model to avoid an
    import cycle with :mod:`agent_service_maf.interface_layer.models`
    -- it is loose-typed as ``dict | AssistantMessageMetadata | None``
    here, with the typed variant produced by the route handler when
    persisting an assistant turn. User and system messages carry
    ``metadata=None``.
    """

    role: str = Field(..., description="Message role: 'user', 'assistant', or 'system'")
    content: str = Field(..., description="Message content")
    timestamp: float = Field(default_factory=time.time, description="POSIX epoch seconds")
    # Typed AssistantMessageMetadata lives in interface_layer/models.py;
    # importing it here would cause an import cycle. We accept it as
    # either the typed model (preferred) or a plain dict (legacy /
    # transport-layer dump). Pydantic validates either form on parse.
    metadata: dict[str, Any] | None = Field(
        default=None,
        description=(
            "Per-message metadata. Typed AssistantMessageMetadata on "
            "assistant messages; None on user / system messages."
        ),
    )
    tokens_actual: int | None = Field(
        default=None,
        description=(
            "Real token count reported by the LLM gateway after an invocation. "
            "None when the gateway did not report usage or the message has not "
            "yet been sent to the LLM."
        ),
    )

    @property
    def estimated_tokens(self) -> int:
        """Approximate token count for this message's content."""
        return estimate_tokens(self.content)

    @property
    def best_token_estimate(self) -> int:
        """Best available token count.

        Returns :attr:`tokens_actual` when the gateway has reported it,
        otherwise falls back to :attr:`estimated_tokens`. Buffer trimming
        and budget enforcement use this property so memory accounting
        converges on real numbers as soon as they are available.
        """
        if self.tokens_actual is not None and self.tokens_actual >= 0:
            return self.tokens_actual
        return self.estimated_tokens


# ---------------------------------------------------------------------------
# Public summary models (returned by SessionStore.list_for_user)
# ---------------------------------------------------------------------------


class SessionSummary(CamelCaseModel):
    """Lightweight summary returned by ``SessionStore.list_for_user``.

    Mirrors the metadata Hash stored alongside the message blob, plus a
    message count derived at list time. Cheap to compute (no decompression
    of the message body required) so listing one user's sessions is O(N) in
    user-owned sessions with one round-trip per session for metadata.

    Attributes:
        session_id: The raw caller-supplied session id (last component of
            the fully-scoped key).
        scope: ``"team"`` or ``"agent"`` -- which URL hierarchy created it.
        project_id: Project that owns the session.
        anchor: ``team_id`` for team-scoped sessions, ``agent_id`` for
            agent-scoped sessions.
        user_id: Authenticated user id, or ``""`` in dev mode without auth.
        name: Friendly name. Auto-generated on first save (e.g. "Session
            May 11, 11:30 PM") and editable via the rename route.
        created_at: POSIX timestamp of the first save.
        last_accessed: POSIX timestamp of the most recent read or save.
        message_count: Number of messages currently stored in the session.
    """

    session_id: str
    scope: str = ""
    project_id: str = ""
    anchor: str = ""
    user_id: str = ""
    name: str = ""
    created_at: float = 0.0
    last_accessed: float = 0.0
    message_count: int = 0


@dataclass
class Session:
    """A conversation session with message history and token tracking."""

    session_id: str
    messages: list[ConversationMessage] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    last_accessed: float = field(default_factory=time.time)
    metadata: dict[str, Any] = field(default_factory=dict)
    token_count: int = 0

    def touch(self) -> None:
        """Update last access time."""
        self.last_accessed = time.time()

    def is_expired(self, ttl_seconds: int) -> bool:
        """Check if session has exceeded TTL."""
        return (time.time() - self.last_accessed) > ttl_seconds

    def recalculate_tokens(self) -> int:
        """Recalculate total token count from all messages.

        Prefers :attr:`ConversationMessage.tokens_actual` when set by the
        LLM gateway, falls back to :attr:`ConversationMessage.estimated_tokens`
        otherwise. As real counts arrive the session-level total converges
        on the gateway-reported truth.

        Returns:
            Updated token count.
        """
        self.token_count = sum(m.best_token_estimate for m in self.messages)
        return self.token_count


# ---------------------------------------------------------------------------
# Session Manager
# ---------------------------------------------------------------------------


class SessionManager:
    """Manages conversation sessions with pluggable storage and memory buffers.

    Supports:
    - TTL-based automatic session expiry with background cleanup
    - Pluggable memory buffer strategies:

      - :class:`~agent_service_maf.core.memory_buffer.SlidingWindowBuffer`
        (``chat_memory_buffer``) — drops oldest messages by count, chars,
        or tokens.
      - :class:`~agent_service_maf.core.memory_buffer.SummaryBuffer`
        (``chat_summary_memory_buffer``) — summarizes oldest messages.
    - Fallback inline trimming by message count and token budget when no
      buffer is configured.
    - Pluggable persistence via
      :class:`~agent_service_maf.core.session_store.SessionStore`.

    Args:
        ttl_seconds: Session time-to-live in seconds.
        max_history_length: Maximum messages per session (0 = unlimited).
            Ignored when a ``memory_buffer`` is provided.
        max_tokens_per_session: Token budget per session (0 = unlimited).
            Ignored when a ``memory_buffer`` is provided.
        cleanup_interval_seconds: Background cleanup interval.
        store: Pluggable storage backend. Defaults to in-memory.
        memory_buffer: Optional memory buffer strategy. When provided,
            all trimming is delegated to the buffer's ``apply()`` method
            instead of the built-in message-count/token-budget logic.
    """

    def __init__(
        self,
        ttl_seconds: int = 3600,
        max_history_length: int = 100,
        max_tokens_per_session: int = 0,
        cleanup_interval_seconds: int = 300,
        store: Any | None = None,
        memory_buffer: Any | None = None,
        *,
        max_session_bytes: int = 0,
        max_session_messages: int = 0,
        max_sessions_per_user: int = 0,
    ) -> None:
        from agent_service_maf.core.session_store import InMemorySessionStore

        self._store = store or InMemorySessionStore()
        self._memory_buffer = memory_buffer
        self._lock = asyncio.Lock()
        self._ttl_seconds = ttl_seconds
        self._max_history_length = max_history_length
        self._max_tokens = max_tokens_per_session
        self._cleanup_interval = cleanup_interval_seconds
        self._cleanup_task: asyncio.Task[None] | None = None
        # Phase 3 budget enforcement caps. Zero = unlimited.
        self._max_session_bytes = max_session_bytes
        self._max_session_messages = max_session_messages
        self._max_sessions_per_user = max_sessions_per_user

    @property
    def store(self) -> Any:
        """The underlying session store (for testing/inspection)."""
        return self._store

    async def start(self) -> None:
        """Start the background cleanup task."""
        self._cleanup_task = asyncio.create_task(self._cleanup_loop())

    async def stop(self) -> None:
        """Stop the background cleanup task and close the store."""
        if self._cleanup_task:
            self._cleanup_task.cancel()
            try:
                await self._cleanup_task
            except asyncio.CancelledError:
                pass
            self._cleanup_task = None
        await self._store.close()

    async def get_or_create(self, session_id: str) -> Session:
        """Get existing session or create a new one.

        Fail-open: on any store error, returns a fresh in-memory
        :class:`Session` (not persisted) and flips the
        ``memory_degraded`` request flag. The caller can proceed with
        the agent invocation; conversation history is empty for this turn.
        """
        async with self._lock:
            try:
                session = await self._store.get(session_id)
                if session is None:
                    session = Session(session_id=session_id)
                session.touch()
                await self._store.save(session)
                return session
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "session_get_or_create_failed",
                    session_id=session_id,
                    error_type=type(exc).__name__,
                    error=str(exc),
                )
                mark_memory_degraded()
                return Session(session_id=session_id)

    async def get(self, session_id: str) -> Session | None:
        """Get a session by ID, returns None if not found or expired.

        Fail-open: on any store error returns ``None`` and flips the
        ``memory_degraded`` flag.
        """
        async with self._lock:
            try:
                session = await self._store.get(session_id)
                if session is None:
                    return None
                if session.is_expired(self._ttl_seconds):
                    await self._store.delete(session_id)
                    return None
                session.touch()
                await self._store.save(session)
                return session
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "session_get_failed",
                    session_id=session_id,
                    error_type=type(exc).__name__,
                    error=str(exc),
                )
                mark_memory_degraded()
                return None

    async def append_message(
        self,
        session_id: str,
        message: ConversationMessage,
    ) -> None:
        """Append a message to a session, enforcing configured limits.

        When a ``memory_buffer`` is configured, all trimming is delegated to
        its ``apply()`` method. Otherwise, the built-in strategy applies:

        1. Append the new message.
        2. If ``max_history_length > 0`` and exceeded: drop oldest messages.
        3. If ``max_tokens_per_session > 0`` and exceeded: drop oldest messages
           until within budget.

        The most recent message is never dropped.
        """
        # Single lock acquisition covers get-or-create + append + trim + save
        # to avoid race conditions with Redis backend (where get returns a copy).
        async with self._lock:
            try:
                session = await self._store.get(session_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "session_append_get_failed",
                    session_id=session_id,
                    error_type=type(exc).__name__,
                    error=str(exc),
                )
                mark_memory_degraded()
                return  # fail-open: skip this turn's persistence

            is_new = session is None
            if session is None:
                session = Session(session_id=session_id)

            session.messages.append(message)

            if self._memory_buffer is not None:
                await self._memory_buffer.apply(session)
            else:
                if (
                    self._max_history_length > 0
                    and len(session.messages) > self._max_history_length
                ):
                    session.messages = session.messages[-self._max_history_length :]

                if self._max_tokens > 0:
                    session.recalculate_tokens()
                    while session.token_count > self._max_tokens and len(session.messages) > 1:
                        dropped = session.messages.pop(0)
                        session.token_count -= dropped.best_token_estimate

            # Phase 3 hard caps -- run AFTER the buffer so we never exceed
            # the storage budget even if the buffer is misconfigured.
            self._enforce_message_cap(session)
            self._enforce_byte_cap(session)
            session.recalculate_tokens()

            # Per-user session count cap (Phase 3, MEM-3.3). Only on first
            # save of a new session — capacity is a function of the user's
            # session count, not message count.
            if is_new:
                await self._enforce_user_session_cap(session)

            session.touch()
            try:
                await self._store.save(session)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "session_save_failed",
                    session_id=session_id,
                    error_type=type(exc).__name__,
                    error=str(exc),
                )
                mark_memory_degraded()

    async def get_history(self, session_id: str) -> list[ConversationMessage]:
        """Get full message history for a session.

        Fail-open via :meth:`get`: returns an empty list when the store
        op fails, after flipping ``memory_degraded``.
        """
        session = await self.get(session_id)
        if session is None:
            return []
        return list(session.messages)

    async def get_token_count(self, session_id: str) -> int:
        """Get the current token count for a session.

        Returns:
            Token count, or 0 if session not found.
        """
        session = await self.get(session_id)
        if session is None:
            return 0
        return session.token_count

    async def clear_session(self, session_id: str) -> bool:
        """Clear a session's history. Returns True if session existed."""
        async with self._lock:
            try:
                return await self._store.delete(session_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "session_clear_failed",
                    session_id=session_id,
                    error_type=type(exc).__name__,
                    error=str(exc),
                )
                mark_memory_degraded()
                return False

    async def list_sessions(self) -> list[str]:
        """List all active (non-expired) session IDs."""
        async with self._lock:
            try:
                all_ids = await self._store.list_ids()
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "session_list_ids_failed",
                    error_type=type(exc).__name__,
                    error=str(exc),
                )
                mark_memory_degraded()
                return []
            active: list[str] = []
            for sid in all_ids:
                try:
                    session = await self._store.get(sid)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "session_list_get_failed",
                        session_id=sid,
                        error=str(exc),
                    )
                    mark_memory_degraded()
                    continue
                if session and not session.is_expired(self._ttl_seconds):
                    active.append(sid)
            return active

    async def list_for_user(
        self,
        *,
        scope: str,
        project_id: str,
        anchor: str,
        user_id: str,
    ) -> list[SessionSummary]:
        """Return the user's sessions for ``(scope, project, anchor)``, newest first.

        Delegates to :meth:`SessionStore.list_for_user`. Fail-open: on a
        store error, returns an empty list and flips the
        ``memory_degraded`` flag.

        Args:
            scope: ``"team"`` or ``"agent"`` -- which URL hierarchy
                created the sessions.
            project_id: Project that owns the sessions (multi-tenant
                isolation boundary).
            anchor: ``team_id`` when scope=team, ``agent_id`` otherwise.
            user_id: Authenticated user id. Empty string in dev mode.

        Returns:
            :class:`SessionSummary` objects sorted by ``last_accessed``
            descending.
        """
        from agent_service_maf.core.session_store import (
            SessionScope,  # narrow Literal at runtime
        )

        scope_t: SessionScope = scope  # type: ignore[assignment]
        try:
            return await self._store.list_for_user(
                scope=scope_t,
                project_id=project_id,
                anchor=anchor,
                user_id=user_id,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "session_list_for_user_failed",
                scope=scope,
                project_id=project_id,
                anchor=anchor,
                error_type=type(exc).__name__,
                error=str(exc),
            )
            mark_memory_degraded()
            return []

    async def record_token_usage(
        self,
        session_id: str,
        *,
        prompt_tokens: int,
        completion_tokens: int,
    ) -> bool:
        """Backfill ``tokens_actual`` on the last user / assistant messages
        from gateway-reported usage, atomically.

        Phase 3 (MEM-3.1) records real LLM token counts on each message
        after an invocation completes. The previous implementation read
        the session via :meth:`get`, mutated ``messages[*].tokens_actual``
        in place, then called ``self._store.save(session)`` **outside the
        SessionManager lock and bypassing the normal save path**. That
        had three problems:

        1. **Race with concurrent appends.** Between this method's
           :meth:`store.get` and :meth:`store.save`, another request on
           the same session could ``append_message`` and the
           token-backfill save would clobber the new message.
        2. **Bypasses invariants.** ``_enforce_message_cap`` /
           ``_enforce_byte_cap`` / ``_enforce_user_session_cap`` only
           run inside :meth:`append_message`'s lock; writing through
           ``store.save`` directly skipped them so a token-backfill on a
           large session could persist beyond the configured byte cap.
        3. **No fail-open flagging.** A failed save dropped the token
           count silently without setting :func:`mark_memory_degraded`,
           so clients had no way to know their token accounting was
           stale.

        This method runs the whole read-modify-write under
        :attr:`_lock`, then routes the save through the same store
        method :meth:`append_message` uses. On any store error the
        method flips :func:`mark_memory_degraded` and returns ``False``
        (so the route handler can stamp the response).

        Args:
            session_id: Fully-scoped session id used for the turn.
            prompt_tokens: Real prompt-side token count from the gateway.
                ``<= 0`` is treated as "not reported" and skipped.
            completion_tokens: Real completion-side token count from the
                gateway. ``<= 0`` is treated as "not reported" and
                skipped.

        Returns:
            ``True`` if at least one message was updated and the save
            succeeded; ``False`` if there was nothing to update or the
            save failed (in which case ``memory_degraded`` is flipped).
        """
        if prompt_tokens <= 0 and completion_tokens <= 0:
            return False

        async with self._lock:
            try:
                session = await self._store.get(session_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "session_token_usage_get_failed",
                    session_id=session_id,
                    error_type=type(exc).__name__,
                    error=str(exc),
                )
                mark_memory_degraded()
                return False

            if session is None or not session.messages:
                return False

            # Walk from the tail: assistant message is last, user message is
            # the most recent user-role entry before it. The SK adapter
            # appends in exactly this order, so this matches the per-turn
            # invariant the route relies on.
            last_assistant: ConversationMessage | None = None
            last_user: ConversationMessage | None = None
            for msg in reversed(session.messages):
                if last_assistant is None and msg.role == "assistant":
                    last_assistant = msg
                elif last_user is None and msg.role == "user":
                    last_user = msg
                if last_assistant is not None and last_user is not None:
                    break

            changed = False
            if last_user is not None and prompt_tokens > 0:
                last_user.tokens_actual = prompt_tokens
                changed = True
            if last_assistant is not None and completion_tokens > 0:
                last_assistant.tokens_actual = completion_tokens
                changed = True
            if not changed:
                return False

            session.recalculate_tokens()
            session.touch()
            try:
                # Use the normal save path so anything the backend does on
                # ``save`` (TTL refresh on Redis, per-user index update,
                # meta-Hash touch) runs once, consistently, with the rest
                # of the lifecycle.
                await self._store.save(session)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "session_token_usage_save_failed",
                    session_id=session_id,
                    error_type=type(exc).__name__,
                    error=str(exc),
                )
                mark_memory_degraded()
                return False

            return True

    async def update_last_assistant_metadata(
        self,
        session_id: str,
        metadata: Any,  # noqa: ANN401  -- AssistantMessageMetadata (avoid import cycle)
    ) -> bool:
        """Attach typed metadata to the most recent assistant message.

        Per §5.6.4 / §B9, every successful invocation enriches the
        assistant ``ConversationMessage`` that was just appended with
        the full :class:`~agent_service_maf.interface_layer.models.AssistantMessageMetadata`
        block (citations, toolCalls, usage, durationMs, traceId,
        parsedOutput, memoryDegraded). The adapter appends a bare
        message inside its own session handling so the conversation
        stays self-contained even when run outside a route; this
        method is the route's hook to upgrade that bare metadata
        in-place.

        Read-modify-write happens under :attr:`_lock`, mirrors the
        invariants enforcement of :meth:`record_token_usage`, and on
        any store error flips :func:`mark_memory_degraded` without
        raising.

        Args:
            session_id: Fully-scoped session id used for the turn.
            metadata: A :class:`AssistantMessageMetadata` instance (or
                ``None`` to skip). Free-form dicts are also accepted
                for backward compatibility but the wire shape will not
                round-trip through the typed model.

        Returns:
            ``True`` when the last assistant message was found and the
            save succeeded; ``False`` when there is no assistant
            message yet or the save failed (``memory_degraded`` is
            flipped in the latter case).
        """
        if metadata is None:
            return False

        async with self._lock:
            try:
                session = await self._store.get(session_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "session_assistant_metadata_get_failed",
                    session_id=session_id,
                    error_type=type(exc).__name__,
                    error=str(exc),
                )
                mark_memory_degraded()
                return False

            if session is None or not session.messages:
                return False

            target: ConversationMessage | None = None
            for msg in reversed(session.messages):
                if msg.role == "assistant":
                    target = msg
                    break
            if target is None:
                return False

            # ``ConversationMessage.metadata`` is typed as ``dict[str, Any]``
            # so Pydantic can serialize it on the wire without warning. The
            # incoming ``metadata`` is typically an ``AssistantMessageMetadata``
            # instance (the typed Pydantic model from §A6/§B9). Normalise to a
            # camelCase-aliased dict so the persisted shape matches the live
            # ``InvokeResponse`` envelope and survives round-trips through
            # session GET endpoints.
            if hasattr(metadata, "model_dump") and callable(metadata.model_dump):
                target.metadata = metadata.model_dump(by_alias=True, mode="json")
            else:
                target.metadata = metadata
            session.touch()
            try:
                await self._store.save(session)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "session_assistant_metadata_save_failed",
                    session_id=session_id,
                    error_type=type(exc).__name__,
                    error=str(exc),
                )
                mark_memory_degraded()
                return False
            return True

    async def rename_session(self, session_id: str, name: str) -> bool:
        """Update the friendly name on a session's metadata Hash.

        Returns ``True`` on success, ``False`` if the session is unknown
        or the store op failed.
        """
        async with self._lock:
            try:
                return await self._store.rename(session_id, name)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "session_rename_failed",
                    session_id=session_id,
                    error_type=type(exc).__name__,
                    error=str(exc),
                )
                mark_memory_degraded()
                return False

    # --- internal: budget enforcement at save time ----------------------

    def _enforce_message_cap(self, session: Session) -> None:
        """Truncate from the front if message count exceeds the hard cap.

        Buffer-level trims are advisory; this is the back-stop that
        guarantees the stored session never exceeds ``max_session_messages``
        regardless of buffer config. The most recent message is preserved.
        """
        cap = self._max_session_messages
        if cap > 0 and len(session.messages) > cap:
            session.messages = session.messages[-cap:]

    def _enforce_byte_cap(self, session: Session) -> None:
        """Truncate from the front if encoded JSON exceeds the byte cap.

        Estimated bytes are computed cheaply via the sum of message content
        lengths + a small per-message overhead constant. Avoids re-encoding
        the whole session on every save. The most recent message is
        preserved.
        """
        cap = self._max_session_bytes
        if cap <= 0:
            return
        # ~120 bytes overhead per message for role/timestamp/metadata wrappers.
        _OVERHEAD_PER_MSG = 120
        while len(session.messages) > 1:
            approx_bytes = sum(len(m.content) + _OVERHEAD_PER_MSG for m in session.messages)
            if approx_bytes <= cap:
                break
            session.messages.pop(0)

    async def _enforce_user_session_cap(self, session: Session) -> None:
        """Evict oldest session for this (scope, anchor, user) if at cap.

        Called from ``append_message`` on the very first save of a new
        session. No-op when ``max_sessions_per_user`` is 0 or when the
        store does not support per-user listing.
        """
        cap = self._max_sessions_per_user
        if cap <= 0:
            return
        try:
            from agent_service_maf.core.session_store import _split_scoped
        except ImportError:  # pragma: no cover
            return
        scope, project_id, anchor, user_id, _ = _split_scoped(session.session_id)
        if not scope:
            # Legacy un-scoped session — caps don't apply.
            return
        try:
            existing = await self._store.list_for_user(
                scope=scope,  # type: ignore[arg-type]
                project_id=project_id,
                anchor=anchor,
                user_id=user_id,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "session_user_cap_list_failed",
                scope=scope,
                project_id=project_id,
                anchor=anchor,
                error=str(exc),
            )
            return

        own_session_raw_id = _split_scoped(session.session_id)[4]
        # Filter out the current session — it's about to be saved.
        others = [s for s in existing if s.session_id != own_session_raw_id]
        if len(others) < cap:
            return
        # Evict oldest by created_at. Do not rely on list_for_user() ordering,
        # which may be based on last_accessed rather than creation time.
        others = sorted(others, key=lambda s: s.created_at)
        evict = others[: len(others) - cap + 1]
        for summary in evict:
            full_scoped_id = self._reconstruct_scoped_id(summary)
            try:
                await self._store.delete(full_scoped_id)
                logger.info(
                    "session_evicted_user_cap",
                    cap=cap,
                    evicted_session_id=summary.session_id,
                    scope=summary.scope,
                    anchor=summary.anchor,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "session_evict_failed",
                    session_id=summary.session_id,
                    error=str(exc),
                )

    @staticmethod
    def _reconstruct_scoped_id(summary: SessionSummary) -> str:
        """Rebuild the fully-scoped key from a :class:`SessionSummary`.

        Always emits the 5-segment Phase-2 shape
        ``scope:project_id:anchor:user_id:session_id``. When ``user_id``
        is empty (dev mode without auth) the segment is left blank,
        producing the canonical ``...:anchor::session_id`` form that
        :func:`_split_scoped` round-trips unambiguously. Dropping the
        empty segment would produce a 4-segment shape that
        ``_split_scoped`` treats as legacy and re-parses with shifted
        components — causing ``_enforce_user_session_cap`` to evict the
        wrong key or no-op.
        """
        return (
            f"{summary.scope}:{summary.project_id}:{summary.anchor}:"
            f"{summary.user_id}:{summary.session_id}"
        )

    async def _cleanup_loop(self) -> None:
        """Periodically remove expired sessions."""
        while True:
            await asyncio.sleep(self._cleanup_interval)
            async with self._lock:
                all_ids = await self._store.list_ids()
                removed = 0
                for sid in all_ids:
                    session = await self._store.get(sid)
                    if session and session.is_expired(self._ttl_seconds):
                        await self._store.delete(sid)
                        removed += 1
                if removed:
                    logger.info(
                        "Session cleanup completed",
                        removed=removed,
                        remaining=len(all_ids) - removed,
                    )
