"""Unit tests for objectstore activities (mocked S3 + credentials)."""

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
pytest.importorskip("temporalio")

from activities import objectstore as os_mod  # noqa: E402


def _call_activity(fn, *args, **kwargs):
    target = getattr(fn, "__wrapped__", fn)
    return target(*args, **kwargs)


def _base_input(**overrides):
    body = {
        "projectID": "proj-1",
        "credentialID": "cred-1",
        "configServiceURL": "http://config-service:3000",
        "connectorConfig": {
            "bucket": "source-bucket",
            "prefix": "incoming/",
            "endpoint": "http://external-s3:9000",
        },
    }
    body.update(overrides)
    return body


@pytest.fixture
def mock_creds(monkeypatch):
    monkeypatch.setattr(
        os_mod,
        "resolve_credential",
        lambda *_a, **_kw: {"access_key_id": "AK", "secret_access_key": "secret"},
    )


@pytest.fixture
def mock_external_client(monkeypatch):
    client = MagicMock()
    monkeypatch.setattr(os_mod, "_get_external_s3_client", lambda *_a, **_kw: client)
    return client


@pytest.fixture
def mock_internal_client(monkeypatch):
    client = MagicMock()
    monkeypatch.setattr(os_mod, "_get_internal_s3_client", lambda: client)
    return client


class TestTestObjectStoreConnection:
    def test_head_bucket_when_bucket_configured(self, mock_creds, mock_external_client):
        mock_external_client.head_bucket.return_value = {}
        out = _call_activity(
            os_mod.test_objectstore_connection,
            _base_input(),
        )
        assert out["success"] is True
        mock_external_client.head_bucket.assert_called_once_with(Bucket="source-bucket")
        mock_external_client.list_buckets.assert_not_called()

    def test_list_buckets_when_no_bucket(self, mock_creds, mock_external_client):
        mock_external_client.list_buckets.return_value = {
            "Buckets": [{"Name": "a"}, {"Name": "b"}],
        }
        inp = _base_input()
        inp["connectorConfig"] = {"endpoint": "http://x:9000"}
        out = _call_activity(os_mod.test_objectstore_connection, inp)
        assert out["success"] is True
        assert out["buckets"] == ["a", "b"]

    def test_returns_failure_on_s3_error(self, mock_creds, mock_external_client):
        mock_external_client.head_bucket.side_effect = Exception("connection refused")
        out = _call_activity(os_mod.test_objectstore_connection, _base_input())
        assert out["success"] is False
        assert "connection refused" in out["message"]


class TestPreviewObjectStore:
    def test_preview_lists_files_and_parquet_sample(
        self,
        mock_creds,
        mock_external_client,
        monkeypatch,
    ):
        import pyarrow as pa

        monkeypatch.setattr(os_mod, "log_activity_start", lambda *_a, **_kw: None)
        monkeypatch.setattr(os_mod, "log_activity_result", lambda *_a, **_kw: None)

        mock_external_client.list_objects_v2.return_value = {
            "Contents": [
                {"Key": "incoming/data.parquet", "Size": 100},
                {"Key": "incoming/readme.txt", "Size": 10},
            ],
        }

        table = pa.table({"id": [1, 2], "name": ["a", "b"]})

        def _download(bucket, key, path):
            pq = __import__("pyarrow.parquet", fromlist=["write_table"])
            pq.write_table(table, path)

        mock_external_client.download_file.side_effect = _download

        out = _call_activity(os_mod.preview_objectstore, _base_input())
        assert len(out["files"]) == 2
        assert out["columns"] == ["id", "name"]
        assert out["rows"]["id"] == [1, 2]

    def test_returns_file_list_without_parquet(
        self,
        mock_creds,
        mock_external_client,
    ):
        mock_external_client.list_objects_v2.return_value = {
            "Contents": [{"Key": "incoming/a.txt", "Size": 4}],
        }
        out = _call_activity(os_mod.preview_objectstore, _base_input())
        assert out["files"] == [{"key": "incoming/a.txt", "size": 4}]
        assert out["columns"] == []
        assert out["rows"] == []


class TestListObjectStoreFiles:
    def test_lists_page_with_continuation_token(self, mock_creds, mock_external_client):
        mock_external_client.list_objects_v2.return_value = {
            "Contents": [
                {
                    "Key": "incoming/a.csv",
                    "Size": 10,
                    "LastModified": MagicMock(isoformat=lambda: "2026-01-01T00:00:00"),
                },
            ],
            "IsTruncated": True,
            "NextContinuationToken": "tok-2",
        }
        out = _call_activity(
            os_mod.list_objectstore_files,
            _base_input(nextToken="tok-1"),
        )
        assert len(out["files"]) == 1
        assert out["files"][0]["key"] == "incoming/a.csv"
        assert out["truncated"] is True
        assert out["nextToken"] == "tok-2"
        call_kw = mock_external_client.list_objects_v2.call_args.kwargs
        assert call_kw["ContinuationToken"] == "tok-1"


