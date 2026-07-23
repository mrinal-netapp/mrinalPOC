"""Unit tests for workflow progress reporting."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

from activities import workflow_progress as wp


class TestPostProgress:
    def test_noop_when_workflow_id_missing(self):
        with patch("activities.workflow_progress.urllib.request.urlopen") as mock_open:
            wp.post_progress("", "http://workflow-engine:8080", "phase", 10.0, 1, 10)
            mock_open.assert_not_called()

    @patch("activities.workflow_progress.urllib.request.urlopen")
    def test_posts_payload(self, mock_urlopen):
        mock_urlopen.return_value = MagicMock()
        wp.post_progress(
            "wf-1",
            "http://workflow-engine:8080/",
            phase="copying",
            percentage=42.5,
            current=4,
            total=10,
            message="copying files",
            extra={"source": "gcs"},
            unit_id="unit-a",
        )
        req = mock_urlopen.call_args[0][0]
        assert (
            req.full_url == "http://workflow-engine:8080/api/v1/workflows/wf-1/progress"
        )
        assert req.method == "POST"
        body = json.loads(req.data.decode("utf-8"))
        assert body["phase"] == "copying"
        assert body["percentage"] == 42.5
        assert body["unitId"] == "unit-a"
        assert body["extra"] == {"source": "gcs"}

    @patch(
        "activities.workflow_progress.urllib.request.urlopen",
        side_effect=OSError("network down"),
    )
    def test_swallows_post_errors(self, _mock_urlopen):
        wp.post_progress("wf-1", "http://workflow-engine:8080", "phase", 0.0, 0, 0)


class TestWorkflowProgressReporter:
    @patch("activities.workflow_progress.post_progress")
    @patch("activities.workflow_progress.time.monotonic", return_value=100.0)
    def test_posts_first_update(self, _mock_time, mock_post):
        reporter = wp.WorkflowProgressReporter(
            "wf-1", "http://workflow-engine:8080", unit_id="u1"
        )
        reporter.post("phase", 10.0, 1, 10, message="one")
        mock_post.assert_called_once_with(
            "wf-1",
            "http://workflow-engine:8080",
            phase="phase",
            percentage=10.0,
            current=1,
            total=10,
            message="one",
            extra=None,
            unit_id="u1",
        )

    @patch("activities.workflow_progress.post_progress")
    @patch("activities.workflow_progress.time.monotonic")
    def test_throttles_rapid_posts(self, mock_time, mock_post):
        mock_time.side_effect = [100.0, 101.0, 106.0]
        reporter = wp.WorkflowProgressReporter("wf-1", "http://workflow-engine:8080")
        reporter.post("phase", 10.0, 1, 10)
        reporter.post("phase", 20.0, 2, 10)
        reporter.post("phase", 30.0, 3, 10)
        assert mock_post.call_count == 2

    @patch("activities.workflow_progress.post_progress")
    @patch("activities.workflow_progress.time.monotonic", return_value=100.0)
    def test_force_bypasses_throttle(self, _mock_time, mock_post):
        reporter = wp.WorkflowProgressReporter("wf-1", "http://workflow-engine:8080")
        reporter.post("phase", 10.0, 1, 10, extra={"_force": True})
        reporter.post("phase", 20.0, 2, 10, extra={"_force": True})
        assert mock_post.call_count == 2
        assert mock_post.call_args_list[0].kwargs["extra"] is None

    def test_reads_url_from_env(self, monkeypatch):
        monkeypatch.setenv("WORKFLOW_ENGINE_URL", "http://engine-from-env:9000")
        reporter = wp.WorkflowProgressReporter("wf-1")
        assert reporter.url == "http://engine-from-env:9000"

    @patch("activities.workflow_progress.post_progress")
    def test_noop_without_workflow_or_url(self, mock_post):
        reporter = wp.WorkflowProgressReporter("", "")
        reporter.post("phase", 0.0, 0, 0)
        mock_post.assert_not_called()
