"""Unit tests for processor.py helpers: compute_files_to_process,
get_source_files_with_metadata, _create_embedder, and ProgressTracker.

These are the core building blocks of the in-process KB orchestration
(``main()``) and of the incremental-processing feature; none had direct
unit coverage before.
"""

import os
import sys
import time
from pathlib import Path
from unittest import mock

import pytest

pytest.importorskip("pyarrow")

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

# processor.py -> processing/lancedb_writer.py imports lancedb at module load.
sys.modules.setdefault("lancedb", mock.MagicMock())

import processor
from processor import ProgressTracker, _create_embedder, compute_files_to_process, get_source_files_with_metadata
from utils.config import Config


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
        llm_gateway_url="http://bifrost:8080",
        project_virtual_key_token="vk-token",
    )
    base.update(overrides)
    return Config(**base)


class TestComputeFilesToProcess:
    def test_full_mode_returns_all_files_and_resets_tracking(self):
        current = {"a.txt": {"last_modified": "2024-01-01T00:00:00Z"}, "b.txt": {"last_modified": "2024-01-02T00:00:00Z"}}
        processed = {"a.txt": {"last_modified": "2020-01-01T00:00:00Z"}}

        to_process, updated = compute_files_to_process(current, processed, "full")

        assert to_process == {"a.txt", "b.txt"}
        assert updated == {}

    def test_incremental_new_file_is_included(self):
        current = {"new.txt": {"last_modified": "2024-01-01T00:00:00Z"}}
        processed = {}

        to_process, updated = compute_files_to_process(current, processed, "incremental")

        assert to_process == {"new.txt"}
        # processed_files is returned unchanged (caller merges results after processing)
        assert updated == {}

    def test_incremental_modified_file_is_included(self):
        current = {"a.txt": {"last_modified": "2024-06-01T00:00:00Z"}}
        processed = {"a.txt": {"last_modified": "2024-01-01T00:00:00Z"}}

        to_process, _ = compute_files_to_process(current, processed, "incremental")

        assert to_process == {"a.txt"}

    def test_incremental_unchanged_file_is_skipped(self):
        current = {"a.txt": {"last_modified": "2024-01-01T00:00:00Z"}}
        processed = {"a.txt": {"last_modified": "2024-01-01T00:00:00Z"}}

        to_process, _ = compute_files_to_process(current, processed, "incremental")

        assert to_process == set()

    def test_incremental_with_no_prior_state_treats_all_as_new(self):
        current = {"a.txt": {"last_modified": "t1"}, "b.txt": {"last_modified": "t2"}}

        to_process, _ = compute_files_to_process(current, {}, "incremental")

        assert to_process == {"a.txt", "b.txt"}

    def test_incremental_deleted_file_is_simply_absent_from_result(self):
        """Files removed from the source aren't in current_files, so they're
        never selected for (re)processing — they just age out of the diff."""
        current = {"b.txt": {"last_modified": "t2"}}
        processed = {"a.txt": {"last_modified": "t1"}, "b.txt": {"last_modified": "t2"}}

        to_process, _ = compute_files_to_process(current, processed, "incremental")

        assert to_process == set()


class TestGetSourceFilesWithMetadata:
    def test_lists_files_with_size_and_last_modified(self, tmp_path):
        prefix = "projects/proj1/datasets/d1/data_files/"
        data_dir = tmp_path / prefix
        data_dir.mkdir(parents=True)
        (data_dir / "a.txt").write_text("hello")
        (data_dir / ".hidden").write_text("skip me")

        with mock.patch.dict(os.environ, {"NEMO_DEFAULT_STORE_ROOT": str(tmp_path)}):
            files = get_source_files_with_metadata("d1", "projects/proj1")

        assert set(files.keys()) == {f"{prefix}a.txt"}
        assert files[f"{prefix}a.txt"]["size"] == 5
        assert "last_modified" in files[f"{prefix}a.txt"]

    def test_returns_empty_dict_when_directory_missing(self, tmp_path):
        with mock.patch.dict(os.environ, {"NEMO_DEFAULT_STORE_ROOT": str(tmp_path)}):
            files = get_source_files_with_metadata("missing-dataset", "projects/proj1")
        assert files == {}

    def test_swallows_exceptions_and_returns_empty_dict(self):
        with mock.patch("processor.posix_path", side_effect=RuntimeError("mount unavailable")):
            files = get_source_files_with_metadata("d1", "projects/proj1")
        assert files == {}

    def test_no_s3_path_prefix_uses_bare_datasets_prefix(self, tmp_path):
        data_dir = tmp_path / "datasets" / "d1" / "data_files"
        data_dir.mkdir(parents=True)
        (data_dir / "a.txt").write_text("x")

        with mock.patch.dict(os.environ, {"NEMO_DEFAULT_STORE_ROOT": str(tmp_path)}):
            files = get_source_files_with_metadata("d1", "")

        assert "datasets/d1/data_files/a.txt" in files


