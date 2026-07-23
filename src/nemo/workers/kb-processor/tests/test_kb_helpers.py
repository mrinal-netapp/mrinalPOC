"""Unit tests for utils/kb_helpers.py: kb_s3_prefix, normalize_manifest_file_keys,
create_data_source, and update_kb_status.

None of these had direct test coverage before, despite being on the hot
path of both the Temporal partition worker and the in-process orchestrator.
"""

import sys
from pathlib import Path
from unittest import mock

import pytest

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

sys.modules.setdefault("lancedb", mock.MagicMock())

import utils.kb_helpers as kb_helpers_mod
from utils.kb_helpers import create_data_source, kb_s3_prefix, normalize_manifest_file_keys, update_kb_status
from utils.config import Config
from data_sources.structured import StructuredDataSource
from data_sources.unstructured import UnstructuredDataSource


def _make_config(**overrides) -> Config:
    base = dict(
        kb_id="kb1",
        kb_name="my-kb",
        project_id="proj1",
        source_dataset_id="d1",
        bucket_name="bucket-1",
        namespace="ns1",
        embedding_model="sentence-transformers/all-MiniLM-L6-v2",
        chunk_size=512,
        chunk_overlap=50,
        chunk_strategy="fixed",
        chunk_options={},
        vector_size=384,
        data_type="float32",
        processing_mode="full",
        indexing_mode="hybrid",
        quantization_type="auto",
        quantization_options={},
        embedding_batch_size=64,
        config_service_url="http://config-service:3000",
        keycloak_internal_issuer="http://keycloak/realms/nemo",
        project_client_id="client-1",
        project_client_secret="secret-1",
        s3_endpoint="http://s3gateway:7070",
        aws_access_key_id="AKIA",
        aws_secret_access_key="secret",
        aws_region="us-east-1",
        s3_path_prefix="projects/proj1",
        dataset_kind="unstructured",
        catalog_table_ref=None,
        lakekeeper_url="http://lakekeeper:8181",
        warehouse_id="wh-1",
        text_columns=None,
    )
    base.update(overrides)
    return Config(**base)


class TestKbS3Prefix:
    def test_with_path_prefix(self):
        assert kb_s3_prefix("kb1", "projects/p1") == "projects/p1/knowledgebases/kb1"

    def test_without_path_prefix(self):
        assert kb_s3_prefix("kb1", "") == "knowledgebases/kb1"


class TestNormalizeManifestFileKeys:
    def test_plain_string_keys_pass_through(self):
        assert normalize_manifest_file_keys(["a.txt", "b.txt"]) == ["a.txt", "b.txt"]

    def test_dict_with_key_field(self):
        assert normalize_manifest_file_keys([{"key": "a.txt", "size": 10}]) == ["a.txt"]

    def test_dict_with_uri_field(self):
        assert normalize_manifest_file_keys([{"uri": "a.txt"}]) == ["a.txt"]

    def test_dict_with_filename_field(self):
        assert normalize_manifest_file_keys([{"fileName": "a.txt"}]) == ["a.txt"]

    def test_s3_uri_strips_bucket_segment(self):
        assert normalize_manifest_file_keys(["s3://my-bucket/datasets/d1/a.txt"]) == ["datasets/d1/a.txt"]

    def test_s3_uri_in_dict_key_field(self):
        assert normalize_manifest_file_keys([{"key": "s3://my-bucket/a.txt"}]) == ["a.txt"]

    def test_empty_and_none_entries_are_dropped(self):
        assert normalize_manifest_file_keys(["", None, {"key": ""}, {}]) == []

    def test_empty_input_returns_empty_list(self):
        assert normalize_manifest_file_keys([]) == []
        assert normalize_manifest_file_keys(None) == []

    def test_mixed_shapes_in_one_manifest(self):
        raw = ["a.txt", {"key": "b.txt"}, {"uri": "s3://bucket/c.txt"}]
        assert normalize_manifest_file_keys(raw) == ["a.txt", "b.txt", "c.txt"]

    def test_s3_uri_with_bucket_only_and_no_key_segment(self):
        """`s3://bucket-only` (no trailing `/key`) has nothing to strip —
        the whole "rest" (minus the scheme) passes through unchanged."""
        assert normalize_manifest_file_keys(["s3://bucket-only"]) == ["bucket-only"]


class TestCreateDataSource:
    def test_unstructured_returns_unstructured_data_source(self):
        config = _make_config(dataset_kind="unstructured")
        source = create_data_source(config)
        assert isinstance(source, UnstructuredDataSource)
        assert source.dataset_id == "d1"

    def test_unstructured_passes_through_file_keys(self):
        config = _make_config(dataset_kind="unstructured")
        source = create_data_source(config, file_keys=["a.txt", "b.txt"])
        assert source._file_keys_filter == ["a.txt", "b.txt"]

    def test_structured_returns_structured_data_source_with_fresh_token(self):
        config = _make_config(dataset_kind="structured", catalog_table_ref="ns.tbl", text_columns=["body"])
        with mock.patch.object(kb_helpers_mod, "get_access_token", return_value="fresh-token") as mock_token:
            source = create_data_source(config)

        assert isinstance(source, StructuredDataSource)
        mock_token.assert_called_once_with(
            keycloak_url="http://keycloak/realms/nemo",
            client_id="client-1",
            client_secret="secret-1",
        )
        assert source.token == "fresh-token"
        assert source.catalog_table_ref == "ns.tbl"
        assert source.text_columns == ["body"]


class TestUpdateKbStatus:
    def test_puts_expected_payload(self):
        config = _make_config()
        mock_session = mock.MagicMock()
        with mock.patch.object(kb_helpers_mod, "get_authenticated_session", return_value=mock_session):
            update_kb_status(config, "ready", lance_table_path="kb1/lancedb-run-1")

        mock_session.put.assert_called_once()
        url, kwargs = mock_session.put.call_args.args[0], mock_session.put.call_args.kwargs
        assert url == "http://config-service:3000/api/v1/projects/proj1/knowledgebases/kb1"
        assert kwargs["json"] == {"status": "ready", "lanceTablePath": "kb1/lancedb-run-1"}

    def test_includes_error_message_when_provided(self):
        config = _make_config()
        mock_session = mock.MagicMock()
        with mock.patch.object(kb_helpers_mod, "get_authenticated_session", return_value=mock_session):
            update_kb_status(config, "errored", error_message="boom")

        kwargs = mock_session.put.call_args.kwargs
        assert kwargs["json"] == {"status": "errored", "errorMessage": "boom"}

    def test_swallows_request_exceptions(self):
        import requests
        config = _make_config()
        mock_session = mock.MagicMock()
        mock_session.put.side_effect = requests.exceptions.ConnectionError("down")
        with mock.patch.object(kb_helpers_mod, "get_authenticated_session", return_value=mock_session):
            # Must not raise -- best-effort status update.
            update_kb_status(config, "ready")

    def test_swallows_http_error_from_raise_for_status(self):
        import requests
        config = _make_config()
        mock_session = mock.MagicMock()
        mock_response = mock.MagicMock()
        mock_response.raise_for_status.side_effect = requests.exceptions.HTTPError("500")
        mock_session.put.return_value = mock_response
        with mock.patch.object(kb_helpers_mod, "get_authenticated_session", return_value=mock_session):
            update_kb_status(config, "ready")
