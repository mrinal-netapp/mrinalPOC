"""Unit tests for the `merge_results` aggregation activity in processing.files.

Covers: structured multi-partition merge (table creation + append + column-stats
merge), unstructured metadata merge (row-oriented and legacy column-oriented),
PII summarization gating, error handling (including nested failure while writing
the error result and cleanup-failure swallowing), and temp-dir cleanup.
"""

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
pytest.importorskip("pyiceberg", reason="pyiceberg not installed")

from processing.config import Config
from processing import files as files_mod
from processing.files import _read_json, _upload_json, merge_results


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
        "job_output_prefix": "jobs/job-1",
    }
    base.update(overrides)
    return Config.from_dict(base)


class _MountFixture(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self._saved_root = os.environ.get("NEMO_DEFAULT_STORE_ROOT")
        os.environ["NEMO_DEFAULT_STORE_ROOT"] = self.tmp
        self.addCleanup(self._restore_root)
        self.addCleanup(self._cleanup_agg_dir)

    def _restore_root(self):
        if self._saved_root is not None:
            os.environ["NEMO_DEFAULT_STORE_ROOT"] = self._saved_root
        else:
            os.environ.pop("NEMO_DEFAULT_STORE_ROOT", None)

    def _cleanup_agg_dir(self):
        import shutil
        shutil.rmtree("/tmp/aggregation", ignore_errors=True)

    def _common_mocks(self):
        """Common patches for config-service/catalog calls used by nearly every test."""
        return [
            mock.patch.object(files_mod, "is_manual_dataset", return_value=False),
            mock.patch.object(files_mod, "update_dataset_catalog_ref"),
            mock.patch.object(files_mod, "update_dataset_status"),
        ]


class TestMergeResultsStructured(_MountFixture):
    def _write_partition(self, config, p_prefix, table, column_stats=None):
        local = Path(self.tmp) / "src.parquet"
        pq.write_table(table, local)
        dest = config.posix_path(f"{p_prefix}/data.parquet")
        dest.parent.mkdir(parents=True, exist_ok=True)
        import shutil
        shutil.copy2(str(local), str(dest))
        if column_stats is not None:
            _upload_json(config, f"{p_prefix}/column_stats.json", column_stats)

    def test_raises_when_pyiceberg_unavailable(self):
        config = _minimal_config(dataset_kind="structured")
        with mock.patch.object(files_mod, "HAS_PYICEBERG", False), \
             mock.patch.object(files_mod, "_list_partition_outputs", return_value=["p0"]), \
             mock.patch.object(files_mod, "is_manual_dataset", return_value=False):
            with self.assertRaises(RuntimeError):
                merge_results(config)

    def test_no_partitions_raises_value_error(self):
        config = _minimal_config(dataset_kind="structured")
        with mock.patch.object(files_mod, "_list_partition_outputs", return_value=[]):
            with self.assertRaises(ValueError):
                merge_results(config)

    def test_single_partition_creates_table_and_writes_result(self):
        config = _minimal_config(dataset_kind="structured")
        table = pa.table({"x": [1, 2, 3]})
        stats = {"columns": {"x": {"category": "integer", "count": 3}}}

        with mock.patch.object(files_mod, "_list_partition_outputs", return_value=["jobs/job-1/partitions/0"]), \
             mock.patch.object(files_mod, "is_manual_dataset", return_value=False), \
             mock.patch.object(files_mod, "register_table_with_pyiceberg", return_value="default.test-ds") as reg, \
             mock.patch.object(files_mod, "update_dataset_catalog_ref") as upd_ref, \
             mock.patch.object(files_mod, "update_dataset_status") as upd_status, \
             mock.patch.object(files_mod, "update_facet") as upd_facet:
            self._write_partition(config, "jobs/job-1/partitions/0", table, stats)
            result = merge_results(config)

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["rowCount"], 3)
        self.assertEqual(result["sourceFileCount"], 1)
        self.assertEqual(result["catalogTableRef"], "default.test-ds")
        reg.assert_called_once()
        self.assertFalse(reg.call_args.kwargs.get("replace_existing"))
        upd_ref.assert_called_once_with(config, "default.test-ds")
        upd_status.assert_called_once_with(config, "ready")
        upd_facet.assert_called_once()

        agg_result = _read_json(config, "jobs/job-1/aggregation/partition_result.json")
        self.assertEqual(agg_result["status"], "success")

    def test_manual_dataset_replaces_existing_table(self):
        config = _minimal_config(dataset_kind="structured")
        table = pa.table({"x": [1]})

        with mock.patch.object(files_mod, "_list_partition_outputs", return_value=["p0"]), \
             mock.patch.object(files_mod, "is_manual_dataset", return_value=True), \
             mock.patch.object(files_mod, "register_table_with_pyiceberg", return_value="ns.tbl") as reg, \
             mock.patch.object(files_mod, "update_dataset_catalog_ref"), \
             mock.patch.object(files_mod, "update_dataset_status"):
            self._write_partition(config, "p0", table)
            merge_results(config)

        self.assertTrue(reg.call_args.kwargs.get("replace_existing"))

    def test_multiple_partitions_appends_to_existing_table(self):
        config = _minimal_config(dataset_kind="structured", warehouse_id="wh")
        table0 = pa.table({"x": [1, 2]})
        table1 = pa.table({"x": [3, 4, 5]})

        iceberg_table = mock.Mock()
        catalog = mock.Mock()
        catalog.load_table.return_value = iceberg_table

        with mock.patch.object(files_mod, "_list_partition_outputs", return_value=["p0", "p1"]), \
             mock.patch.object(files_mod, "is_manual_dataset", return_value=False), \
             mock.patch.object(files_mod, "register_table_with_pyiceberg", return_value="default.test-ds"), \
             mock.patch.object(files_mod, "RestCatalog", return_value=catalog), \
             mock.patch.object(Config, "get_access_token", return_value="tok"), \
             mock.patch.object(files_mod, "update_dataset_catalog_ref"), \
             mock.patch.object(files_mod, "update_dataset_status"):
            self._write_partition(config, "p0", table0)
            self._write_partition(config, "p1", table1)
            result = merge_results(config)

        self.assertEqual(result["rowCount"], 5)
        catalog.load_table.assert_called_once_with("default.test-ds")
        iceberg_table.append.assert_called_once()

    def test_append_failure_on_later_partition_is_logged_and_swallowed(self):
        config = _minimal_config(dataset_kind="structured")
        table0 = pa.table({"x": [1]})
        table1 = pa.table({"x": [2]})

        with mock.patch.object(files_mod, "_list_partition_outputs", return_value=["p0", "p1"]), \
             mock.patch.object(files_mod, "is_manual_dataset", return_value=False), \
             mock.patch.object(files_mod, "register_table_with_pyiceberg", return_value="default.test-ds"), \
             mock.patch.object(files_mod, "RestCatalog", side_effect=RuntimeError("catalog down")), \
             mock.patch.object(Config, "get_access_token", return_value="tok"), \
             mock.patch.object(files_mod, "update_dataset_catalog_ref"), \
             mock.patch.object(files_mod, "update_dataset_status"):
            self._write_partition(config, "p0", table0)
            self._write_partition(config, "p1", table1)
            result = merge_results(config)  # must not raise despite append failure

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["rowCount"], 2)

    def test_missing_column_stats_for_some_partitions_skipped(self):
        config = _minimal_config(dataset_kind="structured")
        table = pa.table({"x": [1]})

        with mock.patch.object(files_mod, "_list_partition_outputs", return_value=["p0"]), \
             mock.patch.object(files_mod, "is_manual_dataset", return_value=False), \
             mock.patch.object(files_mod, "register_table_with_pyiceberg", return_value="ns.tbl"), \
             mock.patch.object(files_mod, "update_dataset_catalog_ref"), \
             mock.patch.object(files_mod, "update_dataset_status"), \
             mock.patch.object(files_mod, "update_facet") as upd_facet:
            self._write_partition(config, "p0", table, column_stats=None)
            merge_results(config)

        upd_facet.assert_not_called()

    def test_update_facet_failure_for_column_stats_is_swallowed(self):
        config = _minimal_config(dataset_kind="structured")
        table = pa.table({"x": [1]})
        stats = {"columns": {"x": {"category": "integer", "count": 1}}}

        with mock.patch.object(files_mod, "_list_partition_outputs", return_value=["p0"]), \
             mock.patch.object(files_mod, "is_manual_dataset", return_value=False), \
             mock.patch.object(files_mod, "register_table_with_pyiceberg", return_value="ns.tbl"), \
             mock.patch.object(files_mod, "update_dataset_catalog_ref"), \
             mock.patch.object(files_mod, "update_dataset_status"), \
             mock.patch.object(files_mod, "update_facet", side_effect=RuntimeError("facet svc down")):
            self._write_partition(config, "p0", table, column_stats=stats)
            result = merge_results(config)  # must not raise

        self.assertEqual(result["status"], "success")

    def test_cleanup_failure_after_success_is_swallowed(self):
        config = _minimal_config(dataset_kind="structured")
        table = pa.table({"x": [1]})

        with mock.patch.object(files_mod, "_list_partition_outputs", return_value=["p0"]), \
             mock.patch.object(files_mod, "is_manual_dataset", return_value=False), \
             mock.patch.object(files_mod, "register_table_with_pyiceberg", return_value="ns.tbl"), \
             mock.patch.object(files_mod, "update_dataset_catalog_ref"), \
             mock.patch.object(files_mod, "update_dataset_status"), \
             mock.patch.object(files_mod, "_cleanup_partition_artifacts", side_effect=RuntimeError("cleanup boom")):
            self._write_partition(config, "p0", table)
            result = merge_results(config)  # must not raise

        self.assertEqual(result["status"], "success")

    def test_temp_dir_cleaned_up_after_success(self):
        config = _minimal_config(dataset_kind="structured")
        table = pa.table({"x": [1]})
        with mock.patch.object(files_mod, "_list_partition_outputs", return_value=["p0"]), \
             mock.patch.object(files_mod, "is_manual_dataset", return_value=False), \
             mock.patch.object(files_mod, "register_table_with_pyiceberg", return_value="ns.tbl"), \
             mock.patch.object(files_mod, "update_dataset_catalog_ref"), \
             mock.patch.object(files_mod, "update_dataset_status"):
            self._write_partition(config, "p0", table)
            merge_results(config)
        self.assertFalse(Path("/tmp/aggregation").exists())


