"""Unit tests for session persistence backends.

Live Redis is not required: the Phase 1 hardening surface is unit-tested
via the in-memory backend (which mirrors the Redis index / meta semantics)
and via direct exercises of the parsing / encode / decode helpers.

Covers:

- ``_split_scoped`` / ``_strip_scope`` parsing of all 5 scoped-id shapes.
- zlib encode + decode round-trip and backward-compat with plain JSON.
- ``InMemorySessionStore`` ABC contract: save/get/delete/list_for_user/rename.
- Per-user index isolation (two users, same session_id → no leakage).
- Lazy migration path on ``_try_legacy_read`` (team-scope only).
- ``create_session_store`` factory rejects unknown backends.
- ``_session_to_dict`` JSON-safety: ``datetime`` objects nested inside
  assistant-message metadata must not cause ``json.dumps`` to raise
  ``TypeError`` (regression for AIAS-1330 ``memoryDegraded`` bug).
"""

from __future__ import annotations

import json
import zlib
from typing import Any

import pytest

from agent_service_maf.core.session import ConversationMessage, Session
from agent_service_maf.core.session_store import (
    InMemorySessionStore,
    _friendly_name,
    _session_from_dict,
    _session_to_dict,
    _split_scoped,
    _strip_scope,
    _try_decode,
    create_session_store,
    hash_for_log,
)

# ---------------------------------------------------------------------------
# Scoped-id parsing
# ---------------------------------------------------------------------------


class TestSplitScoped:
    """`_split_scoped` covers every legacy and current shape MAF has emitted."""

    def test_phase2_team_with_user(self) -> None:
        result = _split_scoped("team:proj1:team_x:u_alice:s1")
        assert result == ("team", "proj1", "team_x", "u_alice", "s1")

    def test_phase2_agent_with_user(self) -> None:
        result = _split_scoped("agent:proj2:agent_a:u_bob:s_2")
        assert result == ("agent", "proj2", "agent_a", "u_bob", "s_2")

    def test_phase2_dev_no_user_is_empty_segment(self) -> None:
        """Dev-mode scoped ids carry an explicit empty user_id segment
        (literal ``::`` between anchor and session_id).

        Previously the helper accepted a 4-segment "dev fallback" shape
        without the user_id slot, but that was ambiguous when the raw
        session_id itself contained a ``:``. The fix made the 5-segment
        form unconditional.
        """
        result = _split_scoped("team:proj1:team_x::s1")
        assert result == ("team", "proj1", "team_x", "", "s1")

    def test_phase2_dev_no_user_with_colon_in_session_id(self) -> None:
        """The new explicit-empty-user_id shape parses correctly even when
        the raw session_id contains colons -- which is precisely the bug
        the old 4-segment shape introduced.
        """
        result = _split_scoped("team:proj1:team_x::user-chat:42:retry")
        assert result == ("team", "proj1", "team_x", "", "user-chat:42:retry")

    def test_legacy_phase2_4component_falls_back_to_legacy_3component_branch(self) -> None:
        """A pre-fix Phase-2 id with the deprecated 4-segment dev shape
        (no explicit empty user_id) no longer matches the Phase-2 branch
        and falls through to the legacy 3-component reader. Documented
        here so the migration path is explicit: such ids are treated as
        legacy data and the
        :class:`~agent_service_maf.core.session_store.RedisSessionStore`
        lazy-migration probe is responsible for surfacing the content
        under the new shape on next read.
        """
        scope, project_id, anchor, user, sid = _split_scoped("team:proj1:team_x:s1")
        # First token still has special meaning, so the 3-component
        # legacy reader sees ``project_id="team", team_id="proj1"`` and
        # joins the rest as session_id. ``scope`` is empty (legacy).
        assert scope == ""
        assert project_id == "team"
        assert anchor == "proj1"
        assert user == ""
        assert sid == "team_x:s1"

    def test_legacy_3component_project_team_session(self) -> None:
        scope, project_id, anchor, user, sid = _split_scoped("proj_42:team_x:s1")
        assert scope == ""  # un-scoped
        assert project_id == "proj_42"
        assert anchor == "team_x"
        assert user == ""
        assert sid == "s1"

    def test_legacy_2component_team_session(self) -> None:
        result = _split_scoped("team_x:s1")
        assert result == ("", "", "team_x", "", "s1")

    def test_single_component_falls_through(self) -> None:
        result = _split_scoped("s1")
        assert result[0] == ""
        assert result[4] == "s1"

    def test_session_id_with_internal_colons_preserved(self) -> None:
        # Caller-supplied session_id may itself contain colons.
        scope, project_id, anchor, user, sid = _split_scoped(
            "team:proj1:team_x:u_alice:nested:id:with:colons"
        )
        assert (scope, project_id, anchor, user) == ("team", "proj1", "team_x", "u_alice")
        assert sid == "nested:id:with:colons"


