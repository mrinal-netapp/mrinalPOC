"""Unit tests for processing/pii.py — reprocess_pii, reprocess_pii_file_set, merge_pii_results.

The Iceberg catalog/table and the underlying PII analyzers are mocked so these
tests exercise the reprocessing *orchestration* (row iteration, schema
evolution, POSIX fallback, heartbeats, summary computation) without needing a
real Lakekeeper/Presidio deployment.
"""

import builtins
import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import pyarrow as pa
import pytest

pytest.importorskip("pyiceberg")

import processing.pii as pii_mod
from processing.config import Config
from processing.pii import (
    _resolve_posix_fallback,
    merge_pii_results,
    reprocess_pii,
    reprocess_pii_file_set,
)


class TestHasPyicebergImportGuard(unittest.TestCase):
    def test_module_sets_has_pyiceberg_false_when_import_fails(self):
        """Simulates `pyiceberg` being unavailable at import time (lines 31-36)."""
        real_import = builtins.__import__

        def _fake_import(name, *args, **kwargs):
            if name == "pyiceberg.catalog.rest" or name.startswith("pyiceberg"):
                raise ImportError(f"No module named '{name}'")
            return real_import(name, *args, **kwargs)

        with mock.patch.object(builtins, "__import__", side_effect=_fake_import):
            reloaded = importlib.reload(pii_mod)

        try:
            self.assertFalse(reloaded.HAS_PYICEBERG)
        finally:
            # Restore the real module state for subsequent tests in this file.
            importlib.reload(pii_mod)


def _minimal_config(**overrides) -> Config:
    base = dict(
        dataset_id="ds-1",
        dataset_name="my-dataset",
        dataset_kind="unstructured",
        project_id="proj-1",
        bucket_name="bucket-1",
        namespace="ns1",
        lakekeeper_url="http://lakekeeper:8181",
        keycloak_internal_issuer="http://keycloak/realms/nemo",
        project_client_id="client-1",
        project_client_secret="secret-1",
        warehouse_id="wh-1",
        s3_endpoint="http://s3gateway:7070",
        aws_access_key_id="AKIA",
        aws_secret_access_key="secret",
        workflow_id="wf-1",
    )
    base.update(overrides)
    return Config(**base)


def _make_mock_iceberg_table(existing_data: pa.Table, field_names):
    """Build a MagicMock Iceberg table whose scan()/schema()/update_schema() behave realistically."""
    table = mock.MagicMock()
    table.scan.return_value.to_arrow.return_value = existing_data

    fields = []
    for name in field_names:
        f = mock.Mock()
        f.name = name
        fields.append(f)
    table.schema.return_value.fields = fields

    schema_update_cm = mock.MagicMock()
    table.update_schema.return_value.__enter__.return_value = schema_update_cm
    table.update_schema.return_value.__exit__.return_value = False

    table.io.properties = {}
    return table, schema_update_cm


class TestResolvePosixFallback(unittest.TestCase):
    """Already partially covered elsewhere; keep a couple of direct sanity checks here."""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)

    def test_returns_none_without_dataset_id(self):
        config = _minimal_config(dataset_id="")
        self.assertIsNone(_resolve_posix_fallback(self._td.name, config, "f.txt"))

    def test_finds_nested_file(self):
        config = _minimal_config()
        data_dir = Path(self._td.name) / "datasets" / "ds-1" / "data_files" / "sub"
        data_dir.mkdir(parents=True)
        (data_dir / "f.txt").write_text("hello")
        found = _resolve_posix_fallback(self._td.name, config, "f.txt")
        self.assertEqual(found, data_dir / "f.txt")

    def test_returns_none_when_walk_does_not_find_file(self):
        config = _minimal_config()
        data_dir = Path(self._td.name) / "datasets" / "ds-1" / "data_files" / "sub"
        data_dir.mkdir(parents=True)
        (data_dir / "other.txt").write_text("hello")
        found = _resolve_posix_fallback(self._td.name, config, "missing.txt")
        self.assertIsNone(found)


