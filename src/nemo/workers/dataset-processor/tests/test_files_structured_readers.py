"""Unit tests for structured-file reading and process_structured_data in processing.files."""

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import pyarrow as pa
import pyarrow.parquet as pq
import pytest

pd = pytest.importorskip("pandas")

from processing.config import Config
from processing.files import (
    _process_single_structured_file,
    get_mime_type,
    process_structured_data,
    read_json_file,
    read_parquet_file,
    read_structured_file,
)


def _minimal_config(**overrides) -> Config:
    base = {
        "dataset_id": "ds-test",
        "dataset_name": "test-ds",
        "project_id": "proj-1",
        "bucket_name": "bucket",
        "project_client_id": "cid",
        "project_client_secret": "secret",
        "aws_access_key_id": "ak",
        "aws_secret_access_key": "sk",
        "s3_endpoint": "http://s3:7070",
    }
    base.update(overrides)
    return Config.from_dict(base)


class TestReadJsonFileEdgeCases(unittest.TestCase):
    def _write(self, content: str, suffix=".json") -> Path:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False, mode="w") as f:
            f.write(content)
            return Path(f.name)

    def test_empty_file_raises_value_error(self):
        path = self._write("")
        try:
            with self.assertRaises(ValueError):
                read_json_file(path)
        finally:
            path.unlink(missing_ok=True)

    def test_whitespace_only_file_raises_value_error(self):
        path = self._write("   \n\t  ")
        try:
            with self.assertRaises(ValueError):
                read_json_file(path)
        finally:
            path.unlink(missing_ok=True)

    def test_invalid_first_character_raises_value_error(self):
        path = self._write("not json at all")
        try:
            with self.assertRaises(ValueError) as ctx:
                read_json_file(path)
            self.assertIn("Invalid JSON", str(ctx.exception))
        finally:
            path.unlink(missing_ok=True)

    def test_jsonl_multi_line_object_parses_with_lines_true(self):
        content = json.dumps({"a": 1}) + "\n" + json.dumps({"a": 2}) + "\n"
        path = self._write(content, suffix=".jsonl")
        try:
            table = read_json_file(path)
            self.assertEqual(table.num_rows, 2)
        finally:
            path.unlink(missing_ok=True)

    def test_multiline_single_json_object_falls_back_when_lines_parse_fails(self):
        # A pretty-printed single JSON object spans multiple lines but is NOT
        # valid JSONL, so pd.read_json(lines=True) raises ValueError and the
        # code falls back to a plain (non-lines) parse.
        content = json.dumps({"a": 1, "b": {"nested": True}}, indent=2)
        path = self._write(content, suffix=".json")
        try:
            table = read_json_file(path)
            self.assertEqual(table.num_rows, 1)
        finally:
            path.unlink(missing_ok=True)

    def test_empty_dataframe_after_parse_raises_value_error(self):
        path = self._write("[]")
        try:
            with self.assertRaises(ValueError) as ctx:
                read_json_file(path)
            self.assertIn("empty DataFrame", str(ctx.exception))
        finally:
            path.unlink(missing_ok=True)


class TestReadStructuredFileDispatch(unittest.TestCase):
    def test_dispatches_parquet(self):
        with tempfile.NamedTemporaryFile(suffix=".parquet", delete=False) as f:
            path = Path(f.name)
        try:
            pq.write_table(pa.table({"x": [1, 2]}), path)
            table = read_structured_file(path)
            self.assertEqual(table.num_rows, 2)
        finally:
            path.unlink(missing_ok=True)

    def test_dispatches_csv(self):
        with tempfile.NamedTemporaryFile(suffix=".csv", delete=False, mode="w") as f:
            f.write("a,b\n1,2\n")
            path = Path(f.name)
        try:
            table = read_structured_file(path)
            self.assertEqual(table.num_rows, 1)
        finally:
            path.unlink(missing_ok=True)

    def test_read_parquet_file_normalizes_nested_columns(self):
        with tempfile.NamedTemporaryFile(suffix=".parquet", delete=False) as f:
            path = Path(f.name)
        try:
            nested = pa.table({
                "id": [1],
                "meta": pa.array([{"k": "v"}], type=pa.struct([("k", pa.string())])),
            })
            pq.write_table(nested, path)
            table = read_parquet_file(path)
            self.assertEqual(table.schema.field("meta").type, pa.string())
        finally:
            path.unlink(missing_ok=True)


