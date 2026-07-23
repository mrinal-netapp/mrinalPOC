"""Unit tests for shared.work_planning partitioning (K_eff + variant B)."""

import os
import sys
import types as _types
import unittest
import random

# Stub temporalio so the module can be imported without the native package.
_activity_mod = _types.ModuleType("temporalio.activity")
_activity_mod.defn = lambda **kw: (lambda fn: fn)  # no-op decorator
_activity_mod.info = lambda: None
sys.modules.setdefault("temporalio", _types.ModuleType("temporalio"))
sys.modules.setdefault("temporalio.activity", _activity_mod)

from work_planning import (
    _FileInfo,
    _ScatterGatherConfig,
    _build_output_prefix,
    _clamp_int,
    _compute_k_clamped,
    _distribute_into_k_partitions_variant_b,
    _scatter_clamp_bounds,
)

MiB = 1024 * 1024


class TestBuildOutputPrefix(unittest.TestCase):
    def test_no_path_prefix(self):
        self.assertEqual(_build_output_prefix("", "job-123"), "jobs/job-123")

    def test_with_path_prefix(self):
        self.assertEqual(_build_output_prefix("projects/p1", "job-456"), "projects/p1/jobs/job-456")


class TestScatterClampBounds(unittest.TestCase):
    def test_floor_le_ceiling(self):
        cfg = _ScatterGatherConfig()
        cfg.max_work_units = 10
        cfg.scatter_max_units_ceiling = 2000
        lo, hi = _scatter_clamp_bounds(cfg)
        self.assertEqual(lo, 10)
        self.assertEqual(hi, 2000)

    def test_misconfig_max_gt_ceiling(self):
        cfg = _ScatterGatherConfig()
        cfg.max_work_units = 500
        cfg.scatter_max_units_ceiling = 100
        lo, hi = _scatter_clamp_bounds(cfg)
        self.assertEqual(lo, 100)
        self.assertEqual(hi, 100)


class TestComputeKClamped(unittest.TestCase):
    def setUp(self):
        for k in (
            "SCATTER_MAX_UNITS_CEILING",
            "MAX_WORK_UNITS",
            "WORK_UNIT_MAX_MB",
            "MAX_FILES_PER_UNIT",
            "MIN_FILES_PER_UNIT",
            "DATASET_FILE_THRESHOLD",
            "KB_FILE_THRESHOLD",
        ):
            os.environ.pop(k, None)

    def _cfg(self) -> _ScatterGatherConfig:
        cfg = _ScatterGatherConfig()
        cfg.max_bytes_per_work_unit = 5 * MiB
        cfg.max_files_per_unit = 100
        cfg.max_work_units = 10
        cfg.min_files_per_unit = 10
        cfg.scatter_max_units_ceiling = 2000
        return cfg

    def test_bytes_path_raises_k_raw(self):
        cfg = self._cfg()
        k_raw, k_clamped, k_eff, reason = _compute_k_clamped(cfg, 100 * MiB, 1)
        self.assertEqual(reason, "bytes")
        self.assertEqual(k_raw, 20)
        self.assertEqual(k_clamped, 20)
        self.assertEqual(k_eff, 1)

    def test_floor_max_work_units(self):
        cfg = self._cfg()
        k_raw, k_clamped, k_eff, _ = _compute_k_clamped(cfg, 10 * MiB, 100)
        self.assertEqual(k_raw, 2)
        self.assertEqual(k_clamped, 10)
        self.assertEqual(k_eff, 10)

    def test_ceiling_caps(self):
        cfg = self._cfg()
        cfg.scatter_max_units_ceiling = 15
        k_raw, k_clamped, k_eff, _ = _compute_k_clamped(cfg, 100 * MiB, 1000)
        self.assertEqual(k_raw, 20)
        self.assertEqual(k_clamped, 15)
        self.assertEqual(k_eff, 15)

    def test_k_eff_never_exceeds_n(self):
        cfg = self._cfg()
        cfg.max_work_units = 1
        cfg.scatter_max_units_ceiling = 2000
        _, _, k_eff, _ = _compute_k_clamped(cfg, 500 * MiB, 3)
        self.assertEqual(k_eff, 3)

    def test_zero_total_bytes_uses_max_files_divisor(self):
        cfg = self._cfg()
        n = 250
        k_raw, k_clamped, k_eff, reason = _compute_k_clamped(cfg, 0, n)
        self.assertEqual(reason, "zero_sizes")
        self.assertEqual(k_raw, 3)
        self.assertGreaterEqual(k_clamped, cfg.max_work_units)
        self.assertEqual(k_eff, min(k_clamped, n))

    def test_no_byte_cap_uses_min_files(self):
        cfg = self._cfg()
        cfg.max_bytes_per_work_unit = 0
        n = 100
        k_raw, k_clamped, k_eff, reason = _compute_k_clamped(cfg, 50 * MiB, n)
        self.assertEqual(reason, "no_byte_cap")
        self.assertEqual(k_raw, 10)
        self.assertEqual(k_eff, min(k_clamped, n))


