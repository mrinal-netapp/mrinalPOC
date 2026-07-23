"""Phase-4 branch coverage: discover resume, register tail drain, ANF merge context."""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

fakeredis = pytest.importorskip("fakeredis")
pytest.importorskip("temporalio")

from activities import acquisition_pipeline as ap  # noqa: E402
from adapters.anf_metrics_adapter import _merge_metric_point  # noqa: E402
from adapters.ontap_adapter import OntapAdapter  # noqa: E402
from streaming.redis_stream import EOF_FIELD, EOF_VALUE, JobStream, JobStreamConfig  # noqa: E402


def _call_activity(fn, *args, **kwargs):
    return getattr(fn, "__wrapped__", fn)(*args, **kwargs)


def _make_stream(wf="wf-p4", run="run-p4") -> JobStream:
    return JobStream(
        JobStreamConfig(
            workflow_id=wf,
            run_id=run,
            client=fakeredis.FakeRedis(decode_responses=True),
            ttl_seconds=3600,
            stream_maxlen=1000,
        )
    )


def _discover_stubs(monkeypatch, js: JobStream):
    monkeypatch.setattr(
        ap, "_activity_workflow_context", lambda: (js.cfg.workflow_id, js.cfg.run_id)
    )
    monkeypatch.setattr(ap, "build_job_stream", lambda *_a, **_kw: js)
    monkeypatch.setattr(ap, "log_activity_start", lambda *_a, **_kw: None)
    monkeypatch.setattr(ap, "log_activity_result", lambda *_a, **_kw: None)
    monkeypatch.setattr(ap.activity, "heartbeat", lambda *_a, **_kw: None)
    monkeypatch.setattr(ap.time, "sleep", lambda *_a, **_kw: None)
    monkeypatch.setattr(ap, "resolve_credential", lambda *_a, **_kw: {})
    monkeypatch.setattr(
        ap,
        "WorkflowProgressReporter",
        lambda *_a, **_kw: MagicMock(url="http://progress"),
    )


class TestDiscoverObjectStoreResume:
    def test_returns_cached_totals_when_eof_already_set(self, monkeypatch):
        js = _make_stream("wf-disc-eof", "run-disc-eof")
        js.ensure_group()
        js.update_state(produced=7, filtered=2, eofSeen=1)
        _discover_stubs(monkeypatch, js)

        out = _call_activity(
            ap.discover_object_store_items,
            {
                "projectID": "p",
                "credentialID": "c",
                "configServiceURL": "http://cfg",
                "connectorConfig": {"bucket": "b", "prefix": ""},
            },
        )
        assert out["resumed"] == "from_eof"
        assert out["totalDiscovered"] == 7
        assert out["filesFiltered"] == 2

    def test_resumes_from_last_produced_key(self, monkeypatch):
        js = _make_stream("wf-disc-resume", "run-disc-resume")
        js.ensure_group()
        js.produce([{"key": "incoming/a.csv", "size": 1}])
        js.update_state(produced=1, listed=1)
        _discover_stubs(monkeypatch, js)

        paginator = MagicMock()
        paginator.paginate.return_value = [
            {
                "Contents": [{"Key": "incoming/b.csv", "Size": 2}],
            }
        ]
        mock_ext = MagicMock()
        mock_ext.get_paginator.return_value = paginator
        monkeypatch.setattr(ap, "get_external_s3_client", lambda *_a, **_kw: mock_ext)

        out = _call_activity(
            ap.discover_object_store_items,
            {
                "projectID": "p",
                "credentialID": "c",
                "configServiceURL": "http://cfg",
                "connectorConfig": {"bucket": "b", "prefix": "incoming/"},
            },
        )
        assert out["totalDiscovered"] == 1
        kwargs = paginator.paginate.call_args.kwargs
        assert kwargs.get("StartAfter") == "incoming/a.csv"

    def test_glob_and_exclude_filters(self, monkeypatch):
        js = _make_stream("wf-disc-glob", "run-disc-glob")
        _discover_stubs(monkeypatch, js)

        paginator = MagicMock()
        paginator.paginate.return_value = [
            {
                "Contents": [
                    {"Key": "incoming/keep.csv", "Size": 1},
                    {"Key": "incoming/skip.txt", "Size": 1},
                    {"Key": "incoming/_tmp.csv", "Size": 1},
                ],
            }
        ]
        mock_ext = MagicMock()
        mock_ext.get_paginator.return_value = paginator
        monkeypatch.setattr(ap, "get_external_s3_client", lambda *_a, **_kw: mock_ext)

        out = _call_activity(
            ap.discover_object_store_items,
            {
                "projectID": "p",
                "credentialID": "c",
                "configServiceURL": "http://cfg",
                "connectorConfig": {"bucket": "b", "prefix": "incoming/"},
                "fileGlob": "*.csv",
                "fileExcludePattern": "_tmp*",
            },
        )
        assert out["totalDiscovered"] == 1
        assert out["filesFiltered"] >= 2


