"""Unit tests for processor.py orchestration entry points:

- ``main()`` — the in-process (non-Temporal) full pipeline
- ``_run_kb_partition_worker()`` — partitioned document/chunk/embed worker
- ``_run_kb_partition_aggregate()`` — partition-output combiner into LanceDB

These are exercised end-to-end at the orchestration level: the data source,
chunker (real, deterministic 'fixed' strategy), embedder, and LanceDBWriter
are mocked/faked so no network, no real LanceDB, and no real embedding
gateway calls happen — but the control flow, branching, and metadata/result
payloads produced by each function are verified precisely.
"""

import json
import os
import shutil
import sys
from contextlib import ExitStack
from pathlib import Path
from unittest import mock

import pytest

pa = pytest.importorskip("pyarrow")

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

# processor.py -> processing/lancedb_writer.py imports lancedb at module load.
sys.modules.setdefault("lancedb", mock.MagicMock())

import processor
from processor import main, _run_kb_partition_worker, _run_kb_partition_aggregate, write_progress
from data_sources.base import Document
from processing.embedder import EmbeddingGenerator
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


class FakeDataSource:
    """Minimal DataSource stand-in that yields fixed Documents."""

    def __init__(self, docs, source_type="unstructured", total_count=None):
        self._docs = docs
        self.connected = False
        self._source_type = source_type
        self._total_count = total_count if total_count is not None else len(docs)

    def connect(self):
        self.connected = True

    def get_documents(self):
        return iter(self._docs)

    def get_total_count(self):
        return self._total_count

    @property
    def source_type(self):
        return self._source_type


def _make_fake_embedder(dim=4):
    fake_embedder = mock.MagicMock()
    fake_embedder.embedding_dimension = dim

    def _fake_stream(chunks, progress_callback=None):
        if progress_callback:
            progress_callback(len(chunks), len(chunks))
        for chunk in chunks:
            batch = pa.RecordBatch.from_pylist(
                [{
                    "id": chunk.chunk_id,
                    "document_id": chunk.document_id,
                    "source": chunk.source,
                    "text": chunk.text,
                    "chunk_index": chunk.chunk_index,
                    "vector": [0.0] * dim,
                    "metadata": "{}",
                }],
                schema=EmbeddingGenerator.get_schema(dim),
            )
            yield batch

    fake_embedder.stream_record_batches.side_effect = _fake_stream
    return fake_embedder


def _make_fake_writer(**overrides):
    writer = mock.MagicMock()
    writer.TABLE_NAME = "kb_vectors"
    writer.read_metadata.return_value = overrides.get("read_metadata", None)
    writer.get_lance_table_path.return_value = overrides.get("lance_table_path", "kb1/lancedb-existing")
    writer.get_upload_stats.return_value = overrides.get("upload_stats", {"total_bytes": 2048, "file_count": 3})
    writer.get_index_results.return_value = overrides.get(
        "index_results", {"vector_index_created": True, "fts_index_created": True}
    )
    writer.upload_metadata.side_effect = lambda md: "kb1/metadata.json"

    def _fake_write_stream(record_batches, schema, mode="full", indexing_mode="hybrid",
                            quantization_type="auto", quantization_options=None,
                            progress_callback=None):
        batches = list(record_batches)
        rows = sum(b.num_rows for b in batches)
        if progress_callback:
            progress_callback(rows, rows, rows * 100)
        return overrides.get("lance_table_path_after_write", f"kb1/lancedb-run-{rows}")

    writer.write_stream.side_effect = overrides.get("write_stream_side_effect", _fake_write_stream)
    return writer


@pytest.fixture(autouse=True)
def _clear_partition_env():
    """Ensure PARTITION_MODE and friends never leak between tests."""
    keys = ["PARTITION_MODE", "PARTITION_MANIFEST_KEY", "PARTITION_OUTPUT_PREFIX",
            "PARTITION_ID", "JOB_OUTPUT_PREFIX"]
    saved = {k: os.environ.get(k) for k in keys}
    for k in keys:
        os.environ.pop(k, None)
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


