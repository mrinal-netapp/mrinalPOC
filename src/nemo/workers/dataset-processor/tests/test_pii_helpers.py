"""Unit tests for processing.pii helpers."""

import tempfile
import unittest
from pathlib import Path

from processing.config import Config
from processing.pii import _resolve_posix_fallback


class TestResolvePosixFallback(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.mount = self.tmp
        self.config = Config.from_dict({
            "dataset_id": "ds-abc",
            "s3_path_prefix": "tenant/proj",
        })

    def _data_dir(self) -> Path:
        return Path(self.mount) / "tenant/proj/datasets/ds-abc/data_files"

    def test_returns_none_when_dataset_id_missing(self):
        cfg = Config.from_dict({"dataset_id": ""})
        self.assertIsNone(_resolve_posix_fallback(self.mount, cfg, "file.txt"))

    def test_finds_file_at_top_level(self):
        data_dir = self._data_dir()
        data_dir.mkdir(parents=True)
        target = data_dir / "report.pdf"
        target.write_bytes(b"%PDF")
        found = _resolve_posix_fallback(self.mount, self.config, "report.pdf")
        self.assertEqual(found, target)

    def test_finds_file_in_nested_subdirectory(self):
        data_dir = self._data_dir()
        nested = data_dir / "2024" / "q1"
        nested.mkdir(parents=True)
        target = nested / "nested.csv"
        target.write_text("a,b\n1,2\n")
        found = _resolve_posix_fallback(self.mount, self.config, "nested.csv")
        self.assertEqual(found, target)

    def test_returns_none_when_data_dir_missing(self):
        self.assertIsNone(_resolve_posix_fallback(self.mount, self.config, "missing.txt"))

    def test_without_s3_prefix_uses_flat_dataset_path(self):
        cfg = Config.from_dict({"dataset_id": "ds-flat"})
        data_dir = Path(self.mount) / "datasets/ds-flat/data_files"
        data_dir.mkdir(parents=True)
        target = data_dir / "only.json"
        target.write_text("{}")
        found = _resolve_posix_fallback(self.mount, cfg, "only.json")
        self.assertEqual(found, target)


if __name__ == "__main__":
    unittest.main()
