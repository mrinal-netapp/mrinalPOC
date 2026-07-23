"""Unit tests for volume-backed acquisition activities and helpers."""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

pytest.importorskip("temporalio")

from activities import acquisition_pipeline as ap  # noqa: E402


def _call_activity(fn, *args, **kwargs):
    target = getattr(fn, "__wrapped__", fn)
    return target(*args, **kwargs)


class TestParseVolumeWatermark:
    def test_parses_iso_zulu(self):
        dt = ap._parse_volume_watermark("2026-05-23T12:00:00Z")
        assert dt is not None
        assert dt.tzinfo is not None

    def test_returns_none_for_empty(self):
        assert ap._parse_volume_watermark("") is None
        assert ap._parse_volume_watermark(None) is None

    def test_returns_none_for_invalid(self):
        assert ap._parse_volume_watermark("not-a-timestamp") is None


class TestListVolumeDirectory:
    def test_requires_volume_id_or_mount_path(self, monkeypatch):
        monkeypatch.setattr(ap, "log_activity_start", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap, "log_activity_result", lambda *_a, **_kw: None)
        out = _call_activity(ap.list_volume_directory, {})
        assert out["error"]
        assert "volumeId or mountPath" in out["error"]

    def test_builds_mount_path_from_volume_id(self, monkeypatch, tmp_path):
        monkeypatch.setattr(ap, "log_activity_start", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap, "log_activity_result", lambda *_a, **_kw: None)
        root = tmp_path / "pvcs" / "vol-1"
        sub = root / "incoming"
        sub.mkdir(parents=True)
        (sub / "a.txt").write_text("x", encoding="utf-8")
        out = _call_activity(
            ap.list_volume_directory,
            {"mountPath": str(root), "subPath": "incoming"},
        )
        assert out.get("error") is None
        assert out["mountPath"] == str(root)
        assert out["subPath"] == "incoming"
        names = {e["name"] for e in out["entries"]}
        assert "a.txt" in names


class TestRegisterVolumeFiles:
    def test_requires_mount_path_and_output_bucket(self, monkeypatch):
        monkeypatch.setattr(ap, "log_activity_start", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap, "log_activity_result", lambda *_a, **_kw: None)
        out = _call_activity(
            ap.register_volume_files,
            {"projectID": "p1", "datasetID": "ds1"},
        )
        assert out["error"]
        assert "mountPath and outputBucket" in out["error"]

    def test_walk_applies_glob_and_watermark(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setattr(ap, "log_activity_start", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap, "log_activity_result", lambda *_a, **_kw: None)
        mount = tmp_path / "mount"
        mount.mkdir()
        old = mount / "old.parquet"
        new = mount / "new.parquet"
        old.write_text("1", encoding="utf-8")
        new.write_text("2", encoding="utf-8")
        old_ts = datetime(2020, 1, 1, tzinfo=timezone.utc).timestamp()
        new_ts = datetime(2026, 5, 23, tzinfo=timezone.utc).timestamp()
        import os

        os.utime(old, (old_ts, old_ts))
        os.utime(new, (new_ts, new_ts))

        put_calls = []

        def fake_put(key, payload):
            put_calls.append((key, payload))

        monkeypatch.setattr(ap, "_put_json", fake_put)

        out = _call_activity(
            ap.register_volume_files,
            {
                "mountPath": str(mount),
                "outputBucket": "proj-bucket",
                "fileGlob": "*.parquet",
                "lastMtimeWatermark": "2024-01-01T00:00:00Z",
                "projectID": "p1",
                "datasetID": "ds1",
            },
        )
        assert out["fileCount"] == 1
        assert put_calls
        payload = put_calls[0][1]
        assert payload["source"] == "volume"
        assert len(payload["files"]) == 1
        assert payload["files"][0]["local_path"].endswith("new.parquet")
