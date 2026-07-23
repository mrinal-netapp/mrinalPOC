"""Unit tests for acquisition_pipeline helpers and activities.

Activities are exercised with a stub S3 client and fakeredis-backed JobStream.
We bypass temporalio's `@activity.defn` decorator by calling the underlying
function via .__wrapped__ when present; otherwise we monkeypatch the helpers
the activity uses.
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock

import pytest

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

# Skip the entire module if dependencies missing in the dev env.
fakeredis = pytest.importorskip("fakeredis")
boto3 = pytest.importorskip("boto3")  # noqa: F401  -- s3_helpers requires boto3 at import
pytest.importorskip("temporalio")

from streaming.redis_stream import JobStream, JobStreamConfig  # noqa: E402
from activities import acquisition_pipeline as ap  # noqa: E402


def _call_activity(fn, *args, **kwargs):
    """Call a temporalio @activity.defn-decorated function in tests.

    temporalio attaches the original callable as __wrapped__; fall back to
    calling fn directly if that's not present (older SDK versions).
    """
    target = getattr(fn, "__wrapped__", fn)
    return target(*args, **kwargs)


def _make_stream(workflow_id="wf-1", run_id="run-1") -> JobStream:
    client = fakeredis.FakeRedis(decode_responses=True)
    cfg = JobStreamConfig(
        workflow_id=workflow_id,
        run_id=run_id,
        client=client,
        ttl_seconds=3600,
        stream_maxlen=100,
    )
    return JobStream(cfg)


class TestFinalizeAggregation:
    def test_aggregates_manifests_and_writes_facet(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        artifact_root = "projects/p/datasets/d"
        manifests = {
            "m0": {
                "setId": "acq-s0",
                "filesCopied": 10,
                "bytesCopied": 1024,
                "errorCount": 0,
                "durationMs": 5_000,
            },
            "m1": {
                "setId": "acq-s1",
                "filesCopied": 7,
                "bytesCopied": 2048,
                "errorCount": 1,
                "durationMs": 12_000,
            },
        }
        for set_id, m in manifests.items():
            man_path = (
                tmp_path
                / artifact_root
                / "_acquisition"
                / "manifests"
                / f"{set_id}.json"
            )
            man_path.parent.mkdir(parents=True, exist_ok=True)
            man_path.write_text(json.dumps(m), encoding="utf-8")
        # Stub Temporal's activity.info() so log_activity_start works.
        monkeypatch.setattr(ap, "_activity_workflow_context", lambda: ("wf-1", "run-1"))
        # Avoid hitting JobStream.destroy (no real Redis configured here).
        monkeypatch.setattr(
            ap, "build_job_stream", lambda *_a, **_kw: MagicMock(destroy=MagicMock())
        )

        facet_calls: list[dict] = []

        def _fake_facet(
            url, project, dataset, *, state, job_id, summary, error_message=None
        ):
            facet_calls.append(
                {
                    "url": url,
                    "project": project,
                    "dataset": dataset,
                    "state": state,
                    "job_id": job_id,
                    "summary": summary,
                }
            )

        monkeypatch.setattr(ap, "_put_facet", _fake_facet)
        # No workflow-engine URL -> skip DELETE progress.
        out = _call_activity(
            ap.finalize_acquisition,
            {
                "projectID": "p",
                "datasetID": "d",
                "outputPath": "/projects/p/datasets/d/data_files",
                "configServiceURL": "http://config-service:3000",
                "filesDiscovered": 17,
                "filesFiltered": 3,
                "consumerCount": 2,
                "scatterError": False,
                "sourceEndpoint": "http://s3gateway:7070",
                "sourceBucket": "src",
                "sourcePrefix": "x/",
            },
        )

        assert out["filesCopied"] == 17
        assert out["totalBytes"] == 3072
        assert out["errorCount"] == 1
        assert out["facetState"] == "errored"  # error_count > 0 but scatter succeeded
        assert out["consumerCount"] == 2
        assert out["fileListKey"].startswith("projects/p/datasets/d/_acquisition/")
        # result.json was written
        result_json = tmp_path / artifact_root / "_acquisition" / "result.json"
        assert result_json.is_file()
        assert (tmp_path / artifact_root / "_acquisition" / "filelist.json").is_file()
        # Facet was written with the same metrics
        assert len(facet_calls) == 1
        fc = facet_calls[0]
        assert fc["state"] == "errored"
        assert fc["job_id"] is None
        assert fc["summary"]["filesCopied"] == 17
        assert fc["summary"]["totalBytes"] == 3072

    def test_scatter_error_marks_failed(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setattr(ap, "_activity_workflow_context", lambda: ("wf-1", "run-1"))
        monkeypatch.setattr(
            ap, "build_job_stream", lambda *_a, **_kw: MagicMock(destroy=MagicMock())
        )
        captured: list[dict] = []
        monkeypatch.setattr(ap, "_put_facet", lambda *a, **kw: captured.append(kw))

        out = _call_activity(
            ap.finalize_acquisition,
            {
                "projectID": "p",
                "datasetID": "d",
                "outputPath": "/projects/p/datasets/d/data_files",
                "scatterError": True,
            },
        )
        assert out["facetState"] == "failed"
        assert captured and captured[0]["state"] == "failed"


class TestCleanupActivity:
    def test_destroy_called_when_inputs_present(self, monkeypatch):
        sentinel = MagicMock()
        sentinel.destroy = MagicMock()
        sentinel.stream_key = "acq:wf:run:items"
        monkeypatch.setattr(ap, "build_job_stream", lambda *_a, **_kw: sentinel)
        out = _call_activity(
            ap.cleanup_acquisition_stream,
            {
                "workflowId": "wf",
                "runId": "run",
            },
        )
        assert out["destroyed"] is True
        sentinel.destroy.assert_called_once()

    def test_missing_ids_returns_no_op(self, monkeypatch):
        monkeypatch.setattr(ap, "_activity_workflow_context", lambda: ("", ""))
        out = _call_activity(ap.cleanup_acquisition_stream, {})
        assert out["destroyed"] is False


WF_ID = "wf-acq-test"
RUN_ID = "run-acq-test"


def _discover_input(**overrides):
    body = {
        "projectID": "proj-1",
        "credentialID": "cred-1",
        "configServiceURL": "http://config-service:3000",
        "connectorConfig": {
            "bucket": "source-bucket",
            "prefix": "incoming/",
            "endpoint": "http://external-s3:9000",
        },
        "fileGlob": "*.csv",
        "fileExcludePattern": "_tmp*",
    }
    body.update(overrides)
    return body


def _acquire_input(**overrides):
    body = {
        "projectID": "proj-1",
        "datasetID": "ds-1",
        "credentialID": "cred-1",
        "configServiceURL": "http://config-service:3000",
        "setId": "acq-s0",
        "connectorConfig": {
            "bucket": "source-bucket",
            "prefix": "incoming/",
            "endpoint": "http://minio:9000",
        },
        "outputPath": "/projects/proj-1/datasets/ds-1/data_files",
        "outputBucket": "dest-bucket",
    }
    body.update(overrides)
    return body


def _pipeline_stubs(monkeypatch, js: JobStream):
    """Wire fakeredis JobStream + Temporal context for discover/acquire activities."""
    monkeypatch.setattr(ap, "_activity_workflow_context", lambda: (WF_ID, RUN_ID))
    monkeypatch.setattr(ap, "build_job_stream", lambda wf, rn: js)
    monkeypatch.setattr(
        ap,
        "resolve_credential",
        lambda *_a, **_kw: {
            "access_key_id": "AK",
            "secret_access_key": "secret",
        },
    )
    monkeypatch.setattr(ap.activity, "heartbeat", lambda *_a, **_kw: None)
    reporter = MagicMock()
    reporter.url = ""
    monkeypatch.setattr(ap, "WorkflowProgressReporter", lambda *_a, **_kw: reporter)
    monkeypatch.setattr(ap.time, "sleep", lambda *_a, **_kw: None)
    monkeypatch.setattr(ap, "_jittered_ms", lambda base: min(base, 50))
    monkeypatch.setattr(ap, "_jittered_seconds", lambda base: 0.0)


def _mock_paginator(mock_ext_s3, pages):
    paginator = MagicMock()
    paginator.paginate.return_value = pages
    mock_ext_s3.get_paginator.return_value = paginator


class TestDiscoverObjectStoreItems:
    def test_produces_filtered_items_and_marks_eof(self, monkeypatch):
        js = _make_stream(WF_ID, RUN_ID)
        _pipeline_stubs(monkeypatch, js)

        mock_ext = MagicMock()
        monkeypatch.setattr(ap, "get_external_s3_client", lambda *_a, **_kw: mock_ext)

        ts = datetime(2026, 1, 15, tzinfo=timezone.utc)
        _mock_paginator(
            mock_ext,
            [
                {
                    "Contents": [
                        {"Key": "incoming/keep.csv", "Size": 11, "LastModified": ts},
                        {"Key": "incoming/skip.txt", "Size": 5, "LastModified": ts},
                        {"Key": "incoming/_tmp_bad.csv", "Size": 1, "LastModified": ts},
                    ],
                }
            ],
        )

        out = _call_activity(ap.discover_object_store_items, _discover_input())

        assert out["eof"] is True
        assert out["totalDiscovered"] == 1
        assert out["filesFiltered"] == 2
        assert out["filesListed"] == 3
        assert out["streamKey"] == js.stream_key
        assert js.is_complete()

        entries = js.consume("test-consumer", count=20, block_ms=50)
        keys = [f["key"] for _sid, f in entries if f.get("key")]
        assert keys == ["incoming/keep.csv"]

        mock_ext.get_paginator.assert_called_once_with("list_objects_v2")
        paginate_kw = mock_ext.get_paginator.return_value.paginate.call_args.kwargs
        assert paginate_kw["Bucket"] == "source-bucket"
        assert paginate_kw["Prefix"] == "incoming/"

    def test_returns_cached_totals_when_stream_already_complete(self, monkeypatch):
        js = _make_stream(WF_ID, RUN_ID)
        js.ensure_group()
        js.produce([{"key": "incoming/x.csv", "size": 1}])
        js.mark_eof()
        js.update_state(produced=1, filtered=0, listed=1)
        _pipeline_stubs(monkeypatch, js)

        list_called = MagicMock()
        monkeypatch.setattr(
            ap, "get_external_s3_client", lambda *_a, **_kw: list_called
        )

        out = _call_activity(ap.discover_object_store_items, _discover_input())

        assert out["resumed"] == "from_eof"
        assert out["totalDiscovered"] == 1
        assert out["eof"] is True
        list_called.get_paginator.assert_not_called()

    def test_requires_bucket(self, monkeypatch):
        js = _make_stream(WF_ID, RUN_ID)
        _pipeline_stubs(monkeypatch, js)
        monkeypatch.setattr(ap, "get_external_s3_client", MagicMock())

        with pytest.raises(ValueError, match="bucket is required"):
            _call_activity(
                ap.discover_object_store_items,
                _discover_input(connectorConfig={"prefix": "p/"}),
            )

    def test_requires_temporal_context(self, monkeypatch):
        monkeypatch.setattr(ap, "_activity_workflow_context", lambda: ("", ""))
        with pytest.raises(RuntimeError, match="Temporal activity context"):
            _call_activity(ap.discover_object_store_items, _discover_input())

    def test_discover_source_items_alias(self, monkeypatch):
        js = _make_stream(WF_ID, RUN_ID)
        _pipeline_stubs(monkeypatch, js)
        mock_ext = MagicMock()
        monkeypatch.setattr(ap, "get_external_s3_client", lambda *_a, **_kw: mock_ext)
        _mock_paginator(
            mock_ext,
            [
                {
                    "Contents": [
                        {
                            "Key": "incoming/a.csv",
                            "Size": 2,
                            "LastModified": datetime.now(timezone.utc),
                        },
                    ]
                }
            ],
        )

        out = _call_activity(ap.discover_source_items, _discover_input(fileGlob=""))
        assert out["totalDiscovered"] == 1
        assert out["eof"] is True


class TestAcquireBatch:
    def _seed_stream(self, js: JobStream, items: list[dict]):
        js.ensure_group()
        js.produce(items)
        js.mark_eof()

    def test_server_side_copy_writes_manifest(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setenv("S3_ENDPOINT", "http://minio:9000")
        monkeypatch.setenv("ACQ_MAX_BATCHES_PER_ACTIVITY", "5")
        monkeypatch.setenv("ACQ_BATCH_SIZE", "10")
        monkeypatch.setenv("ACQ_EMPTY_READS_AFTER_EOF", "1")

        js = _make_stream(WF_ID, RUN_ID)
        self._seed_stream(
            js,
            [
                {"key": "incoming/a.csv", "size": 100},
                {"key": "incoming/b.csv", "size": 200},
            ],
        )
        _pipeline_stubs(monkeypatch, js)

        mock_ext = MagicMock()
        mock_int = MagicMock()
        monkeypatch.setattr(ap, "get_external_s3_client", lambda *_a, **_kw: mock_ext)
        monkeypatch.setattr(ap, "get_internal_s3_client", lambda: mock_int)
        copy_mock = MagicMock()
        monkeypatch.setattr(ap, "copy_object_with_backoff", copy_mock)

        out = _call_activity(ap.acquire_batch, _acquire_input())

        assert out["status"] == "success"
        assert out["fileCount"] == 2
        assert out["extra"]["bytesCopied"] == 300
        assert copy_mock.call_count == 2

        manifest_path = (
            tmp_path
            / "projects/proj-1/datasets/ds-1/_acquisition/manifests/acq-s0.json"
        )
        assert manifest_path.is_file()
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        assert manifest["filesCopied"] == 2
        assert manifest["bytesCopied"] == 300
        assert len(manifest["items"]) == 2

    def test_download_upload_when_endpoints_differ(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setenv("S3_ENDPOINT", "http://internal:9000")
        monkeypatch.setenv("ACQ_MAX_BATCHES_PER_ACTIVITY", "5")
        monkeypatch.setenv("ACQ_BATCH_SIZE", "10")

        js = _make_stream(WF_ID, RUN_ID)
        self._seed_stream(js, [{"key": "incoming/only.csv", "size": 42}])
        _pipeline_stubs(monkeypatch, js)

        mock_ext = MagicMock()

        def _download(bucket, key, fileobj):
            fileobj.write(b"payload")

        mock_ext.download_fileobj.side_effect = _download
        monkeypatch.setattr(ap, "get_external_s3_client", lambda *_a, **_kw: mock_ext)
        monkeypatch.setattr(ap, "get_internal_s3_client", MagicMock())
        copy_mock = MagicMock()
        monkeypatch.setattr(ap, "copy_object_with_backoff", copy_mock)

        inp = _acquire_input(
            connectorConfig={
                "bucket": "source-bucket",
                "prefix": "incoming/",
                "endpoint": "http://external:9000",
            }
        )
        out = _call_activity(ap.acquire_batch, inp)

        assert out["fileCount"] == 1
        copy_mock.assert_not_called()
        dest = tmp_path / "projects/proj-1/datasets/ds-1/data_files/only.csv"
        assert dest.read_bytes() == b"payload"

    def test_copy_failure_leaves_item_pending(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setenv("S3_ENDPOINT", "http://minio:9000")
        monkeypatch.setenv("ACQ_MAX_BATCHES_PER_ACTIVITY", "5")
        monkeypatch.setenv("ACQ_BATCH_SIZE", "10")
        monkeypatch.setenv("ACQ_EMPTY_READS_AFTER_EOF", "1")

        js = _make_stream(WF_ID, RUN_ID)
        self._seed_stream(
            js,
            [
                {"key": "incoming/good.csv", "size": 10},
                {"key": "incoming/bad.csv", "size": 20},
            ],
        )
        _pipeline_stubs(monkeypatch, js)

        def _copy_side_effect(_client, _bucket, dest_key, _source, **kwargs):
            if dest_key.endswith("bad.csv"):
                raise RuntimeError("copy failed")

        monkeypatch.setattr(ap, "get_external_s3_client", MagicMock())
        monkeypatch.setattr(ap, "get_internal_s3_client", MagicMock())
        monkeypatch.setattr(ap, "copy_object_with_backoff", _copy_side_effect)

        out = _call_activity(ap.acquire_batch, _acquire_input())

        assert out["fileCount"] == 1
        assert out["extra"]["errorCount"] == 1
        assert out["status"] == "success"

    def test_all_copy_failures_return_error_status(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setenv("S3_ENDPOINT", "http://minio:9000")
        monkeypatch.setenv("ACQ_MAX_BATCHES_PER_ACTIVITY", "5")
        monkeypatch.setenv("ACQ_BATCH_SIZE", "10")
        monkeypatch.setenv("ACQ_EMPTY_READS_AFTER_EOF", "1")

        js = _make_stream(WF_ID, RUN_ID)
        self._seed_stream(js, [{"key": "incoming/fail.csv", "size": 10}])
        _pipeline_stubs(monkeypatch, js)

        monkeypatch.setattr(ap, "get_external_s3_client", MagicMock())
        monkeypatch.setattr(ap, "get_internal_s3_client", MagicMock())
        monkeypatch.setattr(
            ap,
            "copy_object_with_backoff",
            MagicMock(side_effect=RuntimeError("copy failed")),
        )

        out = _call_activity(ap.acquire_batch, _acquire_input())
        assert out["status"] == "error"
        assert out["fileCount"] == 0
        assert out["extra"]["errorCount"] == 1
        assert "copy failed" in out["error"]

    def test_discover_resumes_from_last_produced_key(self, monkeypatch):
        js = _make_stream(WF_ID, RUN_ID)
        js.ensure_group()
        js.update_state(
            lastProducedKey="incoming/a.csv", produced=1, filtered=0, listed=2
        )
        _pipeline_stubs(monkeypatch, js)

        mock_ext = MagicMock()
        monkeypatch.setattr(ap, "get_external_s3_client", lambda *_a, **_kw: mock_ext)
        ts = datetime(2026, 1, 15, tzinfo=timezone.utc)
        _mock_paginator(
            mock_ext,
            [
                {
                    "Contents": [
                        {"Key": "incoming/b.csv", "Size": 5, "LastModified": ts},
                    ],
                }
            ],
        )

        out = _call_activity(
            ap.discover_object_store_items, _discover_input(fileGlob="")
        )

        assert out["totalDiscovered"] == 1
        paginate_kw = mock_ext.get_paginator.return_value.paginate.call_args.kwargs
        assert paginate_kw.get("StartAfter") == "incoming/a.csv"


class TestFinalizeAcquisitionResilience:
    def test_skips_unreadable_manifest_and_bad_item_sizes(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        artifact_root = "projects/p/datasets/d"
        man_dir = tmp_path / artifact_root / "_acquisition" / "manifests"
        man_dir.mkdir(parents=True)
        (man_dir / "acq-s0.json").write_text("{not-json", encoding="utf-8")
        (man_dir / "acq-s1.json").write_text(
            json.dumps(
                {
                    "setId": "acq-s1",
                    "filesCopied": 1,
                    "bytesCopied": 100,
                    "errorCount": 0,
                    "durationMs": 100,
                    "items": [
                        {"destKey": "projects/p/datasets/d/data/x.csv", "size": "nope"}
                    ],
                }
            ),
            encoding="utf-8",
        )

        monkeypatch.setattr(ap, "_activity_workflow_context", lambda: ("wf-1", "run-1"))
        monkeypatch.setattr(
            ap, "build_job_stream", lambda *_a, **_kw: MagicMock(destroy=MagicMock())
        )
        monkeypatch.setattr(ap, "_put_facet", lambda *_a, **_kw: None)

        out = _call_activity(
            ap.finalize_acquisition,
            {
                "projectID": "p",
                "datasetID": "d",
                "outputPath": "/projects/p/datasets/d/data_files",
                "consumerCount": 0,
            },
        )

        assert out["filesCopied"] == 1
        assert out["totalBytes"] == 100
        filelist = json.loads(
            (tmp_path / artifact_root / "_acquisition" / "filelist.json").read_text(
                encoding="utf-8"
            )
        )
        assert filelist["files"][0]["size"] == 0


class TestAcquireBatchStateBranches:
    def test_increment_state_failure_is_non_fatal(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setenv("S3_ENDPOINT", "http://minio:9000")
        monkeypatch.setenv("ACQ_MAX_BATCHES_PER_ACTIVITY", "5")
        monkeypatch.setenv("ACQ_BATCH_SIZE", "10")
        monkeypatch.setenv("ACQ_EMPTY_READS_AFTER_EOF", "1")

        js = _make_stream(WF_ID, RUN_ID)
        js.ensure_group()
        js.produce([{"key": "incoming/a.csv", "size": 10}])
        js.mark_eof()
        _pipeline_stubs(monkeypatch, js)
        monkeypatch.setattr(ap, "get_external_s3_client", MagicMock())
        monkeypatch.setattr(ap, "get_internal_s3_client", MagicMock())
        monkeypatch.setattr(ap, "copy_object_with_backoff", MagicMock())
        monkeypatch.setattr(js, "increment_state", lambda **_kw: False)

        out = _call_activity(ap.acquire_batch, _acquire_input())
        assert out["status"] == "success"
        assert out["fileCount"] == 1

    def test_requires_temporal_context(self, monkeypatch):
        monkeypatch.setattr(ap, "_activity_workflow_context", lambda: ("", ""))
        with pytest.raises(RuntimeError, match="Temporal activity context"):
            _call_activity(ap.acquire_batch, _acquire_input())