class TestProcessSingleStructuredFile(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._saved_root = os.environ.get("NEMO_DEFAULT_STORE_ROOT")
        os.environ["NEMO_DEFAULT_STORE_ROOT"] = self.tmp
        self.config = _minimal_config()

    def tearDown(self):
        if self._saved_root is not None:
            os.environ["NEMO_DEFAULT_STORE_ROOT"] = self._saved_root
        else:
            os.environ.pop("NEMO_DEFAULT_STORE_ROOT", None)

    def test_reads_from_volume_local_path(self):
        vol_path = Path(self.tmp) / "vol" / "data.csv"
        vol_path.parent.mkdir(parents=True)
        vol_path.write_text("a,b\n1,2\n")

        table = _process_single_structured_file(
            self.config, {"local_path": str(vol_path)}, self.tmp
        )
        self.assertEqual(table.num_rows, 1)

    def test_volume_path_not_a_file_returns_none(self):
        table = _process_single_structured_file(
            self.config, {"local_path": str(Path(self.tmp) / "missing.csv")}, self.tmp
        )
        self.assertIsNone(table)

    def test_volume_read_failure_returns_none(self):
        vol_path = Path(self.tmp) / "bad.json"
        vol_path.write_text("not valid json")
        table = _process_single_structured_file(
            self.config, {"local_path": str(vol_path)}, self.tmp
        )
        self.assertIsNone(table)

    def test_reads_from_posix_mount_key(self):
        key = "datasets/ds-test/data_files/a.csv"
        mount_path = self.config.posix_path(key)
        mount_path.parent.mkdir(parents=True)
        mount_path.write_text("x,y\n1,2\n")

        table = _process_single_structured_file(self.config, {"key": key}, self.tmp)
        self.assertEqual(table.num_rows, 1)

    def test_posix_mount_key_error_returns_none(self):
        table = _process_single_structured_file(
            self.config, {"key": "datasets/ds-test/data_files/missing.csv"}, self.tmp
        )
        self.assertIsNone(table)


class TestProcessStructuredDataSequential(unittest.TestCase):
    """Sequential path (max_workers<=1 or single file) — avoids ProcessPoolExecutor pickling issues in tests."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._saved_root = os.environ.get("NEMO_DEFAULT_STORE_ROOT")
        os.environ["NEMO_DEFAULT_STORE_ROOT"] = self.tmp
        self.config = _minimal_config()
        self.temp_dir = Path(tempfile.mkdtemp())

    def tearDown(self):
        if self._saved_root is not None:
            os.environ["NEMO_DEFAULT_STORE_ROOT"] = self._saved_root
        else:
            os.environ.pop("NEMO_DEFAULT_STORE_ROOT", None)

    def _write_mount_csv(self, key: str, content: str):
        p = self.config.posix_path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)

    def test_single_file_uses_sequential_path_and_calls_tracker(self):
        self._write_mount_csv("datasets/ds-test/data_files/a.csv", "x\n1\n")
        tracker = mock.Mock()
        heartbeats = []

        table, schema = process_structured_data(
            self.config,
            [{"key": "datasets/ds-test/data_files/a.csv"}],
            self.temp_dir,
            tracker=tracker,
            heartbeat_callback=heartbeats.append,
        )
        self.assertEqual(table.num_rows, 1)
        tracker.update.assert_called()
        self.assertTrue(any("structured: reading" in m for m in heartbeats))

    def test_sequential_path_with_volume_files(self):
        vol_path = Path(self.tmp) / "vol" / "b.csv"
        vol_path.parent.mkdir(parents=True)
        vol_path.write_text("y\n2\n")
        tracker = mock.Mock()
        heartbeats = []

        table, schema = process_structured_data(
            self.config,
            [{"key": "unused", "local_path": str(vol_path)}],
            self.temp_dir,
            tracker=tracker,
            heartbeat_callback=heartbeats.append,
        )
        self.assertEqual(table.num_rows, 1)
        tracker.update.assert_any_call(
            0, 1, totalFiles=1, processedFiles=0, currentFile=vol_path.name,
        )
        self.assertTrue(any("structured: reading" in m for m in heartbeats))

    def test_sequential_path_heartbeat_exceptions_swallowed(self):
        self._write_mount_csv("datasets/ds-test/data_files/a.csv", "x\n1\n")
        vol_path = Path(self.tmp) / "vol" / "b.csv"
        vol_path.parent.mkdir(parents=True)
        vol_path.write_text("y\n2\n")

        def bad_hb(_msg):
            raise RuntimeError("boom")

        table, schema = process_structured_data(
            self.config,
            [
                {"key": "unused", "local_path": str(vol_path)},
                {"key": "datasets/ds-test/data_files/a.csv"},
            ],
            self.temp_dir,
            heartbeat_callback=bad_hb,
        )
        self.assertEqual(table.num_rows, 2)

    def test_sequential_path_skips_failed_volume_file_and_continues(self):
        good_vol = Path(self.tmp) / "vol" / "good.csv"
        good_vol.parent.mkdir(parents=True)
        good_vol.write_text("z\n9\n")
        bad_vol = Path(self.tmp) / "vol" / "bad.xyz"
        bad_vol.write_text("garbage")

        table, schema = process_structured_data(
            self.config,
            [
                {"key": "unused1", "local_path": str(bad_vol)},
                {"key": "unused2", "local_path": str(good_vol)},
            ],
            self.temp_dir,
        )
        self.assertEqual(table.num_rows, 1)

    def test_sequential_path_skips_failed_key_and_continues(self):
        self._write_mount_csv("datasets/ds-test/data_files/good.csv", "x\n1\n")

        table, schema = process_structured_data(
            self.config,
            [
                {"key": "datasets/ds-test/data_files/missing.csv"},
                {"key": "datasets/ds-test/data_files/good.csv"},
            ],
            self.temp_dir,
        )
        self.assertEqual(table.num_rows, 1)

    def test_no_files_processed_successfully_raises(self):
        with self.assertRaises(ValueError):
            process_structured_data(
                self.config,
                [{"key": "datasets/ds-test/data_files/missing.csv"}],
                self.temp_dir,
            )

    def test_multiple_files_with_identical_schema_concat_successfully(self):
        self._write_mount_csv("datasets/ds-test/data_files/a.csv", "x,y\n1,hello\n")
        self._write_mount_csv("datasets/ds-test/data_files/b.csv", "x,y\n2,world\n")

        table, schema = process_structured_data(
            self.config,
            [
                {"key": "datasets/ds-test/data_files/a.csv"},
                {"key": "datasets/ds-test/data_files/b.csv"},
            ],
            self.temp_dir,
        )
        self.assertEqual(table.num_rows, 2)

    # NOTE: the `except: unified_tables.append(t)` fallback inside the per-table
    # cast loop (files.py) guards against a `.cast()` failure *after*
    # `pa.unify_schemas` has already succeeded. In practice, every incompatible
    # schema combination we tried (dictionary-encoded vs plain string, list<int>
    # vs list<string>, int vs string, int vs double, string vs double-from-NaN)
    # causes `unify_schemas` itself to raise before reaching `.cast()`. Since
    # `pa.Table` is an immutable C extension type, `.cast` cannot be
    # monkeypatched to force this branch directly, so it is not exercised here
    # — it is a low-risk defensive fallback for a pyarrow edge case we could
    # not reproduce with real data.

    def test_final_heartbeat_before_unify_schema(self):
        self._write_mount_csv("datasets/ds-test/data_files/a.csv", "x\n1\n")
        heartbeats = []
        process_structured_data(
            self.config,
            [{"key": "datasets/ds-test/data_files/a.csv"}],
            self.temp_dir,
            heartbeat_callback=heartbeats.append,
        )
        self.assertIn("structured: unify_schema_and_concat", heartbeats)


class TestProcessStructuredDataParallel(unittest.TestCase):
    """Parallel path (ProcessPoolExecutor) — uses real multiprocessing with real files
    on the POSIX mount so worker subprocesses (which re-read NEMO_DEFAULT_STORE_ROOT
    from the environment) can resolve paths correctly."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._saved_root = os.environ.get("NEMO_DEFAULT_STORE_ROOT")
        os.environ["NEMO_DEFAULT_STORE_ROOT"] = self.tmp
        self.config = _minimal_config()
        self.temp_dir = Path(tempfile.mkdtemp())

    def tearDown(self):
        if self._saved_root is not None:
            os.environ["NEMO_DEFAULT_STORE_ROOT"] = self._saved_root
        else:
            os.environ.pop("NEMO_DEFAULT_STORE_ROOT", None)

    def _write_mount_csv(self, key: str, content: str):
        p = self.config.posix_path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)

    def test_multiple_files_use_parallel_path(self):
        for i in range(3):
            self._write_mount_csv(f"datasets/ds-test/data_files/f{i}.csv", "x\n1\n")

        tracker = mock.Mock()
        table, schema = process_structured_data(
            self.config,
            [{"key": f"datasets/ds-test/data_files/f{i}.csv"} for i in range(3)],
            self.temp_dir,
            tracker=tracker,
        )
        self.assertEqual(table.num_rows, 3)
        tracker.update.assert_called()

    def test_parallel_path_skips_failed_future_and_continues(self):
        self._write_mount_csv("datasets/ds-test/data_files/good1.csv", "x\n1\n")
        self._write_mount_csv("datasets/ds-test/data_files/good2.csv", "x\n2\n")

        table, schema = process_structured_data(
            self.config,
            [
                {"key": "datasets/ds-test/data_files/missing.csv"},
                {"key": "datasets/ds-test/data_files/good1.csv"},
                {"key": "datasets/ds-test/data_files/good2.csv"},
            ],
            self.temp_dir,
        )
        self.assertEqual(table.num_rows, 2)

    def test_parallel_path_future_raising_exception_is_skipped(self):
        # A file that is itself valid CSV but has an incompatible/corrupt
        # extension-vs-content combination can raise inside the worker process
        # rather than returning None; the `future.result()` exception handler
        # (not the `_process_single_structured_file` None-return path) must
        # catch it and continue with the remaining files.
        self._write_mount_csv("datasets/ds-test/data_files/good1.csv", "x\n1\n")
        self._write_mount_csv("datasets/ds-test/data_files/good2.csv", "x\n2\n")
        bad_path = self.config.posix_path("datasets/ds-test/data_files/bad.csv")
        bad_path.parent.mkdir(parents=True, exist_ok=True)
        bad_path.write_bytes(b"\xff\xfe\x00\x01not,valid,csv\xff")

        table, schema = process_structured_data(
            self.config,
            [
                {"key": "datasets/ds-test/data_files/bad.csv"},
                {"key": "datasets/ds-test/data_files/good1.csv"},
                {"key": "datasets/ds-test/data_files/good2.csv"},
            ],
            self.temp_dir,
        )
        self.assertGreaterEqual(table.num_rows, 2)


if __name__ == "__main__":
    unittest.main()
