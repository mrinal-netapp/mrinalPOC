"""Unit tests for AcquireFromGCS and GCS acquisition helpers."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

pytest.importorskip("temporalio")

from activities import gcs_acquisition as ga

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


@pytest.fixture(autouse=True)
def patch_heartbeat(monkeypatch):
    monkeypatch.setattr(
        "activities.gcs_acquisition.activity.heartbeat", lambda *_a, **_k: None
    )


@pytest.fixture
def store_root(tmp_path, monkeypatch):
    monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
    return tmp_path


class TestGcsHelpers:
    def test_default_store_root_raises(self, monkeypatch):
        monkeypatch.delenv("NEMO_DEFAULT_STORE_ROOT", raising=False)
        with pytest.raises(RuntimeError, match="NEMO_DEFAULT_STORE_ROOT"):
            ga._default_store_root()

    @patch(
        "activities.gcs_acquisition.resolve_gcp_service_account_json", return_value=""
    )
    def test_gcs_client_requires_sa_json(self, _mock_sa):
        with pytest.raises(ValueError, match="service account JSON"):
            ga._gcs_client({}, "proj")

    def test_list_candidate_blobs_skips_directory_placeholders(self):
        client = MagicMock()
        blob_file = MagicMock()
        blob_file.name = "prefix/file.txt"
        blob_file.size = 10
        blob_dir = MagicMock()
        blob_dir.name = "prefix/dir/"
        blob_dir.size = 0
        client.list_blobs.return_value = [blob_file, blob_dir]
        client.bucket.return_value = MagicMock()

        out = ga._list_candidate_blobs(client, "bucket-a", "prefix")
        assert out == [("prefix/file.txt", 10)]


class TestAcquireFromGcs:
    def test_requires_output_path(self, store_root):
        with pytest.raises(ValueError, match="outputPath"):
            _call_activity(
                ga.acquire_from_gcs,
                {
                    "connectorConfig": {"bucket": "b1"},
                    "configServiceURL": "http://config-service:3000",
                    "projectID": "p1",
                    "credentialID": "c1",
                },
            )

    def test_requires_bucket(self, store_root):
        with pytest.raises(ValueError, match="bucket is required"):
            _call_activity(
                ga.acquire_from_gcs,
                {
                    "connectorConfig": {},
                    "outputPath": "projects/p1/datasets/d1",
                    "configServiceURL": "http://config-service:3000",
                    "projectID": "p1",
                    "credentialID": "c1",
                },
            )

    @patch(
        "activities.gcs_acquisition.resolve_credential",
        return_value={"service_account_json": json.dumps(FAKE_SA)},
    )
    @patch("activities.gcs_acquisition._gcs_client")
    def test_copies_matching_files(self, mock_gcs_client, _mock_cred, store_root):
        client = MagicMock()
        mock_gcs_client.return_value = client

        blob = MagicMock()
        blob.name = "data/incoming/file1.csv"
        blob.size = 12
        blob.download_to_filename = MagicMock(
            side_effect=lambda path: Path(path).write_text("payload"),
        )
        client.list_blobs.return_value = [blob]
        bucket = MagicMock()
        bucket.blob.return_value = blob
        client.bucket.return_value = bucket

        out = _call_activity(
            ga.acquire_from_gcs,
            {
                "connectorConfig": {
                    "project_id": "my-proj",
                    "bucket": "source-bucket",
                    "prefix": "data/incoming",
                },
                "outputPath": "projects/p1/datasets/d1/data",
                "configServiceURL": "http://config-service:3000",
                "projectID": "p1",
                "credentialID": "c1",
                "datasetID": "d1",
                "workflowID": "wf-1",
                "workflowRunID": "run-1",
            },
        )

        assert out["filesCopied"] == 1.0
        copied = store_root / "projects/p1/datasets/d1/data/file1.csv"
        assert copied.read_text() == "payload"
        filelist = json.loads(
            (store_root / out["fileListKey"]).read_text(encoding="utf-8"),
        )
        assert filelist["source"] == "gcs"
        assert filelist["totalFiles"] == 1

    @patch(
        "activities.gcs_acquisition.resolve_credential",
        return_value={"service_account_json": json.dumps(FAKE_SA)},
    )
    @patch("activities.gcs_acquisition._gcs_client")
    def test_applies_glob_filters(self, mock_gcs_client, _mock_cred, store_root):
        client = MagicMock()
        mock_gcs_client.return_value = client

        blobs = []
        for name, size in [("data/a.csv", 1), ("data/b.txt", 2)]:
            blob = MagicMock()
            blob.name = name
            blob.size = size
            blobs.append(blob)
        client.list_blobs.return_value = blobs
        bucket = MagicMock()
        matched_blob = MagicMock()
        matched_blob.download_to_filename = MagicMock(
            side_effect=lambda path: Path(path).write_text("csv"),
        )
        bucket.blob.return_value = matched_blob
        client.bucket.return_value = bucket

        out = _call_activity(
            ga.acquire_from_gcs,
            {
                "connectorConfig": {"bucket": "b1", "prefix": "data"},
                "outputPath": "projects/p1/datasets/d1",
                "fileGlob": "*.csv",
                "configServiceURL": "http://config-service:3000",
                "projectID": "p1",
                "credentialID": "c1",
            },
        )

        assert out["filesCopied"] == 1.0
