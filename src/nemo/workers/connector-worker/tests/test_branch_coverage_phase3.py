"""Phase-3 branch coverage: ontap LIF helpers, acquisition browse deadline, DB/GCP/ANF paths."""

from __future__ import annotations

import sys
import time
from contextlib import contextmanager
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
from activities import database as db_mod  # noqa: E402
from adapters.anf_metrics_adapter import AnfMetricsAdapter  # noqa: E402
from adapters.gcp_adapter import GCPAdapter  # noqa: E402
from activities import redash_acquisition as ra  # noqa: E402
from adapters.ontap_adapter import (  # noqa: E402
    _build_mount_preflight,
    _count_data_nfs_lifs,
    _nfs_data_lif_for_svm,
    _svm_nfs_service,
)
from ontap_common import OntapError  # noqa: E402
from streaming.redis_stream import JobStream, JobStreamConfig  # noqa: E402
from tests.fixtures.azure_monitor_responses import (  # noqa: E402
    FIXTURE_NETAPP_ACCOUNT,
    FIXTURE_POOL_ARM_ID,
    FIXTURE_POOL_NAME,
    FIXTURE_SUBSCRIPTION_ID,
    FIXTURE_VOLUME_ARM_ID,
    FIXTURE_VOLUME_NAME,
)


def _call_activity(fn, *args, **kwargs):
    return getattr(fn, "__wrapped__", fn)(*args, **kwargs)


def _make_stream(wf="wf-p3", run="run-p3") -> JobStream:
    return JobStream(
        JobStreamConfig(
            workflow_id=wf,
            run_id=run,
            client=fakeredis.FakeRedis(decode_responses=True),
            ttl_seconds=3600,
            stream_maxlen=100,
        )
    )


class TestOntapLifHelpers:
    def _page(self, records):
        return SimpleNamespace(records=records)

    def test_nfs_data_lif_by_uuid(self):
        client = MagicMock()
        client.get_paginated.return_value = self._page(
            [
                {
                    "name": "lif1",
                    "state": "up",
                    "services": ["data_nfs"],
                    "ip": {"address": "10.0.0.5"},
                },
                {
                    "name": "lif2",
                    "state": "down",
                    "services": ["data_nfs"],
                    "ip": {"address": "10.0.0.9"},
                },
            ]
        )
        lif = _nfs_data_lif_for_svm(client, "uuid-1", "")
        assert lif["address"] == "10.0.0.5"

    def test_nfs_data_lif_by_name(self):
        client = MagicMock()
        client.get_paginated.return_value = self._page(
            [
                {
                    "name": "lif-a",
                    "state": "up",
                    "services": ["data-nfs"],
                    "ip": {"address": "10.1.1.1"},
                },
            ]
        )
        lif = _nfs_data_lif_for_svm(client, "", "svm-a")
        assert lif["lif_name"] == "lif-a"

    def test_nfs_data_lif_missing_svm(self):
        assert _nfs_data_lif_for_svm(MagicMock(), "", "") is None

    def test_nfs_data_lif_no_matching_services(self):
        client = MagicMock()
        client.get_paginated.return_value = self._page(
            [
                {
                    "name": "lif-c",
                    "state": "up",
                    "services": ["cifs"],
                    "ip": {"address": "10.0.0.1"},
                },
            ]
        )
        assert _nfs_data_lif_for_svm(client, "uuid", "") is None

    def test_nfs_data_lif_skips_missing_address(self):
        client = MagicMock()
        client.get_paginated.return_value = self._page(
            [
                {"name": "lif-x", "state": "up", "services": ["data_nfs"], "ip": {}},
            ]
        )
        assert _nfs_data_lif_for_svm(client, "uuid", "") is None

    def test_count_data_nfs_lifs(self):
        client = MagicMock()
        client.get_paginated.return_value = self._page(
            [
                {"services": ["data_nfs"]},
                {"services": ["cifs"]},
            ]
        )
        assert _count_data_nfs_lifs(client, "uuid", "") == 1
        assert _count_data_nfs_lifs(client, "", "") == 0

    def test_svm_nfs_service_by_name(self):
        client = MagicMock()
        client.get_paginated.return_value = self._page(
            [{"enabled": True, "state": "online"}]
        )
        svc = _svm_nfs_service(client, "", "svm1")
        assert svc["enabled"] is True

    def test_svm_nfs_service_swallows_ontap_error(self):
        client = MagicMock()
        client.get_paginated.side_effect = OntapError("fail")
        assert _svm_nfs_service(client, "uuid", "") is None


