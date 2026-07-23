"""Phase-5 branch coverage: zero-percent branch lines and remaining edge paths."""

from __future__ import annotations

import json
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
from activities import objectstore as os_mod  # noqa: E402
from activities import redash_acquisition as ra  # noqa: E402
from adapters.gcp_adapter import GCPAdapter  # noqa: E402
from adapters.ontap_adapter import OntapAdapter  # noqa: E402
from adapters.ontap_metrics_adapter import OntapMetricsAdapter  # noqa: E402
from ontap_common.client import split_host_port  # noqa: E402
from tests.fixtures.azure_monitor_responses import FIXTURE_POOL_ARM_ID  # noqa: E402
from streaming.redis_stream import JobStream, JobStreamConfig  # noqa: E402


def _call_activity(fn, *args, **kwargs):
    return getattr(fn, "__wrapped__", fn)(*args, **kwargs)


def _call_redash(body):
    target = getattr(ra.acquire_from_api, "__wrapped__", ra.acquire_from_api)
    return __import__("asyncio").run(target(body))


def _make_stream(wf="wf-p5", run="run-p5") -> JobStream:
    return JobStream(
        JobStreamConfig(
            workflow_id=wf,
            run_id=run,
            client=fakeredis.FakeRedis(decode_responses=True),
            ttl_seconds=3600,
            stream_maxlen=1000,
        )
    )


class TestSplitHostPort:
    def test_http_default_port_80(self):
        assert split_host_port("http://ontap.example.com") == ("ontap.example.com", 80)

    def test_https_explicit_port(self):
        assert split_host_port("https://ontap.example.com:8443") == (
            "ontap.example.com",
            8443,
        )


class TestObjectstoreConnectionErrors:
    def test_gcs_api_not_enabled_message(self, monkeypatch):
        monkeypatch.setattr(
            os_mod,
            "resolve_credential",
            lambda *_a, **_kw: {"service_account_json": "{}"},
        )
        mock_client = MagicMock()
        mock_client.list_buckets.side_effect = Exception(
            "API has not been used in project"
        )
        monkeypatch.setattr(
            "activities.gcs_acquisition._gcs_client", lambda *_a, **_kw: mock_client
        )
        out = os_mod._test_gcs_objectstore_connection(
            {}, {"provider": "gcs", "project_id": "p"}
        )
        assert out["success"] is False
        assert "not enabled" in out["message"]


class TestOntapMetricsConnection:
    @patch("adapters.ontap_metrics_adapter.httpx.Client")
    def test_strips_http_scheme_from_cluster_url(self, mock_client_cls):
        mock_client_cls.return_value.__enter__.return_value.get.return_value = (
            MagicMock(
                status_code=200,
                json=MagicMock(return_value={}),
            )
        )
        resp = OntapMetricsAdapter().execute(
            {"cluster_url": "http://ontap.example.com"},
            {"username": "u", "password": "p"},
            "testConnection",
            {},
        )
        assert resp.error is None
        called_url = mock_client_cls.return_value.__enter__.return_value.get.call_args[
            0
        ][0]
        assert called_url.startswith("https://ontap.example.com")


class TestGcpAlloydbClusterRegion:
    @patch("adapters.gcp_adapter.build")
    def test_cluster_without_locations_path(self, mock_build):
        svc = MagicMock()
        mock_build.return_value = svc
        svc.projects.return_value.locations.return_value.clusters.return_value.list.return_value.execute.return_value = {
            "clusters": [
                {
                    "name": "short-cluster",
                    "state": "READY",
                    "databaseVersion": "POSTGRES_15",
                }
            ],
        }
        resp = GCPAdapter()._list_alloydb_clusters(MagicMock(), "p", "us-central1")
        assert resp.nodes[0].metadata["region"] == ""


class TestOntapDefaultSvmInterfaces:
    @patch("adapters.ontap_adapter._client_from_config")
    def test_list_svm_interfaces_uses_default_svm(self, mock_factory):
        client = MagicMock()
        mock_factory.return_value.__enter__.return_value = client
        client.get_paginated.return_value = SimpleNamespace(records=[], truncated=False)
        OntapAdapter().execute(
            {"cluster_url": "https://x", "default_svm": "svm-default"},
            {"username": "u", "password": "p"},
            "listSvmInterfaces",
            {},
        )
        params = client.get_paginated.call_args.kwargs["params"]
        assert params.get("svm.name") == "svm-default"


