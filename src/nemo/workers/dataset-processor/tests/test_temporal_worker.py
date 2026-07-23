"""Unit tests for temporal_worker helpers (no live Temporal server)."""

import asyncio
import json
import os
import signal
import unittest
from datetime import timedelta
from unittest import mock

import temporal_worker
from temporal_worker import (
    _WorkflowProgressReporter,
    _bind_activity_context,
    _dataset_overall_percentage,
    _graceful_shutdown_timeout,
    _post_workflow_progress,
    _warmup_pii_models,
    merge_dataset_results,
    merge_pii_results_activity,
    process_dataset_files,
    reprocess_dataset_pii,
    reprocess_pii_files,
)


class TestGracefulShutdownTimeout(unittest.TestCase):
    def test_parses_seconds_from_env(self):
        with mock.patch.dict(os.environ, {"TEMPORAL_GRACEFUL_SHUTDOWN_TIMEOUT": "120s"}):
            self.assertEqual(_graceful_shutdown_timeout(), timedelta(seconds=120))

    def test_defaults_to_90_seconds(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            os.environ.pop("TEMPORAL_GRACEFUL_SHUTDOWN_TIMEOUT", None)
            self.assertEqual(_graceful_shutdown_timeout(), timedelta(seconds=90))

    def test_invalid_value_falls_back(self):
        with mock.patch.dict(os.environ, {"TEMPORAL_GRACEFUL_SHUTDOWN_TIMEOUT": "nope"}):
            self.assertEqual(_graceful_shutdown_timeout(), timedelta(seconds=90))


class TestDatasetOverallPercentage(unittest.TestCase):
    def test_processing_phase_maps_into_5_80_range(self):
        self.assertEqual(_dataset_overall_percentage("processing", 0), 5.0)
        self.assertEqual(_dataset_overall_percentage("processing", 100), 80.0)

    def test_writing_parquet_fixed(self):
        self.assertEqual(_dataset_overall_percentage("writing_parquet", 50), 82.0)

    def test_merging_phase(self):
        self.assertEqual(_dataset_overall_percentage("merging", 100), 95.0)

    def test_unknown_phase_uses_phase_pct_capped(self):
        self.assertEqual(_dataset_overall_percentage("custom", 50), 50.0)


class TestPostWorkflowProgress(unittest.TestCase):
    @mock.patch("temporal_worker.urllib.request.urlopen")
    def test_posts_json_payload(self, mock_urlopen):
        mock_urlopen.return_value.__enter__ = mock.Mock(return_value=mock.Mock())
        mock_urlopen.return_value.__exit__ = mock.Mock(return_value=False)
        _post_workflow_progress(
            "wf-1",
            "http://workflow-engine:8080",
            phase="processing",
            percentage=42.0,
            current=4,
            total=10,
            message="half done",
            extra={"set_id": "s1"},
            unit_id="s1",
        )
        mock_urlopen.assert_called_once()
        req = mock_urlopen.call_args[0][0]
        self.assertEqual(req.method, "POST")
        body = json.loads(req.data.decode())
        self.assertEqual(body["phase"], "processing")
        self.assertEqual(body["percentage"], 42.0)
        self.assertEqual(body["unitId"], "s1")

    @mock.patch("temporal_worker.urllib.request.urlopen", side_effect=OSError("network down"))
    def test_swallows_errors(self, _mock_urlopen):
        _post_workflow_progress(
            "wf-1", "http://localhost:1", "p", 0, 0, 0,
        )


class TestWorkflowProgressReporter(unittest.TestCase):
    @mock.patch("temporal_worker._post_workflow_progress")
    @mock.patch("temporal_worker.time.monotonic")
    def test_throttles_rapid_posts(self, mock_mono, mock_post):
        # First post: large gap from initial _last_post_time (0). Second: within 5s window.
        mock_mono.side_effect = [100.0, 101.0]
        reporter = _WorkflowProgressReporter("wf-1", workflow_engine_url="http://we")
        reporter.post("processing", 10, 1, 10)
        reporter.post("processing", 20, 2, 10)
        self.assertEqual(mock_post.call_count, 1)

    @mock.patch("temporal_worker._post_workflow_progress")
    def test_skips_when_url_empty(self, mock_post):
        reporter = _WorkflowProgressReporter("wf-1", workflow_engine_url="")
        reporter.post("processing", 10, 1, 10)
        mock_post.assert_not_called()


def _valid_config_dict(**overrides) -> dict:
    """Minimal dict that satisfies Config.validate()."""
    base = {
        "dataset_id": "ds-1",
        "dataset_name": "my-dataset",
        "project_id": "proj-1",
        "bucket_name": "bucket-1",
        "project_client_id": "client-1",
        "project_client_secret": "secret-1",
        "aws_access_key_id": "AKIA...",
        "aws_secret_access_key": "secret",
        "s3_endpoint": "http://s3gateway:7070",
        "set_id": "s0",
    }
    base.update(overrides)
    return base


class TestBindActivityContext(unittest.TestCase):
    @mock.patch("temporal_worker.activity")
    @mock.patch("temporal_worker.bind_context")
    def test_binds_activity_fields_when_in_activity(self, mock_bind, mock_activity):
        mock_activity.in_activity.return_value = True
        mock_activity.info.return_value = mock.Mock(
            activity_id="act-1", activity_type="Foo", workflow_id="wf-1"
        )
        _bind_activity_context(dataset_id="d1")
        mock_bind.assert_called_once_with(
            activity_id="act-1", activity_type="Foo", workflow_id="wf-1", dataset_id="d1"
        )

    @mock.patch("temporal_worker.activity")
    @mock.patch("temporal_worker.bind_context")
    def test_binds_only_extras_when_not_in_activity(self, mock_bind, mock_activity):
        mock_activity.in_activity.return_value = False
        _bind_activity_context(dataset_id="d1")
        mock_bind.assert_called_once_with(dataset_id="d1")

    @mock.patch("temporal_worker.activity")
    @mock.patch("temporal_worker.bind_context")
    def test_swallows_exceptions(self, mock_bind, mock_activity):
        mock_activity.in_activity.side_effect = RuntimeError("boom")
        # Must not raise.
        _bind_activity_context(dataset_id="d1")


class TestProcessDatasetFilesActivity(unittest.TestCase):
    @mock.patch("temporal_worker.process_file_set")
    @mock.patch("temporal_worker.activity")
    def test_builds_config_validates_and_delegates(self, mock_activity, mock_process):
        mock_activity.in_activity.return_value = False
        mock_process.return_value = {"status": "success", "rowCount": 3}

        result = process_dataset_files(_valid_config_dict())

        self.assertEqual(result, {"status": "success", "rowCount": 3})
        mock_activity.heartbeat.assert_called_with("initializing")
        mock_process.assert_called_once()
        call_kwargs = mock_process.call_args.kwargs
        self.assertEqual(call_kwargs["heartbeat_callback"], mock_activity.heartbeat)
        self.assertIsNotNone(call_kwargs["workflow_progress_callback"])
        config_arg = mock_process.call_args.args[0]
        self.assertEqual(config_arg.dataset_id, "ds-1")

    @mock.patch("temporal_worker.process_file_set")
    @mock.patch("temporal_worker.activity")
    def test_raises_when_required_config_missing(self, mock_activity, mock_process):
        mock_activity.in_activity.return_value = False
        with self.assertRaises(ValueError):
            process_dataset_files({"dataset_id": "?"})
        mock_process.assert_not_called()

    @mock.patch("temporal_worker._WorkflowProgressReporter")
    @mock.patch("temporal_worker.process_file_set")
    @mock.patch("temporal_worker.activity")
    def test_workflow_progress_callback_maps_percentage_and_posts(
        self, mock_activity, mock_process, mock_reporter_cls
    ):
        mock_activity.in_activity.return_value = False
        mock_reporter = mock_reporter_cls.return_value
        mock_reporter.url = "http://workflow-engine:8080"

        def _capture_and_invoke_callback(config, heartbeat_callback, workflow_progress_callback):
            workflow_progress_callback("processing", 50.0, 5, 10, {"foo": "bar"})
            return {"status": "success"}

        mock_process.side_effect = _capture_and_invoke_callback

        process_dataset_files(_valid_config_dict(workflow_id="wf-1"))

        mock_reporter_cls.assert_called_once_with("wf-1", unit_id="s0")
        mock_reporter.post.assert_called_once_with(
            "processing", _dataset_overall_percentage("processing", 50.0), 5, 10, extra={"foo": "bar"}
        )

    @mock.patch("temporal_worker._WorkflowProgressReporter")
    @mock.patch("temporal_worker.process_file_set")
    @mock.patch("temporal_worker.activity")
    def test_workflow_progress_callback_skipped_when_no_url(
        self, mock_activity, mock_process, mock_reporter_cls
    ):
        mock_activity.in_activity.return_value = False
        mock_reporter = mock_reporter_cls.return_value
        mock_reporter.url = ""

        def _invoke_callback(config, heartbeat_callback, workflow_progress_callback):
            workflow_progress_callback("processing", 10.0, 1, 5, {})
            return {"status": "success"}

        mock_process.side_effect = _invoke_callback

        process_dataset_files(_valid_config_dict(workflow_id="wf-1"))

        mock_reporter.post.assert_not_called()

    @mock.patch("temporal_worker.process_file_set")
    @mock.patch("temporal_worker.activity")
    def test_workflow_progress_callback_skipped_when_no_workflow_id(
        self, mock_activity, mock_process
    ):
        # No workflow_id -> reporter is None entirely; callback must no-op.
        mock_activity.in_activity.return_value = False

        def _invoke_callback(config, heartbeat_callback, workflow_progress_callback):
            workflow_progress_callback("processing", 10.0, 1, 5, {})
            return {"status": "success"}

        mock_process.side_effect = _invoke_callback

        process_dataset_files(_valid_config_dict())
        # No exception raised means the `not reporter` early-return path worked.


class TestMergeDatasetResultsActivity(unittest.TestCase):
    @mock.patch("temporal_worker.merge_results")
    @mock.patch("temporal_worker.activity")
    def test_delegates_to_merge_results(self, mock_activity, mock_merge):
        mock_activity.in_activity.return_value = False
        mock_merge.return_value = {"status": "success"}

        result = merge_dataset_results(_valid_config_dict(job_output_prefix="jobs/j1"))

        self.assertEqual(result, {"status": "success"})
        mock_activity.heartbeat.assert_called_with("merging")
        mock_merge.assert_called_once()
        self.assertEqual(mock_merge.call_args.kwargs["heartbeat_callback"], mock_activity.heartbeat)

    @mock.patch("temporal_worker._WorkflowProgressReporter")
    @mock.patch("temporal_worker.merge_results")
    @mock.patch("temporal_worker.activity")
    def test_workflow_progress_callback_skipped_when_no_url(
        self, mock_activity, mock_merge, mock_reporter_cls
    ):
        mock_activity.in_activity.return_value = False
        mock_reporter = mock_reporter_cls.return_value
        mock_reporter.url = ""

        def _invoke_callback(config, heartbeat_callback, workflow_progress_callback):
            workflow_progress_callback("merging", 10.0, 1, 5, {})
            return {"status": "success"}

        mock_merge.side_effect = _invoke_callback

        merge_dataset_results(_valid_config_dict(workflow_id="wf-1"))

        mock_reporter.post.assert_not_called()

    @mock.patch("temporal_worker._WorkflowProgressReporter")
    @mock.patch("temporal_worker.merge_results")
    @mock.patch("temporal_worker.activity")
    def test_workflow_progress_callback_posts_when_url_present(
        self, mock_activity, mock_merge, mock_reporter_cls
    ):
        mock_activity.in_activity.return_value = False
        mock_reporter = mock_reporter_cls.return_value
        mock_reporter.url = "http://workflow-engine:8080"

        def _invoke_callback(config, heartbeat_callback, workflow_progress_callback):
            workflow_progress_callback("merging", 60.0, 3, 5, {"foo": "bar"})
            return {"status": "success"}

        mock_merge.side_effect = _invoke_callback

        merge_dataset_results(_valid_config_dict(workflow_id="wf-1"))

        mock_reporter.post.assert_called_once_with(
            "merging", _dataset_overall_percentage("merging", 60.0), 3, 5, extra={"foo": "bar"}
        )


class TestReprocessDatasetPiiActivity(unittest.TestCase):
    @mock.patch("temporal_worker.reprocess_pii")
    @mock.patch("temporal_worker.activity")
    def test_delegates_to_reprocess_pii(self, mock_activity, mock_reprocess):
        mock_activity.in_activity.return_value = False
        mock_reprocess.return_value = {"status": "success", "rowCount": 10}

        result = reprocess_dataset_pii(_valid_config_dict())

        self.assertEqual(result, {"status": "success", "rowCount": 10})
        mock_activity.heartbeat.assert_called_with("reprocessing-pii")
        mock_reprocess.assert_called_once()

    @mock.patch("temporal_worker._WorkflowProgressReporter")
    @mock.patch("temporal_worker.reprocess_pii")
    @mock.patch("temporal_worker.activity")
    def test_workflow_progress_callback_posts_raw_phase_pct(
        self, mock_activity, mock_reprocess, mock_reporter_cls
    ):
        mock_activity.in_activity.return_value = False
        mock_reporter = mock_reporter_cls.return_value
        mock_reporter.url = "http://we"

        def _invoke_callback(config, heartbeat_callback, workflow_progress_callback):
            workflow_progress_callback("pii_analysis", 42.0, 4, 10, {"processedFiles": 4})
            return {"status": "success"}

        mock_reprocess.side_effect = _invoke_callback

        reprocess_dataset_pii(_valid_config_dict(workflow_id="wf-1"))

        mock_reporter.post.assert_called_once_with(
            "pii_analysis", 42.0, 4, 10, extra={"processedFiles": 4}
        )

    @mock.patch("temporal_worker._WorkflowProgressReporter")
    @mock.patch("temporal_worker.reprocess_pii")
    @mock.patch("temporal_worker.activity")
    def test_workflow_progress_callback_skipped_when_no_url(
        self, mock_activity, mock_reprocess, mock_reporter_cls
    ):
        mock_activity.in_activity.return_value = False
        mock_reporter = mock_reporter_cls.return_value
        mock_reporter.url = ""

        def _invoke_callback(config, heartbeat_callback, workflow_progress_callback):
            workflow_progress_callback("pii_analysis", 10.0, 1, 5, {})
            return {"status": "success"}

        mock_reprocess.side_effect = _invoke_callback

        reprocess_dataset_pii(_valid_config_dict(workflow_id="wf-1"))

        mock_reporter.post.assert_not_called()


class TestReprocessPiiFilesActivity(unittest.TestCase):
    @mock.patch("temporal_worker.reprocess_pii_file_set")
    @mock.patch("temporal_worker.activity")
    def test_delegates_to_reprocess_pii_file_set(self, mock_activity, mock_reprocess_set):
        mock_activity.in_activity.return_value = False
        mock_reprocess_set.return_value = {"setId": "s0", "status": "success", "fileCount": 2}

        result = reprocess_pii_files(_valid_config_dict())

        self.assertEqual(result["status"], "success")
        mock_activity.heartbeat.assert_called_with("starting-pii-reprocess")
        mock_reprocess_set.assert_called_once()
        self.assertEqual(
            mock_reprocess_set.call_args.kwargs["heartbeat_callback"], mock_activity.heartbeat
        )


class TestMergePiiResultsActivity(unittest.TestCase):
    @mock.patch("temporal_worker.merge_pii_results")
    @mock.patch("temporal_worker.activity")
    def test_delegates_to_merge_pii_results(self, mock_activity, mock_merge_pii):
        mock_activity.in_activity.return_value = False
        mock_merge_pii.return_value = {"status": "success", "rowCount": 7}

        result = merge_pii_results_activity(_valid_config_dict(job_output_prefix="jobs/j1"))

        self.assertEqual(result, {"status": "success", "rowCount": 7})
        mock_activity.heartbeat.assert_called_with("merging-pii")
        mock_merge_pii.assert_called_once()


class TestWarmupPiiModels(unittest.TestCase):
    def test_all_analyzers_succeed(self):
        with mock.patch("analyzers.pii._get_analyzer") as mock_text, \
             mock.patch("analyzers.image_pii._get_ocr_engine") as mock_ocr, \
             mock.patch("analyzers.sensitivity._get_classifier") as mock_clip:
            _warmup_pii_models()
        mock_text.assert_called_once()
        mock_ocr.assert_called_once()
        mock_clip.assert_called_once()

    def test_individual_failures_are_non_fatal(self):
        with mock.patch("analyzers.pii._get_analyzer", side_effect=RuntimeError("no presidio")), \
             mock.patch("analyzers.image_pii._get_ocr_engine", side_effect=RuntimeError("no tesseract")), \
             mock.patch("analyzers.sensitivity._get_classifier", side_effect=RuntimeError("no torch")):
            # Must not raise even though every warmup step fails.
            _warmup_pii_models()

    def test_import_error_is_non_fatal(self):
        with mock.patch.dict(
            "sys.modules", {"analyzers.pii": None, "analyzers.image_pii": None, "analyzers.sensitivity": None}
        ):
            _warmup_pii_models()


class TestMain(unittest.IsolatedAsyncioTestCase):
    @mock.patch("temporal_worker.start_watchdog")
    @mock.patch("temporal_worker.Worker")
    @mock.patch("temporal_worker.wait_for_temporal")
    @mock.patch("temporal_worker._warmup_pii_models")
    @mock.patch("observability_client_runtime.configure_observability_minimal", create=True)
    async def test_wires_expected_activities_and_shuts_down_cleanly(
        self, mock_configure_obs, mock_warmup, mock_wait_for_temporal, mock_worker_cls, mock_watchdog
    ):
        mock_client = mock.Mock()

        async def _wait_for_temporal(*args, **kwargs):
            return mock_client

        mock_wait_for_temporal.side_effect = _wait_for_temporal

        mock_worker_instance = mock.AsyncMock()
        mock_worker_cls.return_value = mock_worker_instance

        # __aenter__/__aexit__ must resolve immediately; simulate SIGTERM by
        # setting the shutdown event right after the worker context opens.
        async def _aenter(*args, **kwargs):
            return mock_worker_instance

        mock_worker_instance.__aenter__ = _aenter
        mock_worker_instance.__aexit__ = mock.AsyncMock(return_value=False)

        with mock.patch("temporal_worker.asyncio.Event") as mock_event_cls, \
             mock.patch("temporal_worker.observability_client_runtime", create=True), \
             mock.patch("builtins.__import__", side_effect=__import__):
            mock_event = mock.AsyncMock()
            mock_event.wait = mock.AsyncMock(return_value=None)
            mock_event_cls.return_value = mock_event

            loop = mock.Mock()
            with mock.patch("temporal_worker.asyncio.get_running_loop", return_value=loop):
                await temporal_worker.main()

        mock_worker_cls.assert_called_once()
        _, kwargs = mock_worker_cls.call_args
        activity_names = {fn.__name__ for fn in kwargs["activities"]}
        self.assertEqual(
            activity_names,
            {
                "process_dataset_files",
                "merge_dataset_results",
                "reprocess_dataset_pii",
                "reprocess_pii_files",
                "merge_pii_results_activity",
                "create_work_plan",
            },
        )
        mock_watchdog.assert_called_once()
        mock_warmup.assert_called_once()

    @mock.patch("temporal_worker.start_watchdog")
    @mock.patch("temporal_worker.Worker")
    @mock.patch("temporal_worker.wait_for_temporal")
    @mock.patch("temporal_worker._warmup_pii_models")
    @mock.patch("observability_client_runtime.configure_observability_minimal", create=True)
    async def test_signal_handler_sets_shutdown_event(
        self, mock_configure_obs, mock_warmup, mock_wait_for_temporal, mock_worker_cls, mock_watchdog
    ):
        """Directly exercises the `_request_shutdown` closure registered with
        `loop.add_signal_handler` (normally only invoked by a real SIGTERM/SIGINT)."""
        mock_client = mock.Mock()

        async def _wait_for_temporal(*args, **kwargs):
            return mock_client

        mock_wait_for_temporal.side_effect = _wait_for_temporal

        mock_worker_instance = mock.AsyncMock()
        mock_worker_cls.return_value = mock_worker_instance

        async def _aenter(*args, **kwargs):
            return mock_worker_instance

        mock_worker_instance.__aenter__ = _aenter
        mock_worker_instance.__aexit__ = mock.AsyncMock(return_value=False)

        captured_handlers = {}

        def _capture_add_signal_handler(sig, callback, *args):
            captured_handlers[sig] = (callback, args)

        real_loop = asyncio.get_event_loop()
        loop = mock.Mock()
        loop.add_signal_handler = mock.Mock(side_effect=_capture_add_signal_handler)

        # Real asyncio.Event so we can assert `.set()` was actually invoked
        # by the captured signal-handler closure before `worker.__aexit__`.
        real_event = asyncio.Event()

        with mock.patch("temporal_worker.asyncio.Event", return_value=real_event), \
             mock.patch("temporal_worker.asyncio.get_running_loop", return_value=loop):

            async def _trigger_signal_then_return():
                # Invoke the captured SIGTERM handler as the real signal
                # dispatcher would; this calls `real_event.set()` internally,
                # so `main()` can proceed to shut down immediately afterwards.
                callback, args = captured_handlers[signal.SIGTERM]
                callback(*args)

            with mock.patch.object(real_event, "wait", side_effect=_trigger_signal_then_return):
                await temporal_worker.main()

        self.assertTrue(real_event.is_set())
        self.assertIn(signal.SIGTERM, captured_handlers)
        self.assertIn(signal.SIGINT, captured_handlers)


class TestMainEntryPoint(unittest.TestCase):
    def test_dunder_main_invokes_asyncio_run_with_main(self):
        """Exercises the `if __name__ == "__main__": asyncio.run(main())` guard
        by running the module source directly with `__name__` forced to
        `"__main__"`, with `asyncio.run` mocked out so nothing actually starts."""
        import runpy

        def _fake_run(coro):
            coro.close()  # avoid "coroutine was never awaited" warning

        with mock.patch("asyncio.run", side_effect=_fake_run) as mock_run:
            runpy.run_path(temporal_worker.__file__, run_name="__main__")

        mock_run.assert_called_once()


if __name__ == "__main__":
    unittest.main()