class TestStripScope:
    """`_strip_scope` returns just the caller-supplied raw session_id."""

    def test_phase2_5component(self) -> None:
        assert _strip_scope("team:proj1:team_x:u_alice:s1") == "s1"

    def test_phase2_dev_5component_explicit_empty_user(self) -> None:
        assert _strip_scope("team:proj1:team_x::s1") == "s1"

    def test_phase2_with_colon_bearing_session_id(self) -> None:
        # Raw session_id containing colons is preserved verbatim by the
        # 5-segment shape — regression coverage for the ambiguity that
        # the old 4-segment dev shape introduced.
        assert _strip_scope("team:proj1:team_x::a:b:c") == "a:b:c"

    def test_legacy_2component(self) -> None:
        assert _strip_scope("team_x:s1") == "s1"


# ---------------------------------------------------------------------------
# Compression / decode
# ---------------------------------------------------------------------------


class TestDecode:
    """`_try_decode` accepts zlib bytes, plain JSON bytes, and plain JSON str."""

    def _make_session(self) -> Session:
        return Session(
            session_id="team:proj1:t:u:s",
            messages=[
                ConversationMessage(role="user", content="hello"),
                ConversationMessage(role="assistant", content="world"),
            ],
            metadata={"foo": "bar"},
            token_count=4,
        )

    def test_zlib_roundtrip(self) -> None:
        session = self._make_session()
        payload = json.dumps(_session_to_dict(session)).encode()
        compressed = zlib.compress(payload, level=1)
        rehydrated = _try_decode(compressed)
        assert rehydrated is not None
        assert rehydrated.session_id == session.session_id
        assert len(rehydrated.messages) == 2
        assert rehydrated.messages[0].content == "hello"

    def test_plain_json_bytes_backward_compat(self) -> None:
        """Pre-Phase-1 entries stored plain JSON bytes; must still decode."""
        session = self._make_session()
        payload = json.dumps(_session_to_dict(session)).encode()
        rehydrated = _try_decode(payload)
        assert rehydrated is not None
        assert rehydrated.metadata == {"foo": "bar"}

    def test_plain_json_str_backward_compat(self) -> None:
        """Even older entries were stored with decode_responses=True (str)."""
        session = self._make_session()
        payload = json.dumps(_session_to_dict(session))
        rehydrated = _try_decode(payload)
        assert rehydrated is not None
        assert rehydrated.messages[1].role == "assistant"

    def test_decode_returns_none_for_garbage(self) -> None:
        assert _try_decode(b"\x00\x01\x02 not json or zlib") is None

    def test_decode_returns_none_for_none(self) -> None:
        assert _try_decode(None) is None


# ---------------------------------------------------------------------------
# Round-trip + cross-user isolation on the in-memory backend
# ---------------------------------------------------------------------------


def _list_for(
    store: InMemorySessionStore,
    *,
    scope: str,
    project_id: str,
    anchor: str,
    user_id: str,
) -> Any:
    return store.list_for_user(
        scope=scope,  # type: ignore[arg-type]
        project_id=project_id,
        anchor=anchor,
        user_id=user_id,
    )


