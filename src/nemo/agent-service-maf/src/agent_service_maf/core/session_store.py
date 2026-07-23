"""Pluggable session persistence backends.

Defines the :class:`SessionStore` ABC and two implementations:

- :class:`InMemorySessionStore` -- default, no external dependencies.
- :class:`RedisSessionStore` -- production-grade Redis backend with:

  * zlib-compressed JSON payloads (one round-trip; backward-compat with
    pre-existing uncompressed entries).
  * Sentinel HA via :func:`agent_service_maf.core.redis_factory.create_async_redis_client`.
  * Per-op ``asyncio.wait_for(..., _REDIS_OP_TIMEOUT)`` ceiling so a slow
    Redis cannot block request handlers.
  * Sibling metadata Hash storing ``{name, created_at, last_accessed,
    scope, anchor}``.
  * Sibling per-user index Set so ``list_for_user`` is O(1) Redis cost
    instead of a global ``SCAN``.
  * Atomic multi-key writes via Redis pipeline (session value + meta +
    index entry refreshed in one round-trip).
  * Optional lazy migration: when a Phase-2 scope-aware key is empty but
    a legacy 2/3-component key has data, the legacy entry is copied to
    the new shape on first read.

The backend is selected by ``memory.storage_backend`` config:
``"memory"`` (default) or ``"redis"``.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import time
import zlib
from abc import ABC, abstractmethod
from datetime import datetime
from typing import Any, Literal

import structlog

from agent_service_maf.core.session import ConversationMessage, Session, SessionSummary

logger = structlog.get_logger(__name__)

#: Per-op timeout for Redis calls. Bounds the worst-case blocking time on
#: any single read/write so a slow Redis cannot stall a request handler.
_REDIS_OP_TIMEOUT: float = 10.0

#: Scope discriminator literal -- duplicated here to keep the store free of
#: imports from team_bundle (avoids a circular).
SessionScope = Literal["team", "agent"]


# ---------------------------------------------------------------------------
# Privacy-safe identifiers for observability (MEM-3.6)
# ---------------------------------------------------------------------------
#
# We never log a raw user_id or session_id -- those values are sensitive
# (the raw user_id can be a sub claim or email address; the session id
# can land in a URL bar). Instead, we publish short, deterministic
# fingerprints derived via HMAC-style hashing. With a per-deployment
# salt (``AGENT_MEMORY__LOG_HASH_SALT`` env var), rainbow-table style
# attacks against the hashed values are infeasible.
#
# When the env var is unset we fall back to a per-process random salt
# generated at import time. This keeps the same value stable within one
# process (so a single log stream's correlation stays useful) but makes
# the hash unpredictable across deploys / restarts -- so an attacker
# who scrapes one log batch cannot precompute a rainbow table against
# the next. A WARNING is emitted at import time so operators see that
# they should set the env var for stable cross-process correlation.
# ---------------------------------------------------------------------------

_DEFAULT_SALT_ENV: str = "AGENT_MEMORY__LOG_HASH_SALT"


def _resolve_hash_salt() -> str:
    """Pick the salt for :func:`hash_for_log`, warning on weak fallbacks.

    Priority:

    1. ``AGENT_MEMORY__LOG_HASH_SALT`` env var if set and non-empty.
    2. A 32-byte ``secrets.token_hex`` randomly generated at import
       time. Stable per-process; unpredictable across processes.

    The previous implementation hard-coded ``"maf-default-salt"`` when
    the env var was unset, which made hashes predictable across every
    deployment of the service -- an attacker with access to a single
    log line could precompute the hash for any email address or known
    user_id and re-identify users. Per-process randomness is strictly
    better; an explicit env var is better still (correlation across
    pods).
    """
    explicit = os.environ.get(_DEFAULT_SALT_ENV, "").strip()
    if explicit:
        return explicit

    # No env var; generate a per-process random salt. ``secrets`` is the
    # right primitive here even though the salt is not a secret per se
    # -- we want unpredictability across deploys.
    import secrets

    generated = secrets.token_hex(16)
    logger.warning(
        "memory_hash_salt_unset",
        env_var=_DEFAULT_SALT_ENV,
        action=(
            "Falling back to a per-process random salt. Hashed user_id / "
            "session_id values in logs and metrics will NOT correlate "
            "across processes or restarts. Set "
            f"{_DEFAULT_SALT_ENV}=<random-string> in the environment to "
            "get stable correlation."
        ),
    )
    return generated


_HASH_SALT: str = _resolve_hash_salt()


def hash_for_log(value: str | None, *, length: int = 10) -> str:
    """Hash a sensitive identifier for log/metric attribution.

    Returns the first ``length`` hex chars of ``sha256(salt + value)``.
    Empty input maps to the special token ``"-"`` so dev-mode rows
    (empty user_id) remain visually distinct from real-user rows.

    Args:
        value: The raw identifier to hash. ``None`` / empty returns ``"-"``.
        length: Number of hex chars to return. 10 chars = 40 bits of
            entropy, plenty for log dedup without bloating fields.

    Returns:
        A short hex fingerprint, or ``"-"`` for empty input.
    """
    if not value:
        return "-"
    digest = hashlib.sha256(f"{_HASH_SALT}|{value}".encode()).hexdigest()
    return digest[:length]


# ---------------------------------------------------------------------------
# Optional OTel meter (no-op when opentelemetry is not installed)
# ---------------------------------------------------------------------------


def _build_memory_counter() -> Any:  # noqa: ANN401  # OTel meter API is dynamic
    """Return a memory-op counter, or a no-op when OTel isn't installed."""
    try:
        from opentelemetry import metrics

        meter = metrics.get_meter("agent_service_maf.memory")
        return meter.create_counter(
            "agent_memory_ops_total",
            description="Count of session-store operations (Phase 3 MEM-3.6)",
        )
    except Exception:  # noqa: BLE001

        class _NoopCounter:
            def add(self, _value: int, **_attrs: Any) -> None:  # noqa: ANN401
                return None

        return _NoopCounter()


