"""Redis Streams wrapper for the acquisition pipeline.

A JobStream is keyed on (workflow_id, run_id) so Temporal retries with a fresh
run get their own clean stream while the previous run's data ages out via the
24h EXPIRE safety net.

Layout:
    Stream:  acq:{workflowId}:{runId}:items     (XADD producer, XREADGROUP consumers)
    State:   acq:{workflowId}:{runId}:state     (HSET produced/copied/bytes/eofSeen/lastProducedKey)
    Group:   acq                                 (single consumer group; consumers are acq-s0..N)

EOF semantics: producer writes a single sentinel entry {eof: "1"} and sets
HSET state eofSeen 1. Consumers exit after seeing the sentinel + one extra
empty read, so any lingering pending items get a chance to be reclaimed.

Idempotency: produce() checks is_complete() and last_produced_key() so a
retried discovery resumes instead of re-listing from scratch.

Sentinel-aware: build_job_stream prefers ACQ_REDIS_SENTINEL_URL (Sentinel
discovery) and falls back to ACQ_REDIS_URL (standalone) for laptop overlays.
"""
from __future__ import annotations

from observability_client_runtime import get_logger
import os
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Tuple

logger = get_logger()

_REDIS_INLINE_ATTEMPTS = 3
_REDIS_INLINE_BACKOFF_S = (0.05, 0.1, 0.2)
_WAIT_CAPACITY_READ_ATTEMPTS = 5


class DirQueueRedisError(RuntimeError):
    """Redis failure during DirQueue coordination (not a BRPOP timeout)."""


def _redis_call_with_retries(fn, attempts: int = _REDIS_INLINE_ATTEMPTS) -> Any:
    """Run *fn*; on exception retry with small backoff, then re-raise last error."""
    last_exc: Optional[BaseException] = None
    for i in range(attempts):
        try:
            return fn()
        except Exception as exc:
            last_exc = exc
            if i < attempts - 1:
                time.sleep(_REDIS_INLINE_BACKOFF_S[min(i, len(_REDIS_INLINE_BACKOFF_S) - 1)])
    assert last_exc is not None
    raise last_exc


EOF_FIELD = "eof"
EOF_VALUE = "1"
DEFAULT_GROUP = "acq"
DEFAULT_TTL_SECONDS = 86400  # 24h GC safety net if cleanup activity also fails
DEFAULT_STREAM_MAXLEN = 50000

# Consumer loops: cap consecutive Redis failures when reading eofSeen from stream state.
EOF_SEEN_REDIS_FAILURE_THRESHOLD = 5


def track_eof_seen_redis_failures(eof_val: Optional[bool], counter: List[int]) -> None:
    """Raise if *eof_val* is None too many times in a row (Redis state unreachable)."""
    if eof_val is None:
        counter[0] += 1
        if counter[0] > EOF_SEEN_REDIS_FAILURE_THRESHOLD:
            raise RuntimeError(
                "get_eof_seen() returned None repeatedly — Redis state unreachable"
            )
    else:
        counter[0] = 0


@dataclass
class JobStreamConfig:
    """Connection + tuning config for JobStream.

    Use build_job_stream() to construct from environment variables; this
    dataclass is the explicit form for tests.
    """
    workflow_id: str
    run_id: str
    redis_url: str = "redis://redis-master:6379/3"
    sentinel_addrs: List[Tuple[str, int]] = field(default_factory=list)
    sentinel_master: str = "mymaster"
    db: int = 3
    password: str = ""
    group_name: str = DEFAULT_GROUP
    ttl_seconds: int = DEFAULT_TTL_SECONDS
    stream_maxlen: int = DEFAULT_STREAM_MAXLEN
    # Optional pre-built client (used by tests with fakeredis).
    client: Optional[Any] = None