class TestRunKbPartitionWorker:
    def _run(self, config, docs, output_prefix_tmp, manifest_files, partition_id="p0",
              embedder=None):
        env = {
            "PARTITION_MANIFEST_KEY": "jobs/j1/manifest.json",
            "PARTITION_OUTPUT_PREFIX": str(output_prefix_tmp),
            "PARTITION_ID": partition_id,
        }
        fake_ds = FakeDataSource(docs)
        fake_embedder = embedder or _make_fake_embedder()
        with mock.patch.dict(os.environ, env), \
             mock.patch("processor.read_json_object", return_value={"files": manifest_files}), \
             mock.patch("processor.create_data_source", return_value=fake_ds), \
             mock.patch("processor._create_embedder", return_value=fake_embedder), \
             mock.patch("processor.put_json_object") as mock_put, \
             mock.patch("processor.write_progress") as mock_write_progress, \
             mock.patch("processor.posix_path", side_effect=lambda k: Path(str(output_prefix_tmp)).parent / k):
            _run_kb_partition_worker(config)
        return fake_ds, mock_put, mock_write_progress

    def test_happy_path_process_all_when_no_file_keys(self, tmp_path):
        config = _make_config()
        docs = [
            Document(doc_id="a.txt", content="hello world", metadata={"file_path": "a.txt"}),
            Document(doc_id="b.txt", content="goodbye world", metadata={"file_path": "b.txt"}),
        ]
        output_prefix = tmp_path / "out"
        fake_ds, mock_put, _ = self._run(config, docs, output_prefix, manifest_files=[])

        assert fake_ds.connected is True
        put_key, put_payload = mock_put.call_args.args
        assert put_key == f"{output_prefix}/partition_result.json"
        assert put_payload["status"] == "success"
        assert put_payload["fileCount"] == 2
        assert put_payload["rowCount"] == 2
        assert (Path(str(output_prefix)) / "embeddings.parquet").is_file()
        temp_dir = Path(f"/tmp/kb-partition-{'p0'}")
        assert not temp_dir.exists()

    def test_file_key_filtering_skips_non_matching_docs(self, tmp_path):
        config = _make_config()
        docs = [
            Document(doc_id="a.txt", content="hello", metadata={"file_path": "datasets/d1/data_files/a.txt"}),
            Document(doc_id="c.txt", content="not wanted", metadata={"file_path": "datasets/d1/data_files/c.txt"}),
        ]
        output_prefix = tmp_path / "out"
        manifest_files = [{"key": "datasets/d1/data_files/a.txt"}]
        fake_ds, mock_put, _ = self._run(config, docs, output_prefix, manifest_files=manifest_files)

        put_key, put_payload = mock_put.call_args.args
        assert put_payload["fileCount"] == 1
        assert put_payload["rowCount"] == 1

    def test_structured_dataset_kind_processes_all_regardless_of_file_keys(self, tmp_path):
        config = _make_config(dataset_kind="structured")
        docs = [
            Document(doc_id="row1", content="row one text", metadata={}),
            Document(doc_id="row2", content="row two text", metadata={}),
        ]
        output_prefix = tmp_path / "out"
        manifest_files = [{"key": "datasets/d1/data_files/nonexistent.txt"}]
        fake_ds, mock_put, _ = self._run(config, docs, output_prefix, manifest_files=manifest_files)

        put_key, put_payload = mock_put.call_args.args
        assert put_payload["fileCount"] == 2
        assert put_payload["rowCount"] == 2

    def test_no_matching_docs_yields_zero_row_result_without_embedding_call(self, tmp_path):
        config = _make_config()
        docs = [
            Document(doc_id="c.txt", content="not wanted", metadata={"file_path": "datasets/d1/data_files/c.txt"}),
        ]
        output_prefix = tmp_path / "out"
        manifest_files = [{"key": "datasets/d1/data_files/a.txt"}]
        fake_embedder = _make_fake_embedder()
        fake_ds, mock_put, _ = self._run(
            config, docs, output_prefix, manifest_files=manifest_files, embedder=fake_embedder
        )

        put_key, put_payload = mock_put.call_args.args
        assert put_payload["rowCount"] == 0
        assert put_payload["fileCount"] == 0
        fake_embedder.stream_record_batches.assert_not_called()

    def test_empty_manifest_data_defaults_to_empty_dict(self, tmp_path):
        """`read_json_object` returning None (missing manifest) must not raise."""
        config = _make_config()
        docs = [Document(doc_id="a.txt", content="hello world", metadata={"file_path": "a.txt"})]
        output_prefix = tmp_path / "out"
        env = {
            "PARTITION_MANIFEST_KEY": "jobs/j1/manifest.json",
            "PARTITION_OUTPUT_PREFIX": str(output_prefix),
            "PARTITION_ID": "p0",
        }
        fake_ds = FakeDataSource(docs)
        with mock.patch.dict(os.environ, env), \
             mock.patch("processor.read_json_object", return_value=None), \
             mock.patch("processor.create_data_source", return_value=fake_ds), \
             mock.patch("processor._create_embedder", return_value=_make_fake_embedder()), \
             mock.patch("processor.put_json_object") as mock_put, \
             mock.patch("processor.write_progress"), \
             mock.patch("processor.posix_path", side_effect=lambda k: tmp_path / k):
            _run_kb_partition_worker(config)

        put_key, put_payload = mock_put.call_args.args
        assert put_payload["status"] == "success"
        # No file_keys -> process_all_docs True -> the one doc gets processed.
        assert put_payload["fileCount"] == 1

    def test_exception_writes_error_result_and_exits(self, tmp_path):
        config = _make_config()
        output_prefix = tmp_path / "out"
        env = {
            "PARTITION_MANIFEST_KEY": "jobs/j1/manifest.json",
            "PARTITION_OUTPUT_PREFIX": str(output_prefix),
            "PARTITION_ID": "p0",
        }
        with mock.patch.dict(os.environ, env), \
             mock.patch("processor.read_json_object", return_value={"files": []}), \
             mock.patch("processor.create_data_source", side_effect=RuntimeError("connect boom")), \
             mock.patch("processor.put_json_object") as mock_put, \
             mock.patch("processor.write_progress"):
            with pytest.raises(SystemExit) as exc_info:
                _run_kb_partition_worker(config)

        assert exc_info.value.code == 1
        put_key, put_payload = mock_put.call_args.args
        assert put_key == f"{output_prefix}/partition_result.json"
        assert put_payload["status"] == "error"
        assert "connect boom" in put_payload["error"]
        assert not Path("/tmp/kb-partition-p0").exists()

    def test_error_result_write_failure_is_swallowed(self, tmp_path):
        """If even writing the error result fails, we still sys.exit(1) cleanly."""
        config = _make_config()
        output_prefix = tmp_path / "out"
        env = {
            "PARTITION_MANIFEST_KEY": "jobs/j1/manifest.json",
            "PARTITION_OUTPUT_PREFIX": str(output_prefix),
            "PARTITION_ID": "p0",
        }
        with mock.patch.dict(os.environ, env), \
             mock.patch("processor.read_json_object", side_effect=RuntimeError("manifest boom")), \
             mock.patch("processor.put_json_object", side_effect=RuntimeError("put also fails")), \
             mock.patch("processor.write_progress"):
            with pytest.raises(SystemExit) as exc_info:
                _run_kb_partition_worker(config)
        assert exc_info.value.code == 1

    def test_default_partition_id_is_unknown_when_env_missing(self, tmp_path):
        config = _make_config()
        output_prefix = tmp_path / "out"
        env = {
            "PARTITION_MANIFEST_KEY": "jobs/j1/manifest.json",
            "PARTITION_OUTPUT_PREFIX": str(output_prefix),
        }
        docs = [Document(doc_id="a.txt", content="hello world", metadata={"file_path": "a.txt"})]
        fake_ds = FakeDataSource(docs)
        with mock.patch.dict(os.environ, env), \
             mock.patch("processor.read_json_object", return_value={"files": []}), \
             mock.patch("processor.create_data_source", return_value=fake_ds), \
             mock.patch("processor._create_embedder", return_value=_make_fake_embedder()), \
             mock.patch("processor.put_json_object") as mock_put, \
             mock.patch("processor.write_progress"), \
             mock.patch("processor.posix_path", side_effect=lambda k: tmp_path / k):
            _run_kb_partition_worker(config)
        assert not Path("/tmp/kb-partition-unknown").exists()  # cleaned up
        put_key, put_payload = mock_put.call_args.args
        assert put_payload["partitionId"] == "unknown"