class TestListVolumeDeadline:
    def test_hit_scan_deadline(self, monkeypatch, tmp_path):
        mount = tmp_path / "deadline"
        mount.mkdir()

        class FakeEntry:
            def __init__(self, idx: int):
                self.name = f"f{idx}.txt"

            def is_dir(self, follow_symlinks=True):
                return False

            def stat(self, follow_symlinks=True):
                return SimpleNamespace(st_size=1, st_mtime=time.time())

        @contextmanager
        def fake_scandir(_path):
            yield (FakeEntry(i) for i in range(2001))

        mono = {"n": 0}

        def fake_monotonic():
            mono["n"] += 1
            return 0.0 if mono["n"] < 5 else 9999.0

        monkeypatch.setattr(ap.os, "scandir", fake_scandir)
        monkeypatch.setattr(ap.time, "monotonic", fake_monotonic)
        out = _call_activity(ap.list_volume_directory, {"mountPath": str(mount)})
        assert out["truncated"] is True


class TestDiscoverObjectStoreFilters:
    def test_modified_after_filters_old_objects(self, monkeypatch):
        from datetime import datetime, timezone

        js = _make_stream("wf-disc", "run-disc")
        monkeypatch.setattr(
            ap, "_activity_workflow_context", lambda: ("wf-disc", "run-disc")
        )
        monkeypatch.setattr(ap, "build_job_stream", lambda *_a, **_kw: js)
        monkeypatch.setattr(ap, "log_activity_start", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap.activity, "heartbeat", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap.time, "sleep", lambda *_a, **_kw: None)
        monkeypatch.setattr(
            ap, "WorkflowProgressReporter", lambda *_a, **_kw: MagicMock(url="")
        )
        monkeypatch.setattr(ap, "resolve_credential", lambda *_a, **_kw: {})

        old_ts = datetime(2020, 1, 1, tzinfo=timezone.utc)
        new_ts = datetime(2026, 1, 1, tzinfo=timezone.utc)
        mock_ext = MagicMock()
        paginator = MagicMock()
        paginator.paginate.return_value = [
            {
                "Contents": [
                    {"Key": "incoming/old.csv", "Size": 1, "LastModified": old_ts},
                    {"Key": "incoming/new.csv", "Size": 1, "LastModified": new_ts},
                ],
            }
        ]
        mock_ext.get_paginator.return_value = paginator
        monkeypatch.setattr(ap, "get_external_s3_client", lambda *_a, **_kw: mock_ext)

        out = _call_activity(
            ap.discover_object_store_items,
            {
                "projectID": "p",
                "credentialID": "c",
                "configServiceURL": "http://cfg",
                "connectorConfig": {"bucket": "b", "prefix": "incoming/"},
                "modifiedAfter": "2024-01-01T00:00:00Z",
            },
        )
        assert out["totalDiscovered"] == 1
        assert out["filesFiltered"] >= 1


