"""Additional branch-coverage tests for acquisition pipeline edge paths."""

from __future__ import annotations

import os
from unittest.mock import MagicMock

import pytest

fakeredis = pytest.importorskip("fakeredis")
pytest.importorskip("temporalio")

from activities import acquisition_pipeline as ap  # noqa: E402
from streaming.redis_stream import JobStream, JobStreamConfig  # noqa: E402

WF_ID = "wf-br"
RUN_ID = "run-br"


def _call_activity(fn, *args, **kwargs):
    return getattr(fn, "__wrapped__", fn)(*args, **kwargs)


def _make_stream() -> JobStream:
    return JobStream(
        JobStreamConfig(
            workflow_id=WF_ID,
            run_id=RUN_ID,
            client=fakeredis.FakeRedis(decode_responses=True),
            ttl_seconds=3600,
            stream_maxlen=1000,
        )
    )


def _stubs(monkeypatch, js: JobStream):
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
    monkeypatch.setenv("ACQ_DISCOVER_GREEDY_DEPTH", "1")
    monkeypatch.setenv("ACQ_DISCOVER_GREEDY_ENTRIES", "100")


class TestDiscoverVolumeFilesBranches:
    def test_deep_tree_pushes_overflow_dirs_to_queue(self, monkeypatch, tmp_path):
        root = tmp_path / "deep"
        level1 = root / "l1"
        level2 = level1 / "l2"
        level2.mkdir(parents=True)
        (level2 / "deep.txt").write_text("deep")

        js = _make_stream()
        _stubs(monkeypatch, js)
        out = _call_activity(
            ap.discover_volume_files,
            {
                "mountPath": str(root),
                "projectID": "p",
                "datasetID": "d",
                "outputPath": "/projects/p/datasets/d/data_files",
            },
        )
        assert out["totalDiscovered"] >= 1
        assert out["dirsScanned"] >= 1

    def test_entry_os_error_is_counted(self, monkeypatch, tmp_path):
        mount = tmp_path / "err"
        mount.mkdir()
        (mount / "ok.txt").write_text("ok")
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))

        js = _make_stream()
        _stubs(monkeypatch, js)

        real_scandir = os.scandir

        def _scandir(path):
            if str(path) == str(mount):
                raise PermissionError("denied")
            return real_scandir(path)

        monkeypatch.setattr(ap.os, "scandir", _scandir)
        out = _call_activity(
            ap.discover_volume_files,
            {
                "mountPath": str(mount),
                "projectID": "p",
                "datasetID": "d",
                "outputPath": "/projects/p/datasets/d/data_files",
            },
        )
        assert out["errors"] >= 1

    def test_cancelled_worker_exits_loop(self, monkeypatch, tmp_path):
        mount = tmp_path / "cancel"
        mount.mkdir()
        (mount / "a.txt").write_text("a")

        js = _make_stream()
        _stubs(monkeypatch, js)
        calls = {"n": 0}

        def _cancelled():
            calls["n"] += 1
            return calls["n"] > 1

        monkeypatch.setattr(ap.activity, "is_cancelled", _cancelled)
        out = _call_activity(
            ap.discover_volume_files,
            {
                "mountPath": str(mount),
                "projectID": "p",
                "datasetID": "d",
                "outputPath": "/projects/p/datasets/d/data_files",
            },
        )
        assert out["workerId"] == "0"

    def test_increment_state_failure_flag(self, monkeypatch, tmp_path):
        mount = tmp_path / "redis-fail"
        mount.mkdir()
        (mount / "a.txt").write_text("a")

        js = _make_stream()
        _stubs(monkeypatch, js)
        monkeypatch.setattr(js, "increment_state", lambda **_kw: False)

        out = _call_activity(
            ap.discover_volume_files,
            {
                "mountPath": str(mount),
                "projectID": "p",
                "datasetID": "d",
                "outputPath": "/projects/p/datasets/d/data_files",
            },
        )
        assert out.get("redisStateSyncFailed") is True

    def test_combined_glob_exclude_and_watermark(self, monkeypatch, tmp_path):
        mount = tmp_path / "combo"
        mount.mkdir()
        (mount / "keep.csv").write_text("a")
        (mount / "skip.txt").write_text("b")
        old = mount / "old.csv"
        old.write_text("c")
        import os
        from datetime import datetime, timezone

        old_ts = datetime(2020, 1, 1, tzinfo=timezone.utc).timestamp()
        os.utime(old, (old_ts, old_ts))
        keep_ts = datetime(2026, 5, 23, tzinfo=timezone.utc).timestamp()
        os.utime(mount / "keep.csv", (keep_ts, keep_ts))

        js = _make_stream()
        _stubs(monkeypatch, js)
        out = _call_activity(
            ap.discover_volume_files,
            {
                "mountPath": str(mount),
                "projectID": "p",
                "datasetID": "d",
                "outputPath": "/projects/p/datasets/d/data_files",
                "fileGlob": "*.csv",
                "fileExclude": "old*",
                "lastMtimeWatermark": "2024-01-01T00:00:00Z",
            },
        )
        assert out["totalDiscovered"] == 1
        assert out["filesFiltered"] >= 1