def _parse_sentinel_url(url: str, default_port: int = 26379) -> List[Tuple[str, int]]:
    if not url:
        return []
    out: List[Tuple[str, int]] = []
    for part in url.split(","):
        part = part.strip()
        if not part:
            continue
        if ":" in part:
            host, port = part.rsplit(":", 1)
            try:
                out.append((host, int(port)))
            except ValueError:
                out.append((part, default_port))
        else:
            out.append((part, default_port))
    return out


def build_job_stream(workflow_id: str, run_id: str) -> "JobStream":
    """Build a JobStream from environment variables.

    Honors ACQ_REDIS_SENTINEL_URL (preferred for HA) with fallback to ACQ_REDIS_URL.
    Used by activities; tests should construct JobStream directly with a fakeredis client.
    """
    cfg = JobStreamConfig(
        workflow_id=workflow_id,
        run_id=run_id,
        redis_url=os.environ.get("ACQ_REDIS_URL", "redis://redis-master:6379/3"),
        sentinel_addrs=_parse_sentinel_url(os.environ.get("ACQ_REDIS_SENTINEL_URL", "")),
        sentinel_master=os.environ.get("ACQ_REDIS_SENTINEL_MASTER", "mymaster"),
        db=int(os.environ.get("ACQ_REDIS_DB", "3")),
        password=os.environ.get("ACQ_REDIS_PASSWORD", ""),
        ttl_seconds=int(os.environ.get("ACQ_STREAM_TTL_SECONDS", str(DEFAULT_TTL_SECONDS))),
        stream_maxlen=int(os.environ.get("ACQ_STREAM_MAXLEN", str(DEFAULT_STREAM_MAXLEN))),
    )
    return JobStream(cfg)


