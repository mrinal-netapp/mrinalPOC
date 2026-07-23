"""Unit tests for acquisition_pipeline helpers and volume-oriented activities."""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

fakeredis = pytest.importorskip("fakeredis")
pytest.importorskip("boto3")
pytest.importorskip("temporalio")

from streaming.redis_stream import JobStream, JobStreamConfig  # noqa: E402
from activities import acquisition_pipeline as ap  # noqa: E402


def _call_activity(fn, *args, **kwargs):
    target = getattr(fn, "__wrapped__", fn)
    return target(*args, **kwargs)


def _make_stream(workflow_id="wf-vol", run_id="run-vol") -> JobStream:
    client = fakeredis.FakeRedis(decode_responses=True)
    cfg = JobStreamConfig(
        workflow_id=workflow_id,
        run_id=run_id,
        client=client,
        ttl_seconds=3600,
        stream_maxlen=100,
    )
    return JobStream(cfg)


class TestJitterHelpers:
    def test_jittered_ms_within_bounds(self):
        base = 1000
        for _ in range(20):
            val = ap._jittered_ms(base)
            assert 700 <= val <= 1300

    def test_jittered_seconds_minimum(self):
        for _ in range(10):
            assert ap._jittered_seconds(1.0) >= 0.1


class TestTimestampParsers:
    def test_parse_volume_watermark_z_suffix(self):
        dt = ap._parse_volume_watermark("2024-06-01T12:00:00Z")
        assert dt is not None
        assert dt.tzinfo is not None
        assert dt.year == 2024

    def test_parse_volume_watermark_invalid(self):
        assert ap._parse_volume_watermark("not-a-date") is None
        assert ap._parse_volume_watermark("") is None

    def test_parse_iso8601_naive_becomes_utc(self):
        dt = ap._parse_iso8601("2025-01-15T08:30:00")
        assert dt is not None
        assert dt.tzinfo == timezone.utc

    def test_parse_iso_timestamp_for_pyarrow(self):
        dt = ap._parse_iso_timestamp("2025-02-01T00:00:00+00:00")
        assert dt is not None


class TestScanHelpers:
    def test_scan_max_depth_values(self):
        assert ap._scan_max_depth({"scan_depth": "none"}) == 0
        assert ap._scan_max_depth({"scan_depth": "all_levels"}) is None
        assert ap._scan_max_depth({"scan_depth": "top_2_levels"}) == 2
        assert ap._scan_max_depth({"scan_depth": "custom", "custom_depth": 7}) == 7

    def test_scan_max_depth_requires_config(self):
        with pytest.raises(ValueError, match="scan_config is required"):
            ap._scan_max_depth({})

    def test_scan_max_depth_invalid_custom(self):
        with pytest.raises(ValueError, match="custom_depth"):
            ap._scan_max_depth({"scan_depth": "custom", "custom_depth": 0})

    def test_file_type_for(self):
        assert ap._file_type_for("doc.PDF") == ".pdf"
        assert ap._file_type_for("README") == "<noext>"