_memory_ops_counter: Any = _build_memory_counter()


def _record_op(
    *,
    op: str,
    backend: str,
    status: str,
    scope: str = "",
    user_hash: str = "-",
) -> None:
    """Bump the agent_memory_ops_total counter for one op.

    Only **bounded-cardinality** attributes are attached to the metric:

    - ``op`` — fixed enum (``get`` / ``save`` / ``delete`` / ``rename`` …).
    - ``backend`` — fixed enum (``memory`` / ``redis``).
    - ``status`` — fixed enum (``hit`` / ``miss`` / ``ok`` / ``legacy_migrate`` …).
    - ``scope`` — fixed enum (``team`` / ``agent`` / ``""`` / ``"-"``).

    The ``user_hash`` parameter is **intentionally not** attached as a
    metric attribute. Even though it is a short hash, the cardinality is
    proportional to the active user base — every distinct user produces
    a distinct time series in the metrics backend, which is a textbook
    cardinality blow-up. The hash is still useful in **log lines** for
    per-user correlation (one log record per op, bounded by RPS), so it
    is accepted by this function and forwarded to the structured log
    statement below, but never to the counter.
    """
    # Telemetry failures must never break a request, hence the suppress.
    with contextlib.suppress(Exception):
        _memory_ops_counter.add(
            1,
            attributes={
                "op": op,
                "backend": backend,
                "status": status,
                "scope": scope or "-",
            },
        )
    # Log lines, unlike metrics, are per-event and can carry the
    # user_hash without blowing up storage. Operators searching for "all
    # ops for user fingerprint XYZ" use the log index; alerts use the
    # metric.
    try:
        logger.debug(
            "memory_op",
            op=op,
            backend=backend,
            status=status,
            scope=scope or "-",
            user_hash=user_hash,
        )
    except Exception:  # noqa: BLE001
        return