class TestAcquireBatchEofExit:
    def test_exits_after_empty_reads_post_eof(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setenv("S3_ENDPOINT", "http://minio:9000")
        monkeypatch.setenv("ACQ_MAX_BATCHES_PER_ACTIVITY", "3")
        monkeypatch.setenv("ACQ_BATCH_SIZE", "10")
        monkeypatch.setenv("ACQ_EMPTY_READS_AFTER_EOF", "1")

        js = _make_stream("wf-eof-exit", "run-eof-exit")
        js.ensure_group()
        js.mark_eof()

        monkeypatch.setattr(
            ap, "_activity_workflow_context", lambda: ("wf-eof-exit", "run-eof-exit")
        )
        monkeypatch.setattr(ap, "build_job_stream", lambda *_a, **_kw: js)
        monkeypatch.setattr(ap.activity, "heartbeat", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap.time, "sleep", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap, "_jittered_ms", lambda base: min(base, 50))
        monkeypatch.setattr(ap, "resolve_credential", lambda *_a, **_kw: {})
        monkeypatch.setattr(ap, "get_external_s3_client", MagicMock())
        monkeypatch.setattr(ap, "get_internal_s3_client", MagicMock())

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
        assert out["status"] == "success"
        assert out["fileCount"] == 0


class TestGcpListPathAndBuckets:
    def setup_method(self):
        self.adapter = GCPAdapter()

    @patch("adapters.gcp_adapter.storage.Client")
    def test_list_buckets_api_not_enabled(self, mock_client_cls):
        mock_client_cls.return_value.list_buckets.side_effect = Exception(
            "Cloud Storage API has not been used in project"
        )
        resp = self.adapter._list_buckets(MagicMock(), "test-project")
        assert resp.error.code == "API_NOT_ENABLED"

    @patch("adapters.gcp_adapter.build")
    def test_list_spanner_databases(self, mock_build):
        svc = MagicMock()
        mock_build.return_value = svc
        svc.projects.return_value.instances.return_value.databases.return_value.list.return_value.execute.return_value = {
            "databases": [
                {"name": "projects/p/instances/i/databases/db1", "state": "READY"}
            ],
        }
        resp = self.adapter._list_spanner_databases(MagicMock(), "p", "inst1")
        assert resp.nodes[0].label == "db1"

    @patch("adapters.gcp_adapter.storage.Client")
    def test_list_path_with_folders(self, mock_client_cls):
        bucket = MagicMock()
        iterator = MagicMock()
        iterator.prefixes = ["incoming/"]
        iterator.__iter__ = MagicMock(return_value=iter([]))
        bucket.list_blobs.return_value = iterator
        mock_client_cls.return_value.bucket.return_value = bucket
        resp = self.adapter._list_path(MagicMock(), "p", {"bucket": "b", "prefix": ""})
        assert resp.nodes[0].type == "folder"


class TestDatabaseAcquireThreading:
    @pytest.fixture(autouse=True)
    def _heartbeat(self, monkeypatch):
        monkeypatch.setattr(
            "activities.database.activity.heartbeat", lambda *_a, **_k: None
        )

    def test_slow_query_sends_heartbeats(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setattr(db_mod, "resolve_credential", lambda *_a, **_kw: {})
        heartbeats: list[str] = []
        monkeypatch.setattr(
            "activities.database.activity.heartbeat",
            lambda msg: heartbeats.append(msg),
        )
        monkeypatch.setattr(
            db_mod,
            "WorkflowProgressReporter",
            lambda *_a, **_kw: MagicMock(url="http://progress"),
        )

        def slow_query(*_a, **_kw):
            time.sleep(0.2)
            return (["id"], [(1,)])

        monkeypatch.setattr(db_mod, "_run_query", slow_query)
        real_join = db_mod.threading.Thread.join

        def fast_join(self, timeout=None):
            return real_join(self, timeout=0.05)

        monkeypatch.setattr(db_mod.threading.Thread, "join", fast_join)

        out = _call_activity(
            db_mod.acquire_from_database,
            {
                "projectID": "p",
                "credentialID": "c",
                "configServiceURL": "http://cfg",
                "connectorConfig": {
                    "provider": "postgresql",
                    "host": "h",
                    "port": 5432,
                    "database": "db",
                },
                "sqlQuery": "SELECT id FROM t",
                "outputPath": "projects/p/datasets/d/data",
            },
        )
        assert out["rowCount"] == 1
        assert "executing-query" in heartbeats


class TestAnfPoolOnlyAcquire:
    def test_acquire_writes_pool_metrics_parquet(self, tmp_path):
        adapter = AnfMetricsAdapter()
        conn = {
            "subscription_id": FIXTURE_SUBSCRIPTION_ID,
            "default_region": "eastus",
            "tenant_id": "tenant",
            "client_id": "client",
            "client_secret": "secret",
            "resourceSelector": [{"category": "pool_metrics"}],
        }
        vol = {
            "subscription_id": FIXTURE_SUBSCRIPTION_ID,
            "resource_group": "rg-anf-dev",
            "netapp_account": FIXTURE_NETAPP_ACCOUNT,
            "pool_name": FIXTURE_POOL_NAME,
            "pool_id": FIXTURE_POOL_ARM_ID,
            "volume_name": FIXTURE_VOLUME_NAME,
            "volume_id": FIXTURE_VOLUME_ARM_ID,
        }

        with (
            patch(
                "adapters.anf_metrics_adapter.build_credential",
                return_value=MagicMock(),
            ),
            patch("adapters.anf_metrics_adapter._list_anf_volumes", return_value=[vol]),
            patch.object(
                adapter,
                "_fetch_pool_metrics",
                return_value=[
                    {
                        "timestamp": datetime(2026, 1, 1, tzinfo=timezone.utc),
                        "pool_id": FIXTURE_POOL_ARM_ID,
                        "pool_name": FIXTURE_POOL_NAME,
                        "capacity_bytes": 100,
                        "used_bytes": 50,
                        "cluster_id": "acct",
                    },
                ],
            ),
        ):
            result = __import__("asyncio").run(
                adapter.acquire(conn, watermark=None, output_path=str(tmp_path))
            )
        assert (tmp_path / "pool_metrics.parquet").exists()
        assert result["poolMetricsCount"] >= 1


class TestOntapExtraPreflightBranches:
    def test_export_policy_blocks_client_cidr(self):
        mp = _build_mount_preflight(
            svm_state="running",
            junction_path="/vol",
            nfs_lif={"address": "10.0.0.1"},
            nfs_svc={"enabled": True, "state": "online"},
            nfs_protocols={"v3": True},
            tcp={"ok": True},
            export_policy_name="default",
            export_rules=[{"clients_match": ["172.16.0.0/12"]}],
            client_cidrs=["10.1.0.0/24"],
        )
        assert "export_policy_blocks_node_cidr" in mp["blocking"]

    def test_nfs_service_disabled_blocks_mount(self):
        mp = _build_mount_preflight(
            svm_state="running",
            junction_path="/vol",
            nfs_lif={"address": "10.0.0.1"},
            nfs_svc={"enabled": False, "state": "online"},
            nfs_protocols={"v3": True},
            tcp={"ok": True},
            export_policy_name=None,
            export_rules=[],
            client_cidrs=[],
        )
        assert "nfs_service_disabled" in mp["blocking"]


class TestOntapListInterfaces:
    @patch("adapters.ontap_adapter._client_from_config")
    def test_data_nfs_lif_without_address(self, mock_factory):
        from adapters.ontap_adapter import OntapAdapter

        client = MagicMock()
        mock_factory.return_value.__enter__.return_value = client
        client.get_paginated.return_value = SimpleNamespace(
            records=[
                {
                    "uuid": "lif-1",
                    "name": "lif1",
                    "services": ["data_nfs"],
                    "ip": {},
                    "svm": {"name": "svm1", "uuid": "u1"},
                    "state": "up",
                    "location": {},
                }
            ],
            truncated=False,
        )
        resp = OntapAdapter().execute(
            {"cluster_url": "https://x"},
            {"username": "u", "password": "p"},
            "listSvmInterfaces",
            {"svm_name": "svm1"},
        )
        assert resp.nodes[0].metadata["tcp_2049"]["ok"] is False

    def test_list_luns_requires_svm(self):
        from adapters.ontap_adapter import OntapAdapter

        with patch("adapters.ontap_adapter._client_from_config") as mock_factory:
            mock_factory.return_value.__enter__.return_value = MagicMock()
            resp = OntapAdapter().execute(
                {"cluster_url": "https://x"},
                {"username": "u", "password": "p"},
                "listLuns",
                {},
            )
        assert resp.error.code == "VALIDATION_ERROR"


class TestDiscoverMaxFileSize:
    def test_max_file_size_filters_large_objects(self, monkeypatch):
        js = _make_stream("wf-max", "run-max")
        monkeypatch.setattr(
            ap, "_activity_workflow_context", lambda: ("wf-max", "run-max")
        )
        monkeypatch.setattr(ap, "build_job_stream", lambda *_a, **_kw: js)
        monkeypatch.setattr(ap, "log_activity_start", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap.activity, "heartbeat", lambda *_a, **_kw: None)
        monkeypatch.setattr(ap.time, "sleep", lambda *_a, **_kw: None)
        monkeypatch.setattr(
            ap, "WorkflowProgressReporter", lambda *_a, **_kw: MagicMock(url="")
        )
        monkeypatch.setattr(ap, "resolve_credential", lambda *_a, **_kw: {})

        mock_ext = MagicMock()
        paginator = MagicMock()
        paginator.paginate.return_value = [
            {
                "Contents": [
                    {"Key": "incoming/huge.csv", "Size": 9999},
                    {"Key": "incoming/small.csv", "Size": 10},
                ],
            }
        ]
        mock_ext.get_paginator.return_value = paginator
        monkeypatch.setattr(ap, "get_external_s3_client", lambda *_a, **_kw: mock_ext)

        out = _call_activity(
            ap.discover_object_store_items,
            {
                "projectID": "p",
                "credentialID": "c",
                "configServiceURL": "http://cfg",
                "connectorConfig": {"bucket": "b", "prefix": "incoming/"},
                "maxFileSize": 100,
            },
        )
        assert out["totalDiscovered"] == 1
        assert out["filesFiltered"] >= 1


class TestRedashTableSkips:
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
    def test_empty_sql_result_is_skipped(self, mock_cls, _cred, tmp_path, monkeypatch):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        client = MagicMock()
        mock_cls.return_value = client
        client.list_data_sources.return_value = [{"id": 2, "type": "postgresql"}]
        client.execute_sql.return_value = None

        out = _call_redash(
            ra.acquire_from_api,
            {
                "provider": "redash",
                "projectID": "p1",
                "datasetID": "d1",
                "credentialId": "c1",
                "configServiceURL": "http://cfg",
                "connectionInfo": {"base_url": "https://redash.example.com"},
                "resourceSelector": [{"data_source_id": 2, "table": "public.users"}],
            },
        )
        assert out["filesCopied"] == 0.0

    @patch(
        "activities.redash_acquisition.resolve_credential",
        return_value={"api_key": "k"},
    )
    @patch("activities.redash_acquisition.RedashClient")
    def test_table_without_columns_is_skipped(
        self, mock_cls, _cred, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        client = MagicMock()
        mock_cls.return_value = client
        client.list_data_sources.return_value = [{"id": 2, "type": "mysql"}]
        client.execute_sql.return_value = {"data": {"columns": [], "rows": []}}

        out = _call_redash(
            ra.acquire_from_api,
            {
                "provider": "redash",
                "projectID": "p1",
                "datasetID": "d1",
                "credentialId": "c1",
                "configServiceURL": "http://cfg",
                "connectionInfo": {"base_url": "https://redash.example.com"},
                "resourceSelector": [{"data_source_id": 2, "table": "users"}],
            },
        )
        assert out["filesCopied"] == 0.0


def _call_redash(fn, body):
    target = getattr(fn, "__wrapped__", fn)
    return __import__("asyncio").run(target(body))