class JobStream:
    """Redis-Streams-backed work queue for one acquisition run."""

    def __init__(self, config: JobStreamConfig):
        self.cfg = config
        if not config.workflow_id or not config.run_id:
            raise ValueError("JobStream requires non-empty workflow_id and run_id")
        self.stream_key = f"acq:{config.workflow_id}:{config.run_id}:items"
        self.state_key = f"acq:{config.workflow_id}:{config.run_id}:state"
        self.group = config.group_name
        self._client = config.client or self._build_client()

    @property
    def client(self):
        return self._client

    def _build_client(self):
        import redis  # imported lazily so the base test suite doesn't need redis

        if self.cfg.sentinel_addrs:
            from redis.sentinel import Sentinel

            sentinel = Sentinel(
                self.cfg.sentinel_addrs,
                socket_timeout=5,
                socket_connect_timeout=5,
            )
            return sentinel.master_for(
                self.cfg.sentinel_master,
                db=self.cfg.db,
                password=self.cfg.password or None,
                decode_responses=True,
                socket_timeout=10,
                socket_connect_timeout=5,
            )
        return redis.Redis.from_url(
            self.cfg.redis_url,
            decode_responses=True,
            socket_timeout=10,
            socket_connect_timeout=5,
        )

    def ping(self) -> bool:
        """Check Redis reachability before we commit to producing."""
        try:
            return bool(self._client.ping())
        except Exception as exc:
            logger.warning("JobStream.ping failed: %s", exc)
            return False

    def ensure_group(self) -> None:
        """Create the consumer group + set EXPIRE on stream and state keys.

        Safe to call multiple times. Stream is created lazily by XGROUP CREATE
        with MKSTREAM, so callers don't need to seed an entry first.
        """
        try:
            self._client.xgroup_create(
                name=self.stream_key,
                groupname=self.group,
                id="0",
                mkstream=True,
            )
        except Exception as exc:
            msg = str(exc)
            if "BUSYGROUP" not in msg:
                raise
        try:
            self._client.expire(self.stream_key, self.cfg.ttl_seconds)
            self._client.expire(self.state_key, self.cfg.ttl_seconds)
        except Exception as exc:
            logger.debug("JobStream.ensure_group EXPIRE failed (non-fatal): %s", exc)

    def get_eof_seen(self) -> Optional[bool]:
        """Return whether state hash marks EOF.

        True/False from Redis; None if Redis read failed after inline retries
        (callers must not treat None as False for long-poll exit logic).
        """
        last_exc: Optional[BaseException] = None
        for i in range(_REDIS_INLINE_ATTEMPTS):
            try:
                value = self._client.hget(self.state_key, "eofSeen")
                return _truthy(value)
            except Exception as exc:
                last_exc = exc
                logger.warning(
                    "JobStream.get_eof_seen: HGET eofSeen failed (attempt %d/%d): %s",
                    i + 1,
                    _REDIS_INLINE_ATTEMPTS,
                    exc,
                )
                if i < _REDIS_INLINE_ATTEMPTS - 1:
                    time.sleep(_REDIS_INLINE_BACKOFF_S[min(i, len(_REDIS_INLINE_BACKOFF_S) - 1)])
        if last_exc is not None:
            logger.warning("JobStream.get_eof_seen: exhausted retries: %s", last_exc)
        return None

    def is_complete(self) -> bool:
        """True iff the producer marked EOF in state (best-effort if Redis errors).

        On Redis failure returns False; long-running consumer loops should use
        get_eof_seen() and handle None explicitly.
        """
        v = self.get_eof_seen()
        if v is None:
            return False
        return v

    def last_produced_key(self) -> Optional[str]:
        """Highest source key the producer XADDed in a prior attempt.

        Discovery uses this with S3 paginator's StartAfter to resume listing
        instead of re-emitting items the consumers may already be acking.
        """
        try:
            v = self._client.hget(self.state_key, "lastProducedKey")
            if v in (None, ""):
                return None
            return v
        except Exception:
            return None

    def get_state(self) -> Dict[str, str]:
        try:
            data = self._client.hgetall(self.state_key) or {}
            return {str(k): str(v) for k, v in data.items()}
        except Exception:
            return {}

    def update_state(self, **fields: Any) -> bool:
        if not fields:
            return True
        flat: Dict[str, str] = {k: _to_str(v) for k, v in fields.items()}
        try:
            self._client.hset(self.state_key, mapping=flat)
            self._client.expire(self.state_key, self.cfg.ttl_seconds)
            return True
        except Exception as exc:
            logger.warning(
                "JobStream.update_state failed on %s: %s",
                self.state_key,
                exc,
            )
            return False

    def increment_state(self, **deltas: int) -> bool:
        if not deltas:
            return True
        try:
            pipe = self._client.pipeline()
            for k, v in deltas.items():
                pipe.hincrby(self.state_key, k, int(v))
            pipe.expire(self.state_key, self.cfg.ttl_seconds)
            pipe.execute()
            return True
        except Exception as exc:
            logger.warning(
                "JobStream.increment_state failed on %s: %s",
                self.state_key,
                exc,
            )
            return False

    def produce(
        self,
        items: Iterable[Dict[str, Any]],
        batch_size: int = 200,
        backpressure_sleep_ms: int = 200,
    ) -> int:
        """XADD items in chunks. Returns total written.

        Applies a soft cap via MAXLEN ~ self.cfg.stream_maxlen and blocks
        when XLEN exceeds the cap to avoid runaway memory. Records
        lastProducedKey after each chunk so retries resume from the right place.
        """
        produced = 0
        chunk: List[Dict[str, Any]] = []

        def _flush():
            nonlocal produced
            if not chunk:
                return
            self._wait_for_capacity(backpressure_sleep_ms)
            pipe = self._client.pipeline()
            for entry in chunk:
                pipe.xadd(
                    self.stream_key,
                    fields=_serialize_fields(entry),
                    maxlen=self.cfg.stream_maxlen,
                    approximate=True,
                )
            pipe.execute()
            produced += len(chunk)
            last_key = chunk[-1].get("key") or chunk[-1].get("source_key") or ""
            if last_key:
                ok = self.update_state(lastProducedKey=last_key, produced=produced)
            else:
                ok = self.update_state(produced=produced)
            if not ok:
                raise RuntimeError(
                    f"JobStream.produce: update_state failed after flushing {len(chunk)} entries"
                )
            chunk.clear()

        for item in items:
            chunk.append(item)
            if len(chunk) >= batch_size:
                _flush()
        _flush()
        return produced

    def xadd_batch(
        self,
        entries: List[Dict[str, Any]],
        backpressure_sleep_ms: int = 200,
    ) -> int:
        """Pipelined XADD for concurrent producers (volume discovery).

        Unlike produce(), this method:
        - Uses MAXLEN = stream_maxlen * 3 (safety valve above the backpressure
          cap) so it never trims entries consumers haven't read yet.
        - Uses increment_state (atomic HINCRBY) instead of update_state
          (absolute set) so M concurrent discoverers don't clobber counts.
        - Does NOT track lastProducedKey (volume discovery has no resume key).
        """
        if not entries:
            return 0
        self._wait_for_capacity(backpressure_sleep_ms)
        safety_maxlen = max(1, self.cfg.stream_maxlen * 3)
        pipe = self._client.pipeline()
        for entry in entries:
            pipe.xadd(
                self.stream_key,
                fields=_serialize_fields(entry),
                maxlen=safety_maxlen,
                approximate=True,
            )
        pipe.execute()
        if not self.increment_state(produced=len(entries)):
            logger.warning(
                "JobStream.xadd_batch: increment_state failed after XADD of %d entries",
                len(entries),
            )
        return len(entries)

    def _wait_for_capacity(self, sleep_ms: int) -> None:
        """If stream entries exceed the cap, sleep until consumers drain.

        With XDEL in ack(), XLEN now closely tracks the actual unconsumed
        count.  We still use XTRIM as a safety net for entries that were
        never ACKed (e.g. due to consumer crashes).
        """
        cap = max(1, int(self.cfg.stream_maxlen * 1.5))
        sleep_s = max(0.001, sleep_ms / 1000.0)
        waited = 0
        while True:
            length = 0
            for attempt in range(_WAIT_CAPACITY_READ_ATTEMPTS):
                try:
                    self._client.xtrim(
                        self.stream_key,
                        maxlen=self.cfg.stream_maxlen,
                        approximate=True,
                    )
                    length = int(self._client.xlen(self.stream_key))
                    break
                except Exception as exc:
                    logger.warning(
                        "JobStream._wait_for_capacity: xtrim/xlen failed (attempt %d/%d): %s",
                        attempt + 1,
                        _WAIT_CAPACITY_READ_ATTEMPTS,
                        exc,
                    )
                    if attempt >= _WAIT_CAPACITY_READ_ATTEMPTS - 1:
                        raise RuntimeError(
                            f"JobStream._wait_for_capacity: cannot read stream length for "
                            f"{self.stream_key} after {_WAIT_CAPACITY_READ_ATTEMPTS} attempts"
                        ) from exc
                    time.sleep(sleep_s)
            if length <= cap:
                if waited > 0:
                    logger.info(
                        "JobStream._wait_for_capacity: stream=%s drained to %d (cap=%d) "
                        "after %d waits",
                        self.stream_key, length, cap, waited,
                    )
                return
            waited += 1
            if waited == 1 or waited % 25 == 0:
                logger.info(
                    "JobStream._wait_for_capacity: stream=%s XLEN=%d > cap=%d, "
                    "sleeping %dms (wait #%d)",
                    self.stream_key, length, cap, sleep_ms, waited,
                )
            time.sleep(sleep_s)

    def mark_eof(self) -> None:
        """Append the EOF sentinel + flip eofSeen in state (idempotent for Temporal retries)."""
        seen = self.get_eof_seen()
        if seen is True:
            return
        if seen is None:
            raise RuntimeError(
                "JobStream.mark_eof: cannot read eofSeen from Redis after retries"
            )

        try:
            rev = self._client.xrevrange(self.stream_key, max="+", min="-", count=10)
        except Exception as exc:
            logger.warning("JobStream.mark_eof: XREVRANGE failed, continuing: %s", exc)
            rev = []

        for _stream_id, fields in rev or []:
            if not fields:
                continue
            if str(fields.get(EOF_FIELD, "")) == EOF_VALUE:
                if not self.update_state(eofSeen=1, eofAt=int(time.time())):
                    raise RuntimeError("JobStream.mark_eof: repair update_state failed")
                return

        try:
            self._client.xadd(
                self.stream_key,
                fields={EOF_FIELD: EOF_VALUE},
                maxlen=self.cfg.stream_maxlen,
                approximate=True,
            )
        except Exception as exc:
            raise RuntimeError(f"JobStream.mark_eof: xadd failed: {exc}") from exc
        if not self.update_state(eofSeen=1, eofAt=int(time.time())):
            raise RuntimeError("JobStream.mark_eof: update_state after xadd failed")

    def consume(
        self,
        consumer_name: str,
        count: int,
        block_ms: int = 2000,
    ) -> List[Tuple[str, Dict[str, str]]]:
        """XREADGROUP > group=self.group, returning [(stream_id, fields), ...].

        Returns [] only when Redis returns no data within block_ms (not on
        transport/protocol errors; those raise after inline retries).
        """
        last_exc: Optional[BaseException] = None
        for i in range(_REDIS_INLINE_ATTEMPTS):
            try:
                resp = self._client.xreadgroup(
                    groupname=self.group,
                    consumername=consumer_name,
                    streams={self.stream_key: ">"},
                    count=count,
                    block=block_ms,
                )
                if not resp:
                    return []
                out: List[Tuple[str, Dict[str, str]]] = []
                for _stream, entries in resp:
                    for stream_id, fields in entries:
                        out.append((str(stream_id), {str(k): str(v) for k, v in (fields or {}).items()}))
                return out
            except Exception as exc:
                last_exc = exc
                logger.warning(
                    "JobStream.consume failed (attempt %d/%d): %s",
                    i + 1,
                    _REDIS_INLINE_ATTEMPTS,
                    exc,
                )
                if i < _REDIS_INLINE_ATTEMPTS - 1:
                    time.sleep(_REDIS_INLINE_BACKOFF_S[min(i, len(_REDIS_INLINE_BACKOFF_S) - 1)])
        assert last_exc is not None
        raise last_exc

    def ack(self, stream_ids: Iterable[str]) -> int:
        """XACK + XDEL to remove consumed entries and keep XLEN accurate.

        XTRIM MAXLEN only caps total count and ignores ACK status, so a
        stream at maxlen with all entries ACKed stays full indefinitely.
        XDEL actually removes the specific entries, keeping XLEN close to
        the real unconsumed count and preventing false backpressure.
        """
        ids = list(stream_ids)
        if not ids:
            return 0
        try:
            pipe = self._client.pipeline()
            pipe.xack(self.stream_key, self.group, *ids)
            pipe.xdel(self.stream_key, *ids)
            results = pipe.execute()
            return int(results[0])
        except Exception as exc:
            logger.warning("JobStream.ack failed: %s", exc)
            return 0

    def claim_pending(
        self,
        consumer_name: str,
        min_idle_ms: int = 300_000,
        count: int = 64,
    ) -> List[Tuple[str, Dict[str, str]]]:
        """XAUTOCLAIM idle entries from dead consumers into this consumer.

        Falls back to XPENDING + XCLAIM on Redis < 6.2 (XAUTOCLAIM was added in 6.2).
        Returns the same shape as consume().
        """
        try:
            cursor, claimed, _ = self._client.xautoclaim(
                name=self.stream_key,
                groupname=self.group,
                consumername=consumer_name,
                min_idle_time=min_idle_ms,
                start_id="0-0",
                count=count,
            )
            out: List[Tuple[str, Dict[str, str]]] = []
            for stream_id, fields in claimed:
                out.append((str(stream_id), {str(k): str(v) for k, v in (fields or {}).items()}))
            return out
        except Exception as exc:
            logger.warning("XAUTOCLAIM unavailable / failed (%s); skipping reclaim", exc)
            return []

    def stats(self) -> Dict[str, Any]:
        try:
            length = int(self._client.xlen(self.stream_key))
        except Exception:
            length = 0
        try:
            pending_summary = self._client.xpending(self.stream_key, self.group)
            pending = int(pending_summary.get("pending", 0)) if isinstance(pending_summary, dict) else int(pending_summary[0] if pending_summary else 0)
        except Exception:
            pending = 0
        return {
            "length": length,
            "pending": pending,
            "eofSeen": self.is_complete(),
        }

    def destroy(self) -> None:
        """Tear down the stream + state keys. Idempotent + best-effort."""
        try:
            self._client.xgroup_destroy(self.stream_key, self.group)
        except Exception as exc:
            logger.debug("xgroup_destroy ignored: %s", exc)
        for key in (self.stream_key, self.state_key):
            try:
                self._client.delete(key)
            except Exception as exc:
                logger.debug("DEL %s ignored: %s", key, exc)