class TestInMemoryStoreContract:
    """`InMemorySessionStore` honors the new SessionStore contract."""

    async def test_save_and_get_round_trip(self) -> None:
        store = InMemorySessionStore()
        s = Session(session_id="team:p1:t:u:s1")
        s.messages.append(ConversationMessage(role="user", content="hi"))
        await store.save(s)
        fetched = await store.get("team:p1:t:u:s1")
        assert fetched is not None
        assert fetched.messages[0].content == "hi"

    async def test_delete_returns_true_only_when_existed(self) -> None:
        store = InMemorySessionStore()
        await store.save(Session(session_id="team:p1:t:u:s1"))
        assert await store.delete("team:p1:t:u:s1") is True
        assert await store.delete("team:p1:t:u:s1") is False

    async def test_list_for_user_isolates_users(self) -> None:
        """User A and User B share session_id "s1" — they must not see each other."""
        store = InMemorySessionStore()
        alice = Session(session_id="team:p1:t1:alice:s1")
        bob = Session(session_id="team:p1:t1:bob:s1")
        await store.save(alice)
        await store.save(bob)

        alice_list = await _list_for(
            store,
            scope="team",
            project_id="p1",
            anchor="t1",
            user_id="alice",
        )
        bob_list = await _list_for(
            store,
            scope="team",
            project_id="p1",
            anchor="t1",
            user_id="bob",
        )

        assert {s.session_id for s in alice_list} == {"s1"}
        assert {s.session_id for s in bob_list} == {"s1"}
        assert {s.user_id for s in alice_list} == {"alice"}
        assert {s.user_id for s in bob_list} == {"bob"}

    async def test_list_for_user_separates_scopes(self) -> None:
        """Team-scoped and agent-scoped sessions with the same anchor stay separate."""
        store = InMemorySessionStore()
        await store.save(Session(session_id="team:p1:t1:u:s1"))
        await store.save(Session(session_id="agent:p1:t1:u:s2"))  # different scope

        team_list = await _list_for(
            store,
            scope="team",
            project_id="p1",
            anchor="t1",
            user_id="u",
        )
        agent_list = await _list_for(
            store,
            scope="agent",
            project_id="p1",
            anchor="t1",
            user_id="u",
        )

        assert [s.session_id for s in team_list] == ["s1"]
        assert [s.session_id for s in agent_list] == ["s2"]

    async def test_list_for_user_isolates_projects(self) -> None:
        """Two projects with the same team_id stay isolated even for the same user."""
        store = InMemorySessionStore()
        await store.save(Session(session_id="team:p1:t1:u:s1"))
        await store.save(Session(session_id="team:p2:t1:u:s1"))
        p1 = await _list_for(store, scope="team", project_id="p1", anchor="t1", user_id="u")
        p2 = await _list_for(store, scope="team", project_id="p2", anchor="t1", user_id="u")
        assert [s.session_id for s in p1] == ["s1"]
        assert [s.session_id for s in p2] == ["s1"]
        assert [s.project_id for s in p1] == ["p1"]
        assert [s.project_id for s in p2] == ["p2"]

    async def test_rename_updates_name(self) -> None:
        store = InMemorySessionStore()
        await store.save(Session(session_id="team:p1:t:u:s1"))
        assert await store.rename("team:p1:t:u:s1", "My Custom Name") is True
        summaries = await _list_for(
            store,
            scope="team",
            project_id="p1",
            anchor="t",
            user_id="u",
        )
        assert summaries[0].name == "My Custom Name"

    async def test_rename_returns_false_for_unknown(self) -> None:
        store = InMemorySessionStore()
        assert await store.rename("team:p1:t:u:missing", "ignored") is False

    async def test_delete_removes_index_entry(self) -> None:
        store = InMemorySessionStore()
        await store.save(Session(session_id="team:p1:t:u:s1"))
        await store.save(Session(session_id="team:p1:t:u:s2"))
        await store.delete("team:p1:t:u:s1")
        summaries = await _list_for(
            store,
            scope="team",
            project_id="p1",
            anchor="t",
            user_id="u",
        )
        assert [s.session_id for s in summaries] == ["s2"]

    async def test_list_for_user_sorts_newest_first(self) -> None:
        store = InMemorySessionStore()
        import asyncio

        await store.save(Session(session_id="team:p1:t:u:s_old"))
        await asyncio.sleep(0.01)
        await store.save(Session(session_id="team:p1:t:u:s_new"))
        summaries = await _list_for(
            store,
            scope="team",
            project_id="p1",
            anchor="t",
            user_id="u",
        )
        assert summaries[0].session_id == "s_new"
        assert summaries[1].session_id == "s_old"


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------


