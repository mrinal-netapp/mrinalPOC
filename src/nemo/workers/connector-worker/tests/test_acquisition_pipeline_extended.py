"""Extended unit tests for acquisition_pipeline volume/registration activities."""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest

fakeredis = pytest.importorskip("fakeredis")
pytest.importorskip("temporalio")

from activities import acquisition_pipeline as ap  # noqa: E402
from streaming.redis_stream import JobStream, JobStreamConfig  # noqa: E402


def _call_activity(fn, *args, **kwargs):
    target = getattr(fn, "__wrapped__", fn)
    return target(*args, **kwargs)


def _patch_logging(monkeypatch):
    monkeypatch.setattr(ap, "log_activity_start", lambda *_a, **_kw: None)
    monkeypatch.setattr(ap, "log_activity_result", lambda *_a, **_kw: None)


class TestScanHelpers:
    def test_file_type_for(self):
        assert ap._file_type_for("report.PDF") == ".pdf"
        assert ap._file_type_for("README") == "<noext>"

    def test_scan_max_depth_none(self):
        assert ap._scan_max_depth({"scan_depth": "none"}) == 0

    def test_scan_max_depth_numeric(self):
        assert ap._scan_max_depth({"scan_depth": "top_2_levels"}) == 2
        assert ap._scan_max_depth({"scan_depth": "custom", "custom_depth": 3}) == 3

    def test_scan_max_depth_invalid(self):
        with pytest.raises(ValueError):
            ap._scan_max_depth({"scan_depth": "invalid"})


class TestScanVolume:
    def test_missing_mount_path(self, monkeypatch):
        _patch_logging(monkeypatch)
        out = _call_activity(ap.scan_volume, {})
        assert "error_message" in out
        assert out["total_files"] == 0

    def test_scans_directory_tree(self, monkeypatch, tmp_path):
        _patch_logging(monkeypatch)
        monkeypatch.setattr(ap.activity, "heartbeat", lambda *_a, **_kw: None)
        root = tmp_path / "vol"
        (root / "docs").mkdir(parents=True)
        (root / "docs" / "a.txt").write_text("hello", encoding="utf-8")
        (root / "docs" / "b.pdf").write_bytes(b"%PDF")

        out = _call_activity(
            ap.scan_volume,
            {"mountPath": str(root), "scanConfig": {"scan_depth": "top_2_levels"}},
        )

        assert out.get("error_message") is None
        assert out["total_files"] == 2
        assert out["total_size_bytes"] > 0
        types = {s["file_type"] for s in out["file_type_stats"]}
        assert ".txt" in types
        assert ".pdf" in types


class TestDiscoverSourceItemsAlias:
    def test_delegates_to_discover_object_store_items(self, monkeypatch):
        called = []

        def fake_discover(input_body):
            called.append(input_body)
            return {"ok": True}

        monkeypatch.setattr(ap, "discover_object_store_items", fake_discover)
        out = _call_activity(ap.discover_source_items, {"bucket": "b1"})
        assert out == {"ok": True}
        assert called


class TestMarkStreamEof:
    def test_marks_eof_on_stream(self, monkeypatch):
        _patch_logging(monkeypatch)
        monkeypatch.setattr(
            ap, "_activity_workflow_context", lambda: ("wf-eof", "run-eof")
        )
        client = fakeredis.FakeRedis(decode_responses=True)
        monkeypatch.setattr(
            ap,
            "build_job_stream",
            lambda wf, run: JobStream(
                JobStreamConfig(
                    workflow_id=wf,
                    run_id=run,
                    client=client,
                    ttl_seconds=3600,
                    stream_maxlen=100,
                ),
            ),
        )

        out = _call_activity(ap.mark_stream_eof, {"projectID": "p1", "datasetID": "d1"})
        assert out["eof"] is True
        assert "streamKey" in out


class TestFinalizeRegistration:
    def test_aggregates_manifests(self, monkeypatch, tmp_path):
        _patch_logging(monkeypatch)
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setattr(
            ap, "_activity_workflow_context", lambda: ("wf-fin", "run-fin")
        )
        monkeypatch.delenv("WORKFLOW_ENGINE_URL", raising=False)

        prefix = "projects/p1/datasets/d1"
        man_dir = tmp_path / prefix / "_acquisition" / "manifests"
        man_dir.mkdir(parents=True)
        (man_dir / "reg-s0.json").write_text(
            json.dumps(
                {
                    "fileCount": 3,
                    "totalSize": 300,
                    "durationMs": 1000,
                    "maxMtime": "2026-01-01T00:00:00Z",
                    "partitionKey": f"{prefix}/_acquisition/partitions/part-reg-s0.parquet",
                }
            ),
            encoding="utf-8",
        )

        monkeypatch.setattr(ap, "_put_facet", lambda *_a, **_kw: None)
        monkeypatch.setattr(
            ap, "build_job_stream", lambda *_a, **_kw: MagicMock(destroy=MagicMock())
        )
        monkeypatch.setattr(
            ap, "DirQueue", lambda *_a, **_kw: MagicMock(cleanup=MagicMock())
        )

        out = _call_activity(
            ap.finalize_registration,
            {
                "projectID": "p1",
                "datasetID": "d1",
                "filesDiscovered": 5,
                "filesFiltered": 2,
                "sourceType": "volume",
            },
        )

        assert out["fileCount"] == 3
        assert out["totalSize"] == 300
        manifest = json.loads(
            (tmp_path / prefix / "_acquisition" / "manifest.json").read_text(
                encoding="utf-8"
            ),
        )
        assert manifest["totalFiles"] == 3
        assert manifest["sourceType"] == "volume"
