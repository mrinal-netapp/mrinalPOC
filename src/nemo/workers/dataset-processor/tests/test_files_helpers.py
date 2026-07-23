"""Unit tests for pure helpers in processing.files."""

import json
import os
import tempfile
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import pytest
import pyarrow as pa

from processing.config import Config

pd = pytest.importorskip("pandas")
from processing import files as files_mod
from processing.files import (
    ProgressTracker,
    _BackgroundHeartbeat,
    _get_relative_path,
    _is_image_file,
    _is_text_file,
    _run_pii_analysis,
    build_iceberg_schema,
    compute_checksum,
    compute_column_stats,
    compute_file_stats,
    get_dataset,
    get_mime_type,
    is_manual_dataset,
    normalize_table_for_iceberg,
    pyarrow_type_to_iceberg,
    read_csv_file,
    read_json_file,
    read_structured_file,
    register_table_with_pyiceberg,
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


class TestGetRelativePath(unittest.TestCase):
    def test_extracts_path_after_data_files_marker(self):
        key = "s3://b/prefix/datasets/ds/data_files/subdir/file.csv"
        self.assertEqual(_get_relative_path(key), "subdir/file.csv")

    def test_none_or_empty_returns_unknown(self):
        self.assertEqual(_get_relative_path(None), "unknown")
        self.assertEqual(_get_relative_path(""), "unknown")
        self.assertEqual(_get_relative_path("   "), "unknown")

    def test_fallback_to_basename(self):
        self.assertEqual(_get_relative_path("some/other/path/file.txt"), "file.txt")


class TestComputeChecksum(unittest.TestCase):
    def test_sha256_hex_digest(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(b"hello dataset")
            path = Path(f.name)
        try:
            import hashlib
            expected = hashlib.sha256(b"hello dataset").hexdigest()
            self.assertEqual(compute_checksum(path), expected)
        finally:
            path.unlink(missing_ok=True)

    def test_heartbeat_callback_invoked_on_large_read(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(b"x" * (32 * 1024))
            path = Path(f.name)
        messages = []
        try:
            compute_checksum(
                path,
                heartbeat_fn=messages.append,
                heartbeat_stride_bytes=1024,
            )
            self.assertTrue(any("checksum" in m for m in messages))
        finally:
            path.unlink(missing_ok=True)


class TestGetMimeType(unittest.TestCase):
    def test_guesses_csv_from_extension(self):
        with tempfile.NamedTemporaryFile(suffix=".csv", delete=False) as f:
            f.write(b"a,b\n1,2\n")
            path = Path(f.name)
        try:
            mime = get_mime_type(path)
            self.assertIn(mime, ("text/csv", "application/csv", "application/octet-stream"))
        finally:
            path.unlink(missing_ok=True)


class TestNormalizeAndReadStructured(unittest.TestCase):
    def test_normalize_nested_struct_to_json_string(self):
        table = pa.table({
            "id": [1],
            "meta": pa.array([{"k": "v"}], type=pa.struct([("k", pa.string())])),
        })
        out = normalize_table_for_iceberg(table)
        self.assertEqual(out.schema.field("meta").type, pa.string())
        self.assertEqual(out.column("meta")[0].as_py(), '{"k": "v"}')

    def test_read_csv_roundtrip(self):
        with tempfile.NamedTemporaryFile(suffix=".csv", delete=False, mode="w") as f:
            f.write("name,count\nalice,1\n")
            path = Path(f.name)
        try:
            table = read_csv_file(path)
            self.assertEqual(table.num_rows, 1)
            self.assertIn("name", table.column_names)
        finally:
            path.unlink(missing_ok=True)

    def test_read_json_array(self):
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False, mode="w") as f:
            json.dump([{"x": 1}, {"x": 2}], f)
            path = Path(f.name)
        try:
            table = read_json_file(path)
            self.assertEqual(table.num_rows, 2)
        finally:
            path.unlink(missing_ok=True)

    def test_read_json_single_object(self):
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False, mode="w") as f:
            json.dump({"a": 1}, f)
            path = Path(f.name)
        try:
            table = read_json_file(path)
            self.assertEqual(table.num_rows, 1)
        finally:
            path.unlink(missing_ok=True)

    def test_read_structured_file_unsupported_returns_none(self):
        with tempfile.NamedTemporaryFile(suffix=".xyz", delete=False) as f:
            f.write(b"data")
            path = Path(f.name)
        try:
            self.assertIsNone(read_structured_file(path))
        finally:
            path.unlink(missing_ok=True)


class TestPyarrowTypeToIceberg(unittest.TestCase):
    def test_primitive_mappings(self):
        self.assertEqual(pyarrow_type_to_iceberg(pa.int64()), "long")
        self.assertEqual(pyarrow_type_to_iceberg(pa.float64()), "double")
        self.assertEqual(pyarrow_type_to_iceberg(pa.bool_()), "boolean")
        self.assertEqual(pyarrow_type_to_iceberg(pa.string()), "string")

    def test_build_iceberg_schema_shape(self):
        schema = pa.schema([("id", pa.int32()), ("name", pa.string())])
        out = build_iceberg_schema(schema)
        self.assertEqual(out["type"], "struct")
        self.assertEqual(len(out["fields"]), 2)
        self.assertEqual(out["fields"][0]["name"], "id")
        self.assertEqual(out["fields"][0]["type"], "int")


class TestColumnAndFileStats(unittest.TestCase):
    def test_compute_column_stats_integer_column(self):
        table = pa.table({"age": [20, 30, None, 40]})
        stats = compute_column_stats(table)
        col = stats["columns"]["age"]
        self.assertEqual(col["category"], "integer")
        self.assertEqual(col["nullCount"], 1)
        self.assertIn("min", col)
        self.assertIn("max", col)

    def test_compute_column_stats_boolean_column(self):
        table = pa.table({"flag": [True, False, True]})
        stats = compute_column_stats(table)
        col = stats["columns"]["flag"]
        self.assertEqual(col["category"], "boolean")
        self.assertEqual(col["trueCount"], 2)

    def test_compute_file_stats_distributions(self):
        now = datetime.now(timezone.utc)
        table = pa.table({
            "extension": [".txt", ".pdf", ".txt"],
            "file_size": [500, 2_000_000, 800],
            "modified_time": [now.isoformat(), now.isoformat(), now.isoformat()],
        })
        stats = compute_file_stats(table)
        self.assertEqual(stats["totalFiles"], 3)
        self.assertGreater(stats["totalSizeBytes"], 0)
        self.assertTrue(stats["extensionDistribution"])
        self.assertTrue(stats["sizeDistribution"])


class TestFileClassification(unittest.TestCase):
    def setUp(self):
        self.config = _minimal_config()

    def test_text_file_by_mime_and_extension(self):
        self.assertTrue(_is_text_file(self.config, "text/plain", ".txt"))
        self.assertTrue(_is_text_file(self.config, "application/json", ""))

    def test_image_file_by_mime(self):
        self.assertTrue(_is_image_file(self.config, "image/png", ""))

    def test_run_pii_analysis_disabled_returns_defaults(self):
        cfg = _minimal_config(enable_pii_analysis=False)
        with tempfile.NamedTemporaryFile(suffix=".txt", delete=False) as f:
            f.write(b"email test@example.com")
            path = Path(f.name)
        try:
            result = _run_pii_analysis(cfg, path, "text/plain", ".txt")
            self.assertIsNone(result["has_pii"])
            self.assertEqual(result["pii_risk_level"], "none")
        finally:
            path.unlink(missing_ok=True)


class TestProgressTracker(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        os.environ["NEMO_DEFAULT_STORE_ROOT"] = self.tmp
        self.config = _minimal_config()

    def tearDown(self):
        os.environ.pop("NEMO_DEFAULT_STORE_ROOT", None)

    def test_update_writes_progress_json(self):
        tracker = ProgressTracker(self.config, write_interval_seconds=0)
        tracker.begin_phase("processing")
        tracker.update(2, 10, force=True)
        progress_path = self.config.posix_path(self.config.progress_key())
        self.assertTrue(progress_path.is_file())
        data = json.loads(progress_path.read_text())
        self.assertEqual(data["phase"], "processing")
        self.assertEqual(data["current"], 2)
        self.assertEqual(data["total"], 10)

    def test_finish_marks_completed(self):
        tracker = ProgressTracker(self.config, write_interval_seconds=0)
        tracker.finish(rows=5)
        data = json.loads(
            self.config.posix_path(self.config.progress_key()).read_text()
        )
        self.assertEqual(data["status"], "completed")
        self.assertEqual(data["rows"], 5)

    def test_fail_writes_error_status(self):
        tracker = ProgressTracker(self.config, write_interval_seconds=0)
        tracker.fail("boom")
        data = json.loads(
            self.config.posix_path(self.config.progress_key()).read_text()
        )
        self.assertEqual(data["status"], "error")
        self.assertEqual(data["error"], "boom")


class TestBackgroundHeartbeat(unittest.TestCase):
    def test_sends_heartbeat_while_active(self):
        messages = []
        with _BackgroundHeartbeat(messages.append, interval=0.05):
            time.sleep(0.15)
        self.assertTrue(messages)


class TestIsManualDataset(unittest.TestCase):
    """is_manual_dataset drives whether an import replaces or appends table rows."""

    def setUp(self):
        self.config = _minimal_config()

    def test_returns_true_when_dataset_type_is_manual(self):
        self.config.dataset_type = "manual"
        self.assertTrue(is_manual_dataset(self.config))

    def test_returns_false_when_dataset_type_is_acquired(self):
        self.config.dataset_type = "acquired"
        self.assertFalse(is_manual_dataset(self.config))

    def _fake_response(self, payload):
        resp = mock.Mock()
        resp.json.return_value = payload
        resp.raise_for_status.return_value = None
        return resp

    @mock.patch.object(Config, "get_access_token", return_value="tok")
    @mock.patch("requests.get")
    def test_returns_true_for_manual_type(self, mock_get, _tok):
        mock_get.return_value = self._fake_response({"type": "manual"})
        self.assertTrue(is_manual_dataset(self.config))

    @mock.patch.object(Config, "get_access_token", return_value="tok")
    @mock.patch("requests.get")
    def test_returns_false_for_acquired_type(self, mock_get, _tok):
        mock_get.return_value = self._fake_response({"type": "acquired"})
        self.assertFalse(is_manual_dataset(self.config))

    @mock.patch.object(Config, "get_access_token", return_value="tok")
    @mock.patch("requests.get")
    def test_defaults_to_false_when_lookup_fails(self, mock_get, _tok):
        mock_get.side_effect = RuntimeError("config-service down")
        # A failed lookup must fall back to append (historical behavior), not crash.
        self.assertFalse(is_manual_dataset(self.config))

    @mock.patch.object(Config, "get_access_token", return_value="tok")
    @mock.patch("requests.get")
    def test_get_dataset_returns_payload(self, mock_get, _tok):
        mock_get.return_value = self._fake_response({"id": "ds-test", "type": "manual"})
        self.assertEqual(get_dataset(self.config), {"id": "ds-test", "type": "manual"})


class TestRegisterTableWriteMode(unittest.TestCase):
    """register_table_with_pyiceberg: manual re-imports overwrite, others append."""

    def _run(self, *, replace_existing, table_exists):
        cfg = _minimal_config(warehouse_id="wh")

        table = mock.Mock()
        # existing_field_names = {f.name for f in table.schema().fields}
        table.schema.return_value = SimpleNamespace(fields=[SimpleNamespace(name="col1")])

        catalog = mock.Mock()
        if table_exists:
            catalog.load_table.return_value = table
        else:
            catalog.load_table.side_effect = Exception("not found")
            catalog.create_table.return_value = table

        parquet_table = SimpleNamespace(column_names=["col1"])

        with mock.patch.object(files_mod, "HAS_PYICEBERG", True), \
             mock.patch.object(files_mod, "RestCatalog", create=True, return_value=catalog), \
             mock.patch.object(files_mod, "build_pyiceberg_schema", return_value=object()), \
             mock.patch.object(files_mod, "_configure_table_io_for_static_credentials"), \
             mock.patch.object(files_mod, "_cast_parquet_table_to_iceberg_schema", return_value=parquet_table), \
             mock.patch.object(files_mod.pq, "read_table", return_value=parquet_table), \
             mock.patch.object(Config, "get_access_token", return_value="tok"):
            ref = register_table_with_pyiceberg(
                cfg, object(), "/tmp/x.parquet", replace_existing=replace_existing
            )

        self.assertEqual(ref, f"{cfg.namespace}.{cfg.dataset_name}")
        return table

    def test_manual_reimport_overwrites_existing_table(self):
        table = self._run(replace_existing=True, table_exists=True)
        table.overwrite.assert_called_once()
        table.append.assert_not_called()

    def test_acquired_reimport_appends_to_existing_table(self):
        table = self._run(replace_existing=False, table_exists=True)
        table.append.assert_called_once()
        table.overwrite.assert_not_called()

    def test_new_table_always_appends_even_when_replace_requested(self):
        # A freshly created table has nothing to replace, so overwrite must not run.
        table = self._run(replace_existing=True, table_exists=False)
        table.append.assert_called_once()
        table.overwrite.assert_not_called()


if __name__ == "__main__":
    unittest.main()
