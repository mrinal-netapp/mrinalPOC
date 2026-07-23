"""Unit tests for dataset import work planning from S3 acquisition filelist.json.

Exercises ``shared.work_planning.create_work_plan`` (registered on the
dataset-processor worker) using the same ``filelist.json`` shape written by
connector-worker ``FinalizeAcquisition``.
"""

import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

# Stub temporalio before importing shared.work_planning (no native SDK required).
_activity_mod = types.ModuleType("temporalio.activity")
_activity_mod.defn = lambda **kw: (lambda fn: fn)
_activity_mod.info = lambda: SimpleNamespace(workflow_id="wf-test", activity_id="act-test")
_temporal = types.ModuleType("temporalio")
_temporal.activity = _activity_mod
sys.modules.setdefault("temporalio", _temporal)
sys.modules.setdefault("temporalio.activity", _activity_mod)

from shared.work_planning import _load_file_list, create_work_plan  # noqa: E402

MiB = 1024 * 1024


def _objectstore_filelist(files: list[dict]) -> dict:
    """Mirror connector-worker FinalizeAcquisition filelist.json body."""
    return {
        "files": files,
        "totalFiles": len(files),
        "source": "objectstore",
    }


def _metrics_filelist(files: list[dict]) -> dict:
    """Mirror connector-worker AcquireMetrics filelist.json body."""
    return {
        "files": files,
        "totalFiles": len(files),
        "source": "metrics",
        "provider": "gcp",
    }


class TestLoadAcquisitionFileList(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        os.environ["NEMO_DEFAULT_STORE_ROOT"] = self._td.name

    def tearDown(self):
        os.environ.pop("NEMO_DEFAULT_STORE_ROOT", None)

    def test_loads_finalize_acquisition_shape(self):
        rel_key = "projects/p1/datasets/d1/data_files/doc.pdf"
        full = Path(self._td.name) / rel_key
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_bytes(b"x" * 42)

        fl_key = "projects/p1/datasets/d1/_acquisition/filelist.json"
        fl_path = Path(self._td.name) / fl_key
        fl_path.parent.mkdir(parents=True, exist_ok=True)
        fl_path.write_text(
            json.dumps(_objectstore_filelist([{"key": rel_key, "size": 42}]))
        )

        loaded = _load_file_list(fl_key)
        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0].key, rel_key)
        self.assertEqual(loaded[0].size, 42)

    def test_local_path_alias(self):
        lp = "projects/p1/datasets/d1/data_files/img.png"
        fl_key = "projects/p1/datasets/d1/_acquisition/filelist.json"
        fl_path = Path(self._td.name) / fl_key
        fl_path.parent.mkdir(parents=True, exist_ok=True)
        fl_path.write_text(
            json.dumps({
                "files": [{"key": "", "localPath": lp, "size": 7, "lastModified": "2024-06-01T12:00:00Z"}],
            })
        )

        loaded = _load_file_list(fl_key)
        self.assertEqual(len(loaded), 1)
        self.assertEqual(loaded[0].local_path, lp)
        self.assertEqual(loaded[0].key, lp)


