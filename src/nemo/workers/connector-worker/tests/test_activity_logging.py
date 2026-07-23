"""Unit tests for activity logging helpers."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

pytest.importorskip("temporalio")

from activities import activity_logging as al


class TestSanitizeForLog:
    def test_redacts_secret_keys(self):
        payload = {
            "username": "alice",
            "password": "secret",
            "nested": {"access_token": "tok", "count": 3},
            "service_account_json": '{"type":"service_account"}',
        }
        out = al.sanitize_for_log(payload)
        assert out["username"] == "alice"
        assert out["password"] == "***"
        assert out["nested"]["access_token"] == "***"
        assert out["nested"]["count"] == 3
        assert out["service_account_json"] == "***"

    def test_passthrough_scalars(self):
        assert al.sanitize_for_log(None) is None
        assert al.sanitize_for_log(42) == 42
        assert al.sanitize_for_log("ok") == "ok"

    def test_unknown_object_becomes_type_name(self):
        class Blob:
            pass

        assert al.sanitize_for_log(Blob()) == "Blob"


class TestActivityContext:
    @patch("activities.activity_logging.activity.info")
    def test_returns_temporal_context(self, mock_info):
        mock_info.return_value = MagicMock(
            workflow_id="wf-1",
            workflow_run_id="run-1",
            activity_id="act-1",
            activity_type="TestActivity",
        )
        ctx = al.get_activity_context()
        assert ctx["workflow_id"] == "wf-1"
        assert ctx["activity_type"] == "TestActivity"

    @patch(
        "activities.activity_logging.activity.info",
        side_effect=RuntimeError("no activity"),
    )
    def test_returns_empty_on_failure(self, _mock_info):
        assert al.get_activity_context() == {}


class TestLogActivityStartAndResult:
    @patch("activities.activity_logging.clear_context")
    @patch("activities.activity_logging.bind_context")
    @patch("activities.activity_logging.get_activity_context")
    @patch("activities.activity_logging.logger")
    def test_log_activity_start(self, mock_logger, mock_ctx, mock_bind, mock_clear):
        mock_ctx.return_value = {
            "workflow_id": "wf-1",
            "workflow_run_id": "run-1",
            "activity_id": "act-1",
            "activity_type": "Acquire",
        }
        al.log_activity_start({"password": "x", "projectID": "p1"})
        mock_clear.assert_called_once()
        mock_bind.assert_called_once()
        mock_logger.info.assert_called_once()

    @patch("activities.activity_logging.clear_context")
    @patch("activities.activity_logging.get_activity_context")
    @patch("activities.activity_logging.logger")
    def test_log_activity_result_summarizes_large_payload(
        self, mock_logger, mock_ctx, mock_clear
    ):
        mock_ctx.return_value = {
            "workflow_id": "wf-1",
            "workflow_run_id": "run-1",
            "activity_type": "Acquire",
        }
        al.log_activity_result({"rows": [1, 2, 3], "files": ["a"], "ok": True})
        summary = mock_logger.info.call_args[0][-1]
        assert summary["rowCount"] == 3
        assert summary["fileCount"] == 1
        assert "rows" not in summary
        mock_clear.assert_called_once()

    @patch("activities.activity_logging.clear_context")
    @patch("activities.activity_logging.get_activity_context")
    @patch("activities.activity_logging.logger")
    def test_log_activity_result_error_path(self, mock_logger, mock_ctx, mock_clear):
        mock_ctx.return_value = {
            "workflow_id": "wf-1",
            "workflow_run_id": "run-1",
            "activity_type": "Acquire",
        }
        al.log_activity_result({"ok": False}, error=ValueError("boom"))
        mock_logger.warning.assert_called_once()
        mock_clear.assert_called_once()