def _split_scoped(scoped: str) -> tuple[str, str, str, str, str]:
    """Parse a scoped session id into a 5-tuple.

    Returns ``(scope, project_id, anchor, user_id, session_id)``. The
    store accepts every shape MAF has emitted so it can serve data
    written by every prior schema without losing reads during migration:

    1. ``"{scope}:{project_id}:{anchor}:{user_id}:{session_id}"`` --
       The single Phase 2 shape, always 5 fixed segments followed by an
       arbitrary ``session_id`` (which may itself contain ``:``). When
       the caller did not supply a ``user_id`` (dev mode), the segment
       is the empty string, producing a literal ``::`` between
       ``anchor`` and ``session_id``. The parser uses
       ``str.split(':', 4)`` so the first four segments are fixed-width
       and the remainder is re-joined as the raw session id.
    2. ``"{project_id}:{team_id}:{session_id}"`` -- Phase 1 legacy
       3-component (no scope, no user). ``scope=""`` indicates "legacy".
    3. ``"{team_id}:{session_id}"`` -- Pre-Phase-1 legacy 2-component.
    4. Single component -- caller-supplied raw id with no prefix.
       Treated as fully-legacy.

    .. note::
       Prior to the fix that produced this docstring, a "dev fallback"
       Phase-2 shape with **four** components and no user_id was
       supported. That shape was ambiguous: a raw ``session_id``
       containing a ``:`` (which the API explicitly supports for
       caller-chosen ids like ``"user-conv:42"``) collapsed into the
       same 5-segment-with-colon shape as a real production id and the
       parser mis-attributed the first chunk as ``user_id``. The
       4-segment shape is no longer emitted; legacy keys that still
       carry it are not produced by current code but, if read from
       Redis during a migration window, they fall through to the
       3-component legacy branch with ``scope=""``.

    The function never raises -- malformed input falls through to the
    legacy branch and the caller decides how to treat unscoped data.

    Args:
        scoped: The scoped session id as produced by
            :meth:`agent_service_maf.core.team_bundle.TeamBundle.scoped_session_id`.

    Returns:
        ``(scope, project_id, anchor, user_id, session_id)``. Empty
        strings for any component the input did not contain. ``scope``
        is ``""`` for legacy shapes; ``"team"`` or ``"agent"`` for
        Phase 2 shapes.
    """
    # ``split(':', 4)`` caps at 5 chunks; the last chunk gets every
    # remaining colon-bearing character, which preserves raw session
    # ids like ``"chat:42:retry"`` verbatim.
    parts = scoped.split(":", maxsplit=4)
    if parts and parts[0] in ("team", "agent") and len(parts) == 5:
        scope = parts[0]
        return scope, parts[1], parts[2], parts[3], parts[4]

    # Anything that doesn't match the 5-segment Phase-2 shape (including
    # the now-defunct 4-segment dev variant, which would be malformed if
    # we encountered it) falls through to legacy parsing. Legacy ids
    # never start with "team"/"agent" so the first-token check above is
    # sufficient to disambiguate; an old 4-segment Phase-2 id would be
    # routed to the 3-component legacy branch here and read as
    # ``project_id="{scope}", team_id="{old-project}"`` -- adequate for
    # one-shot migration via :meth:`RedisSessionStore._try_legacy_read`.
    if len(parts) >= 3:
        # Legacy 3-component: {project_id}:{team_id}:{session_id}
        return "", parts[0], parts[1], "", ":".join(parts[2:])
    if len(parts) == 2:
        # Legacy 2-component: {team_id}:{session_id}
        return "", "", parts[0], "", parts[1]
    return "", "", "", "", scoped


def _strip_scope(scoped: str) -> str:
    """Return just the raw caller-supplied session id (last component).

    Mirror of :func:`_split_scoped` for callers that only need the raw
    id to echo back to a client.
    """
    return _split_scoped(scoped)[4]


def _friendly_name(ts: float | None = None) -> str:
    """Return a human-readable default session name like ``"Session May 11, 11:30 PM"``."""
    when = datetime.fromtimestamp(ts) if ts else datetime.now()
    return when.strftime("Session %b %d, %I:%M %p")


# ---------------------------------------------------------------------------
# Abstract base
# ---------------------------------------------------------------------------


class SessionStore(ABC):
    """Abstract interface for session persistence.

    All methods are async to support both in-memory and networked backends.
    Implementations must be safe for use from a single asyncio event loop.

    Implementations that fail an op (timeout, decode error, network error)
    should raise so the caller (the route handler) can apply fail-open
    semantics and stamp ``memory_degraded: true`` on the response. The
    store itself does NOT swallow errors.
    """

    @abstractmethod
    async def get(self, session_id: str) -> Session | None:
        """Retrieve a session by its fully-scoped id. ``None`` if not found."""

    @abstractmethod
    async def save(self, session: Session) -> None:
        """Persist a session (create or update). Refreshes TTL on Redis."""

    @abstractmethod
    async def delete(self, session_id: str) -> bool:
        """Delete a session. Returns ``True`` if it existed."""

    @abstractmethod
    async def list_ids(self) -> list[str]:
        """List every session id in the store (admin / cleanup use only)."""

    @abstractmethod
    async def list_for_user(
        self,
        *,
        scope: SessionScope,
        project_id: str,
        anchor: str,
        user_id: str,
    ) -> list[SessionSummary]:
        """List the user's sessions for the given (scope, project, anchor).

        Args:
            scope: ``"team"`` for team-scoped sessions, ``"agent"`` for
                agent-scoped.
            project_id: Project id (multi-tenant boundary). Must match
                the project under which the sessions were created.
            anchor: ``team_id`` when ``scope="team"``, ``agent_id`` when
                ``scope="agent"``.
            user_id: The authenticated user's id. Empty string is the
                dev-mode partition.

        Returns:
            :class:`SessionSummary` objects newest first by
            ``last_accessed``.
        """

    @abstractmethod
    async def rename(self, session_id: str, name: str) -> bool:
        """Update the friendly name on the metadata Hash. ``False`` if unknown."""

    @abstractmethod
    async def close(self) -> None:
        """Release any resources (connections, pools)."""


