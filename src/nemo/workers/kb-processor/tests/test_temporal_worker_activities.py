"""Unit tests for temporal_worker.py — ProcessKBDocuments and MergeKBResults activities.

Both activities are exercised end-to-end at the orchestration level: the
data source, embedder, and LanceDBWriter are mocked (no network, no real
LanceDB/Iceberg), but manifest/partition-result JSON and intermediate
parquet files are written to real temp directories so the plumbing between
those collaborators is actually verified.
"""

import asyncio
import json
import os
import shutil
import signal
import sys
from pathlib import Path
from unittest import mock

import pytest

pa = pytest.importorskip("pyarrow")
np = pytest.importorskip("numpy")

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT))

# temporal_worker.py -> processor.py -> processing/lancedb_writer.py imports
# lancedb at module load; stub it so these tests don't need a real LanceDB.
sys.modules.setdefault("lancedb", mock.MagicMock())

import temporal_worker
from temporal_worker import (
    _bind_activity_context,
    _consolidate_partitions_chunked,
    _graceful_shutdown_timeout,
    _PeriodicHeartbeat,
    _post_workflow_progress,
    _warmup_embedding_model,
    _WorkflowProgressReporter,
    merge_kb_results,
    process_kb_documents,
)
from data_sources.base import Document
from processing.embedder import EmbeddingGenerator


def _fake_activity(workflow_run_id="run-1", workflow_id="wf-1", activity_id="act-1", activity_type="Foo"):
    act = mock.MagicMock()
    act.in_activity.return_value = True
    act.info.return_value = mock.Mock(
        workflow_id=workflow_id,
        workflow_run_id=workflow_run_id,
        activity_id=activity_id,
        activity_type=activity_type,
    )
    return act


def _write_manifest(root: Path, key: str, files: list) -> str:
    p = root / key
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"files": files}))
    return key


class FakeUnstructuredDataSource:
    """Minimal DataSource stand-in that yields fixed Documents."""

    def __init__(self, docs):
        self._docs = docs
        self.connected = False

    def connect(self):
        self.connected = True

    def get_documents(self):
        return iter(self._docs)

    def get_total_count(self):
        return len(self._docs)

    @property
    def source_type(self):
        return "unstructured"


class TestBindActivityContext:
    def test_binds_when_in_activity(self):
        with mock.patch("temporal_worker.activity", _fake_activity()), \
             mock.patch("temporal_worker.bind_context") as mock_bind:
            _bind_activity_context(kb_id="kb1")
        mock_bind.assert_called_once_with(
            activity_id="act-1", activity_type="Foo", workflow_id="wf-1", kb_id="kb1"
        )

    def test_swallows_exceptions(self):
        act = mock.MagicMock()
        act.in_activity.side_effect = RuntimeError("boom")
        with mock.patch("temporal_worker.activity", act):
            _bind_activity_context(kb_id="kb1")  # must not raise

    def test_binds_extras_directly_when_not_in_activity(self):
        act = mock.MagicMock()
        act.in_activity.return_value = False
        with mock.patch("temporal_worker.activity", act), \
             mock.patch("temporal_worker.bind_context") as mock_bind:
            _bind_activity_context(kb_id="kb1", phase="merge")
        mock_bind.assert_called_once_with(kb_id="kb1", phase="merge")

    def test_no_op_when_not_in_activity_and_no_extras(self):
        act = mock.MagicMock()
        act.in_activity.return_value = False
        with mock.patch("temporal_worker.activity", act), \
             mock.patch("temporal_worker.bind_context") as mock_bind:
            _bind_activity_context()
        mock_bind.assert_not_called()