class TestMergeResultsUnstructured(_MountFixture):
    def _write_metadata(self, config, p_prefix, metadata):
        _upload_json(config, f"{p_prefix}/metadata.json", metadata)

    def test_no_metadata_from_any_partition_raises(self):
        config = _minimal_config(dataset_kind="unstructured")
        with mock.patch.object(files_mod, "_list_partition_outputs", return_value=["p0"]), \
             mock.patch.object(files_mod, "is_manual_dataset", return_value=False):
            with self.assertRaises(ValueError):
                merge_results(config)

    def test_row_oriented_metadata_merged_and_registered(self):
        config = _minimal_config(dataset_kind="unstructured")
        metadata = [
            {"file_name": "a.txt", "file_path": "file:///a.txt", "file_size": 10},
            {"file_name": "b.txt", "file_path": "file:///b.txt", "file_size": 20},
        ]
        with mock.patch.object(files_mod, "_list_partition_outputs", return_value=["p0"]), \
             mock.patch.object(files_mod, "is_manual_dataset", return_value=False), \
             mock.patch.object(files_mod, "register_table_with_pyiceberg", return_value="ns.tbl") as reg, \
             mock.patch.object(files_mod, "update_dataset_catalog_ref"), \
             mock.patch.object(files_mod, "update_dataset_status"), \
             mock.patch.object(files_mod, "update_facet"):
            self._write_metadata(config, "p0", metadata)
            result = merge_results(config)

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["rowCount"], 2)
        self.assertEqual(result["sourceFileCount"], 2)
        reg.assert_called_once()

    def test_legacy_column_oriented_metadata_converted_to_rows(self):
        config = _minimal_config(dataset_kind="unstructured")
        legacy_metadata = [{
            "file_name": ["a.txt", "b.txt"],
            "file_path": ["file:///a.txt", "file:///b.txt"],
            "file_size": [10, 20],
        }]
        with mock.patch.object(files_mod, "_list_partition_outputs", return_value=["p0"]), \
             mock.patch.object(files_mod, "is_manual_dataset", return_value=False), \
             mock.patch.object(files_mod, "register_table_with_pyiceberg", return_value="ns.tbl"), \
             mock.patch.object(files_mod, "update_dataset_catalog_ref"), \
             mock.patch.object(files_mod, "update_dataset_status"), \
             mock.patch.object(files_mod, "update_facet"):
            self._write_metadata(config, "p0", legacy_metadata)
            result = merge_results(config)

        self.assertEqual(result["rowCount"], 2)

    def test_multiple_partitions_metadata_concatenated(self):
        config = _minimal_config(dataset_kind="unstructured")
        with mock.patch.object(files_mod, "_list_partition_outputs", return_value=["p0", "p1"]), \
             mock.patch.object(files_mod, "is_manual_dataset", return_value=False), \
             mock.patch.object(files_mod, "register_table_with_pyiceberg", return_value="ns.tbl"), \
             mock.patch.object(files_mod, "update_dataset_catalog_ref"), \
             mock.patch.object(files_mod, "update_dataset_status"), \
             mock.patch.object(files_mod, "update_facet"):
            self._write_metadata(config, "p0", [{"file_name": "a.txt", "file_path": "x", "file_size": 1}])
            self._write_metadata(config, "p1", [{"file_name": "b.txt", "file_path": "y", "file_size": 2}])
            result = merge_results(config)

        self.assertEqual(result["sourceFileCount"], 2)

    def test_partition_metadata_read_failure_is_skipped(self):
        config = _minimal_config(dataset_kind="unstructured")
        with mock.patch.object(files_mod, "_list_partition_outputs", return_value=["p0", "p1"]), \
             mock.patch.object(files_mod, "is_manual_dataset", return_value=False), \
             mock.patch.object(files_mod, "register_table_with_pyiceberg", return_value="ns.tbl"), \
             mock.patch.object(files_mod, "update_dataset_catalog_ref"), \
             mock.patch.object(files_mod, "update_dataset_status"), \
             mock.patch.object(files_mod, "update_facet"):
            self._write_metadata(config, "p0", [{"file_name": "a.txt", "file_path": "x", "file_size": 1}])
            # p1 has no metadata.json -> _read_json raises -> logged & skipped
            result = merge_results(config)

        self.assertEqual(result["sourceFileCount"], 1)

    def test_file_stats_computed_and_stored(self):
        config = _minimal_config(dataset_kind="unstructured")
        with mock.patch.object(files_mod, "_list_partition_outputs", return_value=["p0"]), \
             mock.patch.object(files_mod, "is_manual_dataset", return_value=False), \
             mock.patch.object(files_mod, "register_table_with_pyiceberg", return_value="ns.tbl"), \
             mock.patch.object(files_mod, "update_dataset_catalog_ref"), \
             mock.patch.object(files_mod, "update_dataset_status"), \
             mock.patch.object(files_mod, "update_facet") as upd_facet:
            self._write_metadata(config, "p0", [{"file_name": "a.txt", "file_path": "x", "file_size": 1}])
            merge_results(config)

        calls = [c for c in upd_facet.call_args_list if c.args[1] == "file_stats"]
        self.assertEqual(len(calls), 1)

    def test_file_stats_failure_is_swallowed(self):
        config = _minimal_config(dataset_kind="unstructured")
        with mock.patch.object(files_mod, "_list_partition_outputs", return_value=["p0"]), \
             mock.patch.object(files_mod, "is_manual_dataset", return_value=False), \
             mock.patch.object(files_mod, "register_table_with_pyiceberg", return_value="ns.tbl"), \
             mock.patch.object(files_mod, "update_dataset_catalog_ref"), \
             mock.patch.object(files_mod, "update_dataset_status"), \
             mock.patch.object(files_mod, "update_facet"), \
             mock.patch.object(files_mod, "compute_file_stats", side_effect=RuntimeError("boom")):
            self._write_metadata(config, "p0", [{"file_name": "a.txt", "file_path": "x", "file_size": 1}])
            result = merge_results(config)  # must not raise

        self.assertEqual(result["status"], "success")

    def test_pii_disabled_by_default_omits_pii_summary(self):
        config = _minimal_config(dataset_kind="unstructured", enable_pii_analysis=False)
        with mock.patch.object(files_mod, "_list_partition_outputs", return_value=["p0"]), \
             mock.patch.object(files_mod, "is_manual_dataset", return_value=False), \
             mock.patch.object(files_mod, "register_table_with_pyiceberg", return_value="ns.tbl"), \
             mock.patch.object(files_mod, "update_dataset_catalog_ref"), \
             mock.patch.object(files_mod, "update_dataset_status"), \
             mock.patch.object(files_mod, "update_facet"), \
             mock.patch.object(files_mod, "update_dataset_pii_summary") as upd_pii:
            self._write_metadata(config, "p0", [{"file_name": "a.txt", "file_path": "x", "file_size": 1}])
            result = merge_results(config)

        self.assertNotIn("piiSummary", result)
        upd_pii.assert_not_called()

    def test_pii_enabled_computes_and_stores_summary(self):
        config = _minimal_config(dataset_kind="unstructured", enable_pii_analysis=True)
        metadata = [{
            "file_name": "a.txt", "file_path": "x", "file_size": 1,
            "has_pii": True, "pii_risk_level": "high",
        }]
        with mock.patch.object(files_mod, "_list_partition_outputs", return_value=["p0"]), \
             mock.patch.object(files_mod, "is_manual_dataset", return_value=False), \
             mock.patch.object(files_mod, "register_table_with_pyiceberg", return_value="ns.tbl"), \
             mock.patch.object(files_mod, "update_dataset_catalog_ref"), \
             mock.patch.object(files_mod, "update_dataset_status"), \
             mock.patch.object(files_mod, "update_facet") as upd_facet, \
             mock.patch.object(files_mod, "update_dataset_pii_summary") as upd_pii, \
             mock.patch.object(files_mod, "write_pii_details") as write_pii:
            self._write_metadata(config, "p0", metadata)
            result = merge_results(config)

        self.assertIn("piiSummary", result)
        self.assertEqual(result["piiSummary"]["filesWithHighRisk"], 1)
        upd_pii.assert_called_once()
        write_pii.assert_called_once()
        pii_facet_calls = [c for c in upd_facet.call_args_list if c.args[1] == "pii"]
        self.assertEqual(len(pii_facet_calls), 1)

    def test_pii_enabled_but_summary_falsy_skips_update_calls(self):
        # `_cast_unstructured_table_to_schema` always produces a `has_pii` column
        # (nulls if absent from source data), so `_compute_pii_summary` in the
        # real flow never returns None; simulate the "no PII columns" case
        # directly via a falsy summary to exercise the `if pii_summary:` guard.
        config = _minimal_config(dataset_kind="unstructured", enable_pii_analysis=True)
        metadata = [{"file_name": "a.txt", "file_path": "x", "file_size": 1}]
        with mock.patch.object(files_mod, "_list_partition_outputs", return_value=["p0"]), \
             mock.patch.object(files_mod, "is_manual_dataset", return_value=False), \
             mock.patch.object(files_mod, "register_table_with_pyiceberg", return_value="ns.tbl"), \
             mock.patch.object(files_mod, "update_dataset_catalog_ref"), \
             mock.patch.object(files_mod, "update_dataset_status"), \
             mock.patch.object(files_mod, "update_facet"), \
             mock.patch.object(files_mod, "_compute_pii_summary", return_value=None), \
             mock.patch.object(files_mod, "update_dataset_pii_summary") as upd_pii:
            self._write_metadata(config, "p0", metadata)
            result = merge_results(config)

        self.assertNotIn("piiSummary", result)
        upd_pii.assert_not_called()

    def test_write_pii_details_failure_is_swallowed(self):
        config = _minimal_config(dataset_kind="unstructured", enable_pii_analysis=True)
        metadata = [{
            "file_name": "a.txt", "file_path": "x", "file_size": 1,
            "has_pii": True, "pii_risk_level": "high",
        }]
        with mock.patch.object(files_mod, "_list_partition_outputs", return_value=["p0"]), \
             mock.patch.object(files_mod, "is_manual_dataset", return_value=False), \
             mock.patch.object(files_mod, "register_table_with_pyiceberg", return_value="ns.tbl"), \
             mock.patch.object(files_mod, "update_dataset_catalog_ref"), \
             mock.patch.object(files_mod, "update_dataset_status"), \
             mock.patch.object(files_mod, "update_facet"), \
             mock.patch.object(files_mod, "update_dataset_pii_summary"), \
             mock.patch.object(files_mod, "write_pii_details", side_effect=RuntimeError("boom")):
            self._write_metadata(config, "p0", metadata)
            result = merge_results(config)  # must not raise

        self.assertEqual(result["status"], "success")


