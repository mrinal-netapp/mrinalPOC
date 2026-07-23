"""Unit tests for ANF metrics adapter pure functions and acquire paths."""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pyarrow.parquet as pq
import pytest

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

from adapters.metric_table_schemas import VOLUME_METRICS_SCHEMA  # noqa: E402
from adapters.anf_metrics_adapter import (  # noqa: E402
    ANF_METRIC_NAMES,
    ANF_POOL_METRIC_NAMES,
    ANF_TIER_METRIC_NAMES,
    ANF_VOLUME_METRIC_NAMES,
    AZURE_MONITOR_MAX_METRICS_PER_QUERY,
    AnfMetricsAdapter,
    _arm_bearer_token,
    _build_credential,
    BACKFILL_DAYS,
    METRICS_QUERY_MAX_DAYS,
    _chunk_metric_names,
    _compute_time_window,
    _iter_metrics_query_windows,
    _enrich_volumes_service_level,
    _field_for_metric,
    _field_for_pool_metric,
    _field_for_tier_metric,
    _flatten_pool_rows,
    _flatten_rows,
    _flatten_tier_rows,
    _ingest_metrics_result,
    _ingest_pool_metrics_result,
    _ingest_tier_metrics_result,
    _list_anf_volumes,
    _list_anf_volumes_arm_enumerate,
    _list_anf_volumes_resource_graph,
    _merge_metric_point,
    _metric_point_value,
    _parse_resource_id,
    _parse_volume_context,
    _query_metrics,
    _query_pool_metrics,
    _query_volume_metrics,
    _resource_group_from_arm,
    _safe_heartbeat,
    _unique_pools_from_volumes,
    _validate_connection_config,
    _volume_from_timeseries_metadata,
)
from tests.fixtures.azure_monitor_responses import (  # noqa: E402
    EMPTY,
    FIXTURE_NETAPP_ACCOUNT,
    FIXTURE_POOL_ARM_ID,
    FIXTURE_POOL_NAME,
    FIXTURE_SUBSCRIPTION_ID,
    FIXTURE_VOLUME_ARM_ID,
    FIXTURE_VOLUME_NAME,
    SINGLE_POOL,
    SINGLE_VOLUME,
)

VALID_ARM = FIXTURE_VOLUME_ARM_ID
METRIC_ID = f"{VALID_ARM}/providers/Microsoft.Insights/metrics/ReadIops"
SUBSCRIPTION_METRIC_ID = (
    f"/subscriptions/{FIXTURE_SUBSCRIPTION_ID}/providers/Microsoft.Insights/metrics/ReadIops"
)
FIXTURE_VOLUME_CONTEXT = {
    "subscription_id": FIXTURE_SUBSCRIPTION_ID,
    "resource_group": "rg-anf-dev",
    "netapp_account": FIXTURE_NETAPP_ACCOUNT,
    "pool_name": FIXTURE_POOL_NAME,
    "pool_id": FIXTURE_POOL_ARM_ID,
    "volume_name": FIXTURE_VOLUME_NAME,
    "volume_id": FIXTURE_VOLUME_ARM_ID,
}
ACCOUNT_ARM = (
    f"/subscriptions/{FIXTURE_SUBSCRIPTION_ID}/resourceGroups/rg-anf-dev/"
    "providers/Microsoft.NetApp/netAppAccounts/acct1"
)
POOL_ARM = f"{ACCOUNT_ARM}/capacityPools/pool1"


def _mock_http_response(status_code: int = 200, payload: dict | None = None):
    resp = MagicMock()
    resp.status_code = status_code
    resp.json.return_value = payload or {}
    resp.raise_for_status = MagicMock()
    if status_code >= 400:
        from requests import HTTPError

        resp.raise_for_status.side_effect = HTTPError(response=resp)
    return resp


class TestMetricPointValue:
    def test_prefers_average_by_default(self):
        point = MagicMock(average=10.0, maximum=20.0, total=30.0, minimum=5.0)
        assert _metric_point_value(point) == 10.0

    def test_byte_fields_prefer_maximum(self):
        point = MagicMock(average=None, maximum=5.1e10, total=None, minimum=None)
        assert _metric_point_value(point, prefer_maximum=True) == 5.1e10

    def test_falls_back_to_total(self):
        point = MagicMock(average=None, maximum=None, total=42.0, minimum=None)
        assert _metric_point_value(point) == 42.0


class TestFieldForMetric:
    @pytest.mark.parametrize(
        "metric,field",
        [
            ("ReadIops", "iops_read"),
            ("WriteIops", "iops_write"),
            ("OtherIops", "iops_other"),
            ("TotalIops", "iops_total"),
            ("ReadThroughput", "throughput_read_bytes"),
            ("WriteThroughput", "throughput_write_bytes"),
            ("OtherThroughput", "throughput_other_bytes"),
            ("TotalThroughput", "throughput_total_bytes"),
            ("AverageReadLatency", "latency_read_us"),
            ("AverageWriteLatency", "latency_write_us"),
            ("VolumeLogicalSize", "space_used_bytes"),
            ("VolumeAllocatedSize", "space_total_bytes"),
            ("VolumeSnapshotSize", "space_snapshot_bytes"),
            ("VolumeConsumedSizePercentage", "space_used_percent"),
            ("VolumeInodesUsed", "inode_used"),
            ("VolumeInodesTotal", "inode_limit"),
            ("VolumeInodesQuota", "inode_limit"),
            ("VolumeInodesPercentage", "inode_used_percent"),
            ("ThroughputLimitReached", "throughput_limit_hit"),
            ("QosLatencyDelta", "qos_latency_delta_us"),
        ],
    )
    def test_known_metrics(self, metric, field):
        assert _field_for_metric(metric) == field

    def test_unknown_returns_none(self):
        assert _field_for_metric("NotARealMetric") is None

    def test_tier_metric_mapping(self):
        assert _field_for_tier_metric("VolumeCoolTierDataReadSize") == (
            "tier_read_bytes",
            "cold",
        )
        assert _field_for_tier_metric("VolumeCoolTierSize") == (
            "tier_footprint_bytes",
            "cold",
        )

    def test_pool_metric_mapping(self):
        assert _field_for_pool_metric("VolumePoolAllocatedSize") == "capacity_bytes"
        assert _field_for_pool_metric("VolumePoolTotalLogicalSize") == "used_bytes"


class TestParseResourceId:
    def test_valid_arm_from_metric_id(self):
        parsed = _parse_resource_id(METRIC_ID)
        assert parsed is not None
        assert parsed["volume_name"] == FIXTURE_VOLUME_NAME
        assert parsed["volume_id"] == VALID_ARM
        assert parsed["subscription_id"] == FIXTURE_SUBSCRIPTION_ID
        assert parsed["resource_group"] == "rg-anf-dev"
        assert parsed["netapp_account"] == FIXTURE_NETAPP_ACCOUNT
        assert parsed["pool_name"] == FIXTURE_POOL_NAME
        assert parsed["pool_id"] == FIXTURE_POOL_ARM_ID

    def test_valid_arm_without_insights_suffix(self):
        parsed = _parse_resource_id(VALID_ARM)
        assert parsed["volume_name"] == FIXTURE_VOLUME_NAME

    def test_malformed(self):
        assert _parse_resource_id("") is None
        assert _parse_resource_id("/subscriptions/x") is None
        assert _parse_resource_id("not-an-arm-id") is None
        assert _parse_resource_id(
            "/subscriptions/s/resourceGroups/r/providers/Microsoft.NetApp/"
            "netAppAccounts/a/capacityPools/p/volumes/"
        ) is None
        assert _parse_resource_id(
            "/bad/subscriptions/s/resourceGroups/r/providers/Microsoft.NetApp/"
            "netAppAccounts/a/capacityPools/p/volumes/v"
        ) is None

    def test_lowercase_insights_suffix(self):
        arm = (
            f"{VALID_ARM}/providers/microsoft.insights/metrics/ReadIops"
        )
        assert _parse_resource_id(arm)["volume_name"] == FIXTURE_VOLUME_NAME

    def test_missing_arm_path_segments_returns_none(self):
        assert _parse_resource_id(
            "/subscriptions/s/providers/Microsoft.NetApp/"
            "netAppAccounts/a/capacityPools/p/volumes/vol1"
        ) is None