class TestRunKbPartitionAggregate:
    def _write_partition_parquet(self, tmp_path, subdir, dim=4, n_rows=2):
        import pyarrow.parquet as pq

        schema = EmbeddingGenerator.get_schema(dim)
        rows = [
            {
                "id": f"{subdir}_{i}", "document_id": f"doc_{i}", "source": "s",
                "text": f"text {i}", "chunk_index": i, "vector": [0.1] * dim, "metadata": "{}",
            }
            for i in range(n_rows)
        ]
        table = pa.Table.from_pylist(rows, schema=schema)
        d = tmp_path / "partitions" / subdir
        d.mkdir(parents=True, exist_ok=True)
        pq.write_table(table, d / "embeddings.parquet")
        return f"jobs/j1/partitions/{subdir}"

    def test_happy_path_combines_partitions_and_marks_ready(self, tmp_path):
        config = _make_config()
        p0 = self._write_partition_parquet(tmp_path, "s0")
        p1 = self._write_partition_parquet(tmp_path, "s1")
        fake_writer = _make_fake_writer()
        env = {"JOB_OUTPUT_PREFIX": "jobs/j1"}

        with mock.patch.dict(os.environ, env), \
             mock.patch("processor.list_subdirs", return_value=[p0, p1]), \
             mock.patch("processor._create_embedder", return_value=_make_fake_embedder()), \
             mock.patch("processor.LanceDBWriter", return_value=fake_writer), \
             mock.patch("processor.posix_download_file",
                        side_effect=lambda key, dest: shutil.copy2(
                            str(tmp_path / key.replace("jobs/j1/", "")), str(dest))), \
             mock.patch("processor.put_json_object") as mock_put, \
             mock.patch("processor.write_progress"), \
             mock.patch("processor.update_kb_status") as mock_update_status, \
             mock.patch("processor.delete_tree") as mock_delete:
            _run_kb_partition_aggregate(config)

        fake_writer.write_stream.assert_called_once()
        mock_update_status.assert_called_once_with(config, "ready", mock.ANY)
        mock_delete.assert_called_once_with("jobs/j1/partitions")
        put_key, put_payload = mock_put.call_args.args
        assert put_key == "jobs/j1/aggregation/partition_result.json"
        assert put_payload["status"] == "success"

    def test_partition_read_failure_is_logged_and_skipped(self, tmp_path):
        config = _make_config()
        p0 = self._write_partition_parquet(tmp_path, "s0")
        fake_writer = _make_fake_writer()
        env = {"JOB_OUTPUT_PREFIX": "jobs/j1"}

        with mock.patch.dict(os.environ, env), \
             mock.patch("processor.list_subdirs", return_value=[p0, "jobs/j1/partitions/missing"]), \
             mock.patch("processor._create_embedder", return_value=_make_fake_embedder()), \
             mock.patch("processor.LanceDBWriter", return_value=fake_writer), \
             mock.patch("processor.posix_download_file",
                        side_effect=lambda key, dest: (
                            shutil.copy2(str(tmp_path / key.replace("jobs/j1/", "")), str(dest))
                            if "missing" not in key else (_ for _ in ()).throw(FileNotFoundError(key))
                        )), \
             mock.patch("processor.put_json_object") as mock_put, \
             mock.patch("processor.write_progress"), \
             mock.patch("processor.update_kb_status"), \
             mock.patch("processor.delete_tree"):
            _run_kb_partition_aggregate(config)

        fake_writer.write_stream.assert_called_once()
        put_key, put_payload = mock_put.call_args.args
        assert put_payload["status"] == "success"

    def test_partial_download_left_on_disk_is_removed_after_parse_failure(self, tmp_path):
        """Download succeeds (file lands on disk) but it isn't valid parquet,
        so ParquetFile() raises — the except branch must still unlink the
        partial local file that DOES exist."""
        config = _make_config()
        fake_writer = _make_fake_writer()
        env = {"JOB_OUTPUT_PREFIX": "jobs/j1"}

        def _fake_download(key, dest):
            Path(str(dest)).parent.mkdir(parents=True, exist_ok=True)
            Path(str(dest)).write_text("not a parquet file")

        with mock.patch.dict(os.environ, env), \
             mock.patch("processor.list_subdirs", return_value=["jobs/j1/partitions/bad0"]), \
             mock.patch("processor._create_embedder", return_value=_make_fake_embedder()), \
             mock.patch("processor.LanceDBWriter", return_value=fake_writer), \
             mock.patch("processor.posix_download_file", side_effect=_fake_download), \
             mock.patch("processor.put_json_object") as mock_put, \
             mock.patch("processor.write_progress"), \
             mock.patch("processor.update_kb_status"), \
             mock.patch("processor.delete_tree"):
            _run_kb_partition_aggregate(config)

        put_key, put_payload = mock_put.call_args.args
        assert put_payload["status"] == "success"
        assert not Path("/tmp/kb-aggregation/part_0.parquet").exists()

    def test_no_partitions_found_still_writes_success_with_zero_rows(self, tmp_path):
        config = _make_config()
        fake_writer = _make_fake_writer()
        env = {"JOB_OUTPUT_PREFIX": "jobs/j1"}

        with mock.patch.dict(os.environ, env), \
             mock.patch("processor.list_subdirs", return_value=[]), \
             mock.patch("processor._create_embedder", return_value=_make_fake_embedder()), \
             mock.patch("processor.LanceDBWriter", return_value=fake_writer), \
             mock.patch("processor.put_json_object") as mock_put, \
             mock.patch("processor.write_progress"), \
             mock.patch("processor.update_kb_status"), \
             mock.patch("processor.delete_tree"):
            _run_kb_partition_aggregate(config)

        put_key, put_payload = mock_put.call_args.args
        assert put_payload["status"] == "success"

    def test_cleanup_failure_after_success_is_non_fatal(self, tmp_path):
        config = _make_config()
        fake_writer = _make_fake_writer()
        env = {"JOB_OUTPUT_PREFIX": "jobs/j1"}

        with mock.patch.dict(os.environ, env), \
             mock.patch("processor.list_subdirs", return_value=[]), \
             mock.patch("processor._create_embedder", return_value=_make_fake_embedder()), \
             mock.patch("processor.LanceDBWriter", return_value=fake_writer), \
             mock.patch("processor.put_json_object") as mock_put, \
             mock.patch("processor.write_progress"), \
             mock.patch("processor.update_kb_status"), \
             mock.patch("processor.delete_tree", side_effect=RuntimeError("cleanup boom")):
            _run_kb_partition_aggregate(config)  # must not raise

        put_key, put_payload = mock_put.call_args.args
        assert put_payload["status"] == "success"

    def test_write_stream_failure_writes_error_result_and_exits(self, tmp_path):
        config = _make_config()
        fake_writer = _make_fake_writer()
        fake_writer.write_stream.side_effect = RuntimeError("lancedb boom")
        env = {"JOB_OUTPUT_PREFIX": "jobs/j1"}

        with mock.patch.dict(os.environ, env), \
             mock.patch("processor.list_subdirs", return_value=[]), \
             mock.patch("processor._create_embedder", return_value=_make_fake_embedder()), \
             mock.patch("processor.LanceDBWriter", return_value=fake_writer), \
             mock.patch("processor.put_json_object") as mock_put, \
             mock.patch("processor.write_progress"), \
             mock.patch("processor.update_kb_status") as mock_update_status, \
             mock.patch("processor.delete_tree"):
            with pytest.raises(SystemExit) as exc_info:
                _run_kb_partition_aggregate(config)

        assert exc_info.value.code == 1
        mock_update_status.assert_not_called()
        put_key, put_payload = mock_put.call_args.args
        assert put_key == "jobs/j1/aggregation/partition_result.json"
        assert put_payload["status"] == "error"
        assert "lancedb boom" in put_payload["error"]

    def test_error_result_write_failure_is_swallowed(self, tmp_path):
        config = _make_config()
        env = {"JOB_OUTPUT_PREFIX": "jobs/j1"}

        with mock.patch.dict(os.environ, env), \
             mock.patch("processor.list_subdirs", side_effect=RuntimeError("listing boom")), \
             mock.patch("processor.put_json_object", side_effect=RuntimeError("put also fails")), \
             mock.patch("processor.write_progress"):
            with pytest.raises(SystemExit) as exc_info:
                _run_kb_partition_aggregate(config)
        assert exc_info.value.code == 1


