"""Unit tests for TestCloudConnection activity."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

pytest.importorskip("temporalio")

from activities import cloud_test as ct

FAKE_SA = {
    "type": "service_account",
    "project_id": "my-proj",
    "private_key_id": "key1",
    "private_key": "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
    "client_email": "sa@my-proj.iam.gserviceaccount.com",
    "client_id": "123",
}


def _call_activity(fn, *args, **kwargs):
    target = getattr(fn, "__wrapped__", fn)
    return target(*args, **kwargs)


def _base_input(**overrides):
    body = {
        "projectID": "proj-1",
        "credentialID": "cred-1",
        "configServiceURL": "http://config-service:3000",
        "connectorConfig": {"project_id": "my-proj"},
    }
    body.update(overrides)
    return body


class TestTestCloudConnection:
    @patch("activities.cloud_test.build")
    @patch(
        "activities.cloud_test.service_account.Credentials.from_service_account_info"
    )
    @patch("activities.cloud_test.resolve_gcp_service_account_json")
    @patch("activities.cloud_test.resolve_credential")
    def test_success(self, mock_resolve_cred, mock_sa_json, mock_from_info, mock_build):
        mock_resolve_cred.return_value = {"service_account_json": json.dumps(FAKE_SA)}
        mock_sa_json.return_value = json.dumps(FAKE_SA)

        svc = MagicMock()
        svc.regions.return_value.list.return_value.execute.return_value = {
            "items": [{"name": "us-central1"}],
        }
        mock_build.return_value = svc

        out = _call_activity(ct.test_cloud_connection, _base_input())

        assert out["success"] is True
        assert "my-proj" in out["message"]
        mock_build.assert_called_once()

    @patch("activities.cloud_test.resolve_gcp_service_account_json", return_value="")
    @patch("activities.cloud_test.resolve_credential", return_value={})
    def test_missing_service_account_json(self, _mock_cred, _mock_sa):
        out = _call_activity(ct.test_cloud_connection, _base_input())
        assert out["success"] is False
        assert "missing service account JSON" in out["message"]

    @patch(
        "activities.cloud_test.resolve_gcp_service_account_json",
        return_value="not-json",
    )
    @patch("activities.cloud_test.resolve_credential", return_value={})
    def test_invalid_json(self, _mock_cred, _mock_sa):
        out = _call_activity(ct.test_cloud_connection, _base_input())
        assert out["success"] is False
        assert "Invalid service account JSON" in out["message"]

    @patch("activities.cloud_test.build", side_effect=RuntimeError("API unavailable"))
    @patch(
        "activities.cloud_test.service_account.Credentials.from_service_account_info"
    )
    @patch("activities.cloud_test.resolve_gcp_service_account_json")
    @patch("activities.cloud_test.resolve_credential")
    def test_api_failure(
        self, mock_resolve_cred, mock_sa_json, _mock_from_info, _mock_build
    ):
        mock_resolve_cred.return_value = {}
        mock_sa_json.return_value = json.dumps(FAKE_SA)

        out = _call_activity(ct.test_cloud_connection, _base_input())

        assert out["success"] is False
        assert "Connection failed" in out["message"]