class TestParseVolumeContextHelpers:
    def test_volume_from_metadata_resource_id_key(self):
        meta = {"resourceId": METRIC_ID}
        ctx = _volume_from_timeseries_metadata(meta)
        assert ctx is not None
        assert ctx["volume_name"] == FIXTURE_VOLUME_NAME

    def test_volume_from_metadata_ignores_unknown_keys(self):
        assert _volume_from_timeseries_metadata({"foo": VALID_ARM}) is None
        assert _volume_from_timeseries_metadata(None) is None

    def test_parse_volume_context_prefers_metric_id(self):
        ctx = _parse_volume_context(METRIC_ID, volume_context=FIXTURE_VOLUME_CONTEXT)
        assert ctx["volume_id"] == FIXTURE_VOLUME_ARM_ID

    def test_parse_volume_context_resource_group_filter(self):
        assert _parse_volume_context(
            METRIC_ID,
            resource_group_filter="other-rg",
            volume_context=FIXTURE_VOLUME_CONTEXT,
        ) is None
        assert _parse_volume_context(
            METRIC_ID,
            resource_group_filter="rg-anf-dev",
            volume_context=FIXTURE_VOLUME_CONTEXT,
        ) is not None

    def test_parse_volume_context_uses_metadata_when_metric_id_opaque(self):
        ctx = _parse_volume_context(
            SUBSCRIPTION_METRIC_ID,
            timeseries_metadata={"resourceId": METRIC_ID},
        )
        assert ctx is not None
        assert ctx["volume_id"] == FIXTURE_VOLUME_ARM_ID

    def test_arm_bearer_token(self):
        cred = MagicMock()
        cred.get_token.return_value.token = "bearer-token"
        assert _arm_bearer_token(cred) == "bearer-token"
        cred.get_token.assert_called_once()

    def test_resource_group_from_arm_missing_segment(self):
        assert _resource_group_from_arm("/subscriptions/s/providers/foo") == ""


class TestChunkMetricNames:
    def test_splits_at_max_size(self):
        names = list(f"m{i}" for i in range(23))
        batches = _chunk_metric_names(names)
        assert len(batches) == 2
        assert len(batches[0]) == AZURE_MONITOR_MAX_METRICS_PER_QUERY
        assert len(batches[1]) == 3

    def test_empty_list(self):
        assert _chunk_metric_names([]) == []

    def test_under_limit_single_batch(self):
        names = ANF_VOLUME_METRIC_NAMES[:5]
        assert _chunk_metric_names(names) == [names]


class TestIterMetricsQueryWindows:
    def test_93_day_span_splits_into_four_chunks(self):
        end = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        start = end - timedelta(days=BACKFILL_DAYS)
        windows = _iter_metrics_query_windows(start, end)
        assert len(windows) == 4
        assert windows[0][0] == start
        assert windows[-1][1] == end
        for chunk_start, chunk_end in windows:
            assert chunk_end - chunk_start <= timedelta(days=METRICS_QUERY_MAX_DAYS)

    def test_short_span_single_window(self):
        end = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        start = end - timedelta(days=7)
        assert _iter_metrics_query_windows(start, end) == [(start, end)]

    def test_empty_when_start_not_before_end(self):
        ts = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        assert _iter_metrics_query_windows(ts, ts) == []


class TestComputeTimeWindow:
    def test_no_watermark_93d_backfill(self):
        now = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        start, end, src = _compute_time_window(None, now=now)
        assert end == now
        assert start == now - timedelta(days=BACKFILL_DAYS)
        assert "no-watermark" in src
        assert "93d" in src

    def test_valid_incremental(self):
        now = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        wm = "2026-06-01T11:00:00+00:00"
        start, end, src = _compute_time_window(wm, now=now)
        assert start == datetime(2026, 6, 1, 11, 0, tzinfo=timezone.utc)
        assert src == "watermark"

    def test_valid_incremental_z_suffix(self):
        now = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        start, _, _ = _compute_time_window("2026-06-01T11:00:00Z", now=now)
        assert start.hour == 11

    def test_invalid_watermark_fallback_93d(self):
        now = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        start, _, src = _compute_time_window("not-a-date", now=now)
        assert start == now - timedelta(days=BACKFILL_DAYS)
        assert "invalid-watermark" in src

    def test_min_10min_clamp(self):
        now = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        wm = (now - timedelta(minutes=2)).isoformat()
        start, end, src = _compute_time_window(wm, now=now)
        assert (end - start) >= timedelta(minutes=10)
        assert "min-window-clamped" in src

    def test_naive_watermark_gets_utc(self):
        now = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        start, _, _ = _compute_time_window("2026-06-01T11:00:00", now=now)
        assert start.tzinfo == timezone.utc


class TestMergeMetricPoint:
    def test_new_volume_bucket(self):
        vd: dict = {}
        ts = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        _merge_metric_point(vd, "vol-1", "vol-a", ts, "iops_read", 10.0)
        assert "vol-1" in vd
        assert vd["vol-1"][ts.isoformat()]["iops_read"] == 10.0

    def test_merge_same_volume_timestamp(self):
        vd: dict = {}
        ts = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        _merge_metric_point(vd, "vol-1", "vol-a", ts, "iops_read", 10.0)
        _merge_metric_point(vd, "vol-1", "vol-a", ts, "iops_write", 20.0)
        bucket = vd["vol-1"][ts.isoformat()]
        assert bucket["iops_read"] == 10.0
        assert bucket["iops_write"] == 20.0


class TestFlattenRows:
    def test_full_row_and_source_type(self):
        ts = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        vd = {
            VALID_ARM: {
                ts.isoformat(): {
                    "timestamp": ts,
                    "volume_id": VALID_ARM,
                    "volume_name": FIXTURE_VOLUME_NAME,
                    "account_id": FIXTURE_SUBSCRIPTION_ID,
                    "cluster_id": FIXTURE_NETAPP_ACCOUNT,
                    "pool_id": FIXTURE_POOL_ARM_ID,
                    "service_level": "Premium",
                    "iops_read": 100.0,
                    "iops_write": 50.0,
                    "throughput_read_bytes": 1e6,
                    "throughput_write_bytes": 2e6,
                    "latency_read_us": 2500.0,
                    "latency_write_us": 3100.0,
                    "space_used_bytes": 1000,
                    "space_total_bytes": 2000,
                    "space_snapshot_bytes": 200,
                }
            }
        }
        rows = _flatten_rows(vd)
        assert len(rows) == 1
        r = rows[0]
        assert r["source_type"] == "anf"
        assert r["cluster_id"] == FIXTURE_NETAPP_ACCOUNT
        assert r["service_level"] == "Premium"
        assert r["space_total_bytes"] == 2000
        assert r["latency_avg_us"] == pytest.approx(2800.0)
        assert r["svm_name"] is None
        assert r["qos_policy"] is None
        assert r["account_id"] == FIXTURE_SUBSCRIPTION_ID
        assert r["pool_id"] == FIXTURE_POOL_ARM_ID

    def test_latency_read_only(self):
        ts = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        vd = {
            "v": {
                ts.isoformat(): {
                    "timestamp": ts,
                    "volume_id": "v",
                    "volume_name": "n",
                    "latency_read_us": 1000.0,
                }
            }
        }
        assert _flatten_rows(vd)[0]["latency_avg_us"] == 1000.0

    def test_latency_write_only(self):
        ts = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        vd = {
            "v": {
                ts.isoformat(): {
                    "timestamp": ts,
                    "volume_id": "v",
                    "volume_name": "n",
                    "latency_write_us": 2000.0,
                }
            }
        }
        assert _flatten_rows(vd)[0]["latency_avg_us"] == 2000.0

    def test_defaults_for_missing_fields(self):
        ts = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        vd = {
            "v": {
                ts.isoformat(): {
                    "timestamp": ts,
                    "volume_id": "v",
                    "volume_name": "n",
                }
            }
        }
        r = _flatten_rows(vd)[0]
        assert r["iops_read"] is None
        assert r["latency_avg_us"] is None
        assert "quota_used_bytes" not in r