class TestAcquireFromObjectStore:
    @pytest.fixture(autouse=True)
    def _activity_stubs(self, monkeypatch):
        monkeypatch.setattr(os_mod.activity, "heartbeat", lambda *_a, **_kw: None)
        reporter = MagicMock()
        reporter.url = ""
        monkeypatch.setattr(
            os_mod, "WorkflowProgressReporter", lambda *_a, **_kw: reporter
        )

    def _paginate(self, mock_external_client, pages):
        paginator = MagicMock()
        paginator.paginate.return_value = pages
        mock_external_client.get_paginator.return_value = paginator

    def test_filters_by_glob_and_uses_download_upload(
        self,
        mock_creds,
        mock_external_client,
        mock_internal_client,
        monkeypatch,
        tmp_path,
    ):
        """Different connector vs worker endpoint -> download_fileobj + POSIX write."""
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setenv("S3_ENDPOINT", "http://internal:9000")

        pages = [
            {
                "Contents": [
                    {"Key": "incoming/keep.csv", "Size": 5},
                    {"Key": "incoming/skip.txt", "Size": 3},
                    {"Key": "incoming/_tmp_bad.csv", "Size": 1},
                ],
            }
        ]
        self._paginate(mock_external_client, pages)

        def _download_fileobj(bucket, key, fileobj):
            fileobj.write(b"data")

        mock_external_client.download_fileobj.side_effect = _download_fileobj

        out = _call_activity(
            os_mod.acquire_from_objectstore,
            _base_input(
                outputPath="/projects/p1/datasets/d1/data_files",
                outputBucket="dest-bucket",
                fileGlob="*.csv",
                fileExcludePattern="_tmp*",
            ),
        )

        assert out["filesCopied"] == 1
        assert out["totalBytes"] == 5
        mock_internal_client.copy_object.assert_not_called()
        dest = tmp_path / "projects/p1/datasets/d1/data_files/keep.csv"
        assert dest.is_file()
        assert dest.read_bytes() == b"data"

    def test_server_side_copy_when_same_cluster(
        self,
        mock_creds,
        mock_external_client,
        mock_internal_client,
        monkeypatch,
    ):
        endpoint = "http://minio:9000"
        monkeypatch.setenv("S3_ENDPOINT", endpoint)
        inp = _base_input(
            connectorConfig={
                "bucket": "src",
                "prefix": "p/",
                "endpoint": endpoint,
            },
            outputPath="/projects/p1/datasets/d1/data_files",
            outputBucket="dest-bucket",
        )
        self._paginate(
            mock_external_client,
            [
                {
                    "Contents": [{"Key": "p/file.csv", "Size": 9}],
                }
            ],
        )
        monkeypatch.setattr(os_mod, "_copy_object_with_backoff", MagicMock())

        out = _call_activity(os_mod.acquire_from_objectstore, inp)

        assert out["filesCopied"] == 1
        assert out["totalBytes"] == 9
        os_mod._copy_object_with_backoff.assert_called_once()
        call = os_mod._copy_object_with_backoff.call_args
        assert call[0][1] == "dest-bucket"
        assert call[0][3] == {"Bucket": "src", "Key": "p/file.csv"}

    def test_requires_output_path(
        self, mock_creds, mock_external_client, mock_internal_client
    ):
        with pytest.raises(ValueError, match="outputPath"):
            _call_activity(os_mod.acquire_from_objectstore, _base_input())

    def test_server_side_copy_requires_output_bucket_for_posix_path(
        self,
        mock_creds,
        mock_external_client,
        mock_internal_client,
        monkeypatch,
    ):
        endpoint = "http://minio:9000"
        monkeypatch.setenv("S3_ENDPOINT", endpoint)
        inp = _base_input(
            connectorConfig={"bucket": "src", "prefix": "", "endpoint": endpoint},
            outputPath="/projects/p1/datasets/d1/data_files",
        )
        self._paginate(
            mock_external_client,
            [
                {
                    "Contents": [{"Key": "f.csv", "Size": 1}],
                }
            ],
        )
        with pytest.raises(ValueError, match="outputBucket"):
            _call_activity(os_mod.acquire_from_objectstore, inp)

    def test_filters_by_max_file_size_and_modified_after(
        self,
        mock_creds,
        mock_external_client,
        mock_internal_client,
        monkeypatch,
        tmp_path,
    ):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setenv("S3_ENDPOINT", "http://internal:9000")

        old_ts = datetime(2020, 1, 1, tzinfo=timezone.utc)
        new_ts = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self._paginate(
            mock_external_client,
            [
                {
                    "Contents": [
                        {
                            "Key": "incoming/huge.csv",
                            "Size": 9999,
                            "LastModified": new_ts,
                        },
                        {"Key": "incoming/old.csv", "Size": 5, "LastModified": old_ts},
                        {"Key": "incoming/new.csv", "Size": 5, "LastModified": new_ts},
                    ],
                }
            ],
        )
        mock_external_client.download_fileobj.side_effect = lambda *_a, **_kw: None

        out = _call_activity(
            os_mod.acquire_from_objectstore,
            _base_input(
                outputPath="/projects/p1/datasets/d1/data_files",
                outputBucket="dest-bucket",
                maxFileSize=100,
                modifiedAfter="2024-01-01T00:00:00Z",
            ),
        )
        assert out["filesCopied"] == 1