class TestMergeResultsErrorHandling(_MountFixture):
    def test_exception_writes_error_result_and_reraises(self):
        config = _minimal_config(dataset_kind="structured")
        with mock.patch.object(files_mod, "_list_partition_outputs", side_effect=RuntimeError("catalog listing failed")):
            with self.assertRaises(RuntimeError):
                merge_results(config)

        error_result = _read_json(config, "jobs/job-1/aggregation/partition_result.json")
        self.assertEqual(error_result["status"], "error")
        self.assertIn("catalog listing failed", error_result["error"])

    def test_error_result_upload_failure_is_swallowed_and_original_raised(self):
        config = _minimal_config(dataset_kind="structured")

        def fail_on_error_result(cfg, key, data):
            if "aggregation/partition_result" in key:
                raise RuntimeError("upload failed too")

        with mock.patch.object(files_mod, "_list_partition_outputs", side_effect=RuntimeError("boom")), \
             mock.patch.object(files_mod, "_upload_json", side_effect=fail_on_error_result):
            with self.assertRaises(RuntimeError) as ctx:
                merge_results(config)
        self.assertEqual(str(ctx.exception), "boom")

    def test_temp_dir_cleaned_up_after_failure(self):
        config = _minimal_config(dataset_kind="structured")
        with mock.patch.object(files_mod, "_list_partition_outputs", side_effect=RuntimeError("boom")):
            with self.assertRaises(RuntimeError):
                merge_results(config)
        self.assertFalse(Path("/tmp/aggregation").exists())


if __name__ == "__main__":
    unittest.main()
