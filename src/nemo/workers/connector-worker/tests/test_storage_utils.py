"""Unit tests for ClearDatasetPath and storage helpers."""

from __future__ import annotations

import pytest

pytest.importorskip("temporalio")

from activities import storage_utils as su


def _call_activity(fn, *args, **kwargs):
    target = getattr(fn, "__wrapped__", fn)
    return target(*args, **kwargs)


@pytest.fixture
def store_root(tmp_path, monkeypatch):
    monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
    return tmp_path


class TestDefaultStoreRoot:
    def test_raises_when_unset(self, monkeypatch):
        monkeypatch.delenv("NEMO_DEFAULT_STORE_ROOT", raising=False)
        with pytest.raises(RuntimeError, match="NEMO_DEFAULT_STORE_ROOT"):
            su._default_store_root()

    def test_returns_trimmed_path(self, store_root):
        assert su._default_store_root() == str(store_root)


class TestClearDatasetPath:
    def test_requires_output_path(self, store_root):
        with pytest.raises(ValueError, match="outputPath"):
            _call_activity(su.clear_dataset_path, {})

    def test_clears_posix_prefix(self, store_root):
        target = store_root / "projects/p1/datasets/d1"
        target.mkdir(parents=True)
        (target / "a.txt").write_text("a")
        sub = target / "sub"
        sub.mkdir()
        (sub / "b.txt").write_text("b")

        result = _call_activity(
            su.clear_dataset_path,
            {"outputPath": "projects/p1/datasets/d1"},
        )

        assert result["deletedCount"] == 2
        assert not target.exists()

    def test_accepts_legacy_s3_path(self, store_root):
        target = store_root / "key"
        target.mkdir(parents=True)
        (target / "file.parquet").write_text("x")

        result = _call_activity(
            su.clear_dataset_path,
            {"s3Path": "s3://bucket/key"},
        )

        assert result["deletedCount"] == 1
        assert not target.exists()

    def test_noop_when_target_missing(self, store_root):
        result = _call_activity(
            su.clear_dataset_path,
            {"output_path": "missing/prefix"},
        )
        assert result["deletedCount"] == 0