class TestPosixJsonHelpers:
    def test_put_read_and_list_manifests(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        ap._put_json("projects/p/ds/_acquisition/manifests/s0.json", {"setId": "s0", "n": 1})
        data = ap._read_json("projects/p/ds/_acquisition/manifests/s0.json")
        assert data == {"setId": "s0", "n": 1}
        keys = ap._list_manifest_keys("projects/p/ds/_acquisition/manifests")
        assert any(k.endswith("s0.json") for k in keys)

    def test_read_json_missing_returns_none(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        assert ap._read_json("does/not/exist.json") is None

    def test_default_store_root_raises_when_unset(self, monkeypatch):
        monkeypatch.delenv("NEMO_DEFAULT_STORE_ROOT", raising=False)
        with pytest.raises(RuntimeError, match="NEMO_DEFAULT_STORE_ROOT"):
            ap._default_store_root()


class TestConsumerName:
    def test_includes_hostname_and_pid(self):
        name = ap._consumer_name()
        assert "-" in name
        assert str(os.getpid()) in name


class TestRegisterVolumeFiles:
    def test_walks_mount_and_writes_filelist(self, monkeypatch, tmp_path):
        mount = tmp_path / "vol"
        mount.mkdir(parents=True)
        (mount / "keep.csv").write_text("a,b\n1,2\n")
        (mount / "skip.tmp").write_text("x")
        (mount / ".sgwtmp").mkdir()
        (mount / ".sgwtmp" / "hidden").write_text("nope")

        store = tmp_path / "store"
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(store))

        out = _call_activity(ap.register_volume_files, {
            "mountPath": str(mount),
            "outputBucket": "dest-bucket",
            "projectID": "proj-1",
            "datasetID": "ds-1",
            "fileGlob": "*.csv",
            "fileExcludePattern": "*.tmp",
        })

        assert out["fileCount"] == 1
        assert out["fileListKey"]
        payload = ap._read_json(out["fileListKey"])
        assert payload["totalFiles"] == 1
        assert payload["files"][0]["local_path"].endswith("keep.csv")

    def test_requires_mount_and_bucket(self):
        out = _call_activity(ap.register_volume_files, {
            "projectID": "p",
            "datasetID": "d",
            "mountPath": "",
            "outputBucket": "",
        })
        assert "error" in out


class TestListVolumeDirectory:
    def test_lists_files_and_directories(self, monkeypatch, tmp_path):
        mount = tmp_path / "vol"
        mount.mkdir(parents=True)
        (mount / "subdir").mkdir()
        (mount / "readme.txt").write_text("hi")
        (mount / ".hidden").write_text("skip")

        out = _call_activity(ap.list_volume_directory, {
            "mountPath": str(mount),
            "subPath": "",
        })

        names = {e["name"] for e in out["entries"]}
        assert "subdir" in names
        assert "readme.txt" in names
        assert ".hidden" not in names
        assert out["totalFileCount"] == 1
        assert out["totalDirCount"] == 1

    def test_missing_path_returns_error(self, tmp_path):
        out = _call_activity(ap.list_volume_directory, {
            "mountPath": str(tmp_path / "nope"),
        })
        assert "error" in out


class TestScanVolume:
    def test_scans_tree_with_depth_limit(self, monkeypatch, tmp_path):
        root = tmp_path / "scan-root"
        root.mkdir(parents=True)
        (root / "a.txt").write_text("a")
        sub = root / "level1"
        sub.mkdir()
        (sub / "b.csv").write_text("b")
        deep = sub / "level2"
        deep.mkdir()
        (deep / "c.json").write_text("{}")

        monkeypatch.setattr(ap.activity, "heartbeat", lambda *_a, **_kw: None)

        out = _call_activity(ap.scan_volume, {
            "mountPath": str(root),
            "scanConfig": {"scan_depth": "top_2_levels"},
        })

        assert out.get("error_message") is None
        assert out["total_files"] >= 1
        assert out["total_folders"] >= 1
        types = {s["file_type"] for s in out["file_type_stats"]}
        assert ".txt" in types or ".csv" in types

    def test_scan_depth_none_returns_empty_stats(self, monkeypatch, tmp_path):
        root = tmp_path / "empty-scan"
        root.mkdir()
        monkeypatch.setattr(ap.activity, "heartbeat", lambda *_a, **_kw: None)
        out = _call_activity(ap.scan_volume, {
            "mountPath": str(root),
            "scanConfig": {"scan_depth": "none"},
        })
        assert out["total_files"] == 0
        assert out["total_folders"] == 0

    def test_invalid_mount_returns_error_message(self):
        out = _call_activity(ap.scan_volume, {
            "mountPath": "/path/does/not/exist/for/scan",
            "scanConfig": {"scan_depth": "all_levels"},
        })
        assert out["error_message"]


class TestMarkStreamEOF:
    def test_marks_eof_on_stream(self, monkeypatch):
        js = _make_stream("wf-eof", "run-eof")
        monkeypatch.setattr(ap, "_activity_workflow_context", lambda: ("wf-eof", "run-eof"))
        monkeypatch.setattr(ap, "build_job_stream", lambda wf, rn: js)

        out = _call_activity(ap.mark_stream_eof, {})
        assert out["eof"] is True
        assert js.is_complete()

    def test_requires_temporal_context(self, monkeypatch):
        monkeypatch.setattr(ap, "_activity_workflow_context", lambda: ("", ""))
        with pytest.raises(RuntimeError, match="Temporal activity context"):
            _call_activity(ap.mark_stream_eof, {})
