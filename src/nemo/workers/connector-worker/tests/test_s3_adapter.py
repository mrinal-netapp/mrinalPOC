"""Unit tests for the S3 explorer adapter (mocked boto3)."""
from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

pytest.importorskip("boto3")

from adapters.s3_adapter import S3Adapter  # noqa: E402

CFG = {"endpoint": "http://minio:9000", "region": "us-east-1", "bucket": "default-bucket"}
CRED = {"access_key_id": "AKIA", "secret_access_key": "secret"}


def _adapter() -> S3Adapter:
    return S3Adapter()


@pytest.fixture
def mock_s3_client(monkeypatch):
    client = MagicMock()
    monkeypatch.setattr(
        "adapters.s3_adapter.get_external_s3_client",
        lambda _creds, _cfg: client,
    )
    return client


class TestDispatcher:
    def test_unsupported_action(self):
        resp = _adapter().execute(CFG, CRED, "deleteBucket", {})
        assert resp.error is not None
        assert resp.error.code == "UNSUPPORTED_ACTION"

    def test_provider_error_when_list_buckets_fails(self, monkeypatch):
        def _boom(_c, _cfg):
            client = MagicMock()
            client.list_buckets.side_effect = RuntimeError("connection reset")
            return client

        monkeypatch.setattr("adapters.s3_adapter.get_external_s3_client", _boom)
        resp = _adapter().execute(CFG, CRED, "listBuckets", {})
        assert resp.error.code == "PROVIDER_ERROR"
        assert "connection reset" in resp.error.message


class TestListBuckets:
    def test_lists_buckets_as_folder_nodes(self, mock_s3_client):
        mock_s3_client.list_buckets.return_value = {
            "Buckets": [
                {"Name": "data-lake"},
                {"Name": ""},
                {"Name": "archive"},
            ],
        }
        resp = _adapter()._list_buckets(CFG, CRED)
        assert resp.error is None
        labels = [n.label for n in resp.nodes]
        assert labels == ["data-lake", "archive"]
        node = resp.nodes[0]
        assert node.id == "s3://data-lake"
        assert node.type == "folder"
        assert node.resource == {"bucket": "data-lake", "prefix": ""}
        assert node.actions == ["listPath"]

    def test_empty_bucket_list(self, mock_s3_client):
        mock_s3_client.list_buckets.return_value = {"Buckets": []}
        resp = _adapter()._list_buckets(CFG, CRED)
        assert resp.nodes == []


class TestListPath:
    def test_validation_error_when_bucket_missing(self, mock_s3_client):
        resp = _adapter()._list_path(
            {"prefix": "x/"},
            CRED,
            {"prefix": "incoming/"},
        )
        assert resp.error.code == "VALIDATION_ERROR"
        mock_s3_client.list_objects_v2.assert_not_called()

    def test_lists_folders_and_files(self, mock_s3_client):
        ts = datetime(2026, 3, 1, 12, 0, tzinfo=timezone.utc)
        mock_s3_client.list_objects_v2.return_value = {
            "CommonPrefixes": [{"Prefix": "incoming/sub/"}],
            "Contents": [
                {"Key": "incoming/", "Size": 0},
                {"Key": "incoming/report.pdf", "Size": 4096, "LastModified": ts},
                {"Key": "incoming/", "Size": 0},
            ],
            "NextContinuationToken": "token-2",
        }
        resp = _adapter()._list_path(
            CFG,
            CRED,
            {"bucket": "src", "prefix": "incoming/", "delimiter": "/"},
        )
        assert resp.error is None
        assert resp.next_token == "token-2"
        labels = {n.label for n in resp.nodes}
        assert "sub" in labels
        assert "report.pdf" in labels
        file_node = next(n for n in resp.nodes if n.label == "report.pdf")
        assert file_node.type == "file"
        assert file_node.kind == "pdf"
        assert file_node.metadata["size"] == 4096
        folder = next(n for n in resp.nodes if n.label == "sub")
        assert folder.type == "folder"
        assert folder.resource["prefix"] == "incoming/sub/"

    def test_uses_bucket_from_connector_config(self, mock_s3_client):
        mock_s3_client.list_objects_v2.return_value = {"Contents": []}
        _adapter()._list_path({"bucket": "cfg-bucket"}, CRED, {"prefix": ""})
        kw = mock_s3_client.list_objects_v2.call_args.kwargs
        assert kw["Bucket"] == "cfg-bucket"

    def test_passes_continuation_token(self, mock_s3_client):
        mock_s3_client.list_objects_v2.return_value = {"Contents": []}
        _adapter()._list_path(CFG, CRED, {
            "bucket": "b",
            "prefix": "",
            "nextToken": "cont-1",
            "maxKeys": 50,
        })
        kw = mock_s3_client.list_objects_v2.call_args.kwargs
        assert kw["ContinuationToken"] == "cont-1"
        assert kw["MaxKeys"] == 50


class TestResolve:
    def test_merges_resource_selector(self):
        effective = _adapter().resolve(
            {"bucket": "b1", "prefix": "p1/"},
            CRED,
            {"bucket": "b2", "prefix": "p2/"},
        )
        assert effective["bucket"] == "b2"
        assert effective["prefix"] == "p2/"