class TestValidateConnectionConfig:
    def test_missing_subscription_id(self):
        assert _validate_connection_config({}) == "subscription_id is required"
        assert _validate_connection_config({"subscription_id": "  "}) == "subscription_id is required"

    def test_missing_default_region(self):
        assert _validate_connection_config({"subscription_id": "sub-1"}) is not None
        assert "default_region" in _validate_connection_config({"subscription_id": "sub-1"})

    def test_valid(self):
        assert (
            _validate_connection_config(
                {"subscription_id": "sub-1", "default_region": "eastus"}
            )
            is None
        )


class TestCreateMetricsClient:
    @patch("azure.monitor.query.MetricsQueryClient")
    def test_arm_endpoint_with_management_audience(self, mock_client):
        from adapters.anf_metrics_adapter import (
            ARM_METRICS_AUDIENCE,
            ARM_METRICS_ENDPOINT,
            _create_metrics_client,
        )

        cred = object()
        _create_metrics_client(cred, "eastus2")
        mock_client.assert_called_once_with(
            cred,
            endpoint=ARM_METRICS_ENDPOINT,
            audience=ARM_METRICS_AUDIENCE,
        )


class TestSafeHeartbeat:
    def test_swallows_callback_errors(self):
        def bad():
            raise RuntimeError("boom")

        _safe_heartbeat(bad, "detail")

    def test_none_callback(self):
        _safe_heartbeat(None, "x")


class TestIngestMetricsResult:
    def test_resource_group_filter_excludes_other_rg(self):
        from tests.fixtures.azure_monitor_responses import metrics_query_result_from_body, _response_body, _metric_block, _points

        body = _response_body([_metric_block("ReadIops", "vol-metrics-a", _points([1.0]))])
        vd: dict = {}
        _ingest_metrics_result(
            metrics_query_result_from_body(body),
            "ReadIops",
            vd,
            resource_group_filter="other-rg",
        )
        assert vd == {}

    def test_unknown_metric_name_in_result_skipped(self):
        vd: dict = {}
        _ingest_metrics_result(SINGLE_VOLUME, "NotReal", vd)
        assert vd == {}

    def test_unparseable_metric_id_skipped(self):
        from azure.monitor.query import Metric, MetricValue, TimeSeriesElement

        bad = Metric(
            id="not-a-volume-arm-path",
            type="Microsoft.Insights/metrics",
            name="ReadIops",
            unit="CountPerSecond",
            timeseries=[
                TimeSeriesElement(
                    metadata_values={},
                    data=[
                        MetricValue(
                            timestamp=datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc),
                            average=1.0,
                        )
                    ],
                )
            ],
            display_description="",
        )
        from azure.monitor.query import MetricsQueryResult

        result = MetricsQueryResult(
            timespan="t",
            metrics=[bad],
        )
        vd: dict = {}
        _ingest_metrics_result(result, "ReadIops", vd)
        assert vd == {}

    def test_subscription_metric_id_uses_volume_context(self):
        from azure.monitor.query import Metric, MetricValue, MetricsQueryResult, TimeSeriesElement

        ts = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        metric = Metric(
            id=SUBSCRIPTION_METRIC_ID,
            type="Microsoft.Insights/metrics",
            name="ReadIops",
            unit="CountPerSecond",
            timeseries=[
                TimeSeriesElement(
                    metadata_values={},
                    data=[MetricValue(timestamp=ts, average=10.0)],
                )
            ],
            display_description="",
        )
        vd: dict = {}
        ts_count, pts = _ingest_metrics_result(
            MetricsQueryResult(timespan="t", metrics=[metric]),
            "ReadIops",
            vd,
            volume_context=FIXTURE_VOLUME_CONTEXT,
        )
        assert ts_count == 1
        assert pts == 1
        assert FIXTURE_VOLUME_ARM_ID in vd

    def test_uses_total_when_average_missing(self):
        from azure.monitor.query import Metric, MetricValue, MetricsQueryResult, TimeSeriesElement

        ts = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        metric = Metric(
            id=METRIC_ID,
            type="Microsoft.Insights/metrics",
            name="VolumeSnapshotSize",
            unit="Bytes",
            timeseries=[
                TimeSeriesElement(
                    metadata_values={},
                    data=[MetricValue(timestamp=ts, total=5.1e10)],
                )
            ],
            display_description="",
        )
        vd: dict = {}
        _ingest_metrics_result(
            MetricsQueryResult(timespan="t", metrics=[metric]),
            "VolumeSnapshotSize",
            vd,
        )
        assert list(vd.values())[0][ts.isoformat()]["space_snapshot_bytes"] == 5.1e10

    def test_uses_maximum_for_byte_metrics_when_average_missing(self):
        from azure.monitor.query import Metric, MetricValue, MetricsQueryResult, TimeSeriesElement

        ts = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        metric = Metric(
            id=METRIC_ID,
            type="Microsoft.Insights/metrics",
            name="VolumeSnapshotSize",
            unit="Bytes",
            timeseries=[
                TimeSeriesElement(
                    metadata_values={},
                    data=[MetricValue(timestamp=ts, maximum=9.9e10)],
                )
            ],
            display_description="",
        )
        vd: dict = {}
        _ingest_metrics_result(
            MetricsQueryResult(timespan="t", metrics=[metric]),
            "VolumeSnapshotSize",
            vd,
        )
        assert list(vd.values())[0][ts.isoformat()]["space_snapshot_bytes"] == 9.9e10

    def test_uses_total_when_average_missing_read_iops(self):
        from azure.monitor.query import Metric, MetricValue, MetricsQueryResult, TimeSeriesElement

        ts = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        metric = Metric(
            id=METRIC_ID,
            type="Microsoft.Insights/metrics",
            name="ReadIops",
            unit="CountPerSecond",
            timeseries=[
                TimeSeriesElement(
                    metadata_values={},
                    data=[MetricValue(timestamp=ts, total=42.0)],
                )
            ],
            display_description="",
        )
        vd: dict = {}
        _ingest_metrics_result(
            MetricsQueryResult(timespan="t", metrics=[metric]),
            "ReadIops",
            vd,
        )
        assert list(vd.values())[0][ts.isoformat()]["iops_read"] == 42.0

    def test_naive_timestamp_treated_as_utc(self):
        from azure.monitor.query import Metric, MetricValue, MetricsQueryResult, TimeSeriesElement

        naive = datetime(2026, 6, 1, 12, 0)
        metric = Metric(
            id=METRIC_ID,
            type="Microsoft.Insights/metrics",
            name="ReadIops",
            unit="CountPerSecond",
            timeseries=[
                TimeSeriesElement(
                    metadata_values={},
                    data=[MetricValue(timestamp=naive, average=5.0)],
                )
            ],
            display_description="",
        )
        vd: dict = {}
        _ingest_metrics_result(
            MetricsQueryResult(timespan="t", metrics=[metric]),
            "ReadIops",
            vd,
        )
        key = list(vd[VALID_ARM].keys())[0]
        assert vd[VALID_ARM][key]["timestamp"].tzinfo == timezone.utc

    def test_aware_timestamp_converted_to_utc(self):
        from zoneinfo import ZoneInfo

        from azure.monitor.query import Metric, MetricValue, MetricsQueryResult, TimeSeriesElement

        eastern = datetime(2026, 6, 1, 8, 0, tzinfo=ZoneInfo("America/New_York"))
        metric = Metric(
            id=METRIC_ID,
            type="Microsoft.Insights/metrics",
            name="AverageReadLatency",
            unit="MilliSeconds",
            timeseries=[
                TimeSeriesElement(
                    metadata_values={},
                    data=[MetricValue(timestamp=eastern, average=1.5)],
                )
            ],
            display_description="",
        )
        vd: dict = {}
        _ingest_metrics_result(
            MetricsQueryResult(timespan="t", metrics=[metric]),
            "AverageReadLatency",
            vd,
        )
        stored = list(vd[VALID_ARM].values())[0]["latency_read_us"]
        assert stored == 1500.0