class TestGracefulShutdownTimeout:
    def test_defaults_to_90_seconds_when_env_unset(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("TEMPORAL_GRACEFUL_SHUTDOWN_TIMEOUT", None)
            result = _graceful_shutdown_timeout()
        from datetime import timedelta
        assert result == timedelta(seconds=90)

    def test_parses_custom_seconds_value(self):
        with mock.patch.dict(os.environ, {"TEMPORAL_GRACEFUL_SHUTDOWN_TIMEOUT": "45s"}):
            result = _graceful_shutdown_timeout()
        from datetime import timedelta
        assert result == timedelta(seconds=45)

    def test_parses_value_without_trailing_s(self):
        with mock.patch.dict(os.environ, {"TEMPORAL_GRACEFUL_SHUTDOWN_TIMEOUT": "30"}):
            result = _graceful_shutdown_timeout()
        from datetime import timedelta
        assert result == timedelta(seconds=30)

    def test_invalid_value_falls_back_to_90_seconds(self):
        with mock.patch.dict(os.environ, {"TEMPORAL_GRACEFUL_SHUTDOWN_TIMEOUT": "not-a-number"}):
            result = _graceful_shutdown_timeout()
        from datetime import timedelta
        assert result == timedelta(seconds=90)


class TestPostWorkflowProgress:
    def test_posts_json_payload_to_expected_url(self):
        captured = {}

        class _FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def _fake_urlopen(req, timeout=None):
            captured["url"] = req.full_url
            captured["data"] = json.loads(req.data.decode("utf-8"))
            captured["method"] = req.get_method()
            return _FakeResponse()

        with mock.patch("temporal_worker.urllib.request.urlopen", side_effect=_fake_urlopen):
            _post_workflow_progress(
                "wf-1", "http://workflow-engine:8080/", "processing", 50.0, 5, 10,
                message="halfway", extra={"foo": "bar"}, unit_id="s0",
            )

        assert captured["url"] == "http://workflow-engine:8080/api/v1/workflows/wf-1/progress"
        assert captured["method"] == "POST"
        assert captured["data"]["phase"] == "processing"
        assert captured["data"]["percentage"] == 50.0
        assert captured["data"]["message"] == "halfway"
        assert captured["data"]["extra"] == {"foo": "bar"}
        assert captured["data"]["unitId"] == "s0"

    def test_default_message_built_from_phase_and_counts(self):
        captured = {}

        def _fake_urlopen(req, timeout=None):
            captured["data"] = json.loads(req.data.decode("utf-8"))
            return mock.MagicMock()

        with mock.patch("temporal_worker.urllib.request.urlopen", side_effect=_fake_urlopen):
            _post_workflow_progress("wf-1", "http://workflow-engine:8080", "merging", 10.0, 1, 4)

        assert captured["data"]["message"] == "merging: 1/4"
        assert "unitId" not in captured["data"]

    def test_default_message_falls_back_to_bare_phase_when_total_zero(self):
        captured = {}

        def _fake_urlopen(req, timeout=None):
            captured["data"] = json.loads(req.data.decode("utf-8"))
            return mock.MagicMock()

        with mock.patch("temporal_worker.urllib.request.urlopen", side_effect=_fake_urlopen):
            _post_workflow_progress("wf-1", "http://workflow-engine:8080", "merging", 0.0, 0, 0)

        assert captured["data"]["message"] == "merging"

    def test_swallows_network_errors(self):
        with mock.patch("temporal_worker.urllib.request.urlopen", side_effect=OSError("network down")):
            _post_workflow_progress("wf-1", "http://workflow-engine:8080", "merging", 0.0, 0, 0)  # must not raise


class TestWorkflowProgressReporter:
    def test_post_is_noop_when_url_missing(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("WORKFLOW_ENGINE_URL", None)
            reporter = _WorkflowProgressReporter("wf-1")
        with mock.patch("temporal_worker._post_workflow_progress") as mock_post:
            reporter.post("processing", 1.0, 1, 10)
        mock_post.assert_not_called()

    def test_url_falls_back_to_environment_variable(self):
        with mock.patch.dict(os.environ, {"WORKFLOW_ENGINE_URL": "http://engine-from-env:9000"}):
            reporter = _WorkflowProgressReporter("wf-1")
        assert reporter.url == "http://engine-from-env:9000"

    def test_post_throttles_within_interval(self):
        reporter = _WorkflowProgressReporter("wf-1", workflow_engine_url="http://engine:9000", unit_id="s0")
        with mock.patch("temporal_worker._post_workflow_progress") as mock_post:
            reporter.post("processing", 1.0, 1, 10)
            reporter.post("processing", 2.0, 2, 10)
        mock_post.assert_called_once()

    def test_post_force_bypasses_throttle(self):
        reporter = _WorkflowProgressReporter("wf-1", workflow_engine_url="http://engine:9000")
        with mock.patch("temporal_worker._post_workflow_progress") as mock_post:
            reporter.post("processing", 1.0, 1, 10, extra={"_force": True})
            reporter.post("processing", 2.0, 2, 10, extra={"_force": True})
        assert mock_post.call_count == 2
        # `_force` itself must never leak into the posted extra payload.
        _, kwargs = mock_post.call_args
        assert "_force" not in kwargs["extra"]

    def test_post_passes_unit_id_and_extra_through(self):
        reporter = _WorkflowProgressReporter("wf-1", workflow_engine_url="http://engine:9000", unit_id="s0")
        with mock.patch("temporal_worker._post_workflow_progress") as mock_post:
            reporter.post("processing", 1.0, 1, 10, message="hi", extra={"k": "v"})
        _, kwargs = mock_post.call_args
        assert kwargs["unit_id"] == "s0"
        assert kwargs["extra"] == {"k": "v"}
        assert kwargs["message"] == "hi"


class TestWarmupEmbeddingModel:
    def test_logs_and_returns_none(self):
        assert _warmup_embedding_model() is None


class TestPeriodicHeartbeat:
    def test_sends_heartbeat_with_current_status(self):
        calls = []
        with mock.patch("temporal_worker.activity") as mock_activity:
            mock_activity.heartbeat.side_effect = lambda status: calls.append(status)
            hb = _PeriodicHeartbeat(interval=0.05)
            with hb:
                hb.status = "doing work"
                import time
                time.sleep(0.2)
        assert "doing work" in calls

    def test_stops_cleanly_when_heartbeat_raises(self):
        with mock.patch("temporal_worker.activity") as mock_activity:
            mock_activity.heartbeat.side_effect = RuntimeError("no activity context")
            hb = _PeriodicHeartbeat(interval=0.02)
            with hb:
                import time
                time.sleep(0.1)
            # Thread must have stopped without raising into the main thread.


class TestProcessKBDocumentsActivity:
    def _base_input(self, tmp_path, **overrides):
        manifest_key = _write_manifest(
            tmp_path, "jobs/j1/partitions/s0/manifest.json",
            [{"key": "datasets/d1/data_files/a.txt"}, {"key": "datasets/d1/data_files/b.txt"}],
        )
        base = {
            "kb_id": "kb1",
            "kb_name": "my-kb",
            "project_id": "proj1",
            "source_dataset_id": "d1",
            "bucket_name": "bucket-1",
            "project_client_id": "client-1",
            "project_client_secret": "secret-1",
            "set_id": "s0",
            "manifest_s3_key": manifest_key,
            "output_prefix": "jobs/j1/partitions/s0",
            "dataset_kind": "unstructured",
            "chunk_strategy": "fixed",
            "chunk_size": 512,
            "chunk_overlap": 0,
            "chunk_options": {},
        }
        base.update(overrides)
        return base

    def _patch_common(self, docs, dim=4):
        fake_ds = FakeUnstructuredDataSource(docs)
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
        return fake_ds, fake_embedder

    def test_happy_path_writes_embeddings_and_success_result(self, tmp_path):
        docs = [
            Document(doc_id="a.txt", content="hello world", metadata={"file_path": "a.txt"}),
            Document(doc_id="b.txt", content="goodbye world", metadata={"file_path": "b.txt"}),
        ]
        fake_ds, fake_embedder = self._patch_common(docs)

        with mock.patch("temporal_worker.activity", _fake_activity()), \
             mock.patch("temporal_worker.create_data_source", return_value=fake_ds), \
             mock.patch("temporal_worker._create_embedder", return_value=fake_embedder), \
             mock.patch("temporal_worker.read_json_object", side_effect=lambda k: json.loads((tmp_path / k).read_text())), \
             mock.patch("temporal_worker.put_json_object") as mock_put, \
             mock.patch("temporal_worker.posix_path", side_effect=lambda k: tmp_path / k):
            result = process_kb_documents(self._base_input(tmp_path))

        assert result["status"] == "success"
        assert result["fileCount"] == 2
        assert result["rowCount"] == 2
        assert fake_ds.connected is True

        mock_put.assert_called_once()
        put_key, put_payload = mock_put.call_args.args
        assert put_key == "jobs/j1/partitions/s0/partition_result.json"
        assert put_payload["status"] == "success"

        emb_path = tmp_path / "jobs/j1/partitions/s0/embeddings.parquet"
        assert emb_path.is_file()
        import pyarrow.parquet as pq
        table = pq.read_table(emb_path)
        assert table.num_rows == 2

    def test_no_documents_yields_zero_row_result_without_embedding_call(self, tmp_path):
        fake_ds, fake_embedder = self._patch_common([])

        with mock.patch("temporal_worker.activity", _fake_activity()), \
             mock.patch("temporal_worker.create_data_source", return_value=fake_ds), \
             mock.patch("temporal_worker._create_embedder", return_value=fake_embedder), \
             mock.patch("temporal_worker.read_json_object", side_effect=lambda k: json.loads((tmp_path / k).read_text())), \
             mock.patch("temporal_worker.put_json_object") as mock_put, \
             mock.patch("temporal_worker.posix_path", side_effect=lambda k: tmp_path / k):
            result = process_kb_documents(self._base_input(tmp_path))

        assert result == {
            "setId": "s0", "status": "success",
            "outputPath": "jobs/j1/partitions/s0", "rowCount": 0, "fileCount": 0,
        }
        fake_embedder.stream_record_batches.assert_not_called()
        assert not (tmp_path / "jobs/j1/partitions/s0/embeddings.parquet").is_file()

    def test_file_filtering_skips_documents_not_in_manifest(self, tmp_path):
        docs = [
            Document(doc_id="a.txt", content="hello", metadata={"file_path": "datasets/d1/data_files/a.txt"}),
            Document(doc_id="c.txt", content="not in manifest", metadata={"file_path": "datasets/d1/data_files/c.txt"}),
        ]
        fake_ds, fake_embedder = self._patch_common(docs)

        with mock.patch("temporal_worker.activity", _fake_activity()), \
             mock.patch("temporal_worker.create_data_source", return_value=fake_ds), \
             mock.patch("temporal_worker._create_embedder", return_value=fake_embedder), \
             mock.patch("temporal_worker.read_json_object", side_effect=lambda k: json.loads((tmp_path / k).read_text())), \
             mock.patch("temporal_worker.put_json_object"), \
             mock.patch("temporal_worker.posix_path", side_effect=lambda k: tmp_path / k):
            result = process_kb_documents(self._base_input(tmp_path))

        # Only a.txt matches a manifest file_key; c.txt must be filtered out.
        assert result["fileCount"] == 1

    def test_structured_dataset_processes_all_docs_ignoring_file_keys(self, tmp_path):
        docs = [
            Document(doc_id="row_0", content="col text", metadata={}),
        ]
        fake_ds, fake_embedder = self._patch_common(docs)

        with mock.patch("temporal_worker.activity", _fake_activity()), \
             mock.patch("temporal_worker.create_data_source", return_value=fake_ds), \
             mock.patch("temporal_worker._create_embedder", return_value=fake_embedder), \
             mock.patch("temporal_worker.read_json_object", side_effect=lambda k: json.loads((tmp_path / k).read_text())), \
             mock.patch("temporal_worker.put_json_object"), \
             mock.patch("temporal_worker.posix_path", side_effect=lambda k: tmp_path / k):
            result = process_kb_documents(
                self._base_input(
                    tmp_path, dataset_kind="structured",
                    catalog_table_ref="ns.table1", text_columns="body",
                )
            )

        assert result["fileCount"] == 1

    def test_exception_path_writes_error_result_and_reraises(self, tmp_path):
        with mock.patch("temporal_worker.activity", _fake_activity()), \
             mock.patch("temporal_worker.create_data_source", side_effect=RuntimeError("connect failed")), \
             mock.patch("temporal_worker.read_json_object", side_effect=lambda k: json.loads((tmp_path / k).read_text())), \
             mock.patch("temporal_worker.put_json_object") as mock_put, \
             mock.patch("temporal_worker.posix_path", side_effect=lambda k: tmp_path / k):
            with pytest.raises(RuntimeError, match="connect failed"):
                process_kb_documents(self._base_input(tmp_path))

        mock_put.assert_called_once()
        put_key, put_payload = mock_put.call_args.args
        assert put_key == "jobs/j1/partitions/s0/partition_result.json"
        assert put_payload["status"] == "error"
        assert "connect failed" in put_payload["error"]

    def test_progress_reporter_posts_when_workflow_id_present(self, tmp_path):
        docs = [Document(doc_id="a.txt", content="hi", metadata={"file_path": "a.txt"})]
        fake_ds, fake_embedder = self._patch_common(docs)

        with mock.patch("temporal_worker.activity", _fake_activity()), \
             mock.patch("temporal_worker.create_data_source", return_value=fake_ds), \
             mock.patch("temporal_worker._create_embedder", return_value=fake_embedder), \
             mock.patch("temporal_worker.read_json_object", side_effect=lambda k: json.loads((tmp_path / k).read_text())), \
             mock.patch("temporal_worker.put_json_object"), \
             mock.patch("temporal_worker.posix_path", side_effect=lambda k: tmp_path / k), \
             mock.patch("temporal_worker._WorkflowProgressReporter") as mock_reporter_cls:
            mock_reporter = mock_reporter_cls.return_value
            mock_reporter.url = "http://workflow-engine:8080"
            process_kb_documents(self._base_input(tmp_path, workflow_id="wf-1"))

        mock_reporter_cls.assert_called_once_with("wf-1", unit_id="s0")
        assert mock_reporter.post.called

    def test_missing_manifest_s3_key_yields_empty_file_keys(self, tmp_path):
        """When `manifest_s3_key` is falsy, file_keys stays [] without even
        attempting a read_json_object() call."""
        docs = [Document(doc_id="a.txt", content="hi", metadata={"file_path": "a.txt"})]
        fake_ds, fake_embedder = self._patch_common(docs)

        with mock.patch("temporal_worker.activity", _fake_activity()), \
             mock.patch("temporal_worker.create_data_source", return_value=fake_ds), \
             mock.patch("temporal_worker._create_embedder", return_value=fake_embedder), \
             mock.patch("temporal_worker.read_json_object") as mock_read, \
             mock.patch("temporal_worker.put_json_object"), \
             mock.patch("temporal_worker.posix_path", side_effect=lambda k: tmp_path / k):
            result = process_kb_documents(self._base_input(tmp_path, manifest_s3_key=""))

        mock_read.assert_not_called()
        assert result["fileCount"] == 1  # no file_keys -> process_all_docs True

    def test_manifest_missing_on_mount_defaults_to_empty_dict(self, tmp_path):
        """`read_json_object` returning None (manifest not found) must not raise."""
        docs = [Document(doc_id="a.txt", content="hi", metadata={"file_path": "a.txt"})]
        fake_ds, fake_embedder = self._patch_common(docs)

        with mock.patch("temporal_worker.activity", _fake_activity()), \
             mock.patch("temporal_worker.create_data_source", return_value=fake_ds), \
             mock.patch("temporal_worker._create_embedder", return_value=fake_embedder), \
             mock.patch("temporal_worker.read_json_object", return_value=None), \
             mock.patch("temporal_worker.put_json_object"), \
             mock.patch("temporal_worker.posix_path", side_effect=lambda k: tmp_path / k):
            result = process_kb_documents(self._base_input(tmp_path))

        assert result["status"] == "success"
        assert result["fileCount"] == 1

    def test_heartbeat_and_progress_post_every_ten_documents(self, tmp_path):
        """With >=10 matching docs, the doc_count % 10 == 0 heartbeat+progress
        branch inside the chunking loop must fire."""
        docs = [
            Document(doc_id=f"d{i}.txt", content=f"content {i}", metadata={"file_path": f"d{i}.txt"})
            for i in range(10)
        ]
        fake_ds, fake_embedder = self._patch_common(docs)

        with mock.patch("temporal_worker.activity", _fake_activity()) as mock_activity, \
             mock.patch("temporal_worker.create_data_source", return_value=fake_ds), \
             mock.patch("temporal_worker._create_embedder", return_value=fake_embedder), \
             mock.patch("temporal_worker.read_json_object", return_value=None), \
             mock.patch("temporal_worker.put_json_object"), \
             mock.patch("temporal_worker.posix_path", side_effect=lambda k: tmp_path / k), \
             mock.patch("temporal_worker._WorkflowProgressReporter") as mock_reporter_cls:
            mock_reporter = mock_reporter_cls.return_value
            mock_reporter.url = "http://workflow-engine:8080"
            result = process_kb_documents(self._base_input(tmp_path, workflow_id="wf-1"))

        assert result["fileCount"] == 10
        heartbeat_calls = [c.args[0] for c in mock_activity.heartbeat.call_args_list]
        assert any("processed 10 docs" in c for c in heartbeat_calls)
        progress_phases = [c.args[0] for c in mock_reporter.post.call_args_list]
        assert "processing" in progress_phases

    def test_error_result_write_failure_is_swallowed_before_reraise(self, tmp_path):
        with mock.patch("temporal_worker.activity", _fake_activity()), \
             mock.patch("temporal_worker.create_data_source", side_effect=RuntimeError("connect failed")), \
             mock.patch("temporal_worker.read_json_object", return_value=None), \
             mock.patch("temporal_worker.put_json_object", side_effect=RuntimeError("mount unavailable")):
            with pytest.raises(RuntimeError, match="connect failed"):
                process_kb_documents(self._base_input(tmp_path))


def _write_partition_parquet(path: Path, dim: int, rows: int, doc_id: str = "doc") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    table = pa.table(
        {
            "id": [f"{doc_id}_{i}" for i in range(rows)],
            "document_id": [doc_id] * rows,
            "source": [f"{doc_id}.txt"] * rows,
            "text": [f"chunk {i}" for i in range(rows)],
            "chunk_index": list(range(rows)),
            "vector": [[0.0] * dim for _ in range(rows)],
            "metadata": ["{}"] * rows,
        },
        schema=EmbeddingGenerator.get_schema(dim),
    )
    import pyarrow.parquet as pq
    pq.write_table(table, path)


class TestMergeKBResultsActivity:
    def _base_input(self, **overrides):
        base = {
            "kb_id": "kb1",
            "kb_name": "my-kb",
            "job_output_prefix": "jobs/j1",
            "project_id": "proj1",
            "source_dataset_id": "d1",
            "bucket_name": "bucket-1",
            "project_client_id": "client-1",
            "project_client_secret": "secret-1",
            "dataset_kind": "unstructured",
        }
        base.update(overrides)
        return base

    def _patch_common(self, tmp_path, partitions, dim=4):
        """partitions: list of (set_id, row_count, status)."""
        job_prefix = tmp_path / "jobs/j1"
        partition_dirs = []
        for set_id, rows, status in partitions:
            pdir = job_prefix / "partitions" / set_id
            pdir.mkdir(parents=True, exist_ok=True)
            (pdir / "partition_result.json").write_text(
                json.dumps({"setId": set_id, "status": status, "fileCount": rows})
            )
            if status == "success" and rows > 0:
                _write_partition_parquet(pdir / "embeddings.parquet", dim, rows, doc_id=set_id)
            partition_dirs.append(f"jobs/j1/partitions/{set_id}")

        def _fake_list_subdirs(prefix):
            assert prefix == "jobs/j1/partitions"
            return partition_dirs

        def _fake_read_json_object(key):
            p = tmp_path / key
            return json.loads(p.read_text()) if p.is_file() else None

        def _fake_download(key, local_path):
            src = tmp_path / key
            Path(local_path).parent.mkdir(parents=True, exist_ok=True)
            if src.is_file():
                shutil.copy2(str(src), str(local_path))
            else:
                raise FileNotFoundError(str(src))

        fake_embedder = mock.MagicMock()
        fake_embedder.embedding_dimension = dim

        fake_writer = mock.MagicMock()

        def _fake_write_stream(record_batches, schema, **kwargs):
            rows_seen = sum(b.num_rows for b in record_batches)
            fake_writer._rows_seen = rows_seen
            return f"kb1/lancedb-run-{rows_seen}"

        fake_writer.write_stream.side_effect = _fake_write_stream
        fake_writer.get_upload_stats.return_value = {"total_bytes": 2048, "file_count": len(partitions)}
        fake_writer.get_index_results.return_value = {"vector_index_created": True, "fts_index_created": True}
        fake_writer.TABLE_NAME = "kb_vectors"

        return {
            "list_subdirs": _fake_list_subdirs,
            "read_json_object": _fake_read_json_object,
            "posix_download_file": _fake_download,
            "embedder": fake_embedder,
            "writer": fake_writer,
        }

    def test_merge_happy_path_writes_metadata_and_marks_ready(self, tmp_path):
        mocks = self._patch_common(tmp_path, [("s0", 2, "success"), ("s1", 3, "success")])

        with mock.patch("temporal_worker.activity", _fake_activity(workflow_run_id="run-abc")), \
             mock.patch("temporal_worker.list_subdirs", side_effect=mocks["list_subdirs"]), \
             mock.patch("temporal_worker.read_json_object", side_effect=mocks["read_json_object"]), \
             mock.patch("temporal_worker.posix_download_file", side_effect=mocks["posix_download_file"]), \
             mock.patch("temporal_worker._create_embedder", return_value=mocks["embedder"]), \
             mock.patch("temporal_worker.LanceDBWriter", return_value=mocks["writer"]) as mock_writer_cls, \
             mock.patch("temporal_worker.put_json_object") as mock_put, \
             mock.patch("temporal_worker.posix_path", side_effect=lambda k: tmp_path / k), \
             mock.patch("temporal_worker.update_kb_status") as mock_update_status, \
             mock.patch("temporal_worker.delete_tree") as mock_delete:
            result = merge_kb_results(self._base_input())

        assert result["status"] == "success"
        assert result["documentCount"] == 5  # 2 + 3 fileCount across partitions
        assert result["chunkCount"] == 5     # total rows streamed
        assert result["vectorCount"] == 5
        assert result["knowledgeBaseId"] == "kb1"
        assert result["sourceType"] == "unstructured"

        mock_writer_cls.assert_called_once()
        _, kwargs = mock_writer_cls.call_args
        assert kwargs["workflow_run_id"] == "run-abc"

        mock_update_status.assert_called_once()
        args = mock_update_status.call_args.args
        assert args[1] == "ready"

        mock_put.assert_called_once()
        put_key, put_payload = mock_put.call_args.args
        assert put_key == "knowledgebases/kb1/metadata.json"
        assert put_payload["status"] == "success"

        mock_delete.assert_called_once_with("jobs/j1/partitions")

    def test_progress_reporter_posts_and_download_failure_is_skipped_not_fatal(self, tmp_path):
        """6 partitions with one (s2) missing its embeddings.parquet — exercises
        the `_download_partition` failure path, the `continue` on missing
        local_path, the every-5th-partition progress posts in both the
        'reading results' and 'streaming' loops, and every LanceDB progress-
        callback phase branch."""
        partitions = [
            ("s0", 1, "success"), ("s1", 1, "success"), ("s2", 0, "success"),
            ("s3", 1, "success"), ("s4", 1, "success"), ("s5", 1, "success"),
        ]
        mocks = self._patch_common(tmp_path, partitions)

        def _fake_write_stream(record_batches, schema, progress_callback=None, **kwargs):
            rows_seen = sum(b.num_rows for b in record_batches)
            if progress_callback:
                progress_callback("creating_table", {})
                progress_callback("creating_vector_index", {})
                progress_callback("creating_fts_index", {})
                progress_callback("write_complete", {"storageMB": 1.0})
                progress_callback("some_other_phase", {})
            return f"kb1/lancedb-run-{rows_seen}"

        mocks["writer"].write_stream.side_effect = _fake_write_stream

        with mock.patch.dict(os.environ, {"WORKFLOW_ENGINE_URL": "http://engine:9000"}), \
             mock.patch("temporal_worker._PROGRESS_POST_INTERVAL_SEC", 0.0), \
             mock.patch("temporal_worker.activity", _fake_activity()), \
             mock.patch("temporal_worker.list_subdirs", side_effect=mocks["list_subdirs"]), \
             mock.patch("temporal_worker.read_json_object", side_effect=mocks["read_json_object"]), \
             mock.patch("temporal_worker.posix_download_file", side_effect=mocks["posix_download_file"]), \
             mock.patch("temporal_worker._create_embedder", return_value=mocks["embedder"]), \
             mock.patch("temporal_worker.LanceDBWriter", return_value=mocks["writer"]), \
             mock.patch("temporal_worker.put_json_object"), \
             mock.patch("temporal_worker.posix_path", side_effect=lambda k: tmp_path / k), \
             mock.patch("temporal_worker.update_kb_status"), \
             mock.patch("temporal_worker.delete_tree"), \
             mock.patch("temporal_worker._post_workflow_progress") as mock_post:
            result = merge_kb_results(self._base_input(workflow_id="wf-1"))

        assert result["status"] == "success"
        # s2 contributed zero rows since its download failed and was skipped.
        assert result["chunkCount"] == 5

        assert mock_post.call_count >= 6
        phases = [c.kwargs.get("phase") for c in mock_post.call_args_list]
        assert all(p == "merging" for p in phases)

    def test_partition_download_succeeds_but_parquet_parse_fails_is_skipped(self, tmp_path):
        """Download lands a file on disk, but it isn't valid parquet — the
        inner except branch (not the download-failure branch) must fire,
        and the partial file must still be unlinked in the finally clause."""
        mocks = self._patch_common(tmp_path, [("s0", 1, "success")])

        def _fake_download_corrupt(key, local_path):
            Path(local_path).parent.mkdir(parents=True, exist_ok=True)
            Path(local_path).write_text("not a parquet file")

        with mock.patch("temporal_worker.activity", _fake_activity()), \
             mock.patch("temporal_worker.list_subdirs", side_effect=mocks["list_subdirs"]), \
             mock.patch("temporal_worker.read_json_object", side_effect=mocks["read_json_object"]), \
             mock.patch("temporal_worker.posix_download_file", side_effect=_fake_download_corrupt), \
             mock.patch("temporal_worker._create_embedder", return_value=mocks["embedder"]), \
             mock.patch("temporal_worker.LanceDBWriter", return_value=mocks["writer"]), \
             mock.patch("temporal_worker.put_json_object"), \
             mock.patch("temporal_worker.posix_path", side_effect=lambda k: tmp_path / k), \
             mock.patch("temporal_worker.update_kb_status"), \
             mock.patch("temporal_worker.delete_tree"):
            result = merge_kb_results(self._base_input())

        assert result["status"] == "success"
        assert result["chunkCount"] == 0
        assert not (Path("/tmp/kb-merge") / "part_0.parquet").exists()

    def test_cleanup_failure_after_success_is_swallowed(self, tmp_path):
        mocks = self._patch_common(tmp_path, [("s0", 1, "success")])

        with mock.patch("temporal_worker.activity", _fake_activity()), \
             mock.patch("temporal_worker.list_subdirs", side_effect=mocks["list_subdirs"]), \
             mock.patch("temporal_worker.read_json_object", side_effect=mocks["read_json_object"]), \
             mock.patch("temporal_worker.posix_download_file", side_effect=mocks["posix_download_file"]), \
             mock.patch("temporal_worker._create_embedder", return_value=mocks["embedder"]), \
             mock.patch("temporal_worker.LanceDBWriter", return_value=mocks["writer"]), \
             mock.patch("temporal_worker.put_json_object"), \
             mock.patch("temporal_worker.posix_path", side_effect=lambda k: tmp_path / k), \
             mock.patch("temporal_worker.update_kb_status"), \
             mock.patch("temporal_worker.delete_tree", side_effect=RuntimeError("cleanup boom")):
            result = merge_kb_results(self._base_input())  # must not raise

        assert result["status"] == "success"

    def test_falls_back_gracefully_when_workflow_run_id_unavailable(self, tmp_path):
        mocks = self._patch_common(tmp_path, [("s0", 1, "success")])
        act = mock.MagicMock()
        act.info.side_effect = RuntimeError("no activity context")

        with mock.patch("temporal_worker.activity", act), \
             mock.patch("temporal_worker.list_subdirs", side_effect=mocks["list_subdirs"]), \
             mock.patch("temporal_worker.read_json_object", side_effect=mocks["read_json_object"]), \
             mock.patch("temporal_worker.posix_download_file", side_effect=mocks["posix_download_file"]), \
             mock.patch("temporal_worker._create_embedder", return_value=mocks["embedder"]), \
             mock.patch("temporal_worker.LanceDBWriter", return_value=mocks["writer"]) as mock_writer_cls, \
             mock.patch("temporal_worker.put_json_object"), \
             mock.patch("temporal_worker.posix_path", side_effect=lambda k: tmp_path / k), \
             mock.patch("temporal_worker.update_kb_status"), \
             mock.patch("temporal_worker.delete_tree"):
            merge_kb_results(self._base_input())

        _, kwargs = mock_writer_cls.call_args
        assert kwargs["workflow_run_id"] is None

    def test_partition_read_failure_is_skipped_not_fatal(self, tmp_path):
        mocks = self._patch_common(tmp_path, [("s0", 1, "success")])

        def _flaky_read(key):
            if "s0" in key:
                raise OSError("disk hiccup")
            return mocks["read_json_object"](key)

        with mock.patch("temporal_worker.activity", _fake_activity()), \
             mock.patch("temporal_worker.list_subdirs", side_effect=mocks["list_subdirs"]), \
             mock.patch("temporal_worker.read_json_object", side_effect=_flaky_read), \
             mock.patch("temporal_worker.posix_download_file", side_effect=mocks["posix_download_file"]), \
             mock.patch("temporal_worker._create_embedder", return_value=mocks["embedder"]), \
             mock.patch("temporal_worker.LanceDBWriter", return_value=mocks["writer"]), \
             mock.patch("temporal_worker.put_json_object"), \
             mock.patch("temporal_worker.posix_path", side_effect=lambda k: tmp_path / k), \
             mock.patch("temporal_worker.update_kb_status"), \
             mock.patch("temporal_worker.delete_tree"):
            # Must not raise even though reading the partition result failed.
            result = merge_kb_results(self._base_input())

        assert result["status"] == "success"
        assert result["documentCount"] == 0

    def test_structured_source_type_reflected_in_metadata(self, tmp_path):
        mocks = self._patch_common(tmp_path, [("s0", 1, "success")])

        with mock.patch("temporal_worker.activity", _fake_activity()), \
             mock.patch("temporal_worker.list_subdirs", side_effect=mocks["list_subdirs"]), \
             mock.patch("temporal_worker.read_json_object", side_effect=mocks["read_json_object"]), \
             mock.patch("temporal_worker.posix_download_file", side_effect=mocks["posix_download_file"]), \
             mock.patch("temporal_worker._create_embedder", return_value=mocks["embedder"]), \
             mock.patch("temporal_worker.LanceDBWriter", return_value=mocks["writer"]), \
             mock.patch("temporal_worker.put_json_object"), \
             mock.patch("temporal_worker.posix_path", side_effect=lambda k: tmp_path / k), \
             mock.patch("temporal_worker.update_kb_status"), \
             mock.patch("temporal_worker.delete_tree"):
            result = merge_kb_results(
                self._base_input(
                    dataset_kind="structured",
                    catalog_table_ref="ns.table1",
                    text_columns="body",
                )
            )

        assert result["sourceType"] == "structured"

    def test_cleanup_removes_temp_dir_even_on_writer_failure(self, tmp_path):
        mocks = self._patch_common(tmp_path, [("s0", 1, "success")])
        mocks["writer"].write_stream.side_effect = RuntimeError("lancedb write failed")

        with mock.patch("temporal_worker.activity", _fake_activity()), \
             mock.patch("temporal_worker.list_subdirs", side_effect=mocks["list_subdirs"]), \
             mock.patch("temporal_worker.read_json_object", side_effect=mocks["read_json_object"]), \
             mock.patch("temporal_worker.posix_download_file", side_effect=mocks["posix_download_file"]), \
             mock.patch("temporal_worker._create_embedder", return_value=mocks["embedder"]), \
             mock.patch("temporal_worker.LanceDBWriter", return_value=mocks["writer"]), \
             mock.patch("temporal_worker.put_json_object"), \
             mock.patch("temporal_worker.update_kb_status") as mock_update_status:
            with pytest.raises(RuntimeError, match="lancedb write failed"):
                merge_kb_results(self._base_input())

        # Raised before update_kb_status('ready', ...) is reached.
        mock_update_status.assert_not_called()
        assert not Path("/tmp/kb-merge").exists()


class TestConsolidatePartitionsChunked:
    def test_groups_partitions_by_size_threshold(self, tmp_path):
        dim = 4
        partitions = []
        sizes = []
        for i in range(3):
            pdir = tmp_path / f"part{i}"
            _write_partition_parquet(pdir / "embeddings.parquet", dim, rows=2, doc_id=f"d{i}")
            partitions.append(str(pdir))
            sizes.append((pdir / "embeddings.parquet").stat().st_size)

        with mock.patch("temporal_worker._MERGE_CHUNK_SIZE_MB", 1), \
             mock.patch("temporal_worker.posix_download_file", side_effect=lambda key, local_path: shutil.copy2(key, local_path)):
            consolidated = _consolidate_partitions_chunked(
                partitions, sizes, tmp_path / "work",
                EmbeddingGenerator.get_schema(dim),
                _PeriodicHeartbeat(interval=100),
                progress_reporter=None,
                total_documents=6,
            )

        assert len(consolidated) >= 1
        import pyarrow.parquet as pq
        total_rows = sum(pq.read_table(p).num_rows for p in consolidated)
        assert total_rows == 6

    def test_forces_multiple_groups_when_threshold_tiny_and_posts_progress(self, tmp_path):
        """A near-zero MB threshold forces every partition into its own
        group, exercising the group-boundary reset branch, and a real
        progress_reporter with a mocked HTTP layer exercises the per-group
        progress post."""
        dim = 4
        partitions = []
        sizes = []
        for i in range(3):
            pdir = tmp_path / f"part{i}"
            _write_partition_parquet(pdir / "embeddings.parquet", dim, rows=2, doc_id=f"d{i}")
            partitions.append(str(pdir))
            sizes.append((pdir / "embeddings.parquet").stat().st_size)

        reporter = _WorkflowProgressReporter("wf-1", workflow_engine_url="http://engine:9000")

        with mock.patch("temporal_worker._MERGE_CHUNK_SIZE_MB", 0), \
             mock.patch("temporal_worker._PROGRESS_POST_INTERVAL_SEC", 0.0), \
             mock.patch("temporal_worker.posix_download_file",
                        side_effect=lambda key, local_path: shutil.copy2(key, local_path)), \
             mock.patch("temporal_worker._post_workflow_progress") as mock_post:
            consolidated = _consolidate_partitions_chunked(
                partitions, sizes, tmp_path / "work",
                EmbeddingGenerator.get_schema(dim),
                _PeriodicHeartbeat(interval=100),
                progress_reporter=reporter,
                total_documents=6,
            )

        # Each partition becomes its own group -> 3 separate consolidated files.
        assert len(consolidated) == 3
        assert mock_post.call_count == 3

    def test_partition_read_failure_within_group_is_skipped_not_fatal(self, tmp_path):
        dim = 4
        good_dir = tmp_path / "good"
        _write_partition_parquet(good_dir / "embeddings.parquet", dim, rows=2, doc_id="good")
        partitions = [str(good_dir), str(tmp_path / "missing")]
        sizes = [100, 100]

        def _flaky_download(key, local_path):
            if "missing" in key:
                raise FileNotFoundError(key)
            shutil.copy2(key, local_path)

        with mock.patch("temporal_worker._MERGE_CHUNK_SIZE_MB", 100), \
             mock.patch("temporal_worker.posix_download_file", side_effect=_flaky_download):
            consolidated = _consolidate_partitions_chunked(
                partitions, sizes, tmp_path / "work",
                EmbeddingGenerator.get_schema(dim),
                _PeriodicHeartbeat(interval=100),
                progress_reporter=None,
                total_documents=2,
            )

        assert len(consolidated) == 1
        import pyarrow.parquet as pq
        assert pq.read_table(consolidated[0]).num_rows == 2

    def test_downloaded_but_unparseable_partition_is_unlinked_in_except_branch(self, tmp_path):
        """Distinguishes the two failure modes inside the try/except: this
        one downloads successfully (file lands on disk) but fails to parse,
        so the except branch's own `local_path.exists()` check is True."""
        dim = 4
        good_dir = tmp_path / "good"
        _write_partition_parquet(good_dir / "embeddings.parquet", dim, rows=2, doc_id="good")
        partitions = [str(good_dir), str(tmp_path / "corrupt")]
        sizes = [100, 100]

        def _fake_download(key, local_path):
            if "corrupt" in key:
                Path(local_path).parent.mkdir(parents=True, exist_ok=True)
                Path(local_path).write_text("not a parquet file")
            else:
                shutil.copy2(key, local_path)

        with mock.patch("temporal_worker._MERGE_CHUNK_SIZE_MB", 100), \
             mock.patch("temporal_worker.posix_download_file", side_effect=_fake_download):
            consolidated = _consolidate_partitions_chunked(
                partitions, sizes, tmp_path / "work",
                EmbeddingGenerator.get_schema(dim),
                _PeriodicHeartbeat(interval=100),
                progress_reporter=None,
                total_documents=2,
            )

        assert len(consolidated) == 1
        import pyarrow.parquet as pq
        assert pq.read_table(consolidated[0]).num_rows == 2
        assert not (tmp_path / "work" / "part_1.parquet").exists()


class _FakeAsyncWorker:
    """Stand-in for temporalio.worker.Worker supporting `async with`."""

    def __init__(self, client, **kwargs):
        self.client = client
        self.kwargs = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class TestAsyncMain:
    def test_main_connects_registers_worker_and_shuts_down_cleanly(self):
        """Exercises the full async bootstrap: observability config, warmup,
        wait_for_temporal, Worker construction/registration, the watchdog,
        signal-handler registration, and the clean-shutdown log path. The
        shutdown event is faked to resolve immediately so the test doesn't
        need to actually deliver a process signal."""
        fake_client = mock.sentinel.temporal_client
        captured_worker_call = {}

        async def _fake_wait_for_temporal(address, namespace):
            captured_worker_call["address"] = address
            captured_worker_call["namespace"] = namespace
            return fake_client

        def _fake_worker_ctor(client, **kwargs):
            captured_worker_call["client"] = client
            captured_worker_call["kwargs"] = kwargs
            return _FakeAsyncWorker(client, **kwargs)

        fake_event = mock.MagicMock()
        fake_event.wait = mock.AsyncMock(return_value=None)

        with mock.patch("temporal_worker.wait_for_temporal", side_effect=_fake_wait_for_temporal), \
             mock.patch("temporal_worker.start_watchdog") as mock_watchdog, \
             mock.patch("temporal_worker.Worker", side_effect=_fake_worker_ctor), \
             mock.patch("temporal_worker._warmup_embedding_model") as mock_warmup, \
             mock.patch("observability_client_runtime.configure_observability_minimal") as mock_configure, \
             mock.patch("asyncio.Event", return_value=fake_event), \
             mock.patch.dict(os.environ, {
                 "TEMPORAL_ADDRESS": "temporal-test:7233",
                 "TEMPORAL_NAMESPACE": "test-ns",
                 "TASK_QUEUE": "kb-processing-test",
                 "MAX_CONCURRENT_ACTIVITIES": "3",
             }):
            asyncio.run(temporal_worker.main())

        mock_configure.assert_called_once()
        mock_warmup.assert_called_once()
        assert captured_worker_call["address"] == "temporal-test:7233"
        assert captured_worker_call["namespace"] == "test-ns"
        mock_watchdog.assert_called_once_with(fake_client, "test-ns")
        assert captured_worker_call["client"] is fake_client
        assert captured_worker_call["kwargs"]["task_queue"] == "kb-processing-test"
        assert captured_worker_call["kwargs"]["max_concurrent_activities"] == 3
        fake_event.wait.assert_awaited_once()

    def test_main_uses_defaults_when_env_vars_unset(self):
        fake_client = mock.sentinel.temporal_client

        async def _fake_wait_for_temporal(address, namespace):
            return fake_client

        captured = {}

        def _fake_worker_ctor(client, **kwargs):
            captured["kwargs"] = kwargs
            return _FakeAsyncWorker(client, **kwargs)

        fake_event = mock.MagicMock()
        fake_event.wait = mock.AsyncMock(return_value=None)

        env_keys = ["TEMPORAL_ADDRESS", "TEMPORAL_NAMESPACE", "TASK_QUEUE", "MAX_CONCURRENT_ACTIVITIES"]
        with mock.patch("temporal_worker.wait_for_temporal", side_effect=_fake_wait_for_temporal), \
             mock.patch("temporal_worker.start_watchdog"), \
             mock.patch("temporal_worker.Worker", side_effect=_fake_worker_ctor), \
             mock.patch("temporal_worker._warmup_embedding_model"), \
             mock.patch("observability_client_runtime.configure_observability_minimal"), \
             mock.patch("asyncio.Event", return_value=fake_event), \
             mock.patch.dict(os.environ, {}, clear=False):
            for k in env_keys:
                os.environ.pop(k, None)
            asyncio.run(temporal_worker.main())

        assert captured["kwargs"]["task_queue"] == "kb-processing"
        assert captured["kwargs"]["max_concurrent_activities"] == 2

    def test_main_shuts_down_cleanly_on_real_sigterm(self):
        """Delivers a real SIGTERM to this process once the loop is running,
        exercising the actual `_request_shutdown` signal-handler closure
        (registered via `loop.add_signal_handler`) rather than faking the
        shutdown event directly."""
        fake_client = mock.sentinel.temporal_client

        async def _fake_wait_for_temporal(address, namespace):
            loop = asyncio.get_running_loop()
            loop.call_later(0.15, lambda: os.kill(os.getpid(), signal.SIGTERM))
            return fake_client

        def _fake_worker_ctor(client, **kwargs):
            return _FakeAsyncWorker(client, **kwargs)

        async def _run_with_timeout():
            await asyncio.wait_for(temporal_worker.main(), timeout=5)

        with mock.patch("temporal_worker.wait_for_temporal", side_effect=_fake_wait_for_temporal), \
             mock.patch("temporal_worker.start_watchdog"), \
             mock.patch("temporal_worker.Worker", side_effect=_fake_worker_ctor), \
             mock.patch("temporal_worker._warmup_embedding_model"), \
             mock.patch("observability_client_runtime.configure_observability_minimal"):
            asyncio.run(_run_with_timeout())  # must return cleanly, not raise/hang