class TestCreateSessionStore:
    def test_memory_backend(self) -> None:
        assert isinstance(create_session_store("memory"), InMemorySessionStore)

    def test_unknown_backend_raises(self) -> None:
        with pytest.raises(ValueError, match="Unknown session storage backend"):
            create_session_store("postgres")


# ---------------------------------------------------------------------------
# Default friendly name
# ---------------------------------------------------------------------------


class TestFriendlyName:
    def test_includes_session_word(self) -> None:
        name = _friendly_name()
        assert name.startswith("Session ")

    def test_uses_supplied_timestamp(self) -> None:
        import datetime

        ts = datetime.datetime(2026, 5, 11, 23, 30).timestamp()
        assert "May 11" in _friendly_name(ts)


# ---------------------------------------------------------------------------
# Sanity: session_to_dict / session_from_dict carries tokens_actual
# ---------------------------------------------------------------------------


class TestSessionTokenSerialisation:
    def test_tokens_actual_survives_round_trip(self) -> None:
        s = Session(session_id="t")
        s.messages.append(ConversationMessage(role="user", content="hi", tokens_actual=42))
        data = _session_to_dict(s)
        rehydrated = _session_from_dict(data)
        assert rehydrated.messages[0].tokens_actual == 42

    def test_best_token_estimate_prefers_actual(self) -> None:
        msg = ConversationMessage(role="user", content="aaaa", tokens_actual=100)
        # estimated would be max(1, 4//4) = 1; actual is 100.
        assert msg.best_token_estimate == 100

    def test_best_token_estimate_falls_back_to_estimate(self) -> None:
        msg = ConversationMessage(role="user", content="a" * 80)
        assert msg.tokens_actual is None
        assert msg.best_token_estimate == 20


# ---------------------------------------------------------------------------
# Phase 3 (MEM-3.6): privacy-safe identifiers for observability
# ---------------------------------------------------------------------------


class TestHashForLog:
    """`hash_for_log` produces stable, privacy-preserving fingerprints."""

    def test_empty_input_returns_dash(self) -> None:
        assert hash_for_log("") == "-"
        assert hash_for_log(None) == "-"

    def test_non_empty_returns_short_hex(self) -> None:
        h = hash_for_log("alice@example.com")
        assert len(h) == 10
        assert all(c in "0123456789abcdef" for c in h)

    def test_deterministic(self) -> None:
        a = hash_for_log("user-42")
        b = hash_for_log("user-42")
        assert a == b

    def test_different_inputs_diverge(self) -> None:
        assert hash_for_log("alice") != hash_for_log("bob")

    def test_does_not_leak_input(self) -> None:
        """The output must not contain the input as a substring."""
        raw = "very-secret-user-id"
        assert raw not in hash_for_log(raw)

    def test_length_parameter(self) -> None:
        assert len(hash_for_log("x", length=4)) == 4
        assert len(hash_for_log("x", length=16)) == 16


# ---------------------------------------------------------------------------
# AIAS-1330 regression: _session_to_dict must produce JSON-safe output
# even when ConversationMessage.metadata contains datetime objects
# (e.g. AgentTraceStep.timestamp nested inside AssistantMessageMetadata).
# ---------------------------------------------------------------------------