class TestVolumeDiscovery:
    def _credential(self):
        cred = MagicMock()
        cred.get_token.return_value.token = "token"
        return cred

    @patch("anf_common.client.requests.post")
    def test_resource_graph_success(self, mock_post):
        mock_post.return_value = _mock_http_response(
            200, {"data": [{"id": VALID_ARM}]}
        )
        vols = _list_anf_volumes_resource_graph(
            self._credential(), FIXTURE_SUBSCRIPTION_ID, "eastus2", "rg-anf-dev"
        )
        assert len(vols) == 1
        assert vols[0]["volume_name"] == FIXTURE_VOLUME_NAME
        query = mock_post.call_args.kwargs["json"]["query"]
        assert "rg-anf-dev" in query

    @patch("anf_common.client.requests.post")
    def test_resource_graph_auth_failure_returns_empty(self, mock_post):
        mock_post.return_value = _mock_http_response(403)
        assert _list_anf_volumes_resource_graph(
            self._credential(), FIXTURE_SUBSCRIPTION_ID, "eastus2"
        ) == []

    @patch("anf_common.client.requests.post")
    def test_resource_graph_skips_unparseable_rows(self, mock_post):
        mock_post.return_value = _mock_http_response(
            200, {"data": [{"id": "not-a-volume"}, {"id": VALID_ARM}]}
        )
        vols = _list_anf_volumes_resource_graph(
            self._credential(), FIXTURE_SUBSCRIPTION_ID, "eastus"
        )
        assert len(vols) == 1

    @patch("anf_common.client.requests.get")
    def test_arm_enumerate_walks_accounts_pools_volumes(self, mock_get):
        def fake_get(url, **kwargs):
            if url.endswith("/netAppAccounts"):
                return _mock_http_response(
                    200,
                    {"value": [{"id": ACCOUNT_ARM, "location": "eastus2"}]},
                )
            if url.endswith("/capacityPools"):
                return _mock_http_response(200, {"value": [{"id": POOL_ARM}]})
            if url.endswith("/volumes"):
                return _mock_http_response(200, {"value": [{"id": VALID_ARM}]})
            raise AssertionError(f"unexpected url {url}")

        mock_get.side_effect = fake_get
        vols = _list_anf_volumes_arm_enumerate(
            self._credential(), FIXTURE_SUBSCRIPTION_ID, "eastus2"
        )
        assert len(vols) == 1
        assert vols[0]["volume_id"] == VALID_ARM

    @patch("anf_common.client.requests.get")
    def test_arm_enumerate_populates_service_level_from_pool(self, mock_get):
        def fake_get(url, **kwargs):
            if url.endswith("/netAppAccounts"):
                return _mock_http_response(
                    200,
                    {"value": [{"id": ACCOUNT_ARM, "location": "eastus2"}]},
                )
            if url.endswith("/capacityPools"):
                return _mock_http_response(
                    200,
                    {
                        "value": [
                            {
                                "id": POOL_ARM,
                                "properties": {"serviceLevel": "Premium"},
                            }
                        ]
                    },
                )
            if url.endswith("/volumes"):
                return _mock_http_response(200, {"value": [{"id": VALID_ARM}]})
            raise AssertionError(f"unexpected url {url}")

        mock_get.side_effect = fake_get
        vols = _list_anf_volumes_arm_enumerate(
            self._credential(), FIXTURE_SUBSCRIPTION_ID, "eastus2"
        )
        assert len(vols) == 1
        assert vols[0]["service_level"] == "Premium"
        assert vols[0]["netapp_account"] == FIXTURE_NETAPP_ACCOUNT
        assert vols[0]["pool_id"] == FIXTURE_POOL_ARM_ID

    @patch("anf_common.client.requests.get")
    def test_arm_enumerate_skips_empty_account_and_pool_ids(self, mock_get):
        def fake_get(url, **kwargs):
            if url.endswith("/netAppAccounts"):
                return _mock_http_response(
                    200,
                    {
                        "value": [
                            {"id": "", "location": "eastus2"},
                            {"id": ACCOUNT_ARM, "location": "eastus2"},
                        ]
                    },
                )
            if url.endswith("/capacityPools"):
                return _mock_http_response(
                    200, {"value": [{"id": POOL_ARM}, {"id": ""}]}
                )
            if url.endswith("/volumes"):
                return _mock_http_response(200, {"value": [{"id": VALID_ARM}]})
            raise AssertionError(url)

        mock_get.side_effect = fake_get
        vols = _list_anf_volumes_arm_enumerate(
            self._credential(), FIXTURE_SUBSCRIPTION_ID, "eastus2"
        )
        assert len(vols) == 1

    @patch("anf_common.client.requests.get")
    def test_arm_enumerate_skips_wrong_region_and_resource_group(self, mock_get):
        def fake_get(url, **kwargs):
            if url.endswith("/netAppAccounts"):
                return _mock_http_response(
                    200,
                    {
                        "value": [
                            {"id": ACCOUNT_ARM, "location": "westus2"},
                            {"id": ACCOUNT_ARM, "location": "eastus2"},
                        ]
                    },
                )
            if url.endswith("/capacityPools"):
                return _mock_http_response(200, {"value": [{"id": POOL_ARM}]})
            if url.endswith("/volumes"):
                return _mock_http_response(200, {"value": [{"id": VALID_ARM}]})
            raise AssertionError(url)

        mock_get.side_effect = fake_get
        vols = _list_anf_volumes_arm_enumerate(
            self._credential(),
            FIXTURE_SUBSCRIPTION_ID,
            "eastus2",
            resource_group="other-rg",
        )
        assert vols == []

    @patch("anf_common.client.requests.get")
    def test_enrich_volumes_service_level_from_pool_arm(self, mock_get):
        vol = {**FIXTURE_VOLUME_CONTEXT}
        mock_get.return_value = _mock_http_response(
            200,
            {"properties": {"serviceLevel": "Standard"}},
        )
        enriched = _enrich_volumes_service_level(self._credential(), [vol])
        assert enriched[0]["service_level"] == "Standard"
        mock_get.assert_called_once()
        assert FIXTURE_POOL_ARM_ID in mock_get.call_args.args[0]

    @patch("adapters.anf_metrics_adapter._enrich_volumes_service_level")
    @patch("adapters.anf_metrics_adapter._list_anf_volumes_arm_enumerate")
    @patch("adapters.anf_metrics_adapter._list_anf_volumes_resource_graph")
    def test_list_anf_volumes_enriches_service_level(
        self, mock_rg, mock_arm, mock_enrich
    ):
        mock_rg.return_value = [FIXTURE_VOLUME_CONTEXT]
        mock_enrich.side_effect = lambda _cred, vols: [
            {**vols[0], "service_level": "Premium"}
        ]
        vols = _list_anf_volumes(
            self._credential(), FIXTURE_SUBSCRIPTION_ID, "eastus2"
        )
        assert vols[0]["service_level"] == "Premium"
        mock_enrich.assert_called_once()
        mock_arm.assert_not_called()

    @patch("adapters.anf_metrics_adapter._list_anf_volumes_arm_enumerate")
    @patch("adapters.anf_metrics_adapter._list_anf_volumes_resource_graph")
    def test_list_anf_volumes_falls_back_and_dedupes(self, mock_rg, mock_arm):
        mock_rg.return_value = []
        mock_arm.return_value = [FIXTURE_VOLUME_CONTEXT, FIXTURE_VOLUME_CONTEXT]
        vols = _list_anf_volumes(
            self._credential(), FIXTURE_SUBSCRIPTION_ID, "eastus2"
        )
        assert len(vols) == 1
        mock_arm.assert_called_once()


