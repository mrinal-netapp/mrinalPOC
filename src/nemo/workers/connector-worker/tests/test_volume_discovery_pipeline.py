"""Branch-coverage tests for DiscoverVolumeFiles and RegisterBatch activities."""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

fakeredis = pytest.importorskip("fakeredis")
pytest.importorskip("temporalio")

from activities import acquisition_pipeline as ap  # noqa: E402
from streaming.redis_stream import JobStream, JobStreamConfig  # noqa: E402

WF_ID = "wf-vol-disc"
RUN_ID = "run-vol-disc"


def _call_activity(fn, *args, **kwargs):
    target = getattr(fn, "__wrapped__", fn)
    return target(*args, **kwargs)


def _make_stream(workflow_id=WF_ID, run_id=RUN_ID) -> JobStream:
    client = fakeredis.FakeRedis(decode_responses=True)
    return JobStream(
        JobStreamConfig(
            workflow_id=workflow_id,
            run_id=run_id,
            client=client,
            ttl_seconds=3600,
            stream_maxlen=1000,
        )
    )


def _volume_pipeline_stubs(monkeypatch, js: JobStream):
    monkeypatch.setattr(ap, "_activity_workflow_context", lambda: (WF_ID, RUN_ID))
    monkeypatch.setattr(ap, "build_job_stream", lambda *_a, **_kw: js)
    monkeypatch.setattr(ap, "log_activity_start", lambda *_a, **_kw: None)
    monkeypatch.setattr(ap, "log_activity_result", lambda *_a, **_kw: None)
    monkeypatch.setattr(ap.activity, "heartbeat", lambda *_a, **_kw: None)
    monkeypatch.setattr(ap.activity, "is_cancelled", lambda: False)
    monkeypatch.setattr(ap.time, "sleep", lambda *_a, **_kw: None)
    monkeypatch.setattr(ap.random, "uniform", lambda *_a, **_kw: 0.0)
    monkeypatch.setattr(ap, "_jittered_seconds", lambda base: 0.01)
    monkeypatch.setattr(ap, "_jittered_ms", lambda base: min(base, 50))
    monkeypatch.setenv("ACQ_DIRQUEUE_BRPOP_TIMEOUT_SEC", "0.1")
    monkeypatch.setenv("ACQ_DISCOVER_GREEDY_DEPTH", "3")
    monkeypatch.setenv("ACQ_DISCOVER_GREEDY_ENTRIES", "10000")


def _discover_input(mount: str, **overrides):
    body = {
        "mountPath": mount,
        "projectID": "proj-v",
        "datasetID": "ds-v",
        "outputPath": "/projects/proj-v/datasets/ds-v/data_files",
        "workerId": "0",
    }
    body.update(overrides)
    return body


def _register_input(**overrides):
    body = {
        "projectID": "proj-v",
        "datasetID": "ds-v",
        "setId": "reg-s0",
        "outputPath": "/projects/proj-v/datasets/ds-v/data_files",
    }
    body.update(overrides)
    return body


class TestDiscoverVolumeFiles:
    def test_discovers_files_and_pushes_to_stream(self, monkeypatch, tmp_path):
        mount = tmp_path / "vol"
        mount.mkdir()
        (mount / "keep.csv").write_text("a,b\n")
        (mount / "skip.txt").write_text("skip")
        sub = mount / "nested"
        sub.mkdir()
        (sub / "inner.json").write_text("{}")

        js = _make_stream()
        _volume_pipeline_stubs(monkeypatch, js)

        out = _call_activity(
            ap.discover_volume_files,
            _discover_input(
                str(mount),
                fileGlob="*.csv,*.json",
                fileExclude="*.tmp",
            ),
        )

        assert out["totalDiscovered"] == 2
        assert out["filesFiltered"] >= 1
        assert out["dirsScanned"] >= 1
        assert out.get("redisStateSyncFailed") is not True

        entries = js.consume("verify", count=10, block_ms=50)
        uris = [fields["uri"] for _sid, fields in entries if fields.get("uri")]
        assert any("keep.csv" in u for u in uris)
        assert any("inner.json" in u for u in uris)

    def test_applies_mtime_watermark_filter(self, monkeypatch, tmp_path):
        mount = tmp_path / "wm"
        mount.mkdir()
        old = mount / "old.txt"
        old.write_text("old")
        old_ts = datetime(2020, 1, 1, tzinfo=timezone.utc).timestamp()
        import os

        os.utime(old, (old_ts, old_ts))
        new = mount / "new.txt"
        new.write_text("new")
        new_ts = datetime(2026, 5, 23, tzinfo=timezone.utc).timestamp()
        os.utime(new, (new_ts, new_ts))

        js = _make_stream()
        _volume_pipeline_stubs(monkeypatch, js)

        out = _call_activity(
            ap.discover_volume_files,
            _discover_input(
                str(mount),
                lastMtimeWatermark="2024-01-01T00:00:00Z",
            ),
        )

        assert out["totalDiscovered"] == 1
        assert out["filesFiltered"] >= 1

    def test_skips_sgwtmp_directories(self, monkeypatch, tmp_path):
        mount = tmp_path / "sgw"
        mount.mkdir()
        (mount / "ok.txt").write_text("ok")
        sgw = mount / ".sgwtmp"
        sgw.mkdir()
        (sgw / "hidden.txt").write_text("hidden")

        js = _make_stream()
        _volume_pipeline_stubs(monkeypatch, js)

        out = _call_activity(ap.discover_volume_files, _discover_input(str(mount)))
        assert out["totalDiscovered"] == 1

    def test_requires_mount_path(self, monkeypatch):
        js = _make_stream()
        _volume_pipeline_stubs(monkeypatch, js)
        with pytest.raises(ValueError, match="mountPath"):
            _call_activity(ap.discover_volume_files, _discover_input(""))

    def test_requires_temporal_context(self, monkeypatch):
        monkeypatch.setattr(ap, "_activity_workflow_context", lambda: ("", ""))
        with pytest.raises(RuntimeError, match="Temporal activity context"):
            _call_activity(ap.discover_volume_files, _discover_input("/tmp"))