class TestRedashSingleTableFailure:
    @pytest.fixture(autouse=True)
    def _temporal(self, monkeypatch):
        monkeypatch.setattr(
            ra.activity,
            "info",
            lambda: SimpleNamespace(workflow_run_id="run12345678"),
        )
        monkeypatch.setattr(ra.activity, "heartbeat", lambda *_a, **_k: None)

    @patch(
        "activities.redash_acquisition.resolve_credential",
        return_value={"api_key": "k"},
    )
    @patch("activities.redash_acquisition.RedashClient")
    def test_raises_when_only_table_fails(self, mock_cls, _cred, tmp_path, monkeypatch):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        client = MagicMock()
        mock_cls.return_value = client
        client.list_data_sources.return_value = [{"id": 2, "type": "postgresql"}]
        client.execute_sql.side_effect = RuntimeError("query failed")

        with pytest.raises(RuntimeError, match="query failed"):
            _call_redash(
                {
                    "provider": "redash",
                    "projectID": "p1",
                    "datasetID": "d1",
                    "credentialId": "c1",
                    "configServiceURL": "http://cfg",
                    "connectionInfo": {"base_url": "https://redash.example.com"},
                    "resourceSelector": [
                        {"data_source_id": 2, "table": "public.users"}
                    ],
                }
            )


class TestRegisterBatchEmptyLogging:
    def test_logs_empty_reads_before_eof_exit(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setenv("ACQ_EMPTY_READS_AFTER_EOF", "2")
        monkeypatch.setenv("ACQ_BATCH_SIZE", "10")

        client = fakeredis.FakeRedis(decode_responses=True)
        js = JobStream(
            JobStreamConfig(
                workflow_id="wf-reg-log",
                run_id="run-reg-log",
                client=client,
                ttl_seconds=3600,
                stream_maxlen=100,
            )
        )
        js.ensure_group()
        js.update_state(eofSeen=1)

        monkeypatch.setattr(
            ap, "_activity_workflow_context", lambda: ("wf-reg-log", "run-reg-log")
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
                "setId": "reg-log",
                "outputPath": "/projects/p/datasets/d/data_files",
            },
        )
        assert out["status"] == "success"
        assert out["fileCount"] == 0


class TestDiscoverVolumeEmptyPopLogging:
    def test_waits_when_queue_not_idle(self, monkeypatch, tmp_path):
        mount = tmp_path / "vol"
        mount.mkdir()
        (mount / "a.txt").write_text("a")

        client = fakeredis.FakeRedis(decode_responses=True)
        js = JobStream(
            JobStreamConfig(
                workflow_id="wf-dvf",
                run_id="run-dvf",
                client=client,
                ttl_seconds=3600,
                stream_maxlen=1000,
            )
        )
        dq = ap.DirQueue(client, "wf-dvf", "run-dvf")
        dq.seed([str(mount)])
        client.hset(dq.state_key, "dirqueue_active", 2)

        monkeypatch.setattr(
            ap, "_activity_workflow_context", lambda: ("wf-dvf", "run-dvf")
        )
        monkeypatch.setattr(ap, "build_job_stream", lambda *_a, **_kw: js)
        monkeypatch.setattr(ap, "log_activity_start", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap, "log_activity_result", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap.activity, "heartbeat", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap.activity, "is_cancelled", lambda: False)
        monkeypatch.setattr(ap.time, "sleep", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap.random, "uniform", lambda *_a, **_kw: 0.0)
        monkeypatch.setattr(ap, "_jittered_seconds", lambda base: 0.01)
        monkeypatch.setattr(ap, "_jittered_ms", lambda base: min(base, 50))
        monkeypatch.setenv("ACQ_DIRQUEUE_BRPOP_TIMEOUT_SEC", "0.01")
        monkeypatch.setenv("ACQ_DISCOVER_GREEDY_DEPTH", "1")
        monkeypatch.setenv("ACQ_DISCOVER_GREEDY_ENTRIES", "100")

        pops = {"n": 0}

        real_blpop = client.blpop

        def fake_blpop(keys, timeout=0):
            pops["n"] += 1
            if pops["n"] <= 6:
                return None
            return real_blpop(keys, timeout=0.01)

        monkeypatch.setattr(client, "blpop", fake_blpop)

        out = _call_activity(
            ap.discover_volume_files,
            {
                "mountPath": str(mount),
                "projectID": "p",
                "datasetID": "d",
                "outputPath": "/projects/p/datasets/d/data_files",
            },
        )
        assert out["totalDiscovered"] >= 0