class TestReprocessPii(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        patcher = mock.patch.dict(os.environ, {"NEMO_DEFAULT_STORE_ROOT": self._td.name})
        patcher.start()
        self.addCleanup(patcher.stop)

    def _patch_common(self, *, catalog, run_pii_analysis=None):
        patches = [
            mock.patch.object(pii_mod, "HAS_PYICEBERG", True),
            mock.patch.object(pii_mod, "RestCatalog", create=True, return_value=catalog),
            mock.patch.object(Config, "get_access_token", return_value="tok"),
            mock.patch.object(pii_mod, "_configure_table_io_for_static_credentials"),
            mock.patch.object(pii_mod, "write_pii_details"),
            mock.patch.object(pii_mod, "write_processing_result"),
            mock.patch.object(pii_mod, "update_dataset_status"),
            mock.patch.object(pii_mod, "update_dataset_pii_summary"),
            mock.patch.object(pii_mod, "update_facet"),
        ]
        if run_pii_analysis is not None:
            patches.append(mock.patch.object(pii_mod, "_run_pii_analysis", side_effect=run_pii_analysis))
        started = [p.start() for p in patches]
        for p in patches:
            self.addCleanup(p.stop)
        return started

    def test_no_pyiceberg_raises_runtime_error(self):
        config = _minimal_config()
        with mock.patch.object(pii_mod, "HAS_PYICEBERG", False):
            with self.assertRaises(RuntimeError):
                reprocess_pii(config)

    def test_empty_table_returns_early_and_marks_ready(self):
        config = _minimal_config()
        empty_table = pa.table({"file_path": pa.array([], type=pa.string())})
        table, _ = _make_mock_iceberg_table(empty_table, ["file_path"])
        catalog = mock.MagicMock()
        catalog.load_table.return_value = table
        mocks = self._patch_common(catalog=catalog)

        result = reprocess_pii(config)

        self.assertEqual(result, {"status": "success", "rowCount": 0, "message": "no rows to reprocess"})
        pii_mod.update_dataset_status.assert_called_once_with(config, "ready")
        table.overwrite.assert_not_called()

    def test_happy_path_updates_pii_columns_and_overwrites_table(self):
        config = _minimal_config()
        data_dir = Path(self._td.name) / "datasets" / "ds-1" / "data_files"
        data_dir.mkdir(parents=True)
        (data_dir / "a.txt").write_text("has ssn 123-45-6789")
        (data_dir / "b.txt").write_text("nothing interesting")

        existing_data = pa.table({
            "file_path": [f"file://{data_dir / 'a.txt'}", f"file://{data_dir / 'b.txt'}"],
            "file_name": ["a.txt", "b.txt"],
            "mime_type": ["text/plain", "text/plain"],
            "extension": [".txt", ".txt"],
        })
        table, schema_update = _make_mock_iceberg_table(existing_data, ["file_path", "file_name", "mime_type", "extension"])
        catalog = mock.MagicMock()
        catalog.load_table.return_value = table

        def _fake_pii(config, local_path, mime_type, extension, heartbeat_fn=None):
            if local_path.name == "a.txt":
                return {
                    "pii_entities": json.dumps(["US_SSN"]),
                    "pii_count": 1,
                    "sensitivity_class": "unknown",
                    "has_pii": True,
                    "pii_risk_level": "high",
                }
            return {
                "pii_entities": None,
                "pii_count": 0,
                "sensitivity_class": "unknown",
                "has_pii": False,
                "pii_risk_level": "none",
            }

        self._patch_common(catalog=catalog, run_pii_analysis=_fake_pii)

        result = reprocess_pii(config)

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["rowCount"], 2)
        table.overwrite.assert_called_once()
        overwritten = table.overwrite.call_args.args[0]
        self.assertIn("pii_entities", overwritten.column_names)
        self.assertEqual(overwritten.column("has_pii").to_pylist(), [True, False])
        self.assertEqual(overwritten.column("pii_risk_level").to_pylist(), ["high", "none"])

        pii_mod.update_dataset_pii_summary.assert_called_once()
        summary = pii_mod.update_dataset_pii_summary.call_args.args[1]
        self.assertEqual(summary["filesWithPii"], 1)
        self.assertEqual(summary["filesWithHighRisk"], 1)
        pii_mod.update_facet.assert_called_once()
        pii_mod.write_processing_result.assert_called_once()

    def test_missing_file_path_defaults_to_none_without_analysis(self):
        config = _minimal_config()
        existing_data = pa.table({
            "file_path": pa.array([None], type=pa.string()),
            "file_name": ["unknown"],
            "mime_type": [""],
            "extension": [""],
        })
        table, _ = _make_mock_iceberg_table(existing_data, ["file_path", "file_name", "mime_type", "extension"])
        catalog = mock.MagicMock()
        catalog.load_table.return_value = table

        run_pii = mock.Mock()
        self._patch_common(catalog=catalog, run_pii_analysis=run_pii)

        result = reprocess_pii(config)

        run_pii.assert_not_called()
        self.assertEqual(result["rowCount"], 1)
        overwritten = table.overwrite.call_args.args[0]
        self.assertEqual(overwritten.column("sensitivity_class").to_pylist(), ["unknown"])
        self.assertEqual(overwritten.column("pii_risk_level").to_pylist(), ["none"])

    def test_uses_posix_fallback_when_file_uri_path_missing(self):
        config = _minimal_config()
        data_dir = Path(self._td.name) / "datasets" / "ds-1" / "data_files"
        data_dir.mkdir(parents=True)
        (data_dir / "a.txt").write_text("hello")

        # file_path points to a *non-existent* absolute path; fallback should
        # locate a.txt on the POSIX mount by file name.
        existing_data = pa.table({
            "file_path": ["file:///no/such/path/a.txt"],
            "file_name": ["a.txt"],
            "mime_type": ["text/plain"],
            "extension": [".txt"],
        })
        table, _ = _make_mock_iceberg_table(existing_data, ["file_path", "file_name", "mime_type", "extension"])
        catalog = mock.MagicMock()
        catalog.load_table.return_value = table

        run_pii = mock.Mock(return_value={
            "pii_entities": None, "pii_count": 0, "sensitivity_class": "unknown",
            "has_pii": False, "pii_risk_level": "none",
        })
        self._patch_common(catalog=catalog, run_pii_analysis=run_pii)

        result = reprocess_pii(config)

        run_pii.assert_called_once()
        self.assertEqual(result["rowCount"], 1)

    def test_per_row_failure_does_not_abort_whole_run(self):
        config = _minimal_config()
        data_dir = Path(self._td.name) / "datasets" / "ds-1" / "data_files"
        data_dir.mkdir(parents=True)
        (data_dir / "a.txt").write_text("x")
        (data_dir / "b.txt").write_text("y")

        existing_data = pa.table({
            "file_path": [f"file://{data_dir / 'a.txt'}", f"file://{data_dir / 'b.txt'}"],
            "file_name": ["a.txt", "b.txt"],
            "mime_type": ["text/plain", "text/plain"],
            "extension": [".txt", ".txt"],
        })
        table, _ = _make_mock_iceberg_table(existing_data, ["file_path", "file_name", "mime_type", "extension"])
        catalog = mock.MagicMock()
        catalog.load_table.return_value = table

        def _fake_pii(config, local_path, mime_type, extension, heartbeat_fn=None):
            if local_path.name == "a.txt":
                raise RuntimeError("analyzer crashed")
            return {
                "pii_entities": None, "pii_count": 0, "sensitivity_class": "unknown",
                "has_pii": False, "pii_risk_level": "none",
            }

        self._patch_common(catalog=catalog, run_pii_analysis=_fake_pii)

        result = reprocess_pii(config)

        # The failing row degrades to defaults; the run still completes successfully.
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["rowCount"], 2)
        overwritten = table.overwrite.call_args.args[0]
        self.assertEqual(overwritten.column("has_pii").to_pylist(), [None, False])

    def test_schema_evolution_adds_missing_pii_columns(self):
        config = _minimal_config()
        existing_data = pa.table({
            "file_path": pa.array([None], type=pa.string()),
            "file_name": ["unknown"],
            "mime_type": [""],
            "extension": [""],
        })
        # None of the PII columns exist yet on the table schema.
        table, schema_update = _make_mock_iceberg_table(
            existing_data, ["file_path", "file_name", "mime_type", "extension"]
        )
        catalog = mock.MagicMock()
        catalog.load_table.return_value = table
        self._patch_common(catalog=catalog, run_pii_analysis=mock.Mock())

        reprocess_pii(config)

        table.update_schema.assert_called_once()
        added_names = [c.args[0] for c in schema_update.add_column.call_args_list]
        self.assertEqual(
            set(added_names),
            {"pii_entities", "pii_count", "sensitivity_class", "has_pii", "pii_risk_level"},
        )
        table.refresh.assert_called_once()

    def test_heartbeat_and_workflow_progress_callbacks_invoked(self):
        config = _minimal_config()
        data_dir = Path(self._td.name) / "datasets" / "ds-1" / "data_files"
        data_dir.mkdir(parents=True)
        rows = 60
        for i in range(rows):
            (data_dir / f"f{i}.txt").write_text("x")
        existing_data = pa.table({
            "file_path": [f"file://{data_dir / f'f{i}.txt'}" for i in range(rows)],
            "file_name": [f"f{i}.txt" for i in range(rows)],
            "mime_type": ["text/plain"] * rows,
            "extension": [".txt"] * rows,
        })
        table, _ = _make_mock_iceberg_table(existing_data, ["file_path", "file_name", "mime_type", "extension"])
        catalog = mock.MagicMock()
        catalog.load_table.return_value = table
        self._patch_common(
            catalog=catalog,
            run_pii_analysis=mock.Mock(return_value={
                "pii_entities": None, "pii_count": 0, "sensitivity_class": "unknown",
                "has_pii": False, "pii_risk_level": "none",
            }),
        )

        heartbeats = []
        progress_calls = []
        reprocess_pii(
            config,
            heartbeat_callback=heartbeats.append,
            workflow_progress_callback=lambda *a: progress_calls.append(a),
        )

        # 60 rows at a 50-row interval -> exactly one heartbeat/progress call.
        self.assertEqual(len(heartbeats), 1)
        self.assertEqual(len(progress_calls), 1)
        self.assertEqual(progress_calls[0][0], "pii_analysis")

    def test_heartbeat_callback_exception_is_swallowed(self):
        config = self._sixty_row_setup()
        reprocess_pii(config, heartbeat_callback=mock.Mock(side_effect=RuntimeError("hb boom")))
        # No exception propagates even though the heartbeat callback raises.

    def test_workflow_progress_callback_exception_is_swallowed(self):
        config = self._sixty_row_setup()
        reprocess_pii(
            config,
            workflow_progress_callback=mock.Mock(side_effect=RuntimeError("progress boom")),
        )
        # No exception propagates even though the workflow progress callback raises.

    def _sixty_row_setup(self):
        config = _minimal_config()
        data_dir = Path(self._td.name) / "datasets" / "ds-1" / "data_files"
        data_dir.mkdir(parents=True)
        rows = 60
        for i in range(rows):
            (data_dir / f"f{i}.txt").write_text("x")
        existing_data = pa.table({
            "file_path": [f"file://{data_dir / f'f{i}.txt'}" for i in range(rows)],
            "file_name": [f"f{i}.txt" for i in range(rows)],
            "mime_type": ["text/plain"] * rows,
            "extension": [".txt"] * rows,
        })
        table, _ = _make_mock_iceberg_table(existing_data, ["file_path", "file_name", "mime_type", "extension"])
        catalog = mock.MagicMock()
        catalog.load_table.return_value = table
        self._patch_common(
            catalog=catalog,
            run_pii_analysis=mock.Mock(return_value={
                "pii_entities": None, "pii_count": 0, "sensitivity_class": "unknown",
                "has_pii": False, "pii_risk_level": "none",
            }),
        )
        return config

    def test_no_local_file_and_no_fallback_raises_and_is_caught_per_row(self):
        # file:// path doesn't exist locally and there's no POSIX mount fallback
        # match -> FileNotFoundError is raised internally and caught per-row.
        config = _minimal_config()
        existing_data = pa.table({
            "file_path": ["file:///no/such/path/missing.txt"],
            "file_name": ["missing.txt"],
            "mime_type": ["text/plain"],
            "extension": [".txt"],
        })
        table, _ = _make_mock_iceberg_table(existing_data, ["file_path", "file_name", "mime_type", "extension"])
        catalog = mock.MagicMock()
        catalog.load_table.return_value = table
        run_pii = mock.Mock()
        self._patch_common(catalog=catalog, run_pii_analysis=run_pii)

        result = reprocess_pii(config)

        run_pii.assert_not_called()
        self.assertEqual(result["rowCount"], 1)
        overwritten = table.overwrite.call_args.args[0]
        self.assertEqual(overwritten.column("has_pii").to_pylist(), [None])

    def test_s3_uri_file_path_downloads_via_download_file(self):
        config = _minimal_config()
        existing_data = pa.table({
            "file_path": ["s3://my-bucket/datasets/ds-1/data_files/a.txt"],
            "file_name": ["a.txt"],
            "mime_type": ["text/plain"],
            "extension": [".txt"],
        })
        table, _ = _make_mock_iceberg_table(existing_data, ["file_path", "file_name", "mime_type", "extension"])
        catalog = mock.MagicMock()
        catalog.load_table.return_value = table
        self._patch_common(
            catalog=catalog,
            run_pii_analysis=mock.Mock(return_value={
                "pii_entities": None, "pii_count": 0, "sensitivity_class": "unknown",
                "has_pii": False, "pii_risk_level": "none",
            }),
        )

        with mock.patch.object(pii_mod, "download_file") as mock_download:
            result = reprocess_pii(config)

        mock_download.assert_called_once()
        called_key = mock_download.call_args.args[1]
        self.assertEqual(called_key, "datasets/ds-1/data_files/a.txt")
        self.assertEqual(result["rowCount"], 1)

    def test_bare_key_file_path_downloads_via_download_file(self):
        config = _minimal_config()
        existing_data = pa.table({
            "file_path": ["datasets/ds-1/data_files/a.txt"],
            "file_name": ["a.txt"],
            "mime_type": ["text/plain"],
            "extension": [".txt"],
        })
        table, _ = _make_mock_iceberg_table(existing_data, ["file_path", "file_name", "mime_type", "extension"])
        catalog = mock.MagicMock()
        catalog.load_table.return_value = table
        self._patch_common(
            catalog=catalog,
            run_pii_analysis=mock.Mock(return_value={
                "pii_entities": None, "pii_count": 0, "sensitivity_class": "unknown",
                "has_pii": False, "pii_risk_level": "none",
            }),
        )

        with mock.patch.object(pii_mod, "download_file") as mock_download:
            result = reprocess_pii(config)

        mock_download.assert_called_once()
        called_key = mock_download.call_args.args[1]
        self.assertEqual(called_key, "datasets/ds-1/data_files/a.txt")
        self.assertEqual(result["rowCount"], 1)


