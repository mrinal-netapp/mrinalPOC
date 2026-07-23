"""Redis-backed session store using Lists, Set-based index, and zlib compression."""

import asyncio
import json
import time
import zlib
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from observability_client_runtime import get_logger
from redis.asyncio import Redis

logger = get_logger()

_REDIS_OP_TIMEOUT = 10


@dataclass
class SummaryRecord:
    """Rolling conversation summary cached for one (owner, user, session) tuple."""

    text: str
    covers_up_to_msg_idx: int
    updated_at: str

    def to_json(self) -> str:
        return json.dumps(
            {
                "text": self.text,
                "covers_up_to_msg_idx": self.covers_up_to_msg_idx,
                "updated_at": self.updated_at,
            }
        )

    @classmethod
    def from_json(cls, raw: str | bytes) -> "SummaryRecord":
        data = json.loads(raw)
        return cls(
            text=data.get("text", ""),
            covers_up_to_msg_idx=int(data.get("covers_up_to_msg_idx", 0)),
            updated_at=data.get("updated_at", ""),
        )


class SessionStore:
    """Session storage using Redis Lists with user-scoped keys and compression.

    Key scheme:
        session:{agent_id}:{user_id}:{session_id}  -- Redis List (compressed msgs)
        sessions:{agent_id}:{user_id}               -- Redis Set (session ID index)
        session_meta:{agent_id}:{user_id}:{session_id} -- Redis Hash (name, createdAt)
    """

    def __init__(
        self,
        redis: Redis,
        session_ttl: int = 86400,
        max_messages: int = 200,
    ):
        self._redis = redis
        self._session_ttl = session_ttl
        self._max_messages = max_messages

    def _msg_key(self, agent_id: str, user_id: str, session_id: str) -> str:
        return f"session:{agent_id}:{user_id}:{session_id}"

    def _idx_key(self, agent_id: str, user_id: str) -> str:
        return f"sessions:{agent_id}:{user_id}"

    def _meta_key(self, agent_id: str, user_id: str, session_id: str) -> str:
        return f"session_meta:{agent_id}:{user_id}:{session_id}"

    @staticmethod
    def _encode(msg: dict) -> bytes:
        return zlib.compress(json.dumps(msg).encode(), level=1)

    @staticmethod
    def _decode(data: bytes) -> dict:
        return json.loads(zlib.decompress(data))

    async def _ensure_meta(
        self, agent_id: str, user_id: str, session_id: str
    ) -> None:
        """Create session metadata if it doesn't exist yet."""
        meta_key = self._meta_key(agent_id, user_id, session_id)
        exists = await asyncio.wait_for(
            self._redis.exists(meta_key), timeout=_REDIS_OP_TIMEOUT,
        )
        if not exists:
            now = datetime.now(timezone.utc).isoformat()
            friendly = datetime.now(timezone.utc).strftime("Session %b %d, %I:%M %p")
            pipe = self._redis.pipeline()
            pipe.hset(meta_key, mapping={"name": friendly, "createdAt": now})
            pipe.expire(meta_key, self._session_ttl)
            await asyncio.wait_for(pipe.execute(), timeout=_REDIS_OP_TIMEOUT)

    async def append_message(
        self,
        agent_id: str,
        user_id: str,
        session_id: str,
        role: str,
        content: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        key = self._msg_key(agent_id, user_id, session_id)
        idx_key = self._idx_key(agent_id, user_id)

        await self._ensure_meta(agent_id, user_id, session_id)

        now_iso = datetime.now(timezone.utc).isoformat()
        entry: dict[str, Any] = {"role": role, "content": content, "timestamp": now_iso}
        if metadata:
            entry.update({k: v for k, v in metadata.items() if v is not None})
        msg = self._encode(entry)
        pipe = self._redis.pipeline()
        pipe.rpush(key, msg)
        pipe.ltrim(key, -self._max_messages, -1)
        pipe.expire(key, self._session_ttl)
        pipe.sadd(idx_key, session_id)
        pipe.expire(idx_key, self._session_ttl)
        await asyncio.wait_for(pipe.execute(), timeout=_REDIS_OP_TIMEOUT)

    async def get_session_messages(
        self, agent_id: str, user_id: str, session_id: str
    ) -> list[dict[str, Any]]:
        key = self._msg_key(agent_id, user_id, session_id)
        raw_items = await asyncio.wait_for(
            self._redis.lrange(key, 0, -1), timeout=_REDIS_OP_TIMEOUT,
        )
        messages: list[dict[str, Any]] = []
        for item in raw_items:
            try:
                messages.append(self._decode(item))
            except Exception:
                logger.warning("Skipping corrupt session message in %s", key)
        return messages

    async def get_session_meta(
        self, agent_id: str, user_id: str, session_id: str
    ) -> dict[str, str]:
        meta_key = self._meta_key(agent_id, user_id, session_id)
        raw = await asyncio.wait_for(
            self._redis.hgetall(meta_key), timeout=_REDIS_OP_TIMEOUT,
        )
        return {
            (k.decode() if isinstance(k, bytes) else k): (v.decode() if isinstance(v, bytes) else v)
            for k, v in raw.items()
        }

    async def rename_session(
        self, agent_id: str, user_id: str, session_id: str, name: str
    ) -> None:
        meta_key = self._meta_key(agent_id, user_id, session_id)
        await asyncio.wait_for(
            self._redis.hset(meta_key, "name", name), timeout=_REDIS_OP_TIMEOUT,
        )
        await asyncio.wait_for(
            self._redis.expire(meta_key, self._session_ttl),
            timeout=_REDIS_OP_TIMEOUT,
        )

    async def list_sessions(
        self, agent_id: str, user_id: str
    ) -> list[dict[str, str]]:
        """Return sessions as list of {id, name, createdAt} dicts, sorted newest first."""
        idx_key = self._idx_key(agent_id, user_id)
        members = await asyncio.wait_for(
            self._redis.smembers(idx_key), timeout=_REDIS_OP_TIMEOUT,
        )
        sessions: list[dict[str, str]] = []
        for m in members:
            sid = m.decode() if isinstance(m, bytes) else m
            meta = await self.get_session_meta(agent_id, user_id, sid)
            sessions.append({
                "id": sid,
                "name": meta.get("name", sid[:8]),
                "createdAt": meta.get("createdAt", ""),
            })
        sessions.sort(key=lambda s: s.get("createdAt", ""), reverse=True)
        return sessions

    async def delete_session(
        self, agent_id: str, user_id: str, session_id: str
    ) -> None:
        key = self._msg_key(agent_id, user_id, session_id)
        idx_key = self._idx_key(agent_id, user_id)
        meta_key = self._meta_key(agent_id, user_id, session_id)
        pipe = self._redis.pipeline()
        pipe.delete(key)
        pipe.delete(meta_key)
        pipe.srem(idx_key, session_id)
        await asyncio.wait_for(pipe.execute(), timeout=_REDIS_OP_TIMEOUT)


class SummaryStore:
    """Redis-backed rolling-summary cache for context management.

    Stores at most one SummaryRecord per (owner_kind, owner_id, user_id,
    session_id) tuple. Concurrent updates from background refresh tasks
    are serialized via a WATCH/MULTI/EXEC transaction on
    ``covers_up_to_msg_idx`` — the writer with the higher index wins.

    Phase 1: stub — only ``get`` is exercised (summarize path disabled
    via CONTEXT_MANAGER_SUMMARIZATION_ENABLED=false until Phase 3).
    The interface is present so context_manager can be wired without
    blocking on Phase 3.
    """

    def __init__(self, redis: Redis, session_ttl: int = 86400):
        self._redis = redis
        self._session_ttl = session_ttl

    def _key(
        self, owner_kind: str, owner_id: str, user_id: str, session_id: str
    ) -> str:
        return f"summary:{owner_kind}:{owner_id}:{user_id}:{session_id}"

    async def get(
        self, owner_kind: str, owner_id: str, user_id: str, session_id: str
    ) -> SummaryRecord | None:
        key = self._key(owner_kind, owner_id, user_id, session_id)
        raw = await asyncio.wait_for(self._redis.get(key), timeout=_REDIS_OP_TIMEOUT)
        if not raw:
            return None
        try:
            return SummaryRecord.from_json(raw)
        except Exception:
            logger.warning("Corrupt summary record at %s; ignoring", key)
            return None

    async def set(
        self,
        owner_kind: str,
        owner_id: str,
        user_id: str,
        session_id: str,
        summary: str,
        covers_up_to_msg_idx: int,
    ) -> bool:
        """Compare-and-set on covers_up_to_msg_idx. Returns True if
        written, False if a newer summary already exists.

        Phase 1: not called from the hot path. Implementation provided
        so Phase 3 can enable summarization with no further plumbing.
        """
        key = self._key(owner_kind, owner_id, user_id, session_id)
        now_iso = datetime.now(timezone.utc).isoformat()
        new_record = SummaryRecord(
            text=summary,
            covers_up_to_msg_idx=int(covers_up_to_msg_idx),
            updated_at=now_iso,
        )

        async with self._redis.pipeline(transaction=True) as pipe:
            try:
                await pipe.watch(key)
                existing_raw = await pipe.get(key)
                if existing_raw:
                    try:
                        existing = SummaryRecord.from_json(existing_raw)
                        if existing.covers_up_to_msg_idx >= new_record.covers_up_to_msg_idx:
                            await pipe.unwatch()
                            return False
                    except Exception:
                        # Treat corrupt existing as overwriteable
                        pass
                pipe.multi()
                pipe.set(key, new_record.to_json(), ex=self._session_ttl)
                await asyncio.wait_for(pipe.execute(), timeout=_REDIS_OP_TIMEOUT)
                return True
            except Exception:
                logger.exception("SummaryStore.set transaction failed for %s", key)
                return False

    async def delete(
        self, owner_kind: str, owner_id: str, user_id: str, session_id: str
    ) -> None:
        key = self._key(owner_kind, owner_id, user_id, session_id)
        await asyncio.wait_for(self._redis.delete(key), timeout=_REDIS_OP_TIMEOUT)
