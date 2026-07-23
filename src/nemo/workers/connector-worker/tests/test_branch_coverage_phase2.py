"""Phase-2 branch coverage: ANF pool fetch, GCP dispatch, redis edge paths, volume browse."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

fakeredis = pytest.importorskip("fakeredis")
pytest.importorskip("temporalio")

from activities import acquisition_pipeline as ap  # noqa: E402
from adapters.anf_metrics_adapter import (  # noqa: E402
    AnfMetricsAdapter,
    _merge_pool_metric_point,
    _parse_pool_context,
    _parse_pool_resource_id,
    _volume_from_timeseries_metadata,
)
from adapters.gcp_adapter import GCPAdapter  # noqa: E402
from adapters.gcnv_metrics_adapter import (  # noqa: E402
    _build_acquire_credentials,
    _gcnv_resource_short_name,
    _normalize_gcnv_tier_label,
    _pool_id_from_labels,
    build_pool_inventory_index,
    build_volume_inventory_index,
    lookup_pool_inventory,
    lookup_volume_inventory,
)
from streaming.redis_stream import (  # noqa: E402
    DirQueue,
    EOF_FIELD,
    EOF_VALUE,
    JobStream,
    JobStreamConfig,
    _to_str,
)
from tests.fixtures.azure_monitor_responses import (  # noqa: E402
    FIXTURE_POOL_ARM_ID,
    FIXTURE_POOL_NAME,
    FIXTURE_SUBSCRIPTION_ID,
    FIXTURE_VOLUME_ARM_ID,
    SINGLE_POOL,
)


def _call_activity(fn, *args, **kwargs):
    return getattr(fn, "__wrapped__", fn)(*args, **kwargs)


def _make_stream(wf="wf-p2", run="run-p2") -> JobStream:
    return JobStream(
        JobStreamConfig(
            workflow_id=wf,
            run_id=run,
            client=fakeredis.FakeRedis(decode_responses=True),
            ttl_seconds=3600,
            stream_maxlen=10,
        )
    )


class TestAnfPoolHelpers:
    def test_parse_pool_resource_id_empty(self):
        assert _parse_pool_resource_id("") is None

    def test_parse_pool_context_from_metadata(self):
        ctx = _parse_pool_context(
            "",
            timeseries_metadata={"ResourceId": FIXTURE_POOL_ARM_ID},
        )
        assert ctx is not None
        assert ctx["pool_name"] == FIXTURE_POOL_NAME

    def test_parse_pool_context_filters_resource_group(self):
        ctx = _parse_pool_context(
            "",
            resource_group_filter="rg-a",
            pool_context={
                "resource_group": "rg-b",
                "pool_id": "p1",
                "pool_name": "pool1",
            },
        )
        assert ctx is None

    def test_merge_pool_metric_point_applies_service_level(self):
        pool_data: dict = {}
        pool_ctx = {
            "netapp_account": "acct",
            "service_level": "Premium",
            "pool_id": "pid",
            "pool_name": "pool1",
        }
        ts = datetime(2026, 1, 1, tzinfo=timezone.utc)
        _merge_pool_metric_point(
            pool_data,
            "pid",
            "pool1",
            ts,
            "used_bytes",
            100,
            pool_context=pool_ctx,
        )
        row = pool_data["pid"][ts.isoformat()]
        assert row["service_level"] == "Premium"
        assert row["cluster_id"] == "acct"
        assert row["used_bytes"] == 100

    def test_volume_from_timeseries_metadata_skips_unknown_keys(self):
        assert (
            _volume_from_timeseries_metadata({"Other": FIXTURE_VOLUME_ARM_ID}) is None
        )

    def test_volume_from_timeseries_metadata_parses_resource_id(self):
        ctx = _volume_from_timeseries_metadata({"ResourceId": FIXTURE_VOLUME_ARM_ID})
        assert ctx is not None
        assert ctx.get("volume_id")


class TestAnfFetchPoolMetrics:
    def test_requires_region(self):
        adapter = AnfMetricsAdapter()
        with pytest.raises(ValueError, match="default_region"):
            asyncio.run(
                adapter._fetch_pool_metrics(
                    FIXTURE_SUBSCRIPTION_ID,
                    datetime(2026, 1, 1, tzinfo=timezone.utc),
                    datetime(2026, 1, 2, tzinfo=timezone.utc),
                    MagicMock(),
                    region="",
                )
            )

    def test_raises_when_no_pools(self):
        adapter = AnfMetricsAdapter()
        with patch(
            "adapters.anf_metrics_adapter._list_anf_volumes",
            return_value=[],
        ):
            with pytest.raises(RuntimeError, match="No ANF capacity pools"):
                asyncio.run(
                    adapter._fetch_pool_metrics(
                        FIXTURE_SUBSCRIPTION_ID,
                        datetime(2026, 1, 1, tzinfo=timezone.utc),
                        datetime(2026, 1, 2, tzinfo=timezone.utc),
                        MagicMock(),
                        region="eastus",
                    )
                )

    def test_raises_when_all_pool_queries_fail(self):
        from azure.core.exceptions import HttpResponseError

        adapter = AnfMetricsAdapter()
        vol = {
            "subscription_id": FIXTURE_SUBSCRIPTION_ID,
            "resource_group": "rg",
            "netapp_account": "acct",
            "pool_name": FIXTURE_POOL_NAME,
            "pool_id": FIXTURE_POOL_ARM_ID,
        }
        err = HttpResponseError(message="quota")

        with patch(
            "adapters.anf_metrics_adapter._query_pool_metrics",
            side_effect=err,
        ):
            with pytest.raises(RuntimeError, match="All pool metric queries failed"):
                asyncio.run(
                    adapter._fetch_pool_metrics(
                        FIXTURE_SUBSCRIPTION_ID,
                        datetime(2026, 1, 1, tzinfo=timezone.utc),
                        datetime(2026, 1, 2, tzinfo=timezone.utc),
                        MagicMock(),
                        region="eastus",
                        volumes=[vol],
                    )
                )

    def test_returns_rows_on_success(self):
        adapter = AnfMetricsAdapter()
        vol = {
            "subscription_id": FIXTURE_SUBSCRIPTION_ID,
            "resource_group": "rg",
            "netapp_account": "acct",
            "pool_name": FIXTURE_POOL_NAME,
            "pool_id": FIXTURE_POOL_ARM_ID,
            "service_level": "Premium",
        }

        with patch(
            "adapters.anf_metrics_adapter._query_pool_metrics",
            return_value=SINGLE_POOL,
        ):
            rows = asyncio.run(
                adapter._fetch_pool_metrics(
                    FIXTURE_SUBSCRIPTION_ID,
                    datetime(2026, 1, 1, tzinfo=timezone.utc),
                    datetime(2026, 1, 2, tzinfo=timezone.utc),
                    MagicMock(),
                    region="eastus",
                    volumes=[vol],
                )
            )
        assert len(rows) >= 1


class TestGcpListResourcesDispatch:
    def setup_method(self):
        self.adapter = GCPAdapter()
        self.creds = MagicMock()
        self.project = "test-project"

    @patch.object(GCPAdapter, "_list_db_sub_services")
    def test_database_service(self, mock_db):
        mock_db.return_value = MagicMock(nodes=[])
        resp = self.adapter._list_resources(
            self.creds,
            self.project,
            {"service": "database", "region": "us-central1"},
        )
        mock_db.assert_called_once_with("us-central1")
        assert resp.nodes == []

    @patch.object(GCPAdapter, "_list_cloudsql_instances")
    def test_cloudsql_service(self, mock_sql):
        mock_sql.return_value = MagicMock(nodes=[])
        self.adapter._list_resources(
            self.creds,
            self.project,
            {"service": "cloudsql", "region": "us-central1"},
        )
        mock_sql.assert_called_once()

    @patch.object(GCPAdapter, "_list_spanner_instances")
    def test_spanner_service(self, mock_sp):
        mock_sp.return_value = MagicMock(nodes=[])
        self.adapter._list_resources(
            self.creds,
            self.project,
            {"service": "spanner", "region": "us-central1"},
        )
        mock_sp.assert_called_once()

    @patch.object(GCPAdapter, "_list_alloydb_clusters")
    def test_alloydb_service(self, mock_alloy):
        mock_alloy.return_value = MagicMock(nodes=[])
        self.adapter._list_resources(
            self.creds,
            self.project,
            {"service": "alloydb", "region": "us-central1"},
        )
        mock_alloy.assert_called_once()

    @patch.object(GCPAdapter, "_list_storage_pools")
    def test_gcnv_service(self, mock_gcnv):
        mock_gcnv.return_value = MagicMock(nodes=[])
        self.adapter._list_resources(
            self.creds,
            self.project,
            {"service": "gcnv", "region": "us-central1"},
        )
        mock_gcnv.assert_called_once()

    @patch.object(GCPAdapter, "_list_buckets")
    def test_gcs_service(self, mock_gcs):
        mock_gcs.return_value = MagicMock(nodes=[])
        self.adapter._list_resources(
            self.creds,
            self.project,
            {"service": "gcs", "region": "us-central1"},
        )
        mock_gcs.assert_called_once()

    def test_unknown_service(self):
        resp = self.adapter._list_resources(
            self.creds,
            self.project,
            {"service": "unknown"},
        )
        assert resp.error is not None
        assert resp.error.code == "UNSUPPORTED_SERVICE"

    @patch("adapters.gcp_adapter.build")
    def test_list_regions_with_items(self, mock_build):
        mock_build.return_value.regions.return_value.list.return_value.execute.return_value = {
            "items": [{"name": "us-central1"}, {"name": "europe-west1"}],
        }
        resp = self.adapter._list_regions(MagicMock(), "test-project")
        assert len(resp.nodes) == 2
        assert resp.nodes[0].label == "europe-west1"


class TestGcnvInventoryHelpers:
    def test_gcnv_resource_short_name(self):
        assert _gcnv_resource_short_name("") == ""
        assert _gcnv_resource_short_name("projects/p/locations/l/volumes/v1") == "v1"

    def test_build_volume_inventory_index(self):
        vols = [
            {
                "name": "projects/p/locations/us-central1/volumes/vol-a",
                "storagePool": "projects/p/locations/us-central1/storagePools/pool-1",
                "serviceLevel": "PREMIUM",
                "volumeId": "12345",
                "shareName": "share-a",
            }
        ]
        idx = build_volume_inventory_index(vols)
        assert idx["vol-a"]["pool_id"] == "pool-1"
        assert idx["12345"]["service_level"] == "PREMIUM"
        assert idx["share-a"]["volume_name"] == "vol-a"

    def test_lookup_volume_inventory_by_short_name(self):
        idx = {
            "vol-a": {
                "pool_id": "p1",
                "service_level": "PREMIUM",
                "volume_name": "vol-a",
            }
        }
        hit = lookup_volume_inventory(idx, "projects/p/locations/l/volumes/vol-a", "")
        assert hit["pool_id"] == "p1"

    def test_lookup_volume_inventory_miss(self):
        assert lookup_volume_inventory({}, "missing", "also-missing") is None

    def test_normalize_gcnv_tier_label(self):
        assert _normalize_gcnv_tier_label("cold") == "cold"
        assert _normalize_gcnv_tier_label("COOL") == "cool"
        assert _normalize_gcnv_tier_label("hot") == "hot"
        assert _normalize_gcnv_tier_label("") is None

    def test_build_and_lookup_pool_inventory(self):
        pools = [
            {
                "name": "projects/p/locations/us-central1/storagePools/pool-1",
                "serviceLevel": "PREMIUM",
            }
        ]
        idx = build_pool_inventory_index(pools)
        hit = lookup_pool_inventory(idx, "pool-1")
        assert hit["service_level"] == "PREMIUM"

    def test_pool_id_from_labels(self):
        assert _pool_id_from_labels({"storage_pool": "pool-1"}, {}) == "pool-1"
        assert _pool_id_from_labels({}, {"storage_pool": "pool-2"}) == "pool-2"

    @patch("google.oauth2.service_account.Credentials.from_service_account_info")
    def test_build_acquire_credentials_from_json(self, mock_from_info):
        mock_from_info.return_value = MagicMock()
        sa = json.dumps(
            {
                "type": "service_account",
                "client_email": "a@b.c",
                "private_key": "x",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        )
        creds, label = _build_acquire_credentials(sa, "", ["scope"])
        assert creds is not None
        assert "service_account_json" in label

    @patch("google.oauth2.service_account.Credentials.from_service_account_file")
    def test_build_acquire_credentials_from_path(self, mock_from_file, tmp_path):
        mock_from_file.return_value = MagicMock()
        path = tmp_path / "sa.json"
        path.write_text("{}")
        creds, label = _build_acquire_credentials("", str(path), ["scope"])
        assert creds is not None
        assert "credentials_path" in label

    def test_build_acquire_credentials_adc_fallback(self):
        creds, label = _build_acquire_credentials(
            "", "/nonexistent/path.json", ["scope"]
        )
        assert creds is None
        assert "ADC" in label


class TestRedisStreamPhase2:
    def test_wait_for_capacity_waits_then_drains(self, monkeypatch):
        js = _make_stream()
        mock_client = MagicMock()
        mock_client.xtrim.return_value = 0
        mock_client.xlen.side_effect = [100, 5]
        js._client = mock_client
        monkeypatch.setattr(
            "streaming.redis_stream.time.sleep", lambda *_a, **_kw: None
        )
        js._wait_for_capacity(10)
        assert mock_client.xlen.call_count >= 2

    def test_wait_for_capacity_raises_after_read_failures(self, monkeypatch):
        js = _make_stream()
        monkeypatch.setattr(
            js._client,
            "xtrim",
            MagicMock(side_effect=ConnectionError("down")),
        )
        monkeypatch.setattr(
            "streaming.redis_stream.time.sleep", lambda *_a, **_kw: None
        )
        with pytest.raises(RuntimeError, match="cannot read stream length"):
            js._wait_for_capacity(10)

    def test_mark_eof_repairs_existing_eof_entry(self):
        js = _make_stream("wf-repair", "run-repair")
        js.ensure_group()
        js._client.xadd(
            js.stream_key,
            {EOF_FIELD: EOF_VALUE, "key": ""},
        )
        js.mark_eof()
        assert js.get_eof_seen() is True

    def test_build_client_sentinel_path(self):
        with patch("redis.sentinel.Sentinel") as mock_sentinel_cls:
            mock_sentinel_cls.return_value.master_for.return_value = MagicMock()
            cfg = JobStreamConfig(
                workflow_id="wf-s",
                run_id="run-s",
                sentinel_addrs=[("127.0.0.1", 26379)],
                sentinel_master="mymaster",
            )
            js = JobStream(cfg)
            assert js.client is mock_sentinel_cls.return_value.master_for.return_value

    def test_dirqueue_stale_active_reset(self, monkeypatch):
        client = fakeredis.FakeRedis(decode_responses=True)
        dq = DirQueue(client, "wf-stale", "run-stale")
        dq._consecutive_empty_not_idle = DirQueue.STALE_COUNTER_THRESHOLD - 1
        client.hset(dq.state_key, "dirqueue_active", 3)
        assert dq.is_idle() is True
        assert int(client.hget(dq.state_key, "dirqueue_active") or 0) == 0

    def test_to_str_coercion(self):
        assert _to_str(None) == ""
        assert _to_str(True) == "1"
        assert _to_str(False) == "0"
        assert _to_str(42) == "42"


class TestVolumeBrowseBranches:
    def test_list_volume_directory_hits_limits(self, monkeypatch, tmp_path):
        mount = tmp_path / "big"
        mount.mkdir()
        for i in range(ap._BROWSE_DIR_LIMIT + 5):
            (mount / f"dir{i}").mkdir()
        for i in range(ap._BROWSE_FILE_LIMIT + 5):
            (mount / f"file{i}.txt").write_text("x")

        out = _call_activity(ap.list_volume_directory, {"mountPath": str(mount)})
        assert out["totalDirCount"] == ap._BROWSE_DIR_LIMIT
        assert out["totalFileCount"] == ap._BROWSE_FILE_LIMIT
        assert out["truncated"] is True

    def test_list_volume_directory_permission_denied(self, monkeypatch, tmp_path):
        mount = tmp_path / "perm"
        mount.mkdir()
        real_scandir = os.scandir

        def _scandir(path):
            if str(path) == str(mount):
                raise PermissionError("denied")
            return real_scandir(path)

        monkeypatch.setattr(ap.os, "scandir", _scandir)
        out = _call_activity(ap.list_volume_directory, {"mountPath": str(mount)})
        assert "permission denied" in out["error"]

    def test_list_volume_directory_with_explicit_mount(self, tmp_path):
        vol = tmp_path / "vol-123"
        vol.mkdir(parents=True)
        (vol / "a.txt").write_text("a")
        out = _call_activity(
            ap.list_volume_directory,
            {
                "volumeId": "vol-123",
                "mountPath": str(vol),
            },
        )
        assert out["totalFileCount"] == 1

    def test_scan_volume_skips_non_regular_files(self, monkeypatch, tmp_path):
        root = tmp_path / "special"
        root.mkdir()
        (root / "regular.txt").write_text("ok")
        fifo = root / "pipe"
        os.mkfifo(fifo)

        monkeypatch.setattr(ap.activity, "heartbeat", lambda *_a, **_kw: None)
        out = _call_activity(
            ap.scan_volume,
            {
                "mountPath": str(root),
                "scanConfig": {"scan_depth": "all_levels"},
            },
        )
        assert out["total_files"] == 1

    def test_scan_volume_permission_error(self, monkeypatch, tmp_path):
        root = tmp_path / "nope"
        root.mkdir()
        real_walk = os.walk

        def _walk(path, *args, **kwargs):
            if str(path) == str(root):
                raise PermissionError("denied")
            return real_walk(path, *args, **kwargs)

        monkeypatch.setattr(ap.os, "walk", _walk)
        monkeypatch.setattr(ap.activity, "heartbeat", lambda *_a, **_kw: None)
        out = _call_activity(
            ap.scan_volume,
            {
                "mountPath": str(root),
                "scanConfig": {"scan_depth": "all_levels"},
            },
        )
        assert "permission denied" in out["error_message"]


class TestFinalizeRegistrationFacetStates:
    def test_failed_when_errors_and_no_files(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setattr(
            ap, "_activity_workflow_context", lambda: ("wf-fr", "run-fr")
        )
        prefix = "projects/p/datasets/d"
        err_dir = tmp_path / prefix / "_acquisition" / "errors"
        err_dir.mkdir(parents=True)
        (err_dir / "discover-0.json").write_text(
            json.dumps({"path": "/x", "error": "boom"}),
        )
        facet_states: list[str] = []
        monkeypatch.setattr(
            ap,
            "_put_facet",
            lambda *_a, state, **_kw: facet_states.append(state),
        )
        monkeypatch.setattr(
            ap, "build_job_stream", lambda *_a, **_kw: MagicMock(destroy=MagicMock())
        )
        monkeypatch.setattr(
            ap, "DirQueue", lambda *_a, **_kw: MagicMock(cleanup=MagicMock())
        )

        out = _call_activity(
            ap.finalize_registration,
            {
                "projectID": "p",
                "datasetID": "d",
            },
        )
        assert out["fileCount"] == 0
        assert facet_states[-1] == "failed"

    def test_errored_when_errors_and_files(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
        monkeypatch.setattr(
            ap, "_activity_workflow_context", lambda: ("wf-fe", "run-fe")
        )
        prefix = "projects/p/datasets/d"
        man_dir = tmp_path / prefix / "_acquisition" / "manifests"
        man_dir.mkdir(parents=True)
        (man_dir / "reg-s0.json").write_text(
            json.dumps({"fileCount": 2, "totalSize": 10})
        )
        err_dir = tmp_path / prefix / "_acquisition" / "errors"
        err_dir.mkdir(parents=True)
        (err_dir / "discover-0.json").write_text(
            json.dumps({"path": "/x", "error": "boom"})
        )
        facet_states: list[str] = []
        monkeypatch.setattr(
            ap,
            "_put_facet",
            lambda *_a, state, **_kw: facet_states.append(state),
        )
        monkeypatch.setattr(
            ap, "build_job_stream", lambda *_a, **_kw: MagicMock(destroy=MagicMock())
        )
        monkeypatch.setattr(
            ap, "DirQueue", lambda *_a, **_kw: MagicMock(cleanup=MagicMock())
        )

        _call_activity(ap.finalize_registration, {"projectID": "p", "datasetID": "d"})
        assert facet_states[-1] == "errored"
