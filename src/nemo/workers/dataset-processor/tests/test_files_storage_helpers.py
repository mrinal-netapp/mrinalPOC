"""Unit tests for POSIX storage helpers and ProgressTracker edge cases in processing.files."""

import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from processing.config import Config
from processing.files import (
    ProgressTracker,
    _BackgroundHeartbeat,
    _cleanup_partition_artifacts,
    _list_partition_outputs,
    _posix_read_json,
    _read_json,
    _upload_file,
    _upload_json,
    _write_bytes,
    download_file,
    list_data_files,
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


class _MountFixture(unittest.TestCase):
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


class TestBackgroundHeartbeatPhaseAndExceptionSwallow(unittest.TestCase):
    def test_set_phase_updates_message(self):
        messages = []
        hb = _BackgroundHeartbeat(messages.append, interval=0.05)
        # Set the phase before the background thread starts so there is no
        # race between this assignment and the thread's first tick, then
        # deterministically drive exactly one loop iteration (wait() -> False
        # runs the body once; wait() -> True ends the loop) instead of
        # relying on a real time.sleep() to "probably" observe a tick.
        hb.set_phase("custom-phase")
        with mock.patch.object(hb._stop, "wait", side_effect=[False, True]):
            with hb:
                hb._thread.join(timeout=5)
        self.assertTrue(any("custom-phase" in m for m in messages))

    def test_heartbeat_fn_exception_is_swallowed(self):
        # The background thread must keep running even if the heartbeat_fn raises.
        call_count = {"n": 0}

        def _raising_hb(msg):
            call_count["n"] += 1
            raise RuntimeError("hb boom")

        hb = _BackgroundHeartbeat(_raising_hb, interval=0.05)
        # Deterministically run exactly one loop iteration instead of hoping
        # a real time.sleep() outlasts at least one `interval`-second tick.
        with mock.patch.object(hb._stop, "wait", side_effect=[False, True]):
            with hb:
                hb._thread.join(timeout=5)
        self.assertEqual(call_count["n"], 1)

    def test_exit_without_enter_does_not_raise(self):
        hb = _BackgroundHeartbeat(lambda m: None, interval=30)
        hb.__exit__(None, None, None)  # thread is None; should be a no-op


class TestPosixReadJson(unittest.TestCase):
    def test_reads_json_bytes_from_path(self):
        with tempfile.NamedTemporaryFile(suffix=".json", delete=False, mode="w") as f:
            json.dump({"a": 1}, f)
            path = Path(f.name)
        try:
            self.assertEqual(_posix_read_json(path), {"a": 1})
        finally:
            path.unlink(missing_ok=True)


class TestUploadAndReadJsonHelpers(_MountFixture):
    def test_upload_json_then_read_json_roundtrip(self):
        _upload_json(self.config, "datasets/ds-test/foo.json", {"hello": "world"})
        result = _read_json(self.config, "datasets/ds-test/foo.json")
        self.assertEqual(result, {"hello": "world"})

    def test_upload_file_copies_to_mount(self):
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(b"file contents")
            src = Path(f.name)
        try:
            _upload_file(self.config, src, "datasets/ds-test/copied.bin")
            dest = self.config.posix_path("datasets/ds-test/copied.bin")
            self.assertTrue(dest.is_file())
            self.assertEqual(dest.read_bytes(), b"file contents")
        finally:
            src.unlink(missing_ok=True)

    def test_write_bytes_creates_file_atomically(self):
        _write_bytes(self.config, "datasets/ds-test/raw.bin", b"raw-data")
        dest = self.config.posix_path("datasets/ds-test/raw.bin")
        self.assertEqual(dest.read_bytes(), b"raw-data")


class TestListPartitionOutputs(_MountFixture):
    def test_returns_empty_list_when_missing_dir(self):
        self.assertEqual(_list_partition_outputs(self.config, "jobs/j1"), [])

    def test_lists_partition_directories_sorted(self):
        base = self.config.posix_path("jobs/j1/partitions")
        (base / "s1").mkdir(parents=True)
        (base / "s0").mkdir(parents=True)
        # A stray file in partitions/ (not a dir) must be excluded.
        (base / "not-a-dir.txt").write_text("x")

        result = _list_partition_outputs(self.config, "jobs/j1")
        self.assertEqual(result, ["jobs/j1/partitions/s0", "jobs/j1/partitions/s1"])


class TestCleanupPartitionArtifacts(_MountFixture):
    def test_removes_partitions_dir_when_present(self):
        base = self.config.posix_path("jobs/j1/partitions")
        (base / "s0").mkdir(parents=True)
        (base / "s0" / "data.parquet").write_text("x")

        _cleanup_partition_artifacts(self.config, "jobs/j1")

        self.assertFalse(base.is_dir())

    def test_no_op_when_partitions_dir_absent(self):
        # Must not raise when there's nothing to clean up.
        _cleanup_partition_artifacts(self.config, "jobs/does-not-exist")


class TestDownloadFile(_MountFixture):
    def test_copies_mount_file_to_local_path(self):
        src_key = "datasets/ds-test/data_files/a.txt"
        src = self.config.posix_path(src_key)
        src.parent.mkdir(parents=True)
        src.write_text("hello")

        local_dest = Path(self.tmp) / "downloaded" / "a.txt"
        download_file(self.config, src_key, local_dest)

        self.assertEqual(local_dest.read_text(), "hello")


class TestListDataFiles(_MountFixture):
    def test_lists_files_recursively_with_metadata(self):
        base = self.config.posix_path("datasets/ds-test/data_files")
        (base / "sub").mkdir(parents=True)
        (base / "a.txt").write_text("a")
        (base / "sub" / "b.txt").write_text("bb")

        files = list_data_files(self.config)

        keys = sorted(f["key"] for f in files)
        self.assertEqual(
            keys,
            ["datasets/ds-test/data_files/a.txt", "datasets/ds-test/data_files/sub/b.txt"],
        )
        for f in files:
            self.assertIn("size", f)
            self.assertIn("last_modified", f)

    def test_returns_empty_list_when_no_data_dir(self):
        self.assertEqual(list_data_files(self.config), [])

    def test_uses_s3_path_prefix_when_configured(self):
        cfg = _minimal_config(s3_path_prefix="tenant/proj")
        base = cfg.posix_path("tenant/proj/datasets/ds-test/data_files")
        base.mkdir(parents=True)
        (base / "x.csv").write_text("x")

        files = list_data_files(cfg)
        self.assertEqual(
            [f["key"] for f in files],
            ["tenant/proj/datasets/ds-test/data_files/x.csv"],
        )


class TestProgressTrackerFormattingAndEta(unittest.TestCase):
    def test_fmt_seconds_under_a_minute(self):
        self.assertEqual(ProgressTracker._fmt(12.3), "12.3s")

    def test_fmt_minutes(self):
        self.assertEqual(ProgressTracker._fmt(125), "2m 5s")

    def test_fmt_hours(self):
        self.assertEqual(ProgressTracker._fmt(3725), "1h 2m")

    def test_eta_returns_none_when_current_is_zero(self):
        self.assertIsNone(ProgressTracker._eta(0, 10, 5.0))

    def test_eta_returns_none_when_total_is_zero(self):
        self.assertIsNone(ProgressTracker._eta(5, 0, 5.0))

    def test_eta_returns_none_when_elapsed_is_zero(self):
        self.assertIsNone(ProgressTracker._eta(5, 10, 0))

    def test_eta_computes_remaining_time(self):
        # 5 of 10 done in 5s -> rate 1/s -> 5s remaining for the other 5.
        self.assertAlmostEqual(ProgressTracker._eta(5, 10, 5.0), 5.0)


class TestProgressTrackerEndPhaseAndCallbacks(_MountFixture):
    def test_end_phase_records_duration_and_appears_in_next_update(self):
        tracker = ProgressTracker(self.config, write_interval_seconds=0)
        tracker.begin_phase("processing")
        time.sleep(0.15)
        tracker.end_phase("processing")
        tracker.begin_phase("writing_parquet")
        tracker.update(1, 1, force=True)

        data = json.loads(self.config.posix_path(self.config.progress_key()).read_text())
        self.assertIn("processing", data["completedPhases"])
        self.assertGreater(data["completedPhases"]["processing"], 0)

    def test_update_includes_eta_fields_when_progress_made(self):
        tracker = ProgressTracker(self.config, write_interval_seconds=0)
        tracker.begin_phase("processing")
        time.sleep(0.02)
        tracker.update(5, 10, force=True)

        data = json.loads(self.config.posix_path(self.config.progress_key()).read_text())
        self.assertIn("estimatedRemainingSeconds", data)
        self.assertIn("ratePerSecond", data)

    def test_heartbeat_callback_exception_is_swallowed(self):
        tracker = ProgressTracker(
            self.config, write_interval_seconds=0,
            heartbeat_callback=mock.Mock(side_effect=RuntimeError("hb boom")),
        )
        tracker.begin_phase("processing")
        # Must not raise even though the heartbeat callback fails.
        tracker.update(1, 10, force=True)

    def test_workflow_progress_callback_invoked_with_filtered_extra(self):
        calls = []
        tracker = ProgressTracker(
            self.config, write_interval_seconds=0,
            workflow_progress_callback=lambda *a: calls.append(a),
        )
        tracker.begin_phase("processing")
        tracker.update(2, 10, force=True, processedFiles=2, totalFiles=10, unrelatedKey="ignored")

        self.assertEqual(len(calls), 1)
        phase, phase_pct, current, total, extra = calls[0]
        self.assertEqual(phase, "processing")
        self.assertEqual(current, 2)
        self.assertEqual(total, 10)
        self.assertIn("processedFiles", extra)
        self.assertIn("totalFiles", extra)
        self.assertNotIn("unrelatedKey", extra)

    def test_workflow_progress_callback_exception_is_swallowed(self):
        tracker = ProgressTracker(
            self.config, write_interval_seconds=0,
            workflow_progress_callback=mock.Mock(side_effect=RuntimeError("progress boom")),
        )
        tracker.begin_phase("processing")
        # Must not raise even though the workflow progress callback fails.
        tracker.update(1, 10, force=True)

    def test_write_s3_failure_logs_warning_and_does_not_raise(self):
        tracker = ProgressTracker(self.config, write_interval_seconds=0)
        tracker.begin_phase("processing")
        with mock.patch(
            "processing.files._posix_write_json", side_effect=OSError("disk full")
        ):
            # Must not raise even though the underlying write fails.
            tracker.update(1, 10, force=True)


if __name__ == "__main__":
    unittest.main()