class TestReprocessPiiFileSet(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        patcher = mock.patch.dict(os.environ, {"NEMO_DEFAULT_STORE_ROOT": self._td.name})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_raises_when_mount_not_set(self):
        config = _minimal_config(manifest_s3_key="jobs/j1/partitions/s0/manifest.json", output_prefix="jobs/j1/partitions/s0")
        with mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(RuntimeError):
                reprocess_pii_file_set(config)

    def _write_manifest(self, entries):
        manifest_key = "jobs/j1/partitions/s0/manifest.json"
        manifest_path = Path(self._td.name) / manifest_key
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps({"files": entries}))
        return manifest_key

    def test_happy_path_writes_pii_results_json(self):
        data_dir = Path(self._td.name) / "datasets" / "ds-1" / "data_files"
        data_dir.mkdir(parents=True)
        (data_dir / "a.txt").write_text("hello")

        manifest_key = self._write_manifest([
            {"key": f"file://{data_dir / 'a.txt'}", "metadata": {"file_name": "a.txt", "mime_type": "text/plain", "extension": ".txt"}}
        ])
        config = _minimal_config(
            manifest_s3_key=manifest_key,
            output_prefix="jobs/j1/partitions/s0",
            set_id="s0",
        )

        with mock.patch.object(
            pii_mod, "_run_pii_analysis",
            return_value={"pii_entities": None, "pii_count": 0, "sensitivity_class": "unknown", "has_pii": False, "pii_risk_level": "none"},
        ):
            result = reprocess_pii_file_set(config)

        self.assertEqual(result, {"setId": "s0", "status": "success", "fileCount": 1})
        results_path = Path(self._td.name) / "jobs/j1/partitions/s0/pii_results.json"
        self.assertTrue(results_path.is_file())
        results = json.loads(results_path.read_text())
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["has_pii"], False)

    def test_skips_entries_with_empty_file_path(self):
        manifest_key = self._write_manifest([{"key": "", "metadata": {}}])
        config = _minimal_config(manifest_s3_key=manifest_key, output_prefix="jobs/j1/partitions/s0", set_id="s0")

        run_pii = mock.Mock()
        with mock.patch.object(pii_mod, "_run_pii_analysis", run_pii):
            result = reprocess_pii_file_set(config)

        run_pii.assert_not_called()
        self.assertEqual(result["fileCount"], 0)

    def test_per_file_failure_recorded_but_does_not_raise(self):
        data_dir = Path(self._td.name) / "datasets" / "ds-1" / "data_files"
        data_dir.mkdir(parents=True)
        (data_dir / "a.txt").write_text("hello")
        manifest_key = self._write_manifest([
            {"key": f"file://{data_dir / 'a.txt'}", "metadata": {"file_name": "a.txt"}}
        ])
        config = _minimal_config(manifest_s3_key=manifest_key, output_prefix="jobs/j1/partitions/s0", set_id="s0")

        with mock.patch.object(pii_mod, "_run_pii_analysis", side_effect=RuntimeError("boom")):
            result = reprocess_pii_file_set(config)

        self.assertEqual(result["status"], "success")
        self.assertEqual(result["fileCount"], 1)
        results = json.loads((Path(self._td.name) / "jobs/j1/partitions/s0/pii_results.json").read_text())
        self.assertEqual(results[0]["has_pii"], None)
        self.assertEqual(results[0]["pii_risk_level"], "none")

    def test_posix_fallback_used_when_file_uri_path_missing(self):
        data_dir = Path(self._td.name) / "datasets" / "ds-1" / "data_files"
        data_dir.mkdir(parents=True)
        (data_dir / "a.txt").write_text("hello")
        manifest_key = self._write_manifest([
            {"key": "file:///no/such/path/a.txt", "metadata": {"file_name": "a.txt"}}
        ])
        config = _minimal_config(manifest_s3_key=manifest_key, output_prefix="jobs/j1/partitions/s0", set_id="s0")

        run_pii = mock.Mock(return_value={
            "pii_entities": None, "pii_count": 0, "sensitivity_class": "unknown",
            "has_pii": False, "pii_risk_level": "none",
        })
        with mock.patch.object(pii_mod, "_run_pii_analysis", run_pii):
            result = reprocess_pii_file_set(config)

        run_pii.assert_called_once()
        self.assertEqual(result["fileCount"], 1)

    def test_no_local_file_and_no_fallback_raises_and_is_caught(self):
        manifest_key = self._write_manifest([
            {"key": "file:///no/such/path/missing.txt", "metadata": {"file_name": "missing.txt"}}
        ])
        config = _minimal_config(manifest_s3_key=manifest_key, output_prefix="jobs/j1/partitions/s0", set_id="s0")

        run_pii = mock.Mock()
        with mock.patch.object(pii_mod, "_run_pii_analysis", run_pii):
            result = reprocess_pii_file_set(config)

        run_pii.assert_not_called()
        self.assertEqual(result["fileCount"], 1)
        results = json.loads((Path(self._td.name) / "jobs/j1/partitions/s0/pii_results.json").read_text())
        self.assertEqual(results[0]["has_pii"], None)

    def test_s3_uri_downloads_via_download_file(self):
        manifest_key = self._write_manifest([
            {"key": "s3://my-bucket/datasets/ds-1/data_files/a.txt", "metadata": {"file_name": "a.txt"}}
        ])
        config = _minimal_config(manifest_s3_key=manifest_key, output_prefix="jobs/j1/partitions/s0", set_id="s0")

        with mock.patch.object(pii_mod, "download_file") as mock_download, \
             mock.patch.object(pii_mod, "_run_pii_analysis", return_value={
                 "pii_entities": None, "pii_count": 0, "sensitivity_class": "unknown",
                 "has_pii": False, "pii_risk_level": "none",
             }):
            result = reprocess_pii_file_set(config)

        mock_download.assert_called_once()
        self.assertEqual(mock_download.call_args.args[1], "datasets/ds-1/data_files/a.txt")
        self.assertEqual(result["fileCount"], 1)

    def test_bare_key_downloads_via_download_file(self):
        manifest_key = self._write_manifest([
            {"key": "datasets/ds-1/data_files/a.txt", "metadata": {"file_name": "a.txt"}}
        ])
        config = _minimal_config(manifest_s3_key=manifest_key, output_prefix="jobs/j1/partitions/s0", set_id="s0")

        with mock.patch.object(pii_mod, "download_file") as mock_download, \
             mock.patch.object(pii_mod, "_run_pii_analysis", return_value={
                 "pii_entities": None, "pii_count": 0, "sensitivity_class": "unknown",
                 "has_pii": False, "pii_risk_level": "none",
             }):
            result = reprocess_pii_file_set(config)

        mock_download.assert_called_once()
        self.assertEqual(mock_download.call_args.args[1], "datasets/ds-1/data_files/a.txt")
        self.assertEqual(result["fileCount"], 1)

    def test_heartbeat_callback_exception_is_swallowed(self):
        data_dir = Path(self._td.name) / "datasets" / "ds-1" / "data_files"
        data_dir.mkdir(parents=True)
        entries = []
        for i in range(51):
            (data_dir / f"f{i}.txt").write_text("x")
            entries.append({"key": f"file://{data_dir / f'f{i}.txt'}", "metadata": {"file_name": f"f{i}.txt"}})
        manifest_key = self._write_manifest(entries)
        config = _minimal_config(manifest_s3_key=manifest_key, output_prefix="jobs/j1/partitions/s0", set_id="s0")

        with mock.patch.object(pii_mod, "_run_pii_analysis", return_value={
            "pii_entities": None, "pii_count": 0, "sensitivity_class": "unknown",
            "has_pii": False, "pii_risk_level": "none",
        }):
            result = reprocess_pii_file_set(
                config, heartbeat_callback=mock.Mock(side_effect=RuntimeError("hb boom"))
            )

        # Heartbeat exception swallowed; processing still completes for all 51 files.
        self.assertEqual(result["fileCount"], 51)