# ---------------------------------------------------------------------------
# In-memory backend (default)
# ---------------------------------------------------------------------------


class InMemorySessionStore(SessionStore):
    """In-memory session store backed by a plain dict.

    Zero external dependencies; sessions are lost on process restart.
    Suitable for development and single-instance deployments. The
    per-user index is mirrored in-process via :attr:`_index` so
    ``list_for_user`` is fast and correctness-equivalent to the Redis
    backend.
    """

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._meta: dict[str, dict[str, Any]] = {}
        # Index key: (scope, project_id, anchor, user_id) → set of scoped ids.
        self._index: dict[tuple[str, str, str, str], set[str]] = {}

    async def get(self, session_id: str) -> Session | None:
        scope, _, _, user_id, _ = _split_scoped(session_id)
        session = self._sessions.get(session_id)
        if session is not None and session_id in self._meta:
            self._meta[session_id]["last_accessed"] = time.time()
        _record_op(
            op="get",
            backend="memory",
            status="hit" if session is not None else "miss",
            scope=scope,
            user_hash=hash_for_log(user_id),
        )
        return session

    async def save(self, session: Session) -> None:
        scope, project_id, anchor, user_id, _ = _split_scoped(session.session_id)
        _record_op(
            op="save",
            backend="memory",
            status="ok",
            scope=scope,
            user_hash=hash_for_log(user_id),
        )
        existing_meta = self._meta.get(session.session_id, {})
        now = time.time()
        self._sessions[session.session_id] = session
        self._meta[session.session_id] = {
            "name": existing_meta.get("name")
            or session.metadata.get("name", _friendly_name(session.created_at)),
            "created_at": existing_meta.get("created_at", session.created_at),
            "last_accessed": now,
            "scope": scope,
            "project_id": project_id,
            "anchor": anchor,
            "user_id": user_id,
        }
        key = (scope, project_id, anchor, user_id)
        self._index.setdefault(key, set()).add(session.session_id)

    async def delete(self, session_id: str) -> bool:
        scope, _, _, user_id, _ = _split_scoped(session_id)
        existed = session_id in self._sessions
        self._sessions.pop(session_id, None)
        meta = self._meta.pop(session_id, None)
        if meta:
            key = (
                meta.get("scope", ""),
                meta.get("project_id", ""),
                meta.get("anchor", ""),
                meta.get("user_id", ""),
            )
            members = self._index.get(key)
            if members is not None:
                members.discard(session_id)
                if not members:
                    self._index.pop(key, None)
        _record_op(
            op="delete",
            backend="memory",
            status="ok" if existed else "miss",
            scope=scope,
            user_hash=hash_for_log(user_id),
        )
        return existed

    async def list_ids(self) -> list[str]:
        return list(self._sessions.keys())

    async def list_for_user(
        self,
        *,
        scope: SessionScope,
        project_id: str,
        anchor: str,
        user_id: str,
    ) -> list[SessionSummary]:
        ids = self._index.get((scope, project_id, anchor, user_id), set())
        summaries: list[SessionSummary] = []
        for sid in ids:
            meta = self._meta.get(sid, {})
            session = self._sessions.get(sid)
            summaries.append(
                SessionSummary(
                    session_id=_strip_scope(sid),
                    scope=meta.get("scope", scope),
                    project_id=meta.get("project_id", project_id),
                    anchor=meta.get("anchor", anchor),
                    user_id=meta.get("user_id", user_id),
                    name=meta.get("name", ""),
                    created_at=float(meta.get("created_at", 0.0)),
                    last_accessed=float(meta.get("last_accessed", 0.0)),
                    message_count=len(session.messages) if session else 0,
                )
            )
        summaries.sort(key=lambda s: s.last_accessed, reverse=True)
        return summaries

    async def rename(self, session_id: str, name: str) -> bool:
        meta = self._meta.get(session_id)
        if meta is None:
            return False
        meta["name"] = name
        return True

    async def close(self) -> None:
        self._sessions.clear()
        self._meta.clear()
        self._index.clear()


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------