class TestMainPartitionDelegation:
    def test_worker_mode_delegates_and_returns(self):
        config = _make_config()
        with mock.patch("processor.Config.from_environment", return_value=config), \
             mock.patch.dict(os.environ, {"PARTITION_MODE": "worker"}), \
             mock.patch("processor._run_kb_partition_worker") as mock_worker, \
             mock.patch("processor._run_kb_partition_aggregate") as mock_aggregate:
            main()
        mock_worker.assert_called_once_with(config)
        mock_aggregate.assert_not_called()

    def test_aggregate_mode_delegates_and_returns(self):
        config = _make_config()
        with mock.patch("processor.Config.from_environment", return_value=config), \
             mock.patch.dict(os.environ, {"PARTITION_MODE": "aggregate"}), \
             mock.patch("processor._run_kb_partition_worker") as mock_worker, \
             mock.patch("processor._run_kb_partition_aggregate") as mock_aggregate:
            main()
        mock_aggregate.assert_called_once_with(config)
        mock_worker.assert_not_called()


class TestMainFullPipeline:
    def _patch_all(self, stack, config, docs, writer=None, embedder=None, source_type="unstructured",
                    source_files_metadata=None):
        fake_ds = FakeDataSource(docs, source_type=source_type)
        fake_writer = writer or _make_fake_writer()
        fake_embedder = embedder or _make_fake_embedder()
        stack.enter_context(mock.patch("processor.Config.from_environment", return_value=config))
        stack.enter_context(mock.patch("processor.LanceDBWriter", return_value=fake_writer))
        stack.enter_context(mock.patch("processor.create_data_source", return_value=fake_ds))
        stack.enter_context(mock.patch("processor._create_embedder", return_value=fake_embedder))
        stack.enter_context(mock.patch("processor.write_progress"))
        stack.enter_context(mock.patch("processor.default_store_root", return_value="/mnt/data"))
        stack.enter_context(
            mock.patch("processor.get_source_files_with_metadata",
                       return_value=source_files_metadata if source_files_metadata is not None else {})
        )
        mock_update_status = stack.enter_context(mock.patch("processor.update_kb_status"))
        return fake_ds, fake_writer, fake_embedder, mock_update_status

    def test_full_mode_happy_path_writes_metadata_and_marks_ready(self, tmp_path):
        config = _make_config(processing_mode="full")
        docs = [
            Document(doc_id="a.txt", content="hello world", metadata={"file_path": "a.txt", "relative_path": "a.txt"}),
            Document(doc_id="b.txt", content="goodbye world", metadata={"file_path": "b.txt", "relative_path": "b.txt"}),
        ]
        with ExitStack() as stack:
            fake_ds, fake_writer, fake_embedder, mock_update_status = self._patch_all(stack, config, docs)
            main()

        assert fake_ds.connected is True
        fake_writer.upload_metadata.assert_called_once()
        metadata = fake_writer.upload_metadata.call_args.args[0]
        assert metadata["status"] == "success"
        assert metadata["documentCount"] == 2
        assert metadata["chunkCount"] == 2
        assert metadata["knowledgeBaseId"] == "kb1"
        mock_update_status.assert_called_once_with(config, "ready", mock.ANY)

    def test_structured_dataset_kind_happy_path(self, tmp_path):
        config = _make_config(dataset_kind="structured", processing_mode="full")
        docs = [
            Document(doc_id="row1", content="row one text", metadata={}),
            Document(doc_id="row2", content="row two text", metadata={}),
        ]
        with ExitStack() as stack:
            fake_ds, fake_writer, fake_embedder, mock_update_status = self._patch_all(
                stack, config, docs, source_type="structured"
            )
            main()

        metadata = fake_writer.upload_metadata.call_args.args[0]
        assert metadata["sourceType"] == "structured"
        assert metadata["documentCount"] == 2
        mock_update_status.assert_called_once_with(config, "ready", mock.ANY)

    def test_incremental_no_files_to_process_short_circuits(self, tmp_path):
        config = _make_config(processing_mode="incremental")
        fake_writer_arg = _make_fake_writer(
            read_metadata={"status": "success", "documentCount": 5, "stats": {}},
        )
        with ExitStack() as stack:
            fake_ds, fake_writer, fake_embedder, mock_update_status = self._patch_all(
                stack, config, [], writer=fake_writer_arg
            )
            main()

        fake_writer.upload_metadata.assert_called_once()
        metadata = fake_writer.upload_metadata.call_args.args[0]
        assert metadata["status"] == "success"
        assert metadata["lastProcessingMode"] == "incremental"
        assert "lastProcessedAt" in metadata["stats"]
        mock_update_status.assert_called_once_with(config, "ready", fake_writer.get_lance_table_path.return_value)
        # connect() must never be reached — short-circuit happens before data-source creation.
        assert fake_ds.connected is False

    def test_incremental_no_files_to_process_without_prior_metadata_skips_upload(self, tmp_path):
        config = _make_config(processing_mode="incremental")
        fake_writer_arg = _make_fake_writer(read_metadata=None)
        with ExitStack() as stack:
            fake_ds, fake_writer, fake_embedder, mock_update_status = self._patch_all(
                stack, config, [], writer=fake_writer_arg
            )
            main()

        fake_writer.upload_metadata.assert_not_called()
        mock_update_status.assert_called_once()

    def test_incremental_files_to_process_but_no_matching_chunks(self, tmp_path):
        """Files changed on disk, but none of the yielded Documents match ->
        all_chunks stays empty -> 'no new chunks' branch."""
        config = _make_config(processing_mode="incremental")
        docs = [
            Document(doc_id="z.txt", content="unrelated content", metadata={"file_path": "z.txt"}),
        ]
        fake_writer_arg = _make_fake_writer(
            read_metadata={"status": "success", "documentCount": 1, "stats": {}},
        )
        source_files_metadata = {"a.txt": {"last_modified": "2024-06-01T00:00:00Z"}}
        with ExitStack() as stack:
            fake_ds, fake_writer, fake_embedder, mock_update_status = self._patch_all(
                stack, config, docs, writer=fake_writer_arg, source_files_metadata=source_files_metadata
            )
            main()

        fake_writer.upload_metadata.assert_called_once()
        metadata = fake_writer.upload_metadata.call_args.args[0]
        assert metadata["lastProcessingMode"] == "incremental"
        mock_update_status.assert_called_once_with(config, "ready", fake_writer.get_lance_table_path.return_value)
        fake_embedder.stream_record_batches.assert_not_called()

    def test_full_mode_no_chunks_raises_and_records_error(self, tmp_path):
        config = _make_config(processing_mode="full")
        fake_writer_arg = _make_fake_writer(read_metadata=None)
        with ExitStack() as stack:
            fake_ds, fake_writer, fake_embedder, mock_update_status = self._patch_all(
                stack, config, [], writer=fake_writer_arg
            )
            with pytest.raises(SystemExit) as exc_info:
                main()

        assert exc_info.value.code == 1
        fake_writer.upload_metadata.assert_called_once()
        error_metadata = fake_writer.upload_metadata.call_args.args[0]
        assert error_metadata["status"] == "error"
        assert "No items found" in error_metadata["error"] or "No chunks" in error_metadata["error"]
        mock_update_status.assert_called_once_with(config, "errored", error_message=mock.ANY)

    def test_no_items_in_data_source_raises_and_records_error(self, tmp_path):
        config = _make_config(processing_mode="full")
        fake_writer_arg = _make_fake_writer(read_metadata=None)
        with ExitStack() as stack:
            fake_ds, fake_writer, fake_embedder, mock_update_status = self._patch_all(
                stack, config, [], writer=fake_writer_arg
            )
            fake_ds._total_count = 0
            with pytest.raises(SystemExit):
                main()

        error_metadata = fake_writer.upload_metadata.call_args.args[0]
        assert error_metadata["status"] == "error"
        assert "No items found" in error_metadata["error"]

    def test_exception_with_prior_success_metadata_preserves_status(self, tmp_path):
        """When a prior successful run exists, an error should NOT flip status
        away from 'success' — it should merge lastError onto the existing dict."""
        config = _make_config(processing_mode="full")
        fake_writer_arg = _make_fake_writer(
            read_metadata={
                "status": "success", "documentCount": 9, "chunkCount": 9,
                "lanceTablePath": "kb1/lancedb-prior", "stats": {"storageBytes": 100},
            },
        )
        with ExitStack() as stack:
            fake_ds, fake_writer, fake_embedder, mock_update_status = self._patch_all(
                stack, config, [], writer=fake_writer_arg
            )
            fake_ds._total_count = 0  # force "No items found" ValueError
            with pytest.raises(SystemExit):
                main()

        error_metadata = fake_writer.upload_metadata.call_args.args[0]
        assert error_metadata["status"] == "success"  # preserved, not overwritten
        assert error_metadata["documentCount"] == 9  # preserved
        assert "No items found" in error_metadata["lastError"]
        assert "lastErrorAt" in error_metadata["stats"]
        mock_update_status.assert_called_once_with(config, "errored", error_message=mock.ANY)

    def test_early_construction_failure_falls_back_to_direct_put(self, tmp_path):
        """If LanceDBWriter() itself raises, `writer` is never bound -> the
        except-block's NameError fallbacks (direct put_json_object write,
        and write_progress since progress exists) must be exercised."""
        config = _make_config(processing_mode="full")

        with mock.patch("processor.Config.from_environment", return_value=config), \
             mock.patch("processor.LanceDBWriter", side_effect=RuntimeError("writer construction boom")), \
             mock.patch("processor.update_kb_status") as mock_update_status, \
             mock.patch("processor.write_progress") as mock_write_progress, \
             mock.patch("processor.put_json_object") as mock_put, \
             mock.patch("processor.default_store_root", return_value="/mnt/data"):
            with pytest.raises(SystemExit):
                main()

        mock_put.assert_called_once()
        put_key, put_payload = mock_put.call_args.args
        assert put_key == "projects/proj1/knowledgebases/kb1/metadata.json"
        assert put_payload["status"] == "error"
        assert "writer construction boom" in put_payload["error"]
        mock_update_status.assert_called_once_with(config, "errored", error_message=mock.ANY)

    def test_nested_failure_while_writing_error_metadata_is_logged_not_raised(self, tmp_path):
        """Even if the error-recovery path itself blows up, main() must still
        sys.exit(1) rather than propagating the nested exception."""
        config = _make_config(processing_mode="full")
        fake_writer_arg = _make_fake_writer(read_metadata=None)
        fake_writer_arg.upload_metadata.side_effect = RuntimeError("upload_metadata also fails")
        with ExitStack() as stack:
            fake_ds, fake_writer, fake_embedder, mock_update_status = self._patch_all(
                stack, config, [], writer=fake_writer_arg
            )
            fake_ds._total_count = 0
            with pytest.raises(SystemExit) as exc_info:
                main()

        assert exc_info.value.code == 1

    def test_full_mode_zero_chunks_despite_nonzero_total_items_raises(self, tmp_path):
        """total_count > 0 but get_documents() yields nothing -> all_chunks
        stays empty in full mode -> hits the `else: raise ValueError(...)`
        branch (as opposed to the incremental no-op-cycle branch)."""
        config = _make_config(processing_mode="full")
        fake_writer_arg = _make_fake_writer(read_metadata=None)
        with ExitStack() as stack:
            fake_ds, fake_writer, fake_embedder, mock_update_status = self._patch_all(
                stack, config, [], writer=fake_writer_arg
            )
            fake_ds._total_count = 5  # passes "No items found" check
            with pytest.raises(SystemExit):
                main()

        error_metadata = fake_writer.upload_metadata.call_args.args[0]
        assert error_metadata["status"] == "error"
        assert "No chunks created" in error_metadata["error"]

    def test_incremental_orphan_file_key_has_zero_chunk_count(self, tmp_path):
        """A file that's part of files_to_process (per the on-disk diff) but
        was never actually chunked (no matching Document) must fall back to
        chunk_count=0 rather than raising or mismatching."""
        config = _make_config(processing_mode="incremental")
        docs = [
            Document(doc_id="a.txt", content="hello world", metadata={"file_path": "a.txt", "relative_path": "a.txt"}),
        ]
        fake_writer_arg = _make_fake_writer(
            read_metadata={"status": "success", "documentCount": 0, "chunkCount": 0, "vectorCount": 0, "stats": {}},
        )
        source_files_metadata = {
            "a.txt": {"last_modified": "2024-06-01T00:00:00Z", "size": 1},
            "orphan.txt": {"last_modified": "2024-06-01T00:00:00Z", "size": 1},
        }
        with ExitStack() as stack:
            fake_ds, fake_writer, fake_embedder, mock_update_status = self._patch_all(
                stack, config, docs, writer=fake_writer_arg, source_files_metadata=source_files_metadata
            )
            main()

        metadata = fake_writer.upload_metadata.call_args.args[0]
        assert metadata["processedFiles"]["orphan.txt"]["chunk_count"] == 0
        assert metadata["processedFiles"]["a.txt"]["chunk_count"] == 1

    def test_error_path_read_metadata_raising_generic_exception_treated_as_no_prior(self, tmp_path):
        config = _make_config(processing_mode="full")
        fake_writer_arg = _make_fake_writer()
        fake_writer_arg.read_metadata.side_effect = RuntimeError("metadata read boom")
        with ExitStack() as stack:
            fake_ds, fake_writer, fake_embedder, mock_update_status = self._patch_all(
                stack, config, [], writer=fake_writer_arg
            )
            fake_ds._total_count = 0
            with pytest.raises(SystemExit):
                main()

        error_metadata = fake_writer.upload_metadata.call_args.args[0]
        # Since read_metadata() raised, prior is treated as {} -> fresh error blob.
        assert error_metadata["status"] == "error"
        assert error_metadata["documentCount"] == 0

    def test_progress_tracker_construction_failure_falls_back_to_write_progress(self, tmp_path):
        """If ProgressTracker() itself raises, `progress` stays None for the
        rest of main() -> the except-block's `if not progress:` direct
        write_progress() fallback must fire (instead of progress.fail())."""
        config = _make_config(processing_mode="full")
        with mock.patch("processor.Config.from_environment", return_value=config), \
             mock.patch("processor.ProgressTracker", side_effect=RuntimeError("progress tracker boom")), \
             mock.patch("processor.update_kb_status") as mock_update_status, \
             mock.patch("processor.write_progress") as mock_write_progress, \
             mock.patch("processor.put_json_object") as mock_put, \
             mock.patch("processor.default_store_root", return_value="/mnt/data"):
            with pytest.raises(SystemExit):
                main()

        mock_write_progress.assert_called_once()
        wp_config, wp_payload = mock_write_progress.call_args.args
        assert wp_payload["status"] == "error"
        assert wp_payload["phase"] == "failed"
        mock_put.assert_called_once()  # writer never constructed either -> direct metadata write
        mock_update_status.assert_called_once_with(config, "errored", error_message=mock.ANY)

    def test_incremental_mode_processes_matching_files_and_appends(self, tmp_path):
        config = _make_config(processing_mode="incremental")
        docs = [
            Document(doc_id="a.txt", content="hello world", metadata={"file_path": "a.txt", "relative_path": "a.txt"}),
        ]
        fake_writer_arg = _make_fake_writer(
            read_metadata={
                "status": "success", "documentCount": 3, "chunkCount": 10, "vectorCount": 10,
                "processedFiles": {"old.txt": {"last_modified": "2020-01-01T00:00:00Z", "chunk_count": 1}},
                "stats": {},
            },
        )
        source_files_metadata = {"a.txt": {"last_modified": "2024-06-01T00:00:00Z", "size": 10}}
        with ExitStack() as stack:
            fake_ds, fake_writer, fake_embedder, mock_update_status = self._patch_all(
                stack, config, docs, writer=fake_writer_arg, source_files_metadata=source_files_metadata
            )
            main()

        metadata = fake_writer.upload_metadata.call_args.args[0]
        assert metadata["documentCount"] == 3 + 1
        assert metadata["chunkCount"] == 10 + 1
        assert "old.txt" in metadata["processedFiles"]
        assert "a.txt" in metadata["processedFiles"]
        mock_update_status.assert_called_once_with(config, "ready", mock.ANY)


class TestWriteProgress:
    def test_writes_progress_json_to_kb_prefix(self, tmp_path):
        config = _make_config()
        with mock.patch.dict(os.environ, {"NEMO_DEFAULT_STORE_ROOT": str(tmp_path)}):
            write_progress(config, {"phase": "x", "status": "in_progress"})

        progress_path = tmp_path / "projects/proj1/knowledgebases/kb1/progress.json"
        assert progress_path.is_file()
        assert json.loads(progress_path.read_text()) == {"phase": "x", "status": "in_progress"}

    def test_swallows_write_failures(self):
        config = _make_config()
        with mock.patch("processor.put_json_object", side_effect=RuntimeError("mount unavailable")):
            write_progress(config, {"phase": "x"})  # must not raise