class TestRegisterBatchTailDrain:
    def test_drains_tail_entries_after_eof(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setenv("ACQ_EMPTY_READS_AFTER_EOF", "1")
        monkeypatch.setenv("ACQ_BATCH_SIZE", "10")

        js = _make_stream("wf-reg-tail", "run-reg-tail")
        js.ensure_group()
        js.produce(
            [
                {
                    "key": "incoming/a.csv",
                    "uri": "s3://b/incoming/a.csv",
                    "relative_path": "a.csv",
                    "size": 10,
                    "last_modified": "2026-01-01T00:00:00Z",
                }
            ]
        )
        js._client.xadd(js.stream_key, {EOF_FIELD: EOF_VALUE, "key": ""})
        js.produce(
            [
                {
                    "key": "incoming/tail.csv",
                    "uri": "s3://b/incoming/tail.csv",
                    "relative_path": "tail.csv",
                    "size": 5,
                    "last_modified": "2026-01-02T00:00:00Z",
                }
            ]
        )
        js.update_state(eofSeen=1)

        monkeypatch.setattr(
            ap, "_activity_workflow_context", lambda: ("wf-reg-tail", "run-reg-tail")
        )
        monkeypatch.setattr(ap, "build_job_stream", lambda *_a, **_kw: js)
        monkeypatch.setattr(ap, "log_activity_start", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap, "log_activity_result", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap.activity, "heartbeat", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap.activity, "is_cancelled", lambda: False)
        monkeypatch.setattr(ap.time, "sleep", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap, "_jittered_ms", lambda base: min(base, 50))
        monkeypatch.setattr(ap.random, "uniform", lambda *_a, **_kw: 0.0)

        out = _call_activity(
            ap.register_batch,
            {
                "projectID": "p",
                "datasetID": "d",
                "setId": "reg-tail",
                "outputPath": "/projects/p/datasets/d/data_files",
            },
        )
        assert out["status"] == "success"
        assert out["fileCount"] == 2


class TestAnfMergeVolumeContext:
    def test_volume_context_stamps_identity_fields(self):
        vd: dict = {}
        ts = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        ctx = {
            "subscription_id": "sub",
            "netapp_account": "acct",
            "pool_id": "pool",
            "volume_id": "vol-1",
            "volume_name": "vol-a",
        }
        vol_ctx = {
            "service_level": "Premium",
            "netapp_account": "acct2",
            "subscription_id": "sub2",
        }
        _merge_metric_point(
            vd,
            "vol-1",
            "vol-a",
            ts,
            "iops_read",
            10.0,
            ctx=ctx,
            volume_context=vol_ctx,
        )
        bucket = vd["vol-1"][ts.isoformat()]
        assert bucket["service_level"] == "Premium"
        assert bucket["cluster_id"] == "acct2"
        assert bucket["account_id"] == "sub2"


class TestOntapListAggregatesTruncated:
    @patch("adapters.ontap_adapter._client_from_config")
    def test_truncated_last_record_gets_marker(self, mock_factory):
        client = MagicMock()
        mock_factory.return_value.__enter__.return_value = client
        client.get_paginated.return_value = SimpleNamespace(
            records=[{"uuid": "a1", "name": "aggr1", "block_storage": {"primary": {}}}],
            truncated=True,
        )
        resp = OntapAdapter().execute(
            {"cluster_url": "https://x"},
            {"username": "u", "password": "p"},
            "listAggregates",
            {},
        )
        assert resp.nodes[0].metadata.get("truncated") is True
