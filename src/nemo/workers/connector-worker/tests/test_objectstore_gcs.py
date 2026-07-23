"""Tests for GCS branch in TestObjectStoreConnection."""
from unittest.mock import MagicMock, patch

from activities.objectstore import _is_gcs_objectstore, _test_gcs_objectstore_connection


def test_is_gcs_objectstore() -> None:
    assert _is_gcs_objectstore({"provider": "gcs"}) is True
    assert _is_gcs_objectstore({"provider": "GCS"}) is True
    assert _is_gcs_objectstore({"provider": "s3"}) is False
    assert _is_gcs_objectstore({}) is False


@patch("activities.gcs_acquisition._gcs_client")
def test_test_gcs_lists_buckets(mock_gcs_client: MagicMock) -> None:
    client = MagicMock()
    mock_gcs_client.return_value = client
    bucket_a = MagicMock()
    bucket_a.name = "bucket-a"
    bucket_b = MagicMock()
    bucket_b.name = "bucket-b"
    client.list_buckets.return_value = [bucket_a, bucket_b]

    creds = {"service_account_json": '{"type":"service_account","project_id":"p1"}'}
    result = _test_gcs_objectstore_connection(creds, {"provider": "gcs"})

    assert result["success"] is True
    assert result["buckets"] == ["bucket-a", "bucket-b"]


@patch("activities.gcs_acquisition._gcs_client")
def test_test_gcs_head_bucket(mock_gcs_client: MagicMock) -> None:
    client = MagicMock()
    mock_gcs_client.return_value = client
    bucket = MagicMock()
    bucket.exists.return_value = True
    client.bucket.return_value = bucket

    creds = {"service_account_json": '{"type":"service_account","project_id":"p1"}'}
    result = _test_gcs_objectstore_connection(creds, {"provider": "gcs", "bucket": "my-bucket"})

    assert result["success"] is True
    client.bucket.assert_called_once_with("my-bucket")