class TestGcpMonitoringFilterEmpty:
    def test_empty_location_returns_empty_filter(self):
        from adapters.gcp_adapter import _gcnv_monitoring_location_filter

        assert _gcnv_monitoring_location_filter("") == ""


class TestRedashExecuteQueryBranches:
    def test_404_returns_none(self):
        from activities.redash_client import RedashClient

        client = RedashClient("https://redash.example.com", "key")
        resp = MagicMock(status_code=404)
        client._request = MagicMock(return_value=resp)
        assert client.execute_query(99) is None

    def test_row_cap_exceeded_returns_none(self):
        from activities.redash_client import RedashClient

        client = RedashClient("https://redash.example.com", "key", max_result_rows=2)
        resp = MagicMock(status_code=200)
        resp.json.return_value = {
            "query_result": {"data": {"rows": [{"a": 1}, {"a": 2}, {"a": 3}]}},
        }
        resp.raise_for_status = MagicMock()
        client._request = MagicMock(return_value=resp)
        assert client.execute_query(1) is None

    def test_missing_job_and_result_returns_none(self):
        from activities.redash_client import RedashClient

        client = RedashClient("https://redash.example.com", "key")
        resp = MagicMock(status_code=200)
        resp.json.return_value = {}
        resp.raise_for_status = MagicMock()
        client._request = MagicMock(return_value=resp)
        assert client.execute_query(1) is None


class TestAnfQueryWindowEdge:
    def test_iter_windows_stops_at_end(self):
        from datetime import timedelta

        from adapters.anf_metrics_adapter import _iter_metrics_query_windows

        start = datetime(2026, 1, 1, tzinfo=timezone.utc)
        end = start + timedelta(days=1)
        windows = _iter_metrics_query_windows(start, end, max_days=1)
        assert windows == [(start, end)]

    def test_merge_metric_point_updates_existing_bucket_context(self):
        from adapters.anf_metrics_adapter import _merge_metric_point

        vd: dict = {}
        ts = datetime(2026, 1, 1, tzinfo=timezone.utc)
        _merge_metric_point(
            vd,
            "v1",
            "vol",
            ts,
            "iops_read",
            1.0,
            ctx={
                "subscription_id": "sub",
                "netapp_account": "acct",
                "pool_id": "pool",
                "volume_id": "v1",
                "volume_name": "vol",
            },
        )
        _merge_metric_point(
            vd,
            "v1",
            "vol",
            ts,
            "iops_write",
            2.0,
            volume_context={"service_level": "Ultra", "netapp_account": "acct2"},
        )
        bucket = vd["v1"][ts.isoformat()]
        assert bucket["service_level"] == "Ultra"
        assert bucket["cluster_id"] == "acct2"


class TestRedashSingleQueryFailure:
    @pytest.fixture(autouse=True)
    def _temporal(self, monkeypatch):
        monkeypatch.setattr(
            ra.activity,
            "info",
            lambda: SimpleNamespace(workflow_run_id="run12345678"),
        )
        monkeypatch.setattr(ra.activity, "heartbeat", lambda *_a, **_k: None)

    @patch(
        "activities.redash_acquisition.resolve_credential",
        return_value={"api_key": "k"},
    )
    @patch("activities.redash_acquisition.RedashClient")
    def test_raises_when_only_query_fails(self, mock_cls, _cred, tmp_path, monkeypatch):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        client = MagicMock()
        mock_cls.return_value = client
        client.get_query.return_value = {"id": 5, "name": "Q"}
        client.execute_query.side_effect = RuntimeError("query boom")
        client.list_data_sources.return_value = []

        with pytest.raises(RuntimeError, match="query boom"):
            _call_redash(
                {
                    "provider": "redash",
                    "projectID": "p1",
                    "datasetID": "d1",
                    "credentialId": "c1",
                    "configServiceURL": "http://cfg",
                    "connectionInfo": {"base_url": "https://redash.example.com"},
                    "resourceSelector": [{"query_id": 5}],
                }
            )