DIRQUEUE_HARD_LIMIT = 500_000
DIRQUEUE_DEFAULT_TTL = 86400  # 24h


class DirQueue:
    """Redis List-backed BFS directory queue for parallel volume discovery.

    Each worker does: HINCRBY active +1 -> BRPOP -> scan -> LPUSH children
    -> HINCRBY active -1.  When BRPOP returns None and active == 0, all work
    is done.

    A hard safety limit (LLEN > DIRQUEUE_HARD_LIMIT) fails fast instead of
    blocking, because blocking on a self-consuming queue causes deadlocks.
    """

    STALE_COUNTER_THRESHOLD = 30  # consecutive empty+non-idle checks before reset

    def __init__(
        self,
        client: Any,
        workflow_id: str,
        run_id: str,
        ttl_seconds: int = DIRQUEUE_DEFAULT_TTL,
        hard_limit: int = DIRQUEUE_HARD_LIMIT,
    ):
        self._client = client
        self.dirs_key = f"acq:{workflow_id}:{run_id}:dirs"
        self.state_key = f"acq:{workflow_id}:{run_id}:state"
        self._ttl = ttl_seconds
        self._hard_limit = hard_limit
        self._consecutive_empty_not_idle = 0

    def seed(self, root_dirs: List[str]) -> int:
        """Push initial root directories (called once before workers start)."""
        if not root_dirs:
            return 0
        pipe = self._client.pipeline()
        for d in root_dirs:
            pipe.lpush(self.dirs_key, d)
        pipe.expire(self.dirs_key, self._ttl)
        pipe.execute()
        logger.info("DirQueue.seed: pushed %d root dirs to %s", len(root_dirs), self.dirs_key)
        return len(root_dirs)

    def push_dirs(self, dirs: List[str]) -> int:
        """Push discovered child directories. Fail-fast if queue exceeds limit."""
        if not dirs:
            return 0
        current_len = 0
        try:
            current_len = int(self._client.llen(self.dirs_key) or 0)
        except Exception:
            pass
        if current_len + len(dirs) > self._hard_limit:
            raise RuntimeError(
                f"DirQueue hard limit exceeded: {current_len} + {len(dirs)} > "
                f"{self._hard_limit}. Volume may be too deeply nested or "
                f"contain circular symlinks."
            )
        pipe = self._client.pipeline()
        for d in dirs:
            pipe.lpush(self.dirs_key, d)
        pipe.expire(self.dirs_key, self._ttl)
        pipe.execute()
        return len(dirs)

    def pop(self, timeout_seconds: float = 2) -> Optional[str]:
        """Increment active counter, then BRPOP. Decrement if nothing popped.

        The increment-before-pop pattern prevents false idle detection when
        all workers are between pops simultaneously.

        Raises DirQueueRedisError if Redis fails (after retries). None means
        BRPOP timed out with an empty list (not an error).
        """
        try:
            _redis_call_with_retries(lambda: self._client.hincrby(self.state_key, "dirqueue_active", 1))
        except Exception as exc:
            logger.warning("DirQueue.pop: HINCRBY active failed after retries: %s", exc)
            raise DirQueueRedisError(f"DirQueue.pop: HINCRBY failed: {exc}") from exc
        try:
            result = _redis_call_with_retries(
                lambda: self._client.brpop(self.dirs_key, timeout=timeout_seconds)
            )
        except Exception as exc:
            logger.warning("DirQueue.pop: BRPOP %s failed after retries: %s", self.dirs_key, exc)
            self._decrement_active()
            raise DirQueueRedisError(f"DirQueue.pop: BRPOP failed: {exc}") from exc
        if result is None:
            self._decrement_active()
            return None
        _key, value = result
        return str(value)

    def done_one(self) -> None:
        """Signal that the current directory has been fully scanned."""
        self._decrement_active()

    def is_idle(self) -> bool:
        """True when queue is empty AND no workers are actively scanning.

        Detects stale active counters: if the queue has been empty but active > 0
        for STALE_COUNTER_THRESHOLD consecutive checks, the counter is assumed
        stale (a worker crashed between HINCRBY +1 and -1). Reset it to 0.

        On Redis read errors returns False (not idle) so workers do not exit
        early with work still pending.
        """
        try:
            qlen = int(self._client.llen(self.dirs_key) or 0)
        except Exception as exc:
            logger.warning("DirQueue.is_idle: LLEN %s failed: %s", self.dirs_key, exc)
            return False
        try:
            active = int(self._client.hget(self.state_key, "dirqueue_active") or 0)
        except Exception as exc:
            logger.warning("DirQueue.is_idle: HGET dirqueue_active failed: %s", exc)
            return False

        if qlen == 0 and active <= 0:
            self._consecutive_empty_not_idle = 0
            return True

        if qlen == 0 and active > 0:
            self._consecutive_empty_not_idle += 1
            if self._consecutive_empty_not_idle >= self.STALE_COUNTER_THRESHOLD:
                logger.warning(
                    "DirQueue.is_idle: queue empty but active=%d for %d consecutive checks "
                    "-- counter is stale (crashed worker), resetting to 0",
                    active, self._consecutive_empty_not_idle,
                )
                try:
                    self._client.hset(self.state_key, "dirqueue_active", 0)
                except Exception:
                    pass
                self._consecutive_empty_not_idle = 0
                return True
            logger.debug(
                "DirQueue.is_idle: qlen=0 active=%d (check %d/%d before stale reset)",
                active, self._consecutive_empty_not_idle, self.STALE_COUNTER_THRESHOLD,
            )
            return False

        self._consecutive_empty_not_idle = 0
        return False

    def cleanup(self) -> None:
        """Delete the dirs key and the active counter."""
        try:
            self._client.delete(self.dirs_key)
        except Exception:
            pass
        try:
            self._client.hdel(self.state_key, "dirqueue_active")
        except Exception:
            pass

    def _decrement_active(self) -> None:
        try:
            self._client.hincrby(self.state_key, "dirqueue_active", -1)
        except Exception:
            pass


def _serialize_fields(entry: Dict[str, Any]) -> Dict[str, str]:
    """Redis Streams accept only string fields. Convert numbers/bools and
    pass through nested dicts as JSON for richer source metadata."""
    import json as _json

    out: Dict[str, str] = {}
    for k, v in entry.items():
        if v is None:
            out[k] = ""
        elif isinstance(v, (str,)):
            out[k] = v
        elif isinstance(v, (int, float, bool)):
            out[k] = str(v)
        else:
            try:
                out[k] = _json.dumps(v, separators=(",", ":"))
            except Exception:
                out[k] = str(v)
    return out


def _truthy(value: Any) -> bool:
    if value in (None, "", b""):
        return False
    if isinstance(value, (int, float)):
        return value != 0
    s = str(value).strip().lower()
    return s in ("1", "true", "yes", "y", "on")


def _to_str(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "1" if value else "0"
    return str(value)
