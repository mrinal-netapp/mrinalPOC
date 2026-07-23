"""Unit tests for the main orchestration activity `process_file_set` in processing.files.

Covers manifest-entry parsing (dict + legacy string formats), the structured
vs. unstructured branches, heartbeat/background-heartbeat wiring, output
artifacts written, error handling (including nested failure while writing the
error result), and temp-dir cleanup.
"""

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import pyarrow as pa
import pytest

pd = pytest.importorskip("pandas")

from processing.config import Config
from processing import files as files_mod
from processing.files import _read_json, process_file_set


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
        "manifest_s3_key": "jobs/job-1/manifest.json",
        "output_prefix": "jobs/job-1/partitions/0",
        "set_id": "0",
    }
    base.update(overrides)
    return Config.from_dict(base)


class _MountFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._saved_root = os.environ.get("NEMO_DEFAULT_STORE_ROOT")
        os.environ["NEMO_DEFAULT_STORE_ROOT"] = self.tmp
        self.addCleanup(self._restore_root)

    def _restore_root(self):
        if self._saved_root is not None:
            os.environ["NEMO_DEFAULT_STORE_ROOT"] = self._saved_root
        else:
            os.environ.pop("NEMO_DEFAULT_STORE_ROOT", None)

    def _write_manifest(self, config: Config, raw_files):
        path = config.posix_path(config.manifest_s3_key)
        path.parent.mkdir(parents=True, exist_ok=True)
        import json
        path.write_text(json.dumps({"files": raw_files}))


class TestProcessFileSetStructured(_MountFixture):
    def test_happy_path_writes_all_outputs(self):
        config = _minimal_config(dataset_kind="structured")
        self._write_manifest(config, [{"key": "datasets/ds-test/data_files/a.csv", "size": 5}])

        table = pa.table({"x": [1, 2, 3]})
        schema = table.schema
        heartbeats = []
        progress_calls = []

        def fake_process(cfg, files, temp_dir, tracker=None, heartbeat_callback=None):
            if tracker:
                tracker.update(1, 1, force=True, totalFiles=1, processedFiles=1)
            return table, schema

        with mock.patch.object(files_mod, "process_structured_data", side_effect=fake_process):
            result = process_file_set(
                config,
                heartbeat_callback=heartbeats.append,
                workflow_progress_callback=lambda *a: progress_calls.append(a),
            )

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["setId"], "0")
        self.assertEqual(result["rowCount"], 3)
        self.assertEqual(result["fileCount"], 1)

        parquet_path = config.posix_path(f"{config.output_prefix}/data.parquet")
        self.assertTrue(parquet_path.is_file())
        schema_json = _read_json(config, f"{config.output_prefix}/schema.json")
        self.assertEqual([f["name"] for f in schema_json["fields"]], ["x"])
        col_stats = _read_json(config, f"{config.output_prefix}/column_stats.json")
        self.assertIn("rowCount", col_stats["columns"]["x"])
        partition_result = _read_json(config, f"{config.output_prefix}/partition_result.json")
        self.assertEqual(partition_result["status"], "success")

        self.assertTrue(any("writing_parquet: before write_table" in m for m in heartbeats))
        self.assertTrue(any("writing_parquet: after write_table" in m for m in heartbeats))
        self.assertTrue(len(progress_calls) > 0)

    def test_temp_dir_cleaned_up_after_success(self):
        config = _minimal_config(dataset_kind="structured", set_id="cleanup-test")
        self._write_manifest(config, [{"key": "a.csv", "size": 1}])
        table = pa.table({"x": [1]})
        with mock.patch.object(files_mod, "process_structured_data", return_value=(table, table.schema)):
            process_file_set(config)
        self.assertFalse(Path("/tmp/fileset-cleanup-test").exists())

    def test_no_heartbeat_callback_skips_background_heartbeat(self):
        config = _minimal_config(dataset_kind="structured")
        self._write_manifest(config, [{"key": "a.csv", "size": 1}])
        table = pa.table({"x": [1]})
        with mock.patch.object(files_mod, "process_structured_data", return_value=(table, table.schema)), \
             mock.patch.object(files_mod, "_BackgroundHeartbeat") as bg_cls:
            process_file_set(config)
        bg_cls.assert_not_called()


class TestProcessFileSetUnstructured(_MountFixture):
    def test_happy_path_writes_metadata_json(self):
        config = _minimal_config(dataset_kind="unstructured")
        self._write_manifest(config, [{"key": "datasets/ds-test/data_files/a.txt", "size": 5}])

        table = pa.table({"file_name": ["a.txt"], "file_size": [5]})
        heartbeats = []
        with mock.patch.object(files_mod, "process_unstructured_data", return_value=(table, table.schema)):
            result = process_file_set(config, heartbeat_callback=heartbeats.append)

        self.assertEqual(result["status"], "success")
        metadata = _read_json(config, f"{config.output_prefix}/metadata.json")
        self.assertEqual(metadata, [{"file_name": "a.txt", "file_size": 5}])
        self.assertTrue(any("before_to_pydict" in m.replace(" ", "_") for m in heartbeats))
        self.assertTrue(any("after_to_pydict" in m.replace(" ", "_") for m in heartbeats))

    def test_empty_table_writes_empty_metadata_list(self):
        config = _minimal_config(dataset_kind="unstructured")
        self._write_manifest(config, [{"key": "a.txt", "size": 0}])
        table = pa.table({"file_name": pa.array([], type=pa.string())})
        with mock.patch.object(files_mod, "process_unstructured_data", return_value=(table, table.schema)):
            result = process_file_set(config)
        metadata = _read_json(config, f"{config.output_prefix}/metadata.json")
        self.assertEqual(metadata, [])
        self.assertEqual(result["rowCount"], 0)