class TestQueryVolumeMetrics:
    def test_query_all_metrics_with_region(self):
        client = MagicMock()
        start = datetime(2026, 6, 1, 10, 0, tzinfo=timezone.utc)
        end = datetime(2026, 6, 1, 11, 0, tzinfo=timezone.utc)
        _query_volume_metrics(client, VALID_ARM, start, end, region="EastUS2")
        _args, kwargs = client.query_resource.call_args
        assert _args[0] == VALID_ARM
        assert _args[1] == ANF_METRIC_NAMES
        assert kwargs["params"] == {"region": "eastus2"}

    def test_query_without_region_omits_params(self):
        client = MagicMock()
        start = datetime(2026, 6, 1, 10, 0, tzinfo=timezone.utc)
        end = datetime(2026, 6, 1, 11, 0, tzinfo=timezone.utc)
        _query_volume_metrics(client, VALID_ARM, start, end)
        assert "params" not in client.query_resource.call_args.kwargs

    def test_query_subset_metric_names(self):
        client = MagicMock()
        start = datetime(2026, 6, 1, 10, 0, tzinfo=timezone.utc)
        end = datetime(2026, 6, 1, 11, 0, tzinfo=timezone.utc)
        _query_volume_metrics(
            client,
            VALID_ARM,
            start,
            end,
            metric_names=ANF_VOLUME_METRIC_NAMES,
        )
        assert client.query_resource.call_args[0][1] == ANF_VOLUME_METRIC_NAMES


class TestQueryPoolMetrics:
    def test_query_pool_metrics_with_region(self):
        client = MagicMock()
        start = datetime(2026, 6, 1, 10, 0, tzinfo=timezone.utc)
        end = datetime(2026, 6, 1, 11, 0, tzinfo=timezone.utc)
        _query_pool_metrics(client, FIXTURE_POOL_ARM_ID, start, end, region="eastus")
        _args, kwargs = client.query_resource.call_args
        assert _args[0] == FIXTURE_POOL_ARM_ID
        assert _args[1] == ANF_POOL_METRIC_NAMES
        assert kwargs["params"] == {"region": "eastus"}


class TestIngestV2Metrics:
    def test_full_v2_mapping_from_single_volume_fixture(self):
        vd: dict = {}
        for metric_name in ANF_VOLUME_METRIC_NAMES:
            _ingest_metrics_result(SINGLE_VOLUME, metric_name, vd, volume_context=FIXTURE_VOLUME_CONTEXT)
        rows = _flatten_rows(vd)
        assert len(rows) == 2
        r = rows[0]
        assert r["iops_other"] == 5.0
        assert r["iops_total"] == 205.0
        assert r["throughput_other_bytes"] == 10000.0
        assert r["inode_used"] == 1000
        assert r["inode_limit"] == 5000
        assert r["inode_used_percent"] == 20.0
        assert r["space_used_percent"] == 50.0
        assert r["throughput_limit_hit"] == 0
        assert r["qos_latency_delta_us"] == 500.0
        assert r["latency_avg_us"] == pytest.approx(2800.0)

    def test_tier_metrics_ingest_and_flatten(self):
        td: dict = {}
        for metric_name in (
            "VolumeCoolTierDataReadSize",
            "VolumeCoolTierDataWriteSize",
            "VolumeCoolTierSize",
        ):
            _ingest_tier_metrics_result(
                SINGLE_VOLUME,
                metric_name,
                td,
                volume_context=FIXTURE_VOLUME_CONTEXT,
            )
        rows = _flatten_tier_rows(td, cluster_id=FIXTURE_NETAPP_ACCOUNT)
        assert len(rows) == 2
        assert rows[0]["tier_name"] == "cold"
        assert rows[0]["tier_read_bytes"] == int(1.0e9)

    def test_pool_metrics_ingest_and_flatten(self):
        pd: dict = {}
        pool_ctx = {
            "subscription_id": FIXTURE_SUBSCRIPTION_ID,
            "resource_group": "rg-anf-dev",
            "netapp_account": FIXTURE_NETAPP_ACCOUNT,
            "pool_name": FIXTURE_POOL_NAME,
            "pool_id": FIXTURE_POOL_ARM_ID,
            "service_level": "Premium",
        }
        for metric_name in ANF_POOL_METRIC_NAMES:
            _ingest_pool_metrics_result(
                SINGLE_POOL,
                metric_name,
                pd,
                pool_context=pool_ctx,
            )
        rows = _flatten_pool_rows(pd, cluster_id=FIXTURE_NETAPP_ACCOUNT)
        assert len(rows) == 2
        assert rows[0]["capacity_bytes"] == int(4.0e12)
        assert rows[0]["used_bytes"] == int(1.8e12)
        assert rows[0]["service_level"] == "Premium"


class TestUniquePoolsFromVolumes:
    def test_dedupes_pools(self):
        vols = [FIXTURE_VOLUME_CONTEXT, {**FIXTURE_VOLUME_CONTEXT, "volume_name": "vol-b"}]
        pools = _unique_pools_from_volumes(vols)
        assert len(pools) == 1
        assert pools[0]["pool_id"] == FIXTURE_POOL_ARM_ID