class TestScatterGatherConfigDefaults(unittest.TestCase):
    def setUp(self):
        for k in (
            "WORK_UNIT_MAX_MB",
            "MAX_FILES_PER_UNIT",
            "MAX_WORK_UNITS",
            "MIN_FILES_PER_UNIT",
            "DATASET_FILE_THRESHOLD",
            "KB_FILE_THRESHOLD",
            "SCATTER_MAX_UNITS_CEILING",
        ):
            os.environ.pop(k, None)

    def test_defaults(self):
        cfg = _ScatterGatherConfig()
        self.assertEqual(cfg.max_work_units, 10)
        self.assertEqual(cfg.min_files_per_unit, 10)
        self.assertEqual(cfg.dataset_file_threshold, 20)
        self.assertEqual(cfg.kb_file_threshold, 25)
        self.assertEqual(cfg.max_bytes_per_work_unit, 5 * MiB)
        self.assertEqual(cfg.max_files_per_unit, 100)
        self.assertEqual(cfg.scatter_max_units_ceiling, 2000)

    def test_env_overrides(self):
        os.environ["MAX_WORK_UNITS"] = "5"
        os.environ["DATASET_FILE_THRESHOLD"] = "50"
        os.environ["WORK_UNIT_MAX_MB"] = "0"
        os.environ["SCATTER_MAX_UNITS_CEILING"] = "3000"
        try:
            cfg = _ScatterGatherConfig()
            self.assertEqual(cfg.max_work_units, 5)
            self.assertEqual(cfg.dataset_file_threshold, 50)
            self.assertEqual(cfg.max_bytes_per_work_unit, 0)
            self.assertEqual(cfg.scatter_max_units_ceiling, 3000)
        finally:
            os.environ.pop("MAX_WORK_UNITS", None)
            os.environ.pop("DATASET_FILE_THRESHOLD", None)
            os.environ.pop("WORK_UNIT_MAX_MB", None)
            os.environ.pop("SCATTER_MAX_UNITS_CEILING", None)