class TestSessionToDictJsonSafety:
    """``_session_to_dict`` must never raise ``TypeError`` in ``json.dumps``.

    Root cause (AIAS-1330): the adapter stored ``AssistantMessageMetadata``
    as a plain dict via ``model_dump(by_alias=True)`` (no ``mode="json"``),
    leaving ``AgentTraceStep.timestamp`` as a native ``datetime`` object
    inside ``ConversationMessage.metadata``.  The old
    ``_session_to_dict`` then called ``m.model_dump()`` (also no
    ``mode="json"``), which passed the raw ``datetime`` through.
    ``json.dumps`` subsequently raised ``TypeError: Object of type
    datetime is not JSON serializable``, the route handler caught it and
    stamped ``memoryDegraded: true``.

    Fix: ``m.model_dump(mode="json")`` forces Pydantic to recursively
    convert every field to a JSON-native type before ``json.dumps`` sees it.
    """

    def _make_session_with_datetime_metadata(self) -> Session:
        """Build a session whose assistant message carries a datetime in metadata."""
        from datetime import UTC, datetime

        metadata_with_datetime = {
            "durationMs": 1234,
            "citations": {
                "agentTrace": [
                    {
                        "stepIndex": 0,
                        "agentName": "weather_agent",
                        "action": "respond",
                        "input": "hi",
                        "output": "hello",
                        # This is the field that triggered the bug:
                        # Pydantic emits a raw datetime when mode="json" is
                        # not used.
                        "timestamp": datetime.now(tz=UTC),
                        "durationMs": 500,
                    }
                ]
            },
        }
        session = Session(session_id="agent:proj1:ag1:u1:s1")
        session.messages.append(ConversationMessage(role="user", content="hi"))
        session.messages.append(
            ConversationMessage(
                role="assistant",
                content="hello",
                metadata=metadata_with_datetime,
            )
        )
        return session

    def test_session_to_dict_is_json_serialisable_with_datetime_in_metadata(
        self,
    ) -> None:
        """``json.dumps(_session_to_dict(session))`` must not raise TypeError.

        Regression for the exact failure path: adapter stores
        ``AssistantMessageMetadata`` containing ``AgentTraceStep.timestamp``
        (a ``datetime``) → ``_session_to_dict`` → ``json.dumps`` →
        ``TypeError`` → ``mark_memory_degraded()`` → ``memoryDegraded: true``.
        """
        session = self._make_session_with_datetime_metadata()
        result = _session_to_dict(session)
        # Must not raise TypeError
        serialised = json.dumps(result)
        assert "hello" in serialised

    def test_session_to_dict_timestamp_serialised_as_string(self) -> None:
        """The nested ``datetime`` must become an ISO string, not a raw object."""
        session = self._make_session_with_datetime_metadata()
        result = _session_to_dict(session)
        assistant_meta = result["messages"][1]["metadata"]
        trace_step = assistant_meta["citations"]["agentTrace"][0]
        assert isinstance(trace_step["timestamp"], str), (
            f"Expected ISO string, got {type(trace_step['timestamp'])}"
        )

    def test_session_to_dict_round_trips_via_try_decode(self) -> None:
        """Full encode → compress → decompress → decode round-trip with datetime metadata."""
        session = self._make_session_with_datetime_metadata()
        payload = json.dumps(_session_to_dict(session)).encode("utf-8")
        compressed = zlib.compress(payload, level=1)
        rehydrated = _try_decode(compressed)
        assert rehydrated is not None
        assert rehydrated.messages[1].role == "assistant"
        assert rehydrated.messages[1].content == "hello"

    def test_session_to_dict_without_metadata_still_works(self) -> None:
        """Sanity: plain messages without metadata are unaffected."""
        session = Session(session_id="agent:p:a:u:s")
        session.messages.append(ConversationMessage(role="user", content="ping"))
        result = _session_to_dict(session)
        serialised = json.dumps(result)
        assert "ping" in serialised