def _session_to_dict(session: Session) -> dict[str, Any]:
    """Serialize a Session to a JSON-compatible dict."""
    return {
        "session_id": session.session_id,
        "messages": [m.model_dump(mode="json") for m in session.messages],
        "created_at": session.created_at,
        "last_accessed": session.last_accessed,
        "metadata": session.metadata,
        "token_count": session.token_count,
    }


def _session_from_dict(data: dict[str, Any]) -> Session:
    """Deserialize a Session from a dict."""
    messages = [ConversationMessage(**m) for m in data.get("messages", [])]
    return Session(
        session_id=data["session_id"],
        messages=messages,
        created_at=data.get("created_at", time.time()),
        last_accessed=data.get("last_accessed", time.time()),
        metadata=data.get("metadata", {}),
        token_count=data.get("token_count", 0),
    )


def _try_decode(raw: bytes | str | None) -> Session | None:
    """Decode a stored payload to a Session.

    Tries zlib-decompression first; falls back to plain JSON if the bytes
    don't look compressed. Returns ``None`` for empty / malformed input.
    Backward-compat: pre-Phase-1 entries were saved as plain JSON without
    compression and are still readable.
    """
    if raw is None:
        return None
    try:
        if isinstance(raw, bytes):
            try:
                decompressed = zlib.decompress(raw)
                data = json.loads(decompressed.decode("utf-8"))
            except zlib.error:
                # Pre-compression legacy payload: treat as plain JSON.
                data = json.loads(raw.decode("utf-8"))
        else:
            data = json.loads(raw)
        return _session_from_dict(data)
    except (zlib.error, json.JSONDecodeError, KeyError, UnicodeDecodeError) as exc:
        logger.warning(
            "session_store_decode_failed",
            error_type=type(exc).__name__,
            error=str(exc),
        )
        return None


# ---------------------------------------------------------------------------
# Redis backend (production)
# ---------------------------------------------------------------------------