class TestBuildCredential:
    def test_missing_keys_raises(self):
        with pytest.raises(ValueError, match="tenant_id"):
            _build_credential({"client_id": "a", "client_secret": "b"})

    def test_missing_azure_identity_raises(self):
        import builtins

        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name == "azure.identity":
                raise ImportError("no identity")
            return real_import(name, *args, **kwargs)

        with patch.object(builtins, "__import__", side_effect=fake_import):
            with pytest.raises(RuntimeError, match="azure-identity"):
                _build_credential(
                    {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
                )

    @patch("azure.identity.ClientSecretCredential")
    def test_success(self, mock_cred_cls):
        cred = _build_credential(
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
        )
        mock_cred_cls.assert_called_once_with(
            tenant_id="t", client_id="c", client_secret="s"
        )
        assert cred is mock_cred_cls.return_value


class TestExecute:
    def setup_method(self):
        self.adapter = AnfMetricsAdapter()

    def test_unsupported_action(self):
        resp = self.adapter.execute({}, {}, "listVolumes", {})
        assert resp.error.code == "UNSUPPORTED_ACTION"

    def test_list_metric_categories_leaf(self):
        resp = self.adapter.execute({}, {}, "listMetricCategories", {})
        assert resp.error is None
        assert len(resp.nodes) == 3
        categories = {n.resource["category"] for n in resp.nodes}
        assert categories == {"volume_metrics", "pool_metrics", "volume_tier_metrics"}

    @patch(
        "adapters.anf_metrics_adapter._list_anf_volumes",
        return_value=[FIXTURE_VOLUME_CONTEXT],
    )
    @patch("adapters.anf_metrics_adapter._create_metrics_client")
    @patch("adapters.anf_metrics_adapter._build_credential")
    def test_test_connection_query_returns_no_series(
        self, mock_build, mock_create_client, _mock_list
    ):
        mock_build.return_value = MagicMock()
        mock_metric = MagicMock()
        mock_metric.name = "ReadIops"
        mock_metric.timeseries = []
        mock_result = MagicMock()
        mock_result.metrics = [mock_metric]
        mock_client = MagicMock()
        mock_client.query_resource.return_value = mock_result
        mock_create_client.return_value = mock_client

        resp = self.adapter.execute(
            {"subscription_id": FIXTURE_SUBSCRIPTION_ID, "default_region": "eastus"},
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            "testConnection",
            {},
        )
        assert resp.error is None
        assert resp.nodes[0].metadata["metric_time_series"] == 0

    @patch(
        "adapters.anf_metrics_adapter._list_anf_volumes",
        return_value=[FIXTURE_VOLUME_CONTEXT],
    )
    @patch("adapters.anf_metrics_adapter._create_metrics_client")
    @patch("adapters.anf_metrics_adapter._build_credential")
    def test_test_connection_exception(self, mock_build, mock_create_client, _mock_list):
        mock_build.return_value = MagicMock()
        mock_client = MagicMock()
        mock_client.query_resource.side_effect = RuntimeError("network")
        mock_create_client.return_value = mock_client
        resp = self.adapter.execute(
            {"subscription_id": FIXTURE_SUBSCRIPTION_ID, "default_region": "eastus"},
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            "testConnection",
            {},
        )
        assert resp.error.code == "CONNECTION_ERROR"

    @patch("adapters.anf_metrics_adapter._list_anf_volumes", return_value=[])
    @patch("adapters.anf_metrics_adapter._create_metrics_client")
    @patch("adapters.anf_metrics_adapter._build_credential")
    def test_test_connection_subscription_probe_when_no_volumes(
        self, mock_build, mock_create_client, _mock_list
    ):
        mock_build.return_value = MagicMock()
        mock_metric = MagicMock()
        mock_metric.timeseries = [MagicMock(), MagicMock()]
        mock_result = MagicMock()
        mock_result.metrics = [mock_metric]
        mock_client = MagicMock()
        mock_client.query_resource.return_value = mock_result
        mock_create_client.return_value = mock_client

        resp = self.adapter.execute(
            {"subscription_id": FIXTURE_SUBSCRIPTION_ID, "default_region": "eastus"},
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            "testConnection",
            {},
        )
        assert resp.error is None
        assert resp.nodes[0].metadata["volume_count"] == 0
        assert resp.nodes[0].metadata["metric_time_series"] == 2
        assert resp.nodes[0].metadata["probe_volume_id"] is None
        mock_client.query_resource.assert_called_once()
        assert mock_client.query_resource.call_args[0][0].startswith("/subscriptions/")

    @patch(
        "adapters.anf_metrics_adapter._list_anf_volumes",
        return_value=[FIXTURE_VOLUME_CONTEXT],
    )
    @patch("adapters.anf_metrics_adapter._create_metrics_client")
    @patch("adapters.anf_metrics_adapter._build_credential")
    def test_test_connection_success(self, mock_build, mock_create_client, _mock_list):
        mock_build.return_value = MagicMock()
        mock_client = MagicMock()
        mock_metric = MagicMock()
        mock_metric.name = "ReadIops"
        mock_metric.timeseries = [MagicMock()]
        mock_result = MagicMock()
        mock_result.metrics = [mock_metric]
        mock_client.query_resource.return_value = mock_result
        mock_create_client.return_value = mock_client

        resp = self.adapter.execute(
            {"subscription_id": FIXTURE_SUBSCRIPTION_ID, "default_region": "eastus"},
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            "testConnection",
            {},
        )
        assert resp.error is None
        assert resp.nodes[0].type == "subscription"
        mock_client.query_resource.assert_called_once()
        assert mock_client.query_resource.call_args[0][1] == [ANF_VOLUME_METRIC_NAMES[0]]

    @patch(
        "adapters.anf_metrics_adapter._list_anf_volumes",
        return_value=[FIXTURE_VOLUME_CONTEXT],
    )
    @patch("adapters.anf_metrics_adapter._create_metrics_client")
    @patch("adapters.anf_metrics_adapter._build_credential")
    @patch("adapters.anf_metrics_adapter._query_volume_metrics")
    def test_test_connection_with_volumes_probes_read_iops_only(
        self, mock_query, mock_build, mock_create_client, _mock_list
    ):
        mock_build.return_value = MagicMock()
        mock_create_client.return_value = MagicMock()
        mock_metric = MagicMock()
        mock_metric.name = ANF_VOLUME_METRIC_NAMES[0]
        mock_metric.timeseries = [MagicMock()]
        mock_result = MagicMock()
        mock_result.metrics = [mock_metric]
        mock_query.return_value = mock_result

        resp = self.adapter.execute(
            {"subscription_id": FIXTURE_SUBSCRIPTION_ID, "default_region": "eastus"},
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            "testConnection",
            {},
        )
        assert resp.error is None
        mock_query.assert_called_once()
        assert mock_query.call_args.kwargs["metric_names"] == [ANF_VOLUME_METRIC_NAMES[0]]

    def test_test_connection_missing_config(self):
        resp = self.adapter.execute({}, {}, "testConnection", {})
        assert resp.error.code == "MISSING_CONFIG"

    def test_test_connection_missing_region(self):
        resp = self.adapter.execute(
            {"subscription_id": FIXTURE_SUBSCRIPTION_ID},
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            "testConnection",
            {},
        )
        assert resp.error.code == "MISSING_CONFIG"
        assert "default_region" in resp.error.message

    @patch("adapters.anf_metrics_adapter._build_credential", side_effect=ValueError("bad cred"))
    def test_test_connection_credential_error(self, _mock):
        resp = self.adapter.execute(
            {"subscription_id": FIXTURE_SUBSCRIPTION_ID, "default_region": "eastus"},
            {},
            "testConnection",
            {},
        )
        assert resp.error.code == "CREDENTIAL_ERROR"

    @patch("adapters.anf_metrics_adapter._build_credential")
    def test_test_connection_missing_sdk(self, mock_build):
        mock_build.return_value = MagicMock()
        import builtins

        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name == "azure.monitor.query":
                raise ImportError("no sdk")
            return real_import(name, *args, **kwargs)

        with patch.object(builtins, "__import__", side_effect=fake_import):
            resp = self.adapter._test_connection(
                {"subscription_id": FIXTURE_SUBSCRIPTION_ID, "default_region": "eastus"},
                {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            )
        assert resp.error.code == "MISSING_SDK"


def _conn_info(**extra):
    base = {
        "subscription_id": FIXTURE_SUBSCRIPTION_ID,
        "default_region": "eastus",
        "tenant_id": "tenant",
        "client_id": "client",
        "client_secret": "secret",
        "resourceSelector": [{"category": "volume_metrics"}],
    }
    base.update(extra)
    return base


def _run(coro):
    return asyncio.run(coro)


def _dispatch_to_thread(fn, *args, **kwargs):
    """Default asyncio.to_thread stand-in: call the target function."""
    return fn(*args, **kwargs)


def _volume_query_thread_result(fn, *args, **kwargs):
    """Run list discovery; return a canned Monitor result for volume queries."""
    from adapters import anf_metrics_adapter as mod

    if getattr(fn, "__name__", "") == "_list_anf_volumes":
        return mod._list_anf_volumes(*args, **kwargs)
    if getattr(fn, "__name__", "") == "_query_volume_metrics":
        return SINGLE_VOLUME
    return fn(*args, **kwargs)


class TestAcquire:
    def setup_method(self):
        self.adapter = AnfMetricsAdapter()

    @patch(
        "adapters.anf_metrics_adapter._list_anf_volumes",
        return_value=[FIXTURE_VOLUME_CONTEXT],
    )
    @patch("asyncio.to_thread")
    @patch("adapters.anf_metrics_adapter._build_credential")
    def test_happy_path_writes_parquet(self, mock_cred, mock_thread, _mock_list):
        mock_cred.return_value = MagicMock()

        mock_thread.side_effect = _volume_query_thread_result

        with tempfile.TemporaryDirectory() as tmp:
            result = _run(
                self.adapter.acquire(
                    _conn_info(),
                    watermark=None,
                    output_path=tmp,
                    heartbeat=MagicMock(),
                )
            )
            assert result["rowCount"] > 0
            path = os.path.join(tmp, "volume_metrics.parquet")
            assert os.path.isfile(path)
            table = pq.read_table(path)
            assert table.schema.names == VOLUME_METRICS_SCHEMA.names
            assert table.column("source_type")[0].as_py() == "anf"
            assert table.column("cluster_id")[0].as_py() == FIXTURE_NETAPP_ACCOUNT
            assert table.column("space_total_bytes")[0].as_py() > 0
            assert table.column("space_snapshot_bytes")[0].as_py() > 0
            assert table.column("iops_other")[0].as_py() == 5.0
            assert table.column("throughput_limit_hit")[0].as_py() == 0
            assert table.column("qos_latency_delta_us")[0].as_py() == 500.0

    @patch(
        "adapters.anf_metrics_adapter._list_anf_volumes",
        return_value=[FIXTURE_VOLUME_CONTEXT],
    )
    @patch("asyncio.to_thread")
    @patch("adapters.anf_metrics_adapter._build_credential")
    def test_zero_rows_after_partial_data_advances_watermark(
        self, mock_cred, mock_thread, _mock_list
    ):
        mock_cred.return_value = MagicMock()

        mock_thread.side_effect = _volume_query_thread_result

        with tempfile.TemporaryDirectory() as tmp:
            result = _run(
                self.adapter.acquire(_conn_info(), watermark=None, output_path=tmp)
            )
            assert result["rowCount"] > 0
            assert result["newWatermarkValue"] != ""

    def test_missing_subscription_raises(self):
        with pytest.raises(ValueError, match="subscription_id"):
            _run(self.adapter.acquire({}, watermark=None, output_path=tempfile.mkdtemp()))

    def test_missing_region_raises(self):
        with pytest.raises(ValueError, match="default_region"):
            _run(
                self.adapter.acquire(
                    {
                        "subscription_id": FIXTURE_SUBSCRIPTION_ID,
                        "tenant_id": "t",
                        "client_id": "c",
                        "client_secret": "s",
                    },
                    watermark=None,
                    output_path=tempfile.mkdtemp(),
                )
            )

    @patch(
        "adapters.anf_metrics_adapter._list_anf_volumes",
        return_value=[FIXTURE_VOLUME_CONTEXT],
    )
    @patch.object(
        AnfMetricsAdapter,
        "_fetch_volume_and_tier_metrics",
        new_callable=AsyncMock,
    )
    @patch("adapters.anf_metrics_adapter._build_credential")
    def test_acquire_empty_rows_writes_empty_parquet(self, mock_cred, mock_fetch, _mock_list):
        mock_cred.return_value = MagicMock()
        mock_fetch.return_value = ([], [])
        with tempfile.TemporaryDirectory() as tmp:
            result = _run(
                self.adapter.acquire(
                    _conn_info(), watermark="2026-05-01T00:00:00Z", output_path=tmp
                )
            )
            assert result["rowCount"] == 0
            assert result["newWatermarkValue"] == "2026-05-01T00:00:00Z"
            table = pq.read_table(os.path.join(tmp, "volume_metrics.parquet"))
            assert table.num_rows == 0

    @patch(
        "adapters.anf_metrics_adapter._list_anf_volumes",
        return_value=[FIXTURE_VOLUME_CONTEXT],
    )
    @patch.object(
        AnfMetricsAdapter,
        "_fetch_volume_and_tier_metrics",
        new_callable=AsyncMock,
    )
    @patch("adapters.anf_metrics_adapter._build_credential")
    def test_acquire_rows_without_timestamps_keep_watermark(self, mock_cred, mock_fetch, _mock_list):
        mock_cred.return_value = MagicMock()
        mock_fetch.return_value = (
            [{"volume_id": VALID_ARM, "volume_name": FIXTURE_VOLUME_NAME}],
            [],
        )
        with tempfile.TemporaryDirectory() as tmp:
            result = _run(
                self.adapter.acquire(
                    _conn_info(), watermark="2026-05-01T00:00:00Z", output_path=tmp
                )
            )
            assert result["rowCount"] == 1
            assert result["newWatermarkValue"] == "2026-05-01T00:00:00Z"

    @patch(
        "adapters.anf_metrics_adapter._list_anf_volumes",
        return_value=[FIXTURE_VOLUME_CONTEXT],
    )
    @patch("asyncio.to_thread")
    @patch("adapters.anf_metrics_adapter._build_credential")
    def test_http_response_error_collected(self, mock_cred, mock_thread, _mock_list):
        from azure.core.exceptions import HttpResponseError

        mock_cred.return_value = MagicMock()
        mock_response = MagicMock()
        mock_response.status_code = 403
        err = HttpResponseError(response=mock_response)
        def fail_query(fn, *args, **kwargs):
            from adapters import anf_metrics_adapter as mod

            if getattr(fn, "__name__", "") == "_list_anf_volumes":
                return mod._list_anf_volumes(*args, **kwargs)
            if getattr(fn, "__name__", "") == "_query_volume_metrics":
                raise err
            return fn(*args, **kwargs)

        mock_thread.side_effect = fail_query

        with pytest.raises(RuntimeError, match="All volume metric queries failed"):
            _run(self.adapter.acquire(_conn_info(), watermark=None, output_path=tempfile.mkdtemp()))

    @patch(
        "adapters.anf_metrics_adapter._list_anf_volumes",
        return_value=[FIXTURE_VOLUME_CONTEXT],
    )
    @patch.object(
        AnfMetricsAdapter,
        "_fetch_volume_and_tier_metrics",
        new_callable=AsyncMock,
    )
    @patch("adapters.anf_metrics_adapter._build_credential")
    def test_acquire_fetch_empty_preserves_watermark(self, mock_cred, mock_fetch, _mock_list):
        mock_cred.return_value = MagicMock()
        mock_fetch.return_value = ([], [])
        wm = "2026-05-01T00:00:00Z"
        with tempfile.TemporaryDirectory() as tmp:
            result = _run(
                self.adapter.acquire(_conn_info(), watermark=wm, output_path=tmp)
            )
            assert result["newWatermarkValue"] == wm
            assert result["rowCount"] == 0

    def test_resource_selector_without_supported_categories_skips(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = _run(
                self.adapter.acquire(
                    {
                        "subscription_id": FIXTURE_SUBSCRIPTION_ID,
                        "default_region": "eastus",
                        "tenant_id": "t",
                        "client_id": "c",
                        "client_secret": "s",
                        "resourceSelector": [{"category": "other"}],
                    },
                    watermark="2026-05-01T00:00:00Z",
                    output_path=tmp,
                )
            )
            assert result["rowCount"] == 0
            assert result["newWatermarkValue"] == "2026-05-01T00:00:00Z"
            assert not os.path.isfile(os.path.join(tmp, "volume_metrics.parquet"))

    @patch(
        "adapters.anf_metrics_adapter._list_anf_volumes",
        return_value=[FIXTURE_VOLUME_CONTEXT],
    )
    @patch("asyncio.to_thread")
    @patch("adapters.anf_metrics_adapter._build_credential")
    def test_all_metrics_fail_raises(self, mock_cred, mock_thread, _mock_list):
        mock_cred.return_value = MagicMock()

        def fail_query(fn, *args, **kwargs):
            from adapters import anf_metrics_adapter as mod

            if getattr(fn, "__name__", "") == "_list_anf_volumes":
                return mod._list_anf_volumes(*args, **kwargs)
            if getattr(fn, "__name__", "") == "_query_volume_metrics":
                raise RuntimeError("fail")
            return fn(*args, **kwargs)

        mock_thread.side_effect = fail_query
        with pytest.raises(RuntimeError, match="All volume metric queries failed"):
            _run(self.adapter.acquire(_conn_info(), watermark=None, output_path=tempfile.mkdtemp()))

    @patch(
        "adapters.anf_metrics_adapter._list_anf_volumes",
        return_value=[FIXTURE_VOLUME_CONTEXT],
    )
    @patch("asyncio.to_thread")
    @patch("adapters.anf_metrics_adapter._build_credential")
    def test_zero_series_raises(self, mock_cred, mock_thread, _mock_list):
        mock_cred.return_value = MagicMock()

        def empty_query(fn, *args, **kwargs):
            from adapters import anf_metrics_adapter as mod

            if getattr(fn, "__name__", "") == "_list_anf_volumes":
                return mod._list_anf_volumes(*args, **kwargs)
            if getattr(fn, "__name__", "") == "_query_volume_metrics":
                return EMPTY
            return fn(*args, **kwargs)

        mock_thread.side_effect = empty_query
        with pytest.raises(RuntimeError, match="no ingestible time series"):
            _run(self.adapter.acquire(_conn_info(), watermark=None, output_path=tempfile.mkdtemp()))

    @patch(
        "adapters.anf_metrics_adapter._list_anf_volumes",
        return_value=[FIXTURE_VOLUME_CONTEXT, {**FIXTURE_VOLUME_CONTEXT, "volume_name": "vol-b", "volume_id": VALID_ARM + "b"}],
    )
    @patch("asyncio.to_thread")
    @patch("adapters.anf_metrics_adapter._build_credential")
    def test_partial_failure_still_writes_rows(self, mock_cred, mock_thread, _mock_list):
        mock_cred.return_value = MagicMock()
        query_calls = {"n": 0}

        def partial_fail(fn, *args, **kwargs):
            from adapters import anf_metrics_adapter as mod

            if getattr(fn, "__name__", "") == "_list_anf_volumes":
                return mod._list_anf_volumes(*args, **kwargs)
            if getattr(fn, "__name__", "") == "_query_volume_metrics":
                query_calls["n"] += 1
                if query_calls["n"] == 1:
                    return SINGLE_VOLUME
                raise RuntimeError("transient")
            return fn(*args, **kwargs)

        mock_thread.side_effect = partial_fail

        with tempfile.TemporaryDirectory() as tmp:
            result = _run(self.adapter.acquire(_conn_info(), watermark=None, output_path=tmp))
            assert result["rowCount"] > 0

    @patch(
        "adapters.anf_metrics_adapter._list_anf_volumes",
        return_value=[FIXTURE_VOLUME_CONTEXT],
    )
    @patch("asyncio.to_thread")
    @patch("adapters.anf_metrics_adapter._build_credential")
    def test_heartbeat_called(self, mock_cred, mock_thread, _mock_list):
        mock_cred.return_value = MagicMock()
        mock_thread.side_effect = _volume_query_thread_result
        hb = MagicMock()
        _run(
            self.adapter.acquire(
                _conn_info(), watermark=None, output_path=tempfile.mkdtemp(), heartbeat=hb
            )
        )
        assert hb.call_count >= 1

    @patch(
        "adapters.anf_metrics_adapter._list_anf_volumes",
        return_value=[FIXTURE_VOLUME_CONTEXT],
    )
    @patch("asyncio.to_thread")
    @patch("adapters.anf_metrics_adapter._build_credential")
    def test_acquire_batches_volume_and_tier_metrics(
        self, mock_cred, mock_thread, _mock_list
    ):
        mock_cred.return_value = MagicMock()
        query_metric_batches: list[list[str]] = []

        def track_query(fn, *args, **kwargs):
            from adapters import anf_metrics_adapter as mod

            if getattr(fn, "__name__", "") == "_list_anf_volumes":
                return mod._list_anf_volumes(*args, **kwargs)
            if getattr(fn, "__name__", "") == "_query_volume_metrics":
                query_metric_batches.append(kwargs["metric_names"])
                return SINGLE_VOLUME
            return fn(*args, **kwargs)

        mock_thread.side_effect = track_query

        conn_info = _conn_info(
            resourceSelector=[
                {"category": "volume_metrics"},
                {"category": "volume_tier_metrics"},
            ],
        )
        assert len(ANF_VOLUME_METRIC_NAMES) + len(ANF_TIER_METRIC_NAMES) == 23
        wm = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()

        with tempfile.TemporaryDirectory() as tmp:
            result = _run(
                self.adapter.acquire(conn_info, watermark=wm, output_path=tmp)
            )
            assert result["rowCount"] > 0
            assert len(query_metric_batches) == 2
            assert query_metric_batches[0] == ANF_VOLUME_METRIC_NAMES
            assert query_metric_batches[1] == ANF_TIER_METRIC_NAMES

    @patch(
        "adapters.anf_metrics_adapter._list_anf_volumes",
        return_value=[FIXTURE_VOLUME_CONTEXT],
    )
    def test_missing_sdk_raises(self, _mock_list):
        import builtins

        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name == "azure.monitor.query":
                raise ImportError("no sdk")
            return real_import(name, *args, **kwargs)

        with patch.object(builtins, "__import__", side_effect=fake_import):
            with pytest.raises(RuntimeError, match="azure-monitor-query"):
                _run(
                    self.adapter._fetch_metrics(
                        FIXTURE_SUBSCRIPTION_ID,
                        datetime.now(timezone.utc) - timedelta(hours=1),
                        datetime.now(timezone.utc),
                        MagicMock(),
                        region="eastus",
                    )
                )

    def test_query_metrics_invoked(self):
        client = MagicMock()
        start = datetime(2026, 6, 1, 10, 0, tzinfo=timezone.utc)
        end = datetime(2026, 6, 1, 11, 0, tzinfo=timezone.utc)
        _query_metrics(
            client, FIXTURE_SUBSCRIPTION_ID, "ReadIops", start, end, region="eastus"
        )
        client.query_resource.assert_called_once()
        _args, kwargs = client.query_resource.call_args
        assert _args[0] == f"/subscriptions/{FIXTURE_SUBSCRIPTION_ID}"
        assert _args[1] == ["ReadIops"]
        assert kwargs["metric_namespace"] == (
            "Microsoft.NetApp/netAppAccounts/capacityPools/volumes"
        )
        assert kwargs["params"] == {"region": "eastus"}

    @patch(
        "adapters.anf_metrics_adapter._list_anf_volumes",
        return_value=[],
    )
    def test_no_volumes_raises(self, _mock_list):
        with pytest.raises(RuntimeError, match="No ANF volumes found"):
            _run(
                self.adapter._fetch_metrics(
                    FIXTURE_SUBSCRIPTION_ID,
                    datetime.now(timezone.utc) - timedelta(hours=1),
                    datetime.now(timezone.utc),
                    MagicMock(),
                    region="eastus",
                )
            )

    def test_fetch_metrics_requires_region(self):
        with pytest.raises(ValueError, match="default_region"):
            _run(
                self.adapter._fetch_metrics(
                    FIXTURE_SUBSCRIPTION_ID,
                    datetime.now(timezone.utc) - timedelta(hours=1),
                    datetime.now(timezone.utc),
                    MagicMock(),
                    region="",
                )
            )

    @patch(
        "adapters.anf_metrics_adapter._list_anf_volumes",
        return_value=[FIXTURE_VOLUME_CONTEXT],
    )
    def test_fetch_metrics_missing_azure_core_raises(self, _mock_list):
        import builtins

        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name == "azure.core.exceptions":
                raise ImportError("no azure.core")
            return real_import(name, *args, **kwargs)

        with patch.object(builtins, "__import__", side_effect=fake_import):
            with pytest.raises(RuntimeError, match="azure-core"):
                _run(
                    self.adapter._fetch_metrics(
                        FIXTURE_SUBSCRIPTION_ID,
                        datetime.now(timezone.utc) - timedelta(hours=1),
                        datetime.now(timezone.utc),
                        MagicMock(),
                        region="eastus",
                    )
                )

    @patch(
        "adapters.anf_metrics_adapter._list_anf_volumes",
        return_value=[FIXTURE_VOLUME_CONTEXT],
    )
    @patch("asyncio.to_thread")
    @patch("adapters.anf_metrics_adapter._build_credential")
    def test_http_response_error_on_volume_recorded(
        self, mock_cred, mock_thread, _mock_list
    ):
        from azure.core.exceptions import HttpResponseError

        mock_cred.return_value = MagicMock()
        err = HttpResponseError(message="forbidden", response=MagicMock(status_code=403))

        def fail_query(fn, *args, **kwargs):
            from adapters import anf_metrics_adapter as mod

            if getattr(fn, "__name__", "") == "_list_anf_volumes":
                return mod._list_anf_volumes(*args, **kwargs)
            if getattr(fn, "__name__", "") == "_query_volume_metrics":
                raise err
            return fn(*args, **kwargs)

        mock_thread.side_effect = fail_query
        with pytest.raises(RuntimeError, match="All volume metric queries failed"):
            _run(self.adapter.acquire(_conn_info(), watermark=None, output_path=tempfile.mkdtemp()))