class TestRegisterBatchBranches:
    def test_cancelled_consumer_exits(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setenv("ACQ_EMPTY_READS_AFTER_EOF", "1")

        js = _make_stream()
        _stubs(monkeypatch, js)
        js.ensure_group()
        js.mark_eof()

        calls = {"n": 0}

        def _cancelled():
            calls["n"] += 1
            return calls["n"] > 1

        monkeypatch.setattr(ap.activity, "is_cancelled", _cancelled)
        out = _call_activity(
            ap.register_batch,
            {
                "projectID": "p",
                "datasetID": "d",
                "setId": "reg-cancel",
                "outputPath": "/projects/p/datasets/d/data_files",
            },
        )
        assert out["status"] == "success"

    def test_reclaim_exception_is_ignored(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setenv("ACQ_EMPTY_READS_AFTER_EOF", "1")

        js = _make_stream()
        _stubs(monkeypatch, js)
        js.ensure_group()
        js.mark_eof()
        monkeypatch.setattr(
            js,
            "claim_pending",
            MagicMock(side_effect=RuntimeError("reclaim boom")),
        )

        out = _call_activity(
            ap.register_batch,
            {
                "projectID": "p",
                "datasetID": "d",
                "setId": "reg-reclaim",
                "outputPath": "/projects/p/datasets/d/data_files",
            },
        )
        assert out["status"] == "success"


class TestDiscoverObjectStoreStateFailure:
    def test_update_state_failure_raises(self, monkeypatch):
        from datetime import datetime, timezone

        client = fakeredis.FakeRedis(decode_responses=True)
        js = JobStream(
            JobStreamConfig(
                workflow_id="wf-st",
                run_id="run-st",
                client=client,
                ttl_seconds=3600,
                stream_maxlen=100,
            )
        )
        monkeypatch.setattr(
            ap, "_activity_workflow_context", lambda: ("wf-st", "run-st")
        )
        monkeypatch.setattr(ap, "build_job_stream", lambda *_a, **_kw: js)
        monkeypatch.setattr(ap, "log_activity_start", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap.activity, "heartbeat", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap.time, "sleep", lambda *_a, **_kw: None)
        monkeypatch.setattr(
            ap, "WorkflowProgressReporter", lambda *_a, **_kw: MagicMock(url="")
        )

        mock_ext = MagicMock()
        paginator = MagicMock()
        paginator.paginate.return_value = [
            {
                "Contents": [
                    {
                        "Key": "incoming/a.csv",
                        "Size": 1,
                        "LastModified": datetime.now(timezone.utc),
                    }
                ],
            }
        ]
        mock_ext.get_paginator.return_value = paginator
        monkeypatch.setattr(ap, "get_external_s3_client", lambda *_a, **_kw: mock_ext)
        monkeypatch.setattr(ap, "resolve_credential", lambda *_a, **_kw: {})
        monkeypatch.setattr(js, "update_state", lambda **_kw: False)

        with pytest.raises(RuntimeError, match="update_state failed"):
            _call_activity(
                ap.discover_object_store_items,
                {
                    "projectID": "p",
                    "credentialID": "c",
                    "configServiceURL": "http://cfg",
                    "connectorConfig": {"bucket": "b", "prefix": "incoming/"},
                },
            )


class TestAcquisitionFacetHelpers:
    def test_put_facet_with_bearer_token(self, monkeypatch):
        monkeypatch.setattr(ap, "_get_service_account_token", lambda: "tok-abc")
        captured = {}

        class _Resp:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def _fake_urlopen(req, timeout=15):
            captured["auth"] = req.headers.get("Authorization")
            return _Resp()

        monkeypatch.setattr(ap.urllib.request, "urlopen", _fake_urlopen)
        ap._put_facet(
            "http://cfg", "p", "d", state="ready", job_id="j1", summary={"n": 1}
        )
        assert captured["auth"] == "Bearer tok-abc"

    def test_delete_progress_ignores_404(self, monkeypatch):
        class _Resp:
            status = 404

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        monkeypatch.setattr(ap.urllib.request, "urlopen", lambda *a, **k: _Resp())
        ap._delete_progress("http://wf-engine", "wf-1")