class TestMergePiiResults(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        patcher = mock.patch.dict(os.environ, {"NEMO_DEFAULT_STORE_ROOT": self._td.name})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_raises_when_mount_not_set(self):
        config = _minimal_config(job_output_prefix="jobs/j1")
        with mock.patch.dict(os.environ, {}, clear=True), \
             mock.patch.object(pii_mod, "HAS_PYICEBERG", True):
            with self.assertRaises(RuntimeError):
                merge_pii_results(config)

    def test_no_pyiceberg_raises(self):
        config = _minimal_config(job_output_prefix="jobs/j1")
        with mock.patch.object(pii_mod, "HAS_PYICEBERG", False):
            with self.assertRaises(RuntimeError):
                merge_pii_results(config)

    def _write_partition_results(self, job_prefix: str, set_id: str, entries):
        p = Path(self._td.name) / job_prefix / "partitions" / set_id / "pii_results.json"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(entries))

    def test_merges_partitions_and_overwrites_iceberg_table(self):
        config = _minimal_config(job_output_prefix="jobs/j1")
        self._write_partition_results("jobs/j1", "s0", [
            {"file_path": "a.txt", "pii_entities": '["US_SSN"]', "pii_count": 1, "sensitivity_class": "unknown", "has_pii": True, "pii_risk_level": "high"},
        ])
        self._write_partition_results("jobs/j1", "s1", [
            {"file_path": "b.txt", "pii_entities": None, "pii_count": 0, "sensitivity_class": "unknown", "has_pii": False, "pii_risk_level": "none"},
        ])

        existing_data = pa.table({"file_path": ["a.txt", "b.txt", "c.txt"]})
        table, schema_update = _make_mock_iceberg_table(existing_data, ["file_path"])
        catalog = mock.MagicMock()
        catalog.load_table.return_value = table

        with mock.patch.object(pii_mod, "HAS_PYICEBERG", True), \
             mock.patch.object(pii_mod, "RestCatalog", create=True, return_value=catalog), \
             mock.patch.object(Config, "get_access_token", return_value="tok"), \
             mock.patch.object(pii_mod, "_configure_table_io_for_static_credentials"), \
             mock.patch.object(pii_mod, "write_pii_details"), \
             mock.patch.object(pii_mod, "update_dataset_pii_summary") as mock_summary, \
             mock.patch.object(pii_mod, "update_facet") as mock_facet:
            result = merge_pii_results(config)

        table.overwrite.assert_called_once()
        overwritten = table.overwrite.call_args.args[0]
        self.assertEqual(overwritten.column("has_pii").to_pylist(), [True, False, None])
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["rowCount"], 3)
        mock_summary.assert_called_once()
        mock_facet.assert_called_once()

    def test_partition_dir_without_results_file_is_skipped(self):
        config = _minimal_config(job_output_prefix="jobs/j1")
        # s0 has a valid pii_results.json; s1 exists but has no results file yet.
        self._write_partition_results("jobs/j1", "s0", [
            {"file_path": "a.txt", "pii_entities": None, "pii_count": 0, "sensitivity_class": "unknown", "has_pii": True, "pii_risk_level": "high"},
        ])
        (Path(self._td.name) / "jobs/j1" / "partitions" / "s1").mkdir(parents=True)

        existing_data = pa.table({"file_path": ["a.txt"]})
        table, _ = _make_mock_iceberg_table(existing_data, ["file_path"])
        catalog = mock.MagicMock()
        catalog.load_table.return_value = table

        with mock.patch.object(pii_mod, "HAS_PYICEBERG", True), \
             mock.patch.object(pii_mod, "RestCatalog", create=True, return_value=catalog), \
             mock.patch.object(Config, "get_access_token", return_value="tok"), \
             mock.patch.object(pii_mod, "_configure_table_io_for_static_credentials"), \
             mock.patch.object(pii_mod, "write_pii_details"), \
             mock.patch.object(pii_mod, "update_dataset_pii_summary"), \
             mock.patch.object(pii_mod, "update_facet"):
            result = merge_pii_results(config)

        self.assertEqual(result["rowCount"], 1)
        overwritten = table.overwrite.call_args.args[0]
        self.assertEqual(overwritten.column("has_pii").to_pylist(), [True])

    def test_no_partitions_dir_still_overwrites_with_all_defaults(self):
        config = _minimal_config(job_output_prefix="jobs/j1")
        existing_data = pa.table({"file_path": ["a.txt"]})
        table, _ = _make_mock_iceberg_table(existing_data, ["file_path"])
        catalog = mock.MagicMock()
        catalog.load_table.return_value = table

        with mock.patch.object(pii_mod, "HAS_PYICEBERG", True), \
             mock.patch.object(pii_mod, "RestCatalog", create=True, return_value=catalog), \
             mock.patch.object(Config, "get_access_token", return_value="tok"), \
             mock.patch.object(pii_mod, "_configure_table_io_for_static_credentials"), \
             mock.patch.object(pii_mod, "write_pii_details"), \
             mock.patch.object(pii_mod, "update_dataset_pii_summary"), \
             mock.patch.object(pii_mod, "update_facet"):
            result = merge_pii_results(config)

        self.assertEqual(result["rowCount"], 1)
        overwritten = table.overwrite.call_args.args[0]
        self.assertEqual(overwritten.column("has_pii").to_pylist(), [None])

    def test_empty_iceberg_table_returns_early(self):
        config = _minimal_config(job_output_prefix="jobs/j1")
        existing_data = pa.table({"file_path": pa.array([], type=pa.string())})
        table, _ = _make_mock_iceberg_table(existing_data, ["file_path"])
        catalog = mock.MagicMock()
        catalog.load_table.return_value = table

        with mock.patch.object(pii_mod, "HAS_PYICEBERG", True), \
             mock.patch.object(pii_mod, "RestCatalog", create=True, return_value=catalog), \
             mock.patch.object(Config, "get_access_token", return_value="tok"), \
             mock.patch.object(pii_mod, "_configure_table_io_for_static_credentials"):
            result = merge_pii_results(config)

        self.assertEqual(result, {"status": "success", "rowCount": 0, "message": "no rows to update"})
        table.overwrite.assert_not_called()

    def test_heartbeat_callback_invoked_at_each_phase_and_exceptions_swallowed(self):
        config = _minimal_config(job_output_prefix="jobs/j1")
        existing_data = pa.table({"file_path": ["a.txt"]})
        table, _ = _make_mock_iceberg_table(existing_data, ["file_path"])
        catalog = mock.MagicMock()
        catalog.load_table.return_value = table

        heartbeat = mock.Mock(side_effect=RuntimeError("hb boom"))

        with mock.patch.object(pii_mod, "HAS_PYICEBERG", True), \
             mock.patch.object(pii_mod, "RestCatalog", create=True, return_value=catalog), \
             mock.patch.object(Config, "get_access_token", return_value="tok"), \
             mock.patch.object(pii_mod, "_configure_table_io_for_static_credentials"), \
             mock.patch.object(pii_mod, "write_pii_details"), \
             mock.patch.object(pii_mod, "update_dataset_pii_summary"), \
             mock.patch.object(pii_mod, "update_facet"):
            result = merge_pii_results(config, heartbeat_callback=heartbeat)

        # All three phase heartbeats ("loading-iceberg-table", "scanning-table",
        # "overwriting-table") are invoked; exceptions raised by the callback
        # are swallowed and do not abort the merge.
        self.assertEqual(heartbeat.call_count, 3)
        phases = [c.args[0] for c in heartbeat.call_args_list]
        self.assertEqual(phases, ["loading-iceberg-table", "scanning-table", "overwriting-table"])
        self.assertEqual(result["status"], "success")

    def test_heartbeat_not_invoked_when_table_empty(self):
        config = _minimal_config(job_output_prefix="jobs/j1")
        existing_data = pa.table({"file_path": pa.array([], type=pa.string())})
        table, _ = _make_mock_iceberg_table(existing_data, ["file_path"])
        catalog = mock.MagicMock()
        catalog.load_table.return_value = table

        heartbeat = mock.Mock()

        with mock.patch.object(pii_mod, "HAS_PYICEBERG", True), \
             mock.patch.object(pii_mod, "RestCatalog", create=True, return_value=catalog), \
             mock.patch.object(Config, "get_access_token", return_value="tok"), \
             mock.patch.object(pii_mod, "_configure_table_io_for_static_credentials"):
            result = merge_pii_results(config, heartbeat_callback=heartbeat)

        # Table is empty -> early return happens *after* the first two
        # heartbeats ("loading-iceberg-table", "scanning-table") but before
        # "overwriting-table".
        self.assertEqual(result["rowCount"], 0)
        phases = [c.args[0] for c in heartbeat.call_args_list]
        self.assertEqual(phases, ["loading-iceberg-table", "scanning-table"])


if __name__ == "__main__":
    unittest.main()
