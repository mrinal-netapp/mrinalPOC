"""Unit tests for the JobStream Redis-Streams wrapper.

Uses fakeredis so the suite runs hermetically; the real Redis client path is
exercised in integration tests against a Sentinel-enabled Bitnami chart.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Make the worker module importable when running pytest from the repo root.
_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

fakeredis = pytest.importorskip("fakeredis")

from streaming.redis_stream import (  # noqa: E402
    EOF_FIELD,
    EOF_VALUE,
    DirQueue,
    DirQueueRedisError,
    JobStream,
    JobStreamConfig,
    _parse_sentinel_url,
)


def _make_stream(workflow_id: str = "wf-test", run_id: str = "run-1") -> JobStream:
    client = fakeredis.FakeRedis(decode_responses=True)
    cfg = JobStreamConfig(
        workflow_id=workflow_id,
        run_id=run_id,
        client=client,
        ttl_seconds=3600,
        stream_maxlen=100,
    )
    return JobStream(cfg)


class TestKeyShape:
    def test_keys_include_run_id_for_isolation(self):
        js = _make_stream("wf-A", "run-X")
        assert js.stream_key == "acq:wf-A:run-X:items"
        assert js.state_key == "acq:wf-A:run-X:state"
        # Different runId -> different stream so retries don't share data
        js2 = _make_stream("wf-A", "run-Y")
        assert js2.stream_key != js.stream_key

    def test_workflow_id_required(self):
        with pytest.raises(ValueError):
            JobStream(
                JobStreamConfig(
                    workflow_id="", run_id="r", client=fakeredis.FakeRedis()
                )
            )


class TestProduceConsumeAck:
    def test_produce_and_consume_round_trip(self):
        js = _make_stream()
        js.ensure_group()
        n = js.produce(
            [
                {"key": "a/1.txt", "size": 10},
                {"key": "a/2.txt", "size": 20},
                {"key": "a/3.txt", "size": 30},
            ]
        )
        js.mark_eof()
        assert n == 3

        entries = js.consume("c0", count=10, block_ms=10)
        # 3 items + 1 EOF sentinel
        assert len(entries) == 4
        eof_seen = any(fields.get(EOF_FIELD) == EOF_VALUE for _id, fields in entries)
        assert eof_seen
        keys = sorted(fields["key"] for _id, fields in entries if "key" in fields)
        assert keys == ["a/1.txt", "a/2.txt", "a/3.txt"]

        # Sizes serialize to strings on the wire
        assert any(fields.get("size") == "20" for _id, fields in entries)

    def test_ack_clears_pending(self):
        js = _make_stream()
        js.ensure_group()
        js.produce([{"key": "a"}, {"key": "b"}])
        entries = js.consume("c0", count=10)
        ids = [sid for sid, _ in entries]
        # Ack just the first one and confirm only one remains pending
        js.ack(ids[:1])
        stats = js.stats()
        assert stats["pending"] == 1


class TestEOFAndState:
    def test_mark_eof_flips_state_and_writes_sentinel(self):
        js = _make_stream()
        js.ensure_group()
        js.produce([{"key": "x"}])
        assert not js.is_complete()
        js.mark_eof()
        assert js.is_complete()
        # eofAt timestamp written too
        state = js.get_state()
        assert "eofAt" in state

    def test_last_produced_key_is_recorded(self):
        js = _make_stream()
        js.ensure_group()
        js.produce([{"key": "a"}, {"key": "b"}, {"key": "c"}], batch_size=2)
        assert js.last_produced_key() == "c"

    def test_increment_state_accumulates(self):
        js = _make_stream()
        js.ensure_group()
        js.increment_state(copied=5, bytes=100)
        js.increment_state(copied=3, errors=1)
        s = js.get_state()
        assert s["copied"] == "8"
        assert s["bytes"] == "100"
        assert s["errors"] == "1"


class TestDestroyAndPing:
    def test_destroy_removes_keys(self):
        js = _make_stream()
        js.ensure_group()
        js.produce([{"key": "k"}])
        js.update_state(produced=1)
        js.destroy()
        assert js.client.exists(js.stream_key) == 0
        assert js.client.exists(js.state_key) == 0

    def test_ping_returns_true_for_healthy_client(self):
        js = _make_stream()
        assert js.ping() is True

    def test_ping_returns_false_when_client_raises(self):
        js = _make_stream()

        class _Boom:
            def ping(self):
                raise RuntimeError("nope")

        js._client = _Boom()  # type: ignore[attr-defined]
        assert js.ping() is False


class TestSentinelURLParsing:
    def test_empty_returns_empty(self):
        assert _parse_sentinel_url("") == []

    def test_single_host_default_port(self):
        assert _parse_sentinel_url("redis-sentinel") == [("redis-sentinel", 26379)]

    def test_host_port(self):
        assert _parse_sentinel_url("redis:26379") == [("redis", 26379)]

    def test_multiple_with_whitespace(self):
        out = _parse_sentinel_url("a:26379, b:26380 ,c")
        assert out == [("a", 26379), ("b", 26380), ("c", 26379)]


class TestProduceFieldSerialization:
    def test_dict_fields_become_json(self):
        js = _make_stream()
        js.ensure_group()
        js.produce([{"key": "k", "meta": {"foo": "bar", "n": 7}}])
        entries = js.consume("c0", count=10, block_ms=10)
        assert entries
        _id, fields = entries[0]
        # JSON-serialized object
        assert fields["meta"].startswith("{") and "foo" in fields["meta"]

    def test_none_becomes_empty_string(self):
        js = _make_stream()
        js.ensure_group()
        js.produce([{"key": "k", "tag": None}])
        entries = js.consume("c0", count=10)
        assert entries[0][1]["tag"] == ""


class TestConsumeRetries:
    def test_consume_succeeds_after_transient_xreadgroup_errors(self):
        class FlakyRedis(fakeredis.FakeRedis):
            def __init__(self) -> None:
                super().__init__(decode_responses=True)
                self._xg_calls = 0

            def xreadgroup(self, *args, **kwargs):  # type: ignore[no-untyped-def]
                self._xg_calls += 1
                if self._xg_calls < 2:
                    raise ConnectionError("transient")
                return super().xreadgroup(*args, **kwargs)

        js = JobStream(
            JobStreamConfig(
                workflow_id="wf-flaky",
                run_id="run-1",
                client=FlakyRedis(),
                ttl_seconds=3600,
                stream_maxlen=100,
            )
        )
        js.ensure_group()
        js.produce([{"key": "a", "size": "1"}])
        entries = js.consume("c0", count=10, block_ms=50)
        assert len(entries) >= 1

    def test_consume_raises_after_exhausted_xreadgroup_errors(self):
        class BadRedis(fakeredis.FakeRedis):
            def xreadgroup(self, *args, **kwargs):  # type: ignore[no-untyped-def]
                raise ConnectionError("always")

        js = JobStream(
            JobStreamConfig(
                workflow_id="wf-bad",
                run_id="run-1",
                client=BadRedis(),
                ttl_seconds=3600,
                stream_maxlen=100,
            )
        )
        js.ensure_group()
        with pytest.raises(ConnectionError):
            js.consume("c0", count=10, block_ms=10)


class TestDirQueueResilience:
    def test_is_idle_false_when_llen_raises(self):
        class BadRedis(fakeredis.FakeRedis):
            def llen(self, name):  # type: ignore[no-untyped-def]
                raise ConnectionError("llen down")

        dq = DirQueue(BadRedis(), "wf", "run")
        assert dq.is_idle() is False

    def test_pop_raises_when_hincrby_always_fails(self):
        class BadRedis(fakeredis.FakeRedis):
            def hincrby(self, *args, **kwargs):  # type: ignore[no-untyped-def]
                raise ConnectionError("hincrby down")

        dq = DirQueue(BadRedis(), "wf", "run")
        with pytest.raises(DirQueueRedisError):
            dq.pop(timeout_seconds=0.05)

    def test_pop_raises_when_brpop_always_fails(self):
        class BadRedis(fakeredis.FakeRedis):
            def brpop(self, *args, **kwargs):  # type: ignore[no-untyped-def]
                raise ConnectionError("brpop down")

        dq = DirQueue(BadRedis(), "wf", "run")
        with pytest.raises(DirQueueRedisError):
            dq.pop(timeout_seconds=0.05)


class TestGetEofSeenAndMarkEofIdempotent:
    def test_get_eof_seen_false_before_eof(self):
        js = _make_stream()
        js.ensure_group()
        assert js.get_eof_seen() is False

    def test_mark_eof_second_call_does_not_extend_stream(self):
        js = _make_stream()
        js.ensure_group()
        js.produce([{"key": "only", "size": "1"}])
        js.mark_eof()
        n1 = int(js.client.xlen(js.stream_key))
        js.mark_eof()
        n2 = int(js.client.xlen(js.stream_key))
        assert n1 == n2
        assert js.get_eof_seen() is True

    def test_mark_eof_repairs_state_when_stream_has_eof_sentinel(self):
        js = _make_stream()
        js.ensure_group()
        js.produce([{"key": "x", "size": "1"}])
        js.mark_eof()
        js.client.hdel(js.state_key, "eofSeen")
        assert js.get_eof_seen() is False
        js.mark_eof()
        assert js.get_eof_seen() is True

    def test_update_state_returns_bool(self):
        js = _make_stream()
        assert js.update_state(produced=1) is True


class TestDirQueueHappyPath:
    def test_seed_pop_done_one_becomes_idle(self):
        client = fakeredis.FakeRedis(decode_responses=True)
        dq = DirQueue(client, "wf-bfs", "run-1")
        dq.seed(["/mnt/vol/root"])
        path = dq.pop(timeout_seconds=2.0)
        assert path == "/mnt/vol/root"
        dq.done_one()
        assert dq.is_idle() is True

    def test_push_dirs_then_pop_order(self):
        client = fakeredis.FakeRedis(decode_responses=True)
        dq = DirQueue(client, "wf-bfs", "run-2")
        dq.seed(["/a"])
        dq.push_dirs(["/a/child1", "/a/child2"])
        seen = {dq.pop(2.0), dq.pop(2.0), dq.pop(2.0)}
        assert "/a" in seen
        assert "/a/child1" in seen
        assert "/a/child2" in seen
        for _ in range(3):
            dq.done_one()
        assert dq.is_idle() is True


class TestGetEofSeenRedisDown:
    def test_get_eof_seen_returns_none_when_hget_always_fails(self):
        class HgetDown(fakeredis.FakeRedis):
            def hget(self, name, key):  # type: ignore[no-untyped-def]
                raise ConnectionError("redis unavailable")

        js = JobStream(
            JobStreamConfig(
                workflow_id="wf-down",
                run_id="run-1",
                client=HgetDown(),
                ttl_seconds=3600,
                stream_maxlen=100,
            )
        )
        assert js.get_eof_seen() is None


class TestVolumeStyleXaddBatch:
    def test_xadd_batch_accepts_uri_fields(self):
        js = _make_stream()
        js.ensure_group()
        n = js.xadd_batch(
            [
                {
                    "uri": "file:///mnt/pvcs/vol1/doc.txt",
                    "relative_path": "doc.txt",
                    "size": "42",
                    "last_modified": "2024-01-01T00:00:00+00:00",
                    "metadata": "",
                },
            ]
        )
        assert n == 1
        entries = js.consume("vol-c", count=5, block_ms=50)
        assert len(entries) == 1
        _sid, fields = entries[0]
        assert fields["uri"].startswith("file://")
        assert fields["relative_path"] == "doc.txt"
        assert fields["size"] == "42"


class TestJobStreamStateFailures:
    def test_update_state_returns_false_on_redis_error(self):
        class HsetDown(fakeredis.FakeRedis):
            def hset(self, name, key=None, value=None, mapping=None):  # type: ignore[no-untyped-def]
                raise ConnectionError("redis down")

        js = JobStream(
            JobStreamConfig(
                workflow_id="wf-state",
                run_id="run-1",
                client=HsetDown(),
                ttl_seconds=3600,
                stream_maxlen=100,
            )
        )
        assert js.update_state(produced=1) is False

    def test_increment_state_returns_false_on_redis_error(self):
        class PipeDown(fakeredis.FakeRedis):
            def pipeline(self, transaction=True):  # type: ignore[no-untyped-def]
                raise ConnectionError("pipeline down")

        js = JobStream(
            JobStreamConfig(
                workflow_id="wf-inc",
                run_id="run-1",
                client=PipeDown(),
                ttl_seconds=3600,
                stream_maxlen=100,
            )
        )
        assert js.increment_state(dirs_scanned=1) is False


class TestClaimPending:
    def test_claim_pending_reclaims_idle_messages(self):
        js = _make_stream()
        js.ensure_group()
        js.produce([{"key": "pending-1", "size": "10"}])
        js.consume("dead-worker", count=1, block_ms=50)

        reclaimed = js.claim_pending("recovery-worker", min_idle_ms=0, count=5)
        assert len(reclaimed) == 1
        assert reclaimed[0][1]["key"] == "pending-1"

    def test_claim_pending_returns_empty_when_nothing_idle(self):
        js = _make_stream()
        js.ensure_group()
        assert js.claim_pending("recovery-worker", min_idle_ms=999999, count=5) == []


class TestDirQueueEdgeCases:
    def test_push_dirs_returns_zero_for_empty(self):
        js = _make_stream()
        from streaming.redis_stream import DirQueue

        dq = DirQueue(js.client, "wf-dq", "run-dq")
        assert dq.push_dirs([]) == 0

    def test_seed_returns_zero_for_empty(self):
        js = _make_stream()
        from streaming.redis_stream import DirQueue

        dq = DirQueue(js.client, "wf-dq2", "run-dq2")
        assert dq.seed([]) == 0

    def test_hard_limit_raises(self):
        js = _make_stream()
        from streaming.redis_stream import DirQueue

        dq = DirQueue(js.client, "wf-dq3", "run-dq3", hard_limit=2)
        dq.seed(["/a"])
        with pytest.raises(RuntimeError, match="hard limit"):
            dq.push_dirs(["/b", "/c"])