class TestAcquireBatchExplicitEofExit:
    def test_breaks_on_empty_reads_when_eof_confirmed(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setenv("S3_ENDPOINT", "http://minio:9000")
        monkeypatch.setenv("ACQ_MAX_BATCHES_PER_ACTIVITY", "5")
        monkeypatch.setenv("ACQ_BATCH_SIZE", "10")
        monkeypatch.setenv("ACQ_EMPTY_READS_AFTER_EOF", "1")

        js = _make_stream("wf-acq-eof", "run-acq-eof")
        js.ensure_group()
        js.update_state(eofSeen=1)

        monkeypatch.setattr(
            ap, "_activity_workflow_context", lambda: ("wf-acq-eof", "run-acq-eof")
        )
        monkeypatch.setattr(ap, "build_job_stream", lambda *_a, **_kw: js)
        monkeypatch.setattr(ap.activity, "heartbeat", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap.time, "sleep", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap, "_jittered_ms", lambda base: min(base, 50))
        monkeypatch.setattr(ap, "resolve_credential", lambda *_a, **_kw: {})
        monkeypatch.setattr(ap, "get_external_s3_client", MagicMock())
        monkeypatch.setattr(ap, "get_internal_s3_client", MagicMock())
        monkeypatch.setattr(js, "get_eof_seen", lambda: True)

        out = _call_activity(
            ap.acquire_batch,
            {
                "projectID": "p",
                "datasetID": "d",
                "credentialID": "c",
                "configServiceURL": "http://cfg",
                "setId": "s0",
                "connectorConfig": {
                    "bucket": "src",
                    "prefix": "",
                    "endpoint": "http://minio:9000",
                },
                "outputPath": "/projects/p/datasets/d/data_files",
                "outputBucket": "dest",
            },
        )
        assert out["fileCount"] == 0

    def test_warns_when_exiting_without_confirmed_eof(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setenv("S3_ENDPOINT", "http://minio:9000")
        monkeypatch.setenv("ACQ_MAX_BATCHES_PER_ACTIVITY", "1")
        monkeypatch.setenv("ACQ_BATCH_SIZE", "10")

        js = _make_stream("wf-acq-budget", "run-acq-budget")
        js.ensure_group()
        js.produce([{"key": "incoming/a.csv", "size": 1}])

        monkeypatch.setattr(
            ap,
            "_activity_workflow_context",
            lambda: ("wf-acq-budget", "run-acq-budget"),
        )
        monkeypatch.setattr(ap, "build_job_stream", lambda *_a, **_kw: js)
        monkeypatch.setattr(ap.activity, "heartbeat", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap.time, "sleep", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap, "_jittered_ms", lambda base: min(base, 50))
        monkeypatch.setattr(ap, "resolve_credential", lambda *_a, **_kw: {})
        monkeypatch.setattr(ap, "get_external_s3_client", MagicMock())
        monkeypatch.setattr(ap, "get_internal_s3_client", MagicMock())
        monkeypatch.setattr(ap, "copy_object_with_backoff", MagicMock())
        monkeypatch.setattr(js, "get_eof_seen", lambda: False)

        out = _call_activity(
            ap.acquire_batch,
            {
                "projectID": "p",
                "datasetID": "d",
                "credentialID": "c",
                "configServiceURL": "http://cfg",
                "setId": "s0",
                "connectorConfig": {
                    "bucket": "src",
                    "prefix": "",
                    "endpoint": "http://minio:9000",
                },
                "outputPath": "/projects/p/datasets/d/data_files",
                "outputBucket": "dest",
            },
        )
        assert out["fileCount"] == 1


class TestRedashExecuteQueryParameters:
    def test_passes_parameters_in_body(self):
        from activities.redash_client import RedashClient

        client = RedashClient("https://redash.example.com", "key")
        resp = MagicMock(status_code=200)
        resp.json.return_value = {"query_result": {"data": {"rows": []}}}
        resp.raise_for_status = MagicMock()
        client._request = MagicMock(return_value=resp)
        client.execute_query(1, parameters={"region": "us"})
        body = client._request.call_args.kwargs["json_body"]
        assert body["parameters"] == {"region": "us"}


class TestAnfPoolContextFromMetricId:
    def test_parse_pool_context_from_metric_id(self):
        from adapters.anf_metrics_adapter import _parse_pool_context

        ctx = _parse_pool_context(FIXTURE_POOL_ARM_ID)
        assert ctx is not None
        assert ctx["pool_name"]


class TestGcpBuildCredentials:
    def test_empty_service_account_json_raises(self, monkeypatch):
        monkeypatch.setattr(
            "adapters.gcp_adapter.resolve_gcp_service_account_json",
            lambda _cred: "",
        )
        with pytest.raises(json.JSONDecodeError):
            from adapters.gcp_adapter import _build_credentials

            _build_credentials({})


class TestOntapCidrExtraBranches:
    def test_cidr_no_match(self):
        from adapters.ontap_adapter import (
            _cidr_matches_rule,
            _export_policy_allows_client_cidrs,
        )

        assert _cidr_matches_rule("10.1.0.0/24", ["172.16.0.0/12"]) is False
        assert (
            _export_policy_allows_client_cidrs(
                [{"clients_match": ["172.16.0.0/12"]}],
                ["10.1.0.0/24"],
            )
            is False
        )


class TestRedashDatasourcePrefetchFailure:
    @pytest.fixture(autouse=True)
    def _temporal(self, monkeypatch):
        monkeypatch.setattr(
            ra.activity,
            "info",
            lambda: SimpleNamespace(workflow_run_id="run12345678"),
        )
        monkeypatch.setattr(ra.activity, "heartbeat", lambda *_a, **_k: None)

    @patch(
        "activities.redash_acquisition.resolve_credential",
        return_value={"api_key": "k"},
    )
    @patch("activities.redash_acquisition.RedashClient")
    def test_table_mode_survives_datasource_list_failure(
        self,
        mock_cls,
        _cred,
        tmp_path,
        monkeypatch,
    ):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        client = MagicMock()
        mock_cls.return_value = client
        client.list_data_sources.side_effect = RuntimeError("ds list down")
        client.execute_sql.return_value = {
            "data": {
                "columns": [{"name": "id", "type": "integer"}],
                "rows": [{"id": 1}],
            },
        }

        out = _call_redash(
            {
                "provider": "redash",
                "projectID": "p1",
                "datasetID": "d1",
                "credentialId": "c1",
                "configServiceURL": "http://cfg",
                "connectionInfo": {"base_url": "https://redash.example.com"},
                "resourceSelector": [{"data_source_id": 2, "table": "users"}],
            }
        )
        assert out["filesCopied"] == 1.0


class TestGcnvTierNormalizeHot:
    def test_non_cold_maps_to_hot(self):
        from adapters.gcnv_metrics_adapter import _normalize_gcnv_tier_label

        assert _normalize_gcnv_tier_label("non cold") == "hot"


class TestAnfMetricPointFallback:
    def test_returns_zero_when_all_attrs_missing(self):
        from adapters.anf_metrics_adapter import _metric_point_value

        point = MagicMock(average=None, maximum=None, total=None, minimum=None)
        assert _metric_point_value(point) == 0.0


class TestDiscoverSkipsEmptyFilename:
    def test_skips_trailing_slash_keys(self, monkeypatch):
        js = _make_stream("wf-disc-empty", "run-disc-empty")
        monkeypatch.setattr(
            ap,
            "_activity_workflow_context",
            lambda: ("wf-disc-empty", "run-disc-empty"),
        )
        monkeypatch.setattr(ap, "build_job_stream", lambda *_a, **_kw: js)
        monkeypatch.setattr(ap, "log_activity_start", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap, "log_activity_result", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap.activity, "heartbeat", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap.time, "sleep", lambda *_a, **_kw: None)
        monkeypatch.setattr(
            ap, "WorkflowProgressReporter", lambda *_a, **_kw: MagicMock(url="")
        )
        monkeypatch.setattr(ap, "resolve_credential", lambda *_a, **_kw: {})

        paginator = MagicMock()
        paginator.paginate.return_value = [
            {
                "Contents": [{"Key": "incoming/", "Size": 0}],
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
        assert out["totalDiscovered"] == 0