class TestCreateEmbedder:
    def test_prefers_embedding_gateway_model_id(self):
        config = _make_config(
            embedding_gateway_model_id="openai/proj_cred_text-embedding-3-small",
            embedding_provider_model_id="sentence-transformers/all-MiniLM-L6-v2",
            embedding_model="legacy-model",
        )
        embedder = _create_embedder(config)
        assert embedder.model_name == "openai/proj_cred_text-embedding-3-small"

    def test_falls_back_to_provider_model_id_when_gateway_id_absent(self):
        config = _make_config(
            embedding_gateway_model_id="",
            embedding_provider_model_id="sentence-transformers/all-MiniLM-L6-v2",
            embedding_model="legacy-model",
        )
        embedder = _create_embedder(config)
        assert embedder.model_name == "sentence-transformers/all-MiniLM-L6-v2"

    def test_falls_back_to_legacy_embedding_model_when_others_absent(self):
        config = _make_config(
            embedding_gateway_model_id="",
            embedding_provider_model_id="",
            embedding_model="legacy-model",
        )
        embedder = _create_embedder(config)
        assert embedder.model_name == "legacy-model"

    def test_dimension_prefers_embedding_dimensions_over_vector_size(self):
        config = _make_config(embedding_dimensions=768, vector_size=384)
        embedder = _create_embedder(config)
        assert embedder.embedding_dimension == 768

    def test_dimension_falls_back_to_vector_size_when_dimensions_zero(self):
        config = _make_config(embedding_dimensions=0, vector_size=512)
        embedder = _create_embedder(config)
        assert embedder.embedding_dimension == 512

    def test_dimension_defaults_to_384_when_both_unset(self):
        config = _make_config(embedding_dimensions=0, vector_size=0)
        embedder = _create_embedder(config)
        assert embedder.embedding_dimension == 384


class TestProgressTracker:
    def test_update_writes_progress_payload_via_write_progress(self):
        config = _make_config()
        with mock.patch("processor.write_progress") as mock_write:
            tracker = ProgressTracker(config, write_interval_seconds=0)
            tracker.begin_phase("processing_documents")
            tracker.update(5, 10, force=True, documentsProcessed=5)

        mock_write.assert_called_once()
        _, payload = mock_write.call_args.args
        assert payload["phase"] == "processing_documents"
        assert payload["status"] == "in_progress"
        assert payload["current"] == 5
        assert payload["total"] == 10
        assert payload["percentage"] == 50.0
        assert payload["documentsProcessed"] == 5

    def test_update_throttles_writes_within_interval(self):
        config = _make_config()
        # ProgressTracker.__init__ seeds _last_s3_write at 0.0 and compares
        # `time.monotonic() - _last_s3_write >= write_interval` on the first
        # update. That comparison only reliably passes on machines with a long
        # enough monotonic uptime; on a freshly started CI container
        # time.monotonic() can itself be smaller than write_interval, so the
        # very first write would silently be skipped too. Mock the clock so
        # this test is deterministic regardless of host uptime: one call for
        # __init__, then two calls for the two update()s, 2000s apart followed
        # by 0.5s apart.
        with mock.patch("processor.write_progress") as mock_write, mock.patch(
            "time.monotonic", side_effect=[0.0, 2000.0, 2000.5]
        ):
            tracker = ProgressTracker(config, write_interval_seconds=1000)
            tracker.update(1, 10)
            tracker.update(2, 10)
        # Second call is within the throttle window and force=False -> only 1 write.
        assert mock_write.call_count == 1

    def test_force_bypasses_throttle(self):
        config = _make_config()
        with mock.patch("processor.write_progress") as mock_write:
            tracker = ProgressTracker(config, write_interval_seconds=1000)
            tracker.update(1, 10, force=True)
            tracker.update(2, 10, force=True)
        assert mock_write.call_count == 2

    def test_finish_marks_status_completed(self):
        config = _make_config()
        with mock.patch("processor.write_progress") as mock_write:
            tracker = ProgressTracker(config)
            tracker.finish(lanceTablePath="kb1/lancedb-1")
        _, payload = mock_write.call_args.args
        assert payload["status"] == "completed"
        assert payload["lanceTablePath"] == "kb1/lancedb-1"

    def test_fail_marks_status_error_with_message(self):
        config = _make_config()
        with mock.patch("processor.write_progress") as mock_write:
            tracker = ProgressTracker(config)
            tracker.fail("boom")
        _, payload = mock_write.call_args.args
        assert payload["status"] == "error"
        assert payload["error"] == "boom"

    def test_eta_is_none_before_any_progress(self):
        assert ProgressTracker._eta(0, 10, 5.0) is None
        assert ProgressTracker._eta(5, 0, 5.0) is None
        assert ProgressTracker._eta(5, 10, 0) is None

    def test_eta_computes_remaining_time(self):
        # 5 of 10 done in 5 seconds -> rate 1/s -> 5s remaining.
        remaining = ProgressTracker._eta(5, 10, 5.0)
        assert remaining == pytest.approx(5.0)

    def test_fmt_human_readable_durations(self):
        assert ProgressTracker._fmt(30) == "30.0s"
        assert ProgressTracker._fmt(125) == "2m 5s"
        assert ProgressTracker._fmt(7325) == "2h 2m"
