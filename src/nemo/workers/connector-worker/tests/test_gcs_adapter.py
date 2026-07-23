"""Unit tests for the GCS object-store adapter."""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

from adapters.base import ExplorerNode, ExplorerResponse
from adapters.gcs_adapter import GCSAdapter, _resolve_project_id

FAKE_SA = json.dumps(
    {
        "type": "service_account",
        "project_id": "my-gcp-project",
        "private_key_id": "k1",
        "private_key": "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
        "client_email": "sa@my-gcp-project.iam.gserviceaccount.com",
        "client_id": "1",
    }
)
CRED = {"service_account_json": FAKE_SA}


class TestResolveProjectId:
    def test_prefers_connector_config(self):
        assert _resolve_project_id({"project_id": "cfg-proj"}, CRED) == "cfg-proj"

    def test_falls_back_to_sa_json(self):
        assert _resolve_project_id({}, CRED) == "my-gcp-project"

    def test_returns_empty_when_missing(self):
        assert _resolve_project_id({}, {}) == ""


class TestGCSAdapter:
    def setup_method(self):
        self.adapter = GCSAdapter()

    @patch("adapters.gcs_adapter.GCPAdapter._list_buckets")
    @patch("adapters.gcs_adapter._build_credentials")
    def test_list_buckets_delegates_to_gcp(self, mock_build, mock_list_buckets):
        mock_list_buckets.return_value = ExplorerResponse(
            nodes=[ExplorerNode(id="b1", label="bucket-a", type="bucket")],
        )
        mock_build.return_value = MagicMock()

        out = self.adapter.execute({"project_id": "p1"}, CRED, "listBuckets", {})
        assert out.nodes[0].label == "bucket-a"
        mock_list_buckets.assert_called_once()

    @patch("adapters.gcs_adapter.GCPAdapter._list_path")
    @patch("adapters.gcs_adapter._build_credentials")
    def test_list_path_delegates_to_gcp(self, mock_build, mock_list_path):
        mock_list_path.return_value = ExplorerResponse(nodes=[])
        mock_build.return_value = MagicMock()

        out = self.adapter.execute(
            {"project_id": "p1", "bucket": "b1"},
            CRED,
            "listPath",
            {"prefix": "data/"},
        )
        assert out.error is None
        mock_list_path.assert_called_once()

    @patch("adapters.gcs_adapter._build_credentials", return_value=MagicMock())
    def test_unsupported_action(self, _mock_build):
        out = self.adapter.execute({"project_id": "p1"}, CRED, "deleteBucket", {})
        assert out.error.code == "UNSUPPORTED_ACTION"

    @patch(
        "adapters.gcs_adapter._build_credentials",
        side_effect=json.JSONDecodeError("bad", "", 0),
    )
    def test_invalid_credential_json(self, _mock_build):
        out = self.adapter.execute(
            {"project_id": "p1"},
            {"service_account_json": "not-json"},
            "listBuckets",
            {},
        )
        assert out.error.code == "CREDENTIAL_ERROR"

    @patch("adapters.gcs_adapter._build_credentials", side_effect=RuntimeError("boom"))
    def test_provider_error(self, _mock_build):
        out = self.adapter.execute({"project_id": "p1"}, CRED, "listBuckets", {})
        assert out.error.code == "PROVIDER_ERROR"