class RedisSessionStore(SessionStore):
    """Redis-backed session store for multi-instance deployments.

    Requires the ``redis`` package (``pip install redis[hiredis]``).
    Sessions are stored as zlib-compressed JSON under a configurable key
    prefix. Three keys are written per session::

        agent_session:{scoped_id}            (String, zlib JSON)
        agent_session_meta:{scoped_id}       (Hash: name, created_at, ...)
        agent_session_index:{scope}:{anchor}:{user_id}  (Set of scoped_ids)

    All three carry the same TTL, refreshed on every save.

    Args:
        redis_url: Connection URL (used when no Sentinel is configured).
        redis_sentinel_url: Comma-separated Sentinel hosts. Non-empty
            switches the client to master-discovery mode.
        redis_sentinel_master: Sentinel service name.
        redis_password: Optional AUTH password.
        key_prefix: Prefix for the session value String.
        index_prefix: Prefix for the per-user index Set.
        meta_prefix: Prefix for the per-session metadata Hash.
        ttl_seconds: TTL applied to all three keys on every save. ``0`` or
            negative disables TTL (rely on application-level cleanup).
        compression_level: zlib compression level (1 fast .. 9 thorough).
        legacy_team_prefix: When non-empty, ``get`` falls back to the
            legacy 2-/3-component key shape under this prefix if the new
            key is empty. Phase 2 lazy-migration path. Defaults to the
            same value as ``key_prefix``.

    Raises:
        ImportError: If the ``redis`` package is not installed.
    """

    def __init__(
        self,
        redis_url: str = "redis://localhost:6379/0",
        *,
        redis_sentinel_url: str = "",
        redis_sentinel_master: str = "mymaster",
        redis_password: str = "",
        key_prefix: str = "agent_session:",
        index_prefix: str = "agent_session_index:",
        meta_prefix: str = "agent_session_meta:",
        ttl_seconds: int = 86400,
        compression_level: int = 1,
        legacy_team_prefix: str = "",
    ) -> None:
        from agent_service_maf.core.redis_factory import create_async_redis_client

        self._redis = create_async_redis_client(
            redis_url=redis_url,
            redis_sentinel_url=redis_sentinel_url,
            redis_sentinel_master=redis_sentinel_master,
            redis_password=redis_password,
            decode_responses=False,
        )
        self._prefix = key_prefix
        self._index_prefix = index_prefix
        self._meta_prefix = meta_prefix
        self._ttl = ttl_seconds
        self._level = compression_level
        self._legacy_prefix = legacy_team_prefix or key_prefix
        logger.info(
            "redis_session_store_initialized",
            url=redis_url,
            sentinel=bool(redis_sentinel_url),
            prefix=key_prefix,
            ttl=ttl_seconds,
            compression_level=compression_level,
        )

    # --- key helpers -----------------------------------------------------

    def _session_key(self, scoped_id: str) -> str:
        return f"{self._prefix}{scoped_id}"

    def _meta_key(self, scoped_id: str) -> str:
        return f"{self._meta_prefix}{scoped_id}"

    def _index_key(
        self,
        scope: str,
        project_id: str,
        anchor: str,
        user_id: str,
    ) -> str:
        return f"{self._index_prefix}{scope}:{project_id}:{anchor}:{user_id}"

    def _encode(self, session: Session) -> bytes:
        payload = json.dumps(_session_to_dict(session)).encode("utf-8")
        return zlib.compress(payload, level=self._level)

    # --- core ops --------------------------------------------------------

    async def get(self, session_id: str) -> Session | None:
        """Retrieve a session, with lazy migration fallback for legacy keys.

        Order of operations:

        1. Try the new-shape key (``{prefix}{scoped_id}``).
        2. If empty AND the scoped id is team-scoped, try the legacy
           2-component (``{team_id}:{session_id}``) and 3-component
           (``{project_id}:{team_id}:{session_id}``) shapes derived from
           the scope. If found, copy to the new key and return.
        3. Otherwise return ``None``.
        """
        scope, _, _, op_user_id, _ = _split_scoped(session_id)
        op_user_hash = hash_for_log(op_user_id)
        raw = await asyncio.wait_for(
            self._redis.get(self._session_key(session_id)),
            timeout=_REDIS_OP_TIMEOUT,
        )
        session = _try_decode(raw)
        if session is not None:
            _record_op(
                op="get",
                backend="redis",
                status="hit",
                scope=scope,
                user_hash=op_user_hash,
            )
            # NOTE: no meta-touch here. ``SessionManager.get`` and
            # ``SessionManager.get_or_create`` already call
            # ``session.touch()`` and route through ``store.save`` after
            # this method returns; ``save`` rewrites the meta hash and
            # refreshes every TTL in one pipeline. Duplicating that work
            # here added two extra Redis round-trips on the hot read
            # path, and -- worse -- could leave an orphaned meta hash
            # for a session value that was never persisted via ``save``
            # (e.g. ``get`` succeeds, ``HSET`` succeeds, then
            # ``SessionManager`` decides the session is expired and
            # deletes only the value). Letting the higher-level manager
            # own the touch keeps meta and value lifecycles aligned.
            return session

        migrated = await self._try_legacy_read(session_id)
        if migrated is not None:
            await self.save(migrated)
            _record_op(
                op="get",
                backend="redis",
                status="legacy_migrate",
                scope=scope,
                user_hash=op_user_hash,
            )
            return migrated
        _record_op(
            op="get",
            backend="redis",
            status="miss",
            scope=scope,
            user_hash=op_user_hash,
        )
        return None

    async def _try_legacy_read(self, scoped_id: str) -> Session | None:
        """Probe legacy 2-/3-component key shapes for team-scoped reads.

        Returns the rehydrated :class:`Session` if a legacy entry exists,
        otherwise ``None``. The caller is responsible for re-saving the
        result under the new-shape key (lazy migration).

        Agent-scoped reads are NOT migrated: the legacy team-anchored
        keys carry no agent identity, so there is no defensible mapping.
        """
        scope, project_id, anchor, _user_id, raw_session_id = _split_scoped(scoped_id)
        if scope != "team":
            return None
        if not anchor or not raw_session_id:
            return None

        # Probe both legacy shapes. The 3-component shape was the
        # last-shipped pre-Phase-2 key in MAF; the 2-component shape
        # predates project scoping.
        candidates: list[str] = []
        if project_id:
            candidates.append(f"{self._legacy_prefix}{project_id}:{anchor}:{raw_session_id}")
        candidates.append(f"{self._legacy_prefix}{anchor}:{raw_session_id}")

        for legacy_key in candidates:
            try:
                raw = await asyncio.wait_for(
                    self._redis.get(legacy_key),
                    timeout=_REDIS_OP_TIMEOUT,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "legacy_read_failed",
                    key=legacy_key,
                    error=str(exc),
                )
                continue
            session = _try_decode(raw)
            if session is not None:
                logger.info(
                    "session_legacy_migrate_hit",
                    legacy_key=legacy_key,
                    new_scoped_id=scoped_id,
                )
                # The legacy Session.session_id is the legacy key; rewrite
                # to the new scoped_id so the new save lands under the
                # right Redis key.
                session.session_id = scoped_id
                return session
        return None

    async def save(self, session: Session) -> None:
        """Persist session + meta + index in one Redis pipeline.

        Refreshes TTL on all three keys. Sets the friendly name on first
        save (when no prior meta Hash exists) by reading the meta Hash
        first; falls back to ``_friendly_name()`` if the read fails.
        """
        scoped = session.session_id
        scope, project_id, anchor, user_id, _ = _split_scoped(scoped)
        encoded = self._encode(session)
        now = time.time()

        existing_name = ""
        try:
            existing_name_bytes = await asyncio.wait_for(
                self._redis.hget(self._meta_key(scoped), "name"),
                timeout=_REDIS_OP_TIMEOUT,
            )
            if isinstance(existing_name_bytes, bytes):
                existing_name = existing_name_bytes.decode("utf-8")
            elif isinstance(existing_name_bytes, str):
                existing_name = existing_name_bytes
        except Exception as exc:  # noqa: BLE001
            logger.debug("session_meta_hget_failed", session_id=scoped, error=str(exc))

        name = (
            existing_name or session.metadata.get("name", "") or _friendly_name(session.created_at)
        )

        index_key = self._index_key(scope, project_id, anchor, user_id)
        pipe = self._redis.pipeline()
        if self._ttl > 0:
            pipe.set(self._session_key(scoped), encoded, ex=self._ttl)
        else:
            pipe.set(self._session_key(scoped), encoded)
        pipe.hset(
            self._meta_key(scoped),
            mapping={
                "name": name,
                "created_at": str(session.created_at),
                "last_accessed": str(now),
                "scope": scope,
                "project_id": project_id,
                "anchor": anchor,
                "user_id": user_id,
                "message_count": str(len(session.messages)),
            },
        )
        if self._ttl > 0:
            pipe.expire(self._meta_key(scoped), self._ttl)
        pipe.sadd(index_key, scoped)
        if self._ttl > 0:
            pipe.expire(index_key, self._ttl)
        await asyncio.wait_for(pipe.execute(), timeout=_REDIS_OP_TIMEOUT)
        _record_op(
            op="save",
            backend="redis",
            status="ok",
            scope=scope,
            user_hash=hash_for_log(user_id),
        )

    async def delete(self, session_id: str) -> bool:
        scope, project_id, anchor, user_id, _ = _split_scoped(session_id)
        pipe = self._redis.pipeline()
        pipe.delete(self._session_key(session_id))
        pipe.delete(self._meta_key(session_id))
        pipe.srem(self._index_key(scope, project_id, anchor, user_id), session_id)
        results = await asyncio.wait_for(pipe.execute(), timeout=_REDIS_OP_TIMEOUT)
        existed = bool(results[0])
        _record_op(
            op="delete",
            backend="redis",
            status="ok" if existed else "miss",
            scope=scope,
            user_hash=hash_for_log(user_id),
        )
        return existed

    async def list_ids(self) -> list[str]:
        prefix_len = len(self._prefix)
        result: list[str] = []
        # SCAN is bounded per call; the cursor loop itself isn't wrapped in
        # wait_for because each iteration is independently bounded by the
        # client socket_timeout.
        async for key in self._redis.scan_iter(
            match=f"{self._prefix}*",
            count=100,
        ):
            if isinstance(key, bytes):
                result.append(key.decode("utf-8")[prefix_len:])
            else:
                result.append(key[prefix_len:])
        return result

    async def list_for_user(
        self,
        *,
        scope: SessionScope,
        project_id: str,
        anchor: str,
        user_id: str,
    ) -> list[SessionSummary]:
        members: set[bytes | str] = await asyncio.wait_for(
            self._redis.smembers(self._index_key(scope, project_id, anchor, user_id)),
            timeout=_REDIS_OP_TIMEOUT,
        )
        summaries: list[SessionSummary] = []
        # One HGETALL per session is N+1 but bounded by max_sessions_per_user
        # (default 100). For larger caps we'd switch to a pipeline; the
        # current load profile keeps the simple loop honest.
        for raw in members:
            scoped = raw.decode("utf-8") if isinstance(raw, bytes) else raw
            try:
                meta_raw = await asyncio.wait_for(
                    self._redis.hgetall(self._meta_key(scoped)),
                    timeout=_REDIS_OP_TIMEOUT,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "session_meta_hgetall_failed",
                    scoped_id=scoped,
                    error=str(exc),
                )
                continue
            if not meta_raw:
                # Orphan index entry — opportunistic prune, skip in result.
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(
                        self._redis.srem(
                            self._index_key(scope, project_id, anchor, user_id),
                            scoped,
                        ),
                        timeout=_REDIS_OP_TIMEOUT,
                    )
                continue

            def _coerce(value: bytes | str | None) -> str:
                if value is None:
                    return ""
                return value.decode("utf-8") if isinstance(value, bytes) else value

            meta: dict[str, str] = {
                (k.decode("utf-8") if isinstance(k, bytes) else k): _coerce(v)
                for k, v in meta_raw.items()
            }
            summaries.append(
                SessionSummary(
                    session_id=_strip_scope(scoped),
                    scope=meta.get("scope", scope),
                    project_id=meta.get("project_id", project_id),
                    anchor=meta.get("anchor", anchor),
                    user_id=meta.get("user_id", user_id),
                    name=meta.get("name", ""),
                    created_at=float(meta.get("created_at") or 0.0),
                    last_accessed=float(meta.get("last_accessed") or 0.0),
                    message_count=int(meta.get("message_count") or 0),
                )
            )
        summaries.sort(key=lambda s: s.last_accessed, reverse=True)
        return summaries

    async def rename(self, session_id: str, name: str) -> bool:
        # HSET returns 0 if the field already existed (got updated) and 1 if
        # it was new. Either way the rename succeeded. We check the key
        # existence separately so the route can 404 a non-existent session.
        exists = await asyncio.wait_for(
            self._redis.exists(self._meta_key(session_id)),
            timeout=_REDIS_OP_TIMEOUT,
        )
        if not exists:
            return False
        await asyncio.wait_for(
            self._redis.hset(self._meta_key(session_id), "name", name),
            timeout=_REDIS_OP_TIMEOUT,
        )
        return True

    async def close(self) -> None:
        await self._redis.aclose()
        logger.info("redis_session_store_closed")


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