class TestManifestEntryParsing(_MountFixture):
    def _run_and_capture_files(self, raw_files):
        config = _minimal_config(dataset_kind="structured")
        self._write_manifest(config, raw_files)
        table = pa.table({"x": [1]})
        captured = {}

        def fake_process(cfg, files, *a, **kw):
            captured["files"] = files
            return table, table.schema

        with mock.patch.object(files_mod, "process_structured_data", side_effect=fake_process):
            process_file_set(config)
        return captured["files"]

    def test_dict_entry_with_key_and_metadata(self):
        files = self._run_and_capture_files([
            {"key": "a.csv", "size": 42, "lastModified": "2024-01-01T00:00:00Z", "etag": '"abc123"'},
        ])
        self.assertEqual(files[0]["key"], "a.csv")
        self.assertEqual(files[0]["size"], 42)
        self.assertEqual(files[0]["last_modified"], "2024-01-01T00:00:00Z")
        self.assertEqual(files[0]["etag"], "abc123")

    def test_dict_entry_with_capital_key_field(self):
        files = self._run_and_capture_files([{"Key": "b.csv"}])
        self.assertEqual(files[0]["key"], "b.csv")
        self.assertEqual(files[0]["size"], 0)

    def test_dict_entry_with_local_path_fallback_key(self):
        files = self._run_and_capture_files([{"local_path": "/vol/c.csv"}])
        self.assertEqual(files[0]["key"], "/vol/c.csv")
        self.assertEqual(files[0]["local_path"], "/vol/c.csv")

    def test_dict_entry_with_camel_case_local_path(self):
        files = self._run_and_capture_files([{"localPath": " /vol/d.csv "}])
        self.assertEqual(files[0]["local_path"], "/vol/d.csv")

    def test_dict_entry_with_no_key_or_path_becomes_unknown(self):
        files = self._run_and_capture_files([{"size": 5}])
        self.assertEqual(files[0]["key"], "unknown")

    def test_legacy_string_entry(self):
        files = self._run_and_capture_files(["plain-key.csv"])
        self.assertEqual(files[0]["key"], "plain-key.csv")
        self.assertEqual(files[0]["size"], 0)
        self.assertEqual(files[0]["etag"], "")

    def test_legacy_empty_string_entry_becomes_unknown(self):
        files = self._run_and_capture_files([""])
        self.assertEqual(files[0]["key"], "unknown")


class TestProcessFileSetErrorHandling(_MountFixture):
    def test_exception_writes_error_result_and_reraises(self):
        config = _minimal_config(dataset_kind="structured")
        self._write_manifest(config, [{"key": "a.csv"}])
        with mock.patch.object(files_mod, "process_structured_data", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                process_file_set(config)

        error_result = _read_json(config, f"{config.output_prefix}/partition_result.json")
        self.assertEqual(error_result["status"], "error")
        self.assertIn("boom", error_result["error"])

    def test_error_result_upload_failure_is_swallowed_and_original_raised(self):
        config = _minimal_config(dataset_kind="structured")
        self._write_manifest(config, [{"key": "a.csv"}])

        def fail_on_error_result(cfg, key, data):
            if "partition_result" in key:
                raise RuntimeError("upload failed too")

        with mock.patch.object(files_mod, "process_structured_data", side_effect=RuntimeError("boom")), \
             mock.patch.object(files_mod, "_upload_json", side_effect=fail_on_error_result):
            with self.assertRaises(RuntimeError) as ctx:
                process_file_set(config)
        self.assertEqual(str(ctx.exception), "boom")

    def test_temp_dir_cleaned_up_after_failure(self):
        config = _minimal_config(dataset_kind="structured", set_id="cleanup-fail")
        self._write_manifest(config, [{"key": "a.csv"}])
        with mock.patch.object(files_mod, "process_structured_data", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                process_file_set(config)
        self.assertFalse(Path("/tmp/fileset-cleanup-fail").exists())

    def test_background_heartbeat_exited_even_on_failure(self):
        config = _minimal_config(dataset_kind="structured")
        self._write_manifest(config, [{"key": "a.csv"}])
        with mock.patch.object(files_mod, "process_structured_data", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                process_file_set(config, heartbeat_callback=lambda m: None)
        # No assertion beyond "did not hang / raise a secondary exception" --
        # bg_hb.__exit__ must run in the `finally` block even after failure.


if __name__ == "__main__":
    unittest.main()
