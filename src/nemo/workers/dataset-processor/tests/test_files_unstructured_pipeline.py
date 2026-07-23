"""Unit tests for the unstructured-file pipeline in processing.files:

- `_is_text_file` / `_is_image_file` / `_is_document_file` classification
- `_run_pii_analysis` branch dispatch (image / document / text / none) + error handling
- `_download_and_extract_metadata` (volume path and POSIX-mount path)
- `process_unstructured_data` orchestration (sequential + parallel metadata download,
  URI construction, cleanup, tracker/heartbeat callbacks, error handling)
- `_parse_iso_timestamp`
- `_cast_unstructured_table_to_schema`
"""

import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import pyarrow as pa
import pytest

from processing.config import Config
from processing.files import (
    _cast_unstructured_table_to_schema,
    _download_and_extract_metadata,
    _is_document_file,
    _is_image_file,
    _is_text_file,
    _parse_iso_timestamp,
    _run_pii_analysis,
    _unstructured_metadata_schema,
    process_unstructured_data,
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


class TestFileClassification(unittest.TestCase):
    def setUp(self):
        self.config = _minimal_config()

    def test_is_text_file_by_mime_prefix(self):
        self.assertTrue(_is_text_file(self.config, "text/plain", ".weird"))

    def test_is_text_file_by_extension(self):
        self.assertTrue(_is_text_file(self.config, "application/octet-stream", ".md"))

    def test_is_text_file_false(self):
        self.assertFalse(_is_text_file(self.config, "application/octet-stream", ".bin"))

    def test_is_image_file_by_mime(self):
        self.assertTrue(_is_image_file(self.config, "image/png", ".xyz"))

    def test_is_image_file_by_extension(self):
        self.assertTrue(_is_image_file(self.config, "application/octet-stream", ".png"))

    def test_is_image_file_false(self):
        self.assertFalse(_is_image_file(self.config, "application/octet-stream", ".bin"))

    def test_is_document_file_by_mime(self):
        self.assertTrue(_is_document_file(self.config, "application/pdf", ".xyz"))

    def test_is_document_file_by_extension(self):
        self.assertTrue(_is_document_file(self.config, "application/octet-stream", ".pdf"))

    def test_is_document_file_false(self):
        self.assertFalse(_is_document_file(self.config, "application/octet-stream", ".bin"))


class _FakePiiResult:
    def __init__(self, entities=None, count=0, risk_level="none"):
        self.entities = entities or []
        self.count = count
        self.risk_level = risk_level

    def to_json(self):
        import json
        return json.dumps(sorted(set(self.entities)))


class _FakeSensResult:
    def __init__(self, sensitivity_class="unknown"):
        self.sensitivity_class = sensitivity_class


class TestRunPiiAnalysis(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.local_path = Path(self.tmp) / "f.txt"
        self.local_path.write_text("hello world")

    def test_disabled_returns_defaults(self):
        config = _minimal_config(enable_pii_analysis=False)
        result = _run_pii_analysis(config, self.local_path, "text/plain", ".txt")
        self.assertEqual(result["sensitivity_class"], "unknown")
        self.assertIsNone(result["has_pii"])

    def test_import_error_returns_defaults(self):
        config = _minimal_config(enable_pii_analysis=True)
        with mock.patch.dict(sys.modules, {"analyzers.pii": None}):
            result = _run_pii_analysis(config, self.local_path, "text/plain", ".txt")
        self.assertEqual(result["pii_risk_level"], "none")
        self.assertIsNone(result["has_pii"])

    def test_image_branch_not_sensitive(self):
        config = _minimal_config(enable_pii_analysis=True)
        img_path = Path(self.tmp) / "f.png"
        img_path.write_bytes(b"\x89PNG")
        heartbeats = []
        with mock.patch(
            "analyzers.image_pii.analyze_image",
            return_value=_FakePiiResult(entities=["PERSON"], count=1, risk_level="medium"),
        ), mock.patch(
            "analyzers.sensitivity.classify_image",
            return_value=_FakeSensResult(sensitivity_class="public"),
        ):
            result = _run_pii_analysis(
                config, img_path, "image/png", ".png", heartbeat_fn=heartbeats.append,
            )
        self.assertEqual(result["pii_count"], 1)
        self.assertEqual(result["sensitivity_class"], "public")
        self.assertEqual(result["pii_risk_level"], "medium")
        self.assertTrue(result["has_pii"])
        self.assertTrue(any("analyze_image" in m for m in heartbeats))

    def test_image_branch_sensitive_forces_high_risk(self):
        config = _minimal_config(enable_pii_analysis=True)
        img_path = Path(self.tmp) / "f.png"
        img_path.write_bytes(b"\x89PNG")
        with mock.patch(
            "analyzers.image_pii.analyze_image",
            return_value=_FakePiiResult(entities=[], count=0, risk_level="none"),
        ), mock.patch(
            "analyzers.sensitivity.classify_image",
            return_value=_FakeSensResult(sensitivity_class="sensitive"),
        ):
            result = _run_pii_analysis(config, img_path, "image/png", ".png")
        self.assertEqual(result["pii_risk_level"], "high")
        self.assertTrue(result["has_pii"])

    def test_image_branch_heartbeat_exception_swallowed(self):
        config = _minimal_config(enable_pii_analysis=True)
        img_path = Path(self.tmp) / "f.png"
        img_path.write_bytes(b"\x89PNG")

        def bad_hb(_msg):
            raise RuntimeError("boom")

        with mock.patch(
            "analyzers.image_pii.analyze_image",
            return_value=_FakePiiResult(),
        ), mock.patch(
            "analyzers.sensitivity.classify_image",
            return_value=_FakeSensResult(),
        ):
            result = _run_pii_analysis(config, img_path, "image/png", ".png", heartbeat_fn=bad_hb)
        self.assertEqual(result["sensitivity_class"], "unknown")

    def test_document_branch_with_content(self):
        config = _minimal_config(enable_pii_analysis=True)
        doc_path = Path(self.tmp) / "f.pdf"
        doc_path.write_bytes(b"%PDF-1.4")
        heartbeats = []
        with mock.patch(
            "analyzers.document_extractor.extract_document_text", return_value="secret text",
        ), mock.patch(
            "analyzers.pii.analyze_text",
            return_value=_FakePiiResult(entities=["US_SSN"], count=1, risk_level="high"),
        ):
            result = _run_pii_analysis(
                config, doc_path, "application/pdf", ".pdf", heartbeat_fn=heartbeats.append,
            )
        self.assertEqual(result["pii_count"], 1)
        self.assertTrue(result["has_pii"])
        self.assertEqual(result["sensitivity_class"], "not_applicable")
        self.assertTrue(any("extract_document" in m for m in heartbeats))
        self.assertTrue(any("analyze_text" in m for m in heartbeats))

    def test_document_branch_heartbeat_exceptions_swallowed(self):
        config = _minimal_config(enable_pii_analysis=True)
        doc_path = Path(self.tmp) / "f.pdf"
        doc_path.write_bytes(b"%PDF-1.4")

        def bad_hb(_msg):
            raise RuntimeError("boom")

        with mock.patch(
            "analyzers.document_extractor.extract_document_text", return_value="secret text",
        ), mock.patch(
            "analyzers.pii.analyze_text", return_value=_FakePiiResult(),
        ):
            result = _run_pii_analysis(config, doc_path, "application/pdf", ".pdf", heartbeat_fn=bad_hb)
        self.assertEqual(result["sensitivity_class"], "not_applicable")

    def test_document_branch_none_content_returns_not_applicable(self):
        config = _minimal_config(enable_pii_analysis=True)
        doc_path = Path(self.tmp) / "f.pdf"
        doc_path.write_bytes(b"%PDF-1.4")
        with mock.patch(
            "analyzers.document_extractor.extract_document_text", return_value=None,
        ):
            result = _run_pii_analysis(config, doc_path, "application/pdf", ".pdf")
        self.assertEqual(result["sensitivity_class"], "not_applicable")
        self.assertIsNone(result["has_pii"])

    def test_document_branch_skipped_when_image_only(self):
        config = _minimal_config(enable_pii_analysis=True, pii_analysis_image_only=True)
        doc_path = Path(self.tmp) / "f.pdf"
        doc_path.write_bytes(b"%PDF-1.4")
        result = _run_pii_analysis(config, doc_path, "application/pdf", ".pdf")
        self.assertEqual(result["sensitivity_class"], "not_applicable")
        self.assertIsNone(result["has_pii"])

    def test_text_branch_with_content(self):
        config = _minimal_config(enable_pii_analysis=True)
        heartbeats = []
        with mock.patch(
            "analyzers.pii.analyze_text",
            return_value=_FakePiiResult(entities=["EMAIL_ADDRESS"], count=1, risk_level="medium"),
        ):
            result = _run_pii_analysis(
                config, self.local_path, "text/plain", ".txt", heartbeat_fn=heartbeats.append,
            )
        self.assertEqual(result["pii_count"], 1)
        self.assertTrue(result["has_pii"])
        self.assertTrue(any("read_text" in m for m in heartbeats))

    def test_text_branch_heartbeat_exceptions_swallowed(self):
        config = _minimal_config(enable_pii_analysis=True)

        def bad_hb(_msg):
            raise RuntimeError("boom")

        with mock.patch("analyzers.pii.analyze_text", return_value=_FakePiiResult()):
            result = _run_pii_analysis(config, self.local_path, "text/plain", ".txt", heartbeat_fn=bad_hb)
        self.assertEqual(result["sensitivity_class"], "not_applicable")

    def test_text_branch_skipped_when_image_only(self):
        config = _minimal_config(enable_pii_analysis=True, pii_analysis_image_only=True)
        result = _run_pii_analysis(config, self.local_path, "text/plain", ".txt")
        self.assertEqual(result["sensitivity_class"], "not_applicable")
        self.assertIsNone(result["has_pii"])

    def test_none_of_the_above_returns_not_applicable(self):
        config = _minimal_config(enable_pii_analysis=True)
        bin_path = Path(self.tmp) / "f.bin"
        bin_path.write_bytes(b"\x00\x01")
        result = _run_pii_analysis(config, bin_path, "application/octet-stream", ".bin")
        self.assertEqual(result["sensitivity_class"], "not_applicable")
        self.assertIsNone(result["has_pii"])

    def test_exception_during_analysis_returns_defaults(self):
        config = _minimal_config(enable_pii_analysis=True)
        with mock.patch("analyzers.pii.analyze_text", side_effect=RuntimeError("boom")):
            result = _run_pii_analysis(config, self.local_path, "text/plain", ".txt")
        self.assertEqual(result["pii_risk_level"], "none")
        self.assertIsNone(result["has_pii"])


class TestDownloadAndExtractMetadata(unittest.TestCase):
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

    def test_volume_path_success(self):
        vol_path = Path(self.tmp) / "vol" / "a.txt"
        vol_path.parent.mkdir(parents=True)
        vol_path.write_text("hello")
        result = _download_and_extract_metadata(
            self.config, {"local_path": str(vol_path), "key": "unused", "size": 5}, self.temp_dir,
        )
        self.assertIsNotNone(result)
        path, file_info, mime_type, checksum, extension = result
        self.assertEqual(path, vol_path)
        self.assertEqual(extension, ".txt")

    def test_volume_path_not_a_file_returns_none(self):
        result = _download_and_extract_metadata(
            self.config,
            {"local_path": str(Path(self.tmp) / "missing.txt"), "key": "unused"},
            self.temp_dir,
        )
        self.assertIsNone(result)

    def test_volume_path_exception_returns_none(self):
        vol_path = Path(self.tmp) / "vol" / "a.txt"
        vol_path.parent.mkdir(parents=True)
        vol_path.write_text("hello")
        with mock.patch("processing.files.compute_checksum", side_effect=RuntimeError("boom")):
            result = _download_and_extract_metadata(
                self.config, {"local_path": str(vol_path), "key": "unused"}, self.temp_dir,
            )
        self.assertIsNone(result)

    def test_posix_mount_key_success(self):
        key = "datasets/ds-test/data_files/a.txt"
        mount_path = self.config.posix_path(key)
        mount_path.parent.mkdir(parents=True)
        mount_path.write_text("hello")
        result = _download_and_extract_metadata(self.config, {"key": key, "size": 5}, self.temp_dir)
        self.assertIsNotNone(result)

    def test_posix_mount_key_missing_returns_none(self):
        result = _download_and_extract_metadata(
            self.config, {"key": "datasets/ds-test/data_files/missing.txt"}, self.temp_dir,
        )
        self.assertIsNone(result)

    def test_heartbeat_forwarded_to_compute_checksum(self):
        key = "datasets/ds-test/data_files/big.txt"
        mount_path = self.config.posix_path(key)
        mount_path.parent.mkdir(parents=True)
        mount_path.write_text("x" * (64 * 1024))
        messages = []
        result = _download_and_extract_metadata(
            self.config, {"key": key, "size": 64 * 1024}, self.temp_dir,
            heartbeat_fn=messages.append,
        )
        self.assertIsNotNone(result)


class TestProcessUnstructuredData(unittest.TestCase):
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

    def _write_mount_file(self, key: str, content: str = "hello"):
        p = self.config.posix_path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
        return p

    def test_single_file_sequential_posix_uri(self):
        self._write_mount_file("datasets/ds-test/data_files/a.txt")
        tracker = mock.Mock()
        table, schema = process_unstructured_data(
            self.config,
            [{"key": "datasets/ds-test/data_files/a.txt", "size": 5}],
            self.temp_dir,
            tracker=tracker,
        )
        self.assertEqual(table.num_rows, 1)
        self.assertTrue(table.column("file_path")[0].as_py().startswith("file://"))
        tracker.update.assert_called()

    def test_multiple_files_parallel_metadata_download(self):
        for i in range(3):
            self._write_mount_file(f"datasets/ds-test/data_files/f{i}.txt")
        heartbeats = []
        table, schema = process_unstructured_data(
            self.config,
            [{"key": f"datasets/ds-test/data_files/f{i}.txt", "size": 5} for i in range(3)],
            self.temp_dir,
            heartbeat_callback=heartbeats.append,
        )
        self.assertEqual(table.num_rows, 3)
        self.assertTrue(any("metadata: downloaded" in m for m in heartbeats))
        self.assertTrue(any("building_metadata_table" in m for m in heartbeats))

    def test_parallel_metadata_heartbeat_exception_swallowed(self):
        for i in range(3):
            self._write_mount_file(f"datasets/ds-test/data_files/f{i}.txt")

        def bad_hb(_msg):
            raise RuntimeError("boom")

        table, schema = process_unstructured_data(
            self.config,
            [{"key": f"datasets/ds-test/data_files/f{i}.txt", "size": 5} for i in range(3)],
            self.temp_dir,
            heartbeat_callback=bad_hb,
        )
        self.assertEqual(table.num_rows, 3)

    def test_volume_files_use_local_path_uri_and_no_unlink(self):
        vol_path = Path(self.tmp) / "vol" / "b.txt"
        vol_path.parent.mkdir(parents=True)
        vol_path.write_text("hello")
        table, schema = process_unstructured_data(
            self.config,
            [{"key": "unused", "local_path": str(vol_path), "size": 5}],
            self.temp_dir,
        )
        self.assertEqual(table.num_rows, 1)
        self.assertEqual(table.column("file_path")[0].as_py(), f"file://{vol_path}")
        self.assertTrue(vol_path.exists())

    def test_non_posix_source_builds_s3_uri_and_unlinks(self):
        key = "datasets/ds-test/data_files/c.txt"
        local_copy = self.temp_dir / "c.txt"
        local_copy.write_text("hello")

        with mock.patch.object(Config, "use_posix", return_value=False):
            with mock.patch(
                "processing.files._download_and_extract_metadata",
                return_value=(local_copy, {"key": key, "size": 5}, "text/plain", "abc123", ".txt"),
            ):
                table, schema = process_unstructured_data(
                    self.config, [{"key": key, "size": 5}], self.temp_dir,
                )
        self.assertEqual(table.num_rows, 1)
        self.assertEqual(table.column("file_path")[0].as_py(), f"s3://bucket/{key}")
        self.assertFalse(local_copy.exists())

    def test_per_file_exception_is_logged_and_skipped_non_posix(self):
        key = "datasets/ds-test/data_files/d.txt"
        local_copy = self.temp_dir / "d.txt"
        local_copy.write_text("hello")

        with mock.patch.object(Config, "use_posix", return_value=False):
            with mock.patch(
                "processing.files._download_and_extract_metadata",
                return_value=(local_copy, {"key": key}, "text/plain", "abc123", ".txt"),
            ), mock.patch(
                "processing.files._run_pii_analysis", side_effect=RuntimeError("boom"),
            ):
                with self.assertRaises(ValueError):
                    process_unstructured_data(
                        self.config, [{"key": key, "size": 5}], self.temp_dir,
                    )
        self.assertFalse(local_copy.exists())

    def test_no_files_downloaded_raises_value_error(self):
        with self.assertRaises(ValueError):
            process_unstructured_data(
                self.config,
                [{"key": "datasets/ds-test/data_files/missing.txt"}],
                self.temp_dir,
            )

    def test_last_modified_parsed_into_timestamp_columns(self):
        self._write_mount_file("datasets/ds-test/data_files/a.txt")
        table, schema = process_unstructured_data(
            self.config,
            [{
                "key": "datasets/ds-test/data_files/a.txt",
                "size": 5,
                "last_modified": "2024-01-15T10:30:00Z",
            }],
            self.temp_dir,
        )
        created = table.column("created_time")[0].as_py()
        self.assertEqual(created.year, 2024)


class TestParseIsoTimestamp(unittest.TestCase):
    def test_none_returns_none(self):
        self.assertIsNone(_parse_iso_timestamp(None))

    def test_empty_string_returns_none(self):
        self.assertIsNone(_parse_iso_timestamp(""))
        self.assertIsNone(_parse_iso_timestamp("   "))

    def test_naive_datetime_gets_utc_tzinfo(self):
        dt = datetime(2024, 1, 1, 12, 0, 0)
        result = _parse_iso_timestamp(dt)
        self.assertEqual(result.tzinfo, timezone.utc)

    def test_aware_datetime_passthrough(self):
        dt = datetime(2024, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
        result = _parse_iso_timestamp(dt)
        self.assertIs(result, dt)

    def test_iso_string_with_z_suffix(self):
        result = _parse_iso_timestamp("2024-01-15T10:30:00Z")
        self.assertEqual(result.year, 2024)
        self.assertIsNotNone(result.tzinfo)

    def test_iso_string_with_offset(self):
        result = _parse_iso_timestamp("2024-01-15T10:30:00+05:00")
        self.assertIsNotNone(result.tzinfo)

    def test_invalid_string_returns_none(self):
        self.assertIsNone(_parse_iso_timestamp("not-a-date"))


class TestCastUnstructuredTableToSchema(unittest.TestCase):
    def test_missing_column_filled_with_nulls(self):
        table = pa.table({"file_path": ["a"], "file_name": ["a.txt"]})
        out = _cast_unstructured_table_to_schema(table)
        self.assertEqual(out.num_rows, 1)
        self.assertIsNone(out.column("checksum")[0].as_py())

    def test_null_type_column_replaced(self):
        table = pa.table({
            "file_path": pa.array([None], type=pa.null()),
        })
        out = _cast_unstructured_table_to_schema(table)
        self.assertIsNone(out.column("file_path")[0].as_py())
        self.assertEqual(out.schema.field("file_path").type, pa.string())

    def test_matching_type_column_passthrough(self):
        table = pa.table({"file_size": pa.array([42], type=pa.int64())})
        out = _cast_unstructured_table_to_schema(table)
        self.assertEqual(out.column("file_size")[0].as_py(), 42)

    def test_string_to_timestamp_conversion(self):
        table = pa.table({"created_time": ["2024-01-15T10:30:00Z"]})
        out = _cast_unstructured_table_to_schema(table)
        self.assertEqual(out.column("created_time")[0].as_py().year, 2024)

    def test_string_to_integer_conversion(self):
        table = pa.table({"file_size": ["123", "", None]})
        out = _cast_unstructured_table_to_schema(table)
        vals = out.column("file_size").to_pylist()
        self.assertEqual(vals, [123, None, None])

    def test_string_to_integer_invalid_becomes_none(self):
        table = pa.table({"file_size": ["not-a-number"]})
        out = _cast_unstructured_table_to_schema(table)
        self.assertIsNone(out.column("file_size")[0].as_py())

    def test_string_to_boolean_conversion(self):
        table = pa.table({"has_pii": ["true", "false", "1", "", None]})
        out = _cast_unstructured_table_to_schema(table)
        vals = out.column("has_pii").to_pylist()
        self.assertEqual(vals, [True, False, True, None, None])

    def test_generic_cast_via_compute(self):
        table = pa.table({"file_size": pa.array([1, 2], type=pa.int32())})
        out = _cast_unstructured_table_to_schema(table)
        self.assertEqual(out.column("file_size").to_pylist(), [1, 2])

    def test_incompatible_cast_falls_back_to_nulls(self):
        table = pa.table({"file_size": pa.array([[1, 2]], type=pa.list_(pa.int64()))})
        out = _cast_unstructured_table_to_schema(table)
        self.assertIsNone(out.column("file_size")[0].as_py())


if __name__ == "__main__":
    unittest.main()