class TestCreateWorkPlanFromAcquisition(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        os.environ["NEMO_DEFAULT_STORE_ROOT"] = self._td.name
        for k in (
            "SCATTER_MAX_UNITS_CEILING",
            "MAX_WORK_UNITS",
            "WORK_UNIT_MAX_MB",
            "MAX_FILES_PER_UNIT",
            "DATASET_FILE_THRESHOLD",
        ):
            os.environ.pop(k, None)
        # Real temporalio may already be imported (e.g. test_temporal_worker.py);
        # patch the binding used by create_work_plan, not only sys.modules stubs.
        self._activity_info = mock.patch(
            "shared.work_planning.activity.info",
            return_value=SimpleNamespace(
                workflow_id="wf-test",
                workflow_run_id="run-test",
                activity_id="act-test",
            ),
        )
        self._activity_info.start()
        self.addCleanup(self._activity_info.stop)

    def tearDown(self):
        os.environ.pop("NEMO_DEFAULT_STORE_ROOT", None)

    def _write_filelist(self, files: list[dict], *, under_acquisition: bool = True) -> str:
        fl_key = "projects/p1/datasets/d1/_acquisition/filelist.json"
        fl_path = Path(self._td.name) / fl_key
        fl_path.parent.mkdir(parents=True, exist_ok=True)
        for item in files:
            rel = item["key"]
            p = Path(self._td.name) / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b"0" * int(item.get("size") or 1))
        fl_path.write_text(json.dumps(_objectstore_filelist(files)))
        return fl_key

    def test_explicit_file_list_key_single_worker(self):
        files = [
            {"key": f"projects/p1/datasets/d1/data_files/f{i}.bin", "size": 100}
            for i in range(5)
        ]
        fl_key = self._write_filelist(files)

        plan = create_work_plan({
            "bucketName": "proj-bucket",
            "pathPrefix": "projects/p1",
            "datasetId": "d1",
            "jobId": "job-1",
            "workloadType": "dataset",
            "fileListKey": fl_key,
        })

        self.assertTrue(plan["useSingleWorker"])
        self.assertEqual(plan["totalFiles"], 5)
        self.assertEqual(len(plan["fileSets"]), 1)
        self.assertEqual(plan["fileSets"][0]["setId"], "s0")
        manifest_path = Path(self._td.name) / plan["fileSets"][0]["manifestS3Key"]
        self.assertTrue(manifest_path.is_file())
        manifest = json.loads(manifest_path.read_text())
        self.assertEqual(manifest["totalFiles"], 5)
        self.assertEqual(len(manifest["files"]), 5)

    def test_empty_file_list_key_falls_back_to_acquisition_artifact(self):
        """Retry path: workflow passes empty fileListKey; worker probes _acquisition/."""
        rel = "projects/p1/datasets/d1/data_files/only.bin"
        fl_key = self._write_filelist([{"key": rel, "size": 8}])
        # Decoy under data_files/ must not be picked when filelist.json exists.
        decoy_dir = Path(self._td.name) / "projects/p1/datasets/d1/data_files"
        (decoy_dir / "decoy.parquet").write_bytes(b"decoy")

        plan = create_work_plan({
            "bucketName": "proj-bucket",
            "pathPrefix": "projects/p1",
            "datasetId": "d1",
            "jobId": "job-fallback",
            "workloadType": "dataset",
            "fileListKey": "",
        })

        self.assertEqual(plan["totalFiles"], 1)
        self.assertEqual(plan["fileSets"][0]["totalFiles"], 1)
        loaded_keys = {e["key"] for e in json.loads(
            (Path(self._td.name) / plan["fileSets"][0]["manifestS3Key"]).read_text()
        )["files"]}
        self.assertEqual(loaded_keys, {rel})
        self.assertTrue((Path(self._td.name) / fl_key).is_file())

    def test_scatters_when_above_dataset_threshold(self):
        os.environ["DATASET_FILE_THRESHOLD"] = "3"
        files = [
            {"key": f"projects/p1/datasets/d1/data_files/big{i}.bin", "size": 2 * MiB}
            for i in range(4)
        ]
        fl_key = self._write_filelist(files)

        plan = create_work_plan({
            "bucketName": "proj-bucket",
            "pathPrefix": "projects/p1",
            "datasetId": "d1",
            "jobId": "job-scatter",
            "workloadType": "dataset",
            "fileListKey": fl_key,
        })

        self.assertFalse(plan["useSingleWorker"])
        self.assertEqual(plan["totalFiles"], 4)
        self.assertGreater(len(plan["fileSets"]), 1)
        self.assertEqual(
            sum(fs["totalFiles"] for fs in plan["fileSets"]),
            4,
        )
        for fs in plan["fileSets"]:
            mpath = Path(self._td.name) / fs["manifestS3Key"]
            self.assertTrue(mpath.is_file())

    def _write_metrics_filelist(self, files: list[dict]) -> str:
        fl_key = "projects/p1/datasets/d1/_acquisition/filelist.json"
        fl_path = Path(self._td.name) / fl_key
        fl_path.parent.mkdir(parents=True, exist_ok=True)
        for item in files:
            rel = item["key"]
            p = Path(self._td.name) / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b"PAR1" + b"\x00" * max(int(item.get("size") or 1) - 4, 0))
        fl_path.write_text(json.dumps(_metrics_filelist(files)))
        return fl_key

    def test_metrics_filelist_single_parquet_worker(self):
        rel = "projects/p1/datasets/d1/data/run12345/volume_metrics.parquet"
        fl_key = self._write_metrics_filelist([
            {"key": rel, "size": 128, "format": "parquet"},
        ])

        plan = create_work_plan({
            "bucketName": "proj-bucket",
            "pathPrefix": "projects/p1",
            "datasetId": "d1",
            "jobId": "job-gcnv-metrics",
            "workloadType": "dataset",
            "fileListKey": fl_key,
        })

        self.assertTrue(plan["useSingleWorker"])
        self.assertEqual(plan["totalFiles"], 1)
        manifest = json.loads(
            (Path(self._td.name) / plan["fileSets"][0]["manifestS3Key"]).read_text()
        )
        self.assertEqual(manifest["files"][0]["key"], rel)