def create_session_store(
    backend: str = "memory",
    redis_url: str = "redis://localhost:6379/0",
    *,
    redis_sentinel_url: str = "",
    redis_sentinel_master: str = "mymaster",
    redis_password: str = "",
    key_prefix: str = "agent_session:",
    index_prefix: str = "agent_session_index:",
    meta_prefix: str = "agent_session_meta:",
    ttl_seconds: int = 0,
    compression_level: int = 1,
) -> SessionStore:
    """Create a session store from config.

    Args:
        backend: ``"memory"`` or ``"redis"``.
        redis_url: Standalone Redis URL.
        redis_sentinel_url: Sentinel host list (non-empty enables HA).
        redis_sentinel_master: Sentinel master service name.
        redis_password: Optional AUTH password.
        key_prefix: Prefix for session value strings.
        index_prefix: Prefix for per-user index Sets.
        meta_prefix: Prefix for per-session metadata Hashes.
        ttl_seconds: Per-key TTL refreshed on every save (Redis only).
        compression_level: zlib level (Redis only).

    Returns:
        A :class:`SessionStore` implementation.

    Raises:
        ValueError: If backend is not recognised.
        ImportError: If ``"redis"`` backend is selected but the package
            is missing.
    """
    if backend == "memory":
        return InMemorySessionStore()
    if backend == "redis":
        return RedisSessionStore(
            redis_url=redis_url,
            redis_sentinel_url=redis_sentinel_url,
            redis_sentinel_master=redis_sentinel_master,
            redis_password=redis_password,
            key_prefix=key_prefix,
            index_prefix=index_prefix,
            meta_prefix=meta_prefix,
            ttl_seconds=ttl_seconds,
            compression_level=compression_level,
        )
    raise ValueError(
        f"Unknown session storage backend: '{backend}'. Supported backends: 'memory', 'redis'."
    )