class TestDistributeVariantB(unittest.TestCase):
    def test_exactly_k_eff_bins_all_non_empty(self):
        cfg = _ScatterGatherConfig()
        cfg.max_bytes_per_work_unit = 5 * MiB
        cfg.max_work_units = 1
        cfg.scatter_max_units_ceiling = 2000
        files = [
            _FileInfo(key="h1", size=10 * MiB, last_modified=""),
            _FileInfo(key="h2", size=9 * MiB, last_modified=""),
            _FileInfo(key="s", size=1, last_modified=""),
        ]
        _, _, k_eff, _ = _compute_k_clamped(cfg, sum(f.size for f in files), len(files))
        self.assertEqual(k_eff, 3)
        rng = random.Random(42)
        sets = _distribute_into_k_partitions_variant_b(files, k_eff, rng)
        self.assertEqual(len(sets), 3)
        self.assertEqual(sum(len(s) for s in sets), 3)
        for s in sets:
            self.assertGreater(len(s), 0)

    def test_deterministic_with_seed(self):
        cfg = _ScatterGatherConfig()
        cfg.max_bytes_per_work_unit = MiB
        cfg.max_work_units = 2
        cfg.scatter_max_units_ceiling = 10
        files = [_FileInfo(key=f"f{i}", size=i + 1, last_modified="") for i in range(8)]
        total_b = sum(f.size for f in files)
        _, _, k_eff, _ = _compute_k_clamped(cfg, total_b, len(files))
        rng1 = random.Random(12345)
        rng2 = random.Random(12345)
        a = _distribute_into_k_partitions_variant_b(files, k_eff, rng1)
        b = _distribute_into_k_partitions_variant_b(files, k_eff, rng2)
        self.assertEqual([[x.key for x in s] for s in a], [[x.key for x in s] for s in b])

    def test_large_files_not_all_same_bin(self):
        cfg = _ScatterGatherConfig()
        cfg.max_bytes_per_work_unit = MiB
        cfg.max_work_units = 2
        cfg.scatter_max_units_ceiling = 5
        files = [
            _FileInfo(key="a", size=1000, last_modified=""),
            _FileInfo(key="b", size=900, last_modified=""),
            _FileInfo(key="c", size=800, last_modified=""),
            _FileInfo(key="d", size=10, last_modified=""),
            _FileInfo(key="e", size=10, last_modified=""),
        ]
        _, _, k_eff, _ = _compute_k_clamped(cfg, sum(f.size for f in files), len(files))
        self.assertGreaterEqual(k_eff, 2)
        rng = random.Random(0)
        sets = _distribute_into_k_partitions_variant_b(files, k_eff, rng)
        keys_per_bin = [[f.key for f in s] for s in sets]
        flat = [k for s in keys_per_bin for k in s]
        self.assertEqual(len(flat), 5)
        self.assertEqual(len(set(flat)), 5)
        self.assertGreaterEqual(len(sets), 2)


class TestClampInt(unittest.TestCase):
    def test_clamp(self):
        self.assertEqual(_clamp_int(5, 10, 100), 10)
        self.assertEqual(_clamp_int(50, 10, 100), 50)
        self.assertEqual(_clamp_int(200, 10, 100), 100)


class TestCreateWorkPlanAcquisitionProbe(unittest.TestCase):
    def tearDown(self):
        if "NEMO_DEFAULT_STORE_ROOT" in os.environ:
            del os.environ["NEMO_DEFAULT_STORE_ROOT"]

    def test_uses_filelist_under_dataset_acquisition_not_data_files_listing(self):
        import json as _json
        import tempfile
        from pathlib import Path as _Path
        from types import SimpleNamespace

        import temporalio.activity as tact

        old_info = tact.info

        def _fake_info():
            return SimpleNamespace(workflow_id="wf-probe", activity_id="act-probe")

        tact.info = _fake_info
        try:
            from work_planning import create_work_plan

            with tempfile.TemporaryDirectory() as td:
                os.environ["NEMO_DEFAULT_STORE_ROOT"] = td
                df = _Path(td) / "projects" / "p1" / "datasets" / "d1" / "data_files"
                df.mkdir(parents=True)
                (_Path(td) / "projects" / "p1" / "datasets" / "d1" / "data_files" / "noise1.parquet").write_bytes(b"x")
                (_Path(td) / "projects" / "p1" / "datasets" / "d1" / "data_files" / "noise2.parquet").write_bytes(b"y")
                acq = _Path(td) / "projects" / "p1" / "datasets" / "d1" / "_acquisition"
                acq.mkdir(parents=True)
                key = "projects/p1/datasets/d1/data_files/acquired.bin"
                (_Path(td) / key).parent.mkdir(parents=True, exist_ok=True)
                (_Path(td) / key).write_bytes(b"0" * 10)
                fl = {"files": [{"key": key, "size": 10, "lastModified": "2020-01-01T00:00:00Z"}]}
                (acq / "filelist.json").write_text(_json.dumps(fl))

                plan = create_work_plan({
                    "bucketName": "b",
                    "pathPrefix": "projects/p1",
                    "datasetId": "d1",
                    "jobId": "job-probe",
                    "workloadType": "dataset",
                    "fileListKey": "",
                })
                self.assertEqual(plan["totalFiles"], 1)
        finally:
            tact.info = old_info


if __name__ == "__main__":
    unittest.main()
