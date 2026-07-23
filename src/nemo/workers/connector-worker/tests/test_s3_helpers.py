"""Unit tests for activities.s3_helpers (pure helpers + copy retry)."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

pytest.importorskip("boto3")
from botocore.exceptions import ClientError  # noqa: E402

from activities import s3_helpers as sh  # noqa: E402


def _client_error(code: str) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "test"}}, "TestOp")


class TestParseGlobPatterns:
    def test_empty_returns_empty_list(self):
        assert sh.parse_glob_patterns("") == []
        assert sh.parse_glob_patterns("   ") == []

    def test_comma_separated_strips_and_skips_blanks(self):
        assert sh.parse_glob_patterns(" *.csv , *.parquet ,  ") == ["*.csv", "*.parquet"]


class TestMatchesAnyPattern:
    def test_empty_patterns_matches_all(self):
        assert sh.matches_any_pattern("file.csv", []) is True

    def test_matches_fnmatch(self):
        assert sh.matches_any_pattern("events.parquet", ["*.parquet"]) is True
        assert sh.matches_any_pattern("events.parquet", ["*.csv"]) is False

    def test_any_of_multiple_patterns(self):
        patterns = ["*.csv", "*.json"]
        assert sh.matches_any_pattern("a.json", patterns) is True
        assert sh.matches_any_pattern("a.txt", patterns) is False


class TestRelativeKeyUnderPrefix:
    def test_strips_prefix_preserving_subdirs(self):
        assert sh.relative_key_under_prefix("data/in/", "data/in/a/b.csv") == "a/b.csv"

    def test_no_prefix_uses_basename_only(self):
        assert sh.relative_key_under_prefix("", "folder/file.txt") == "file.txt"

    def test_key_equals_prefix_returns_basename(self):
        assert sh.relative_key_under_prefix("data", "data") == "data"


class TestResolveS3Credentials:
    def test_session_token_aliases(self):
        assert sh.resolve_s3_session_token({"session_token": "tok-a"}) == "tok-a"
        assert sh.resolve_s3_session_token({"aws_session_token": "tok-b"}) == "tok-b"
        assert sh.resolve_s3_session_token({"access_key_id": "x"}) is None

    def test_access_key_aliases(self):
        assert sh.resolve_s3_access_key_id({"access_key_id": "AKIA1"}) == "AKIA1"
        assert sh.resolve_s3_access_key_id({"aws_access_key_id": "AKIA2"}) == "AKIA2"


class TestGetExternalS3ClientSessionToken:
    def test_passes_aws_session_token_to_boto3(self, monkeypatch):
        captured: dict = {}

        def fake_client(service_name, **kwargs):
            captured.update(kwargs)
            return MagicMock()

        monkeypatch.setattr(sh.boto3, "client", fake_client)
        sh.get_external_s3_client(
            {
                "access_key_id": "AKIA",
                "secret_access_key": "secret",
                "session_token": "sso-token",
            },
            {"region": "us-east-1"},
        )
        assert captured["aws_session_token"] == "sso-token"
        assert captured["aws_access_key_id"] == "AKIA"

    def test_omits_token_when_absent(self, monkeypatch):
        captured: dict = {}

        def fake_client(service_name, **kwargs):
            captured.update(kwargs)
            return MagicMock()

        monkeypatch.setattr(sh.boto3, "client", fake_client)
        sh.get_external_s3_client(
            {"access_key_id": "AKIA", "secret_access_key": "secret"},
            {},
        )
        assert "aws_session_token" not in captured


class TestSameClusterAsWorker:
    def test_true_when_origins_match(self, monkeypatch):
        monkeypatch.setenv("S3_ENDPOINT", "http://minio:9000")
        assert sh.same_cluster_as_worker("http://minio:9000") is True
        assert sh.same_cluster_as_worker("http://minio:9000/") is True

    def test_false_when_connector_differs(self, monkeypatch):
        monkeypatch.setenv("S3_ENDPOINT", "http://minio:9000")
        assert sh.same_cluster_as_worker("https://s3.amazonaws.com") is False

    def test_false_when_worker_endpoint_unset(self, monkeypatch):
        monkeypatch.delenv("S3_ENDPOINT", raising=False)
        assert sh.same_cluster_as_worker("http://minio:9000") is False


class TestSplitS3Path:
    def test_bucket_and_prefix(self):
        assert sh.split_s3_path("s3://my-bucket/path/to/data/") == ("my-bucket", "path/to/data")

    def test_bucket_only(self):
        assert sh.split_s3_path("s3://only-bucket") == ("only-bucket", "")


class TestResolveAcquisitionDest:
    def test_posix_output_path_requires_bucket(self):
        with pytest.raises(ValueError, match="outputPath"):
            sh.resolve_acquisition_dest({})
        bucket, prefix = sh.resolve_acquisition_dest({
            "outputPath": "/projects/p/datasets/d/data_files",
            "outputBucket": "nemo-default",
        })
        assert bucket == "nemo-default"
        assert prefix == "projects/p/datasets/d/data_files"

    def test_legacy_s3_uri(self):
        bucket, prefix = sh.resolve_acquisition_dest({
            "outputS3Path": "s3://dest-bucket/projects/p/datasets/d/data_files",
        })
        assert bucket == "dest-bucket"
        assert prefix == "projects/p/datasets/d/data_files"

    def test_snake_case_keys(self):
        bucket, prefix = sh.resolve_acquisition_dest({
            "output_path": "/projects/p/datasets/d/data_files",
            "output_bucket": "b1",
        })
        assert bucket == "b1"
        assert prefix == "projects/p/datasets/d/data_files"


class TestIsRetriableS3Error:
    @pytest.mark.parametrize("code", [
        "SlowDown", "InternalError", "ServiceUnavailable", "Throttling",
    ])
    def test_retriable_codes(self, code):
        assert sh.is_retriable_s3_error(_client_error(code)) is True

    def test_non_retriable_client_error(self):
        assert sh.is_retriable_s3_error(_client_error("AccessDenied")) is False

    def test_non_client_error(self):
        assert sh.is_retriable_s3_error(RuntimeError("network")) is False


class TestCopyObjectWithBackoff:
    def test_succeeds_on_first_attempt(self, monkeypatch):
        monkeypatch.setattr(sh.time, "sleep", MagicMock())
        client = MagicMock()
        sh.copy_object_with_backoff(
            client, "dest", "key", {"Bucket": "src", "Key": "k"},
        )
        client.copy_object.assert_called_once()

    def test_retries_then_succeeds(self, monkeypatch):
        sleeps: list[float] = []
        monkeypatch.setattr(sh.time, "sleep", lambda s: sleeps.append(s))
        client = MagicMock()
        client.copy_object.side_effect = [
            _client_error("SlowDown"),
            None,
        ]
        sh.copy_object_with_backoff(
            client, "dest", "key", {"Bucket": "src", "Key": "k"},
            max_attempts=3,
        )
        assert client.copy_object.call_count == 2
        assert len(sleeps) == 1

    def test_raises_immediately_on_non_retriable(self, monkeypatch):
        monkeypatch.setattr(sh.time, "sleep", MagicMock())
        client = MagicMock()
        client.copy_object.side_effect = _client_error("AccessDenied")
        with pytest.raises(ClientError):
            sh.copy_object_with_backoff(
                client, "dest", "key", {"Bucket": "src", "Key": "k"},
            )
        assert client.copy_object.call_count == 1