class TestRegisterBatch:
    def _seed_volume_items(self, js: JobStream, items: list[dict]):
        js.ensure_group()
        js.xadd_batch(items)
        js.mark_eof()

    def test_writes_parquet_partition_and_manifest(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setenv("ACQ_BATCH_SIZE", "10")
        monkeypatch.setenv("ACQ_EMPTY_READS_AFTER_EOF", "1")

        js = _make_stream()
        _volume_pipeline_stubs(monkeypatch, js)
        self._seed_volume_items(
            js,
            [
                {
                    "uri": "file:///mnt/vol/a.csv",
                    "relative_path": "a.csv",
                    "size": "100",
                    "last_modified": "2026-01-01T00:00:00+00:00",
                    "metadata": "",
                },
                {
                    "uri": "file:///mnt/vol/b.csv",
                    "relative_path": "b.csv",
                    "size": "200",
                    "last_modified": "2026-01-02T00:00:00+00:00",
                    "metadata": "",
                },
            ],
        )

        out = _call_activity(ap.register_batch, _register_input())

        assert out["status"] == "success"
        assert out["fileCount"] == 2
        assert out["totalSize"] == 300
        assert out["partitionKey"]

        part_path = tmp_path / out["partitionKey"]
        assert part_path.is_file()

        manifest_path = (
            tmp_path
            / "projects/proj-v/datasets/ds-v/_acquisition/manifests/reg-s0.json"
        )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        assert manifest["fileCount"] == 2
        assert manifest["totalSize"] == 300

    def test_skips_empty_uri_and_invalid_size(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setenv("ACQ_EMPTY_READS_AFTER_EOF", "1")

        js = _make_stream()
        _volume_pipeline_stubs(monkeypatch, js)
        js.ensure_group()
        js.xadd_batch(
            [
                {
                    "uri": "",
                    "relative_path": "",
                    "size": "0",
                    "last_modified": "",
                    "metadata": "",
                },
                {
                    "uri": "file:///mnt/vol/x.csv",
                    "relative_path": "x.csv",
                    "size": "not-a-number",
                    "last_modified": "2026-01-01T00:00:00+00:00",
                    "metadata": "",
                },
            ]
        )
        js.mark_eof()

        out = _call_activity(ap.register_batch, _register_input())
        assert out["fileCount"] == 1
        assert out["totalSize"] == 0

    def test_reclaim_pending_is_best_effort(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setenv("ACQ_EMPTY_READS_AFTER_EOF", "1")
        monkeypatch.setenv("ACQ_RECLAIM_IDLE_MS", "0")

        js = _make_stream()
        _volume_pipeline_stubs(monkeypatch, js)
        js.ensure_group()
        js.produce(
            [
                {
                    "uri": "file:///mnt/vol/reclaimed.csv",
                    "relative_path": "reclaimed.csv",
                    "size": "50",
                    "last_modified": "2026-01-01T00:00:00+00:00",
                    "metadata": "",
                }
            ]
        )
        js.consume("dead-consumer", count=1, block_ms=50)
        js.mark_eof()

        out = _call_activity(ap.register_batch, _register_input())
        assert out["status"] == "success"
        assert out["fileCount"] == 1
        assert out["totalSize"] == 50

        manifest_path = (
            tmp_path
            / "projects/proj-v/datasets/ds-v/_acquisition/manifests/reg-s0.json"
        )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        assert manifest["fileCount"] == 1
        assert manifest["totalSize"] == 50

    def test_requires_temporal_context(self, monkeypatch):
        monkeypatch.setattr(ap, "_activity_workflow_context", lambda: ("", ""))
        with pytest.raises(RuntimeError, match="Temporal activity context"):
            _call_activity(ap.register_batch, _register_input())
