"""Unit tests for OntapMetricsAdapter.

Covers every logical section of the adapter that has zero existing coverage:

  Interval selection       — watermark age → ONTAP Counter Manager interval string
  _fetch_volumes_inventory — volume UUID-keyed dict from /storage/volumes
  _fetch_aggregates_inventory — aggregate UUID-keyed dict (empty on FSxN)
  _fetch_volume_metrics_timeseries — row building, watermark filter, dedup, 404
  _fetch_aggregate_metrics_timeseries — same, plus FSxN empty-inventory path
  _fetch_quota_reports — quota map, disabled path (FSxN), HTTP error path
  acquire() full flow     — Parquet writing, category filtering, return shape
  quota_metrics.parquet   — v2 split: quota data in its own table, not on volume rows
  FSxN-specific scenarios — no aggregates, quota reports disabled, verify_tls=False
  execute() / _test_connection — error mapping via httpx (not OntapClient)
"""
from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pyarrow.parquet as pq
import pytest

from adapters.metric_table_schemas import QUOTA_METRICS_SCHEMA, VOLUME_METRICS_SCHEMA
from adapters.ontap_metrics_adapter import OntapMetricsAdapter


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _arun(coro):
    return asyncio.run(coro)


def _resp(json_data=None, status=200, raise_http=False):
    """Build a fake httpx response."""
    r = MagicMock()
    r.status_code = status
    r.json.return_value = json_data if json_data is not None else {"records": []}
    if raise_http:
        exc = httpx.HTTPStatusError(
            message="error",
            request=MagicMock(),
            response=MagicMock(status_code=status, text="error body"),
        )
        r.raise_for_status.side_effect = exc
    else:
        r.raise_for_status = MagicMock()
    return r


def _vol_record(uuid="v1", name="vol1", svm="svm1",
                size=10 * 1024 ** 3, used=1 * 1024 ** 3, snap_used=100 * 1024 ** 2,
                qos_policy="perf-policy"):
    return {
        "uuid": uuid,
        "name": name,
        "svm": {"name": svm},
        "space": {"size": size, "used": used, "snapshot": {"used": snap_used}},
        "qos": {"policy": {"name": qos_policy}},
    }


def _metric_sample(ts="2026-06-01T10:00:00Z",
                   iops_read=100, iops_write=50,
                   tput_read=1_048_576, tput_write=524_288,
                   latency=200):
    return {
        "timestamp": ts,
        "iops": {"read": iops_read, "write": iops_write, "total": iops_read + iops_write},
        "throughput": {"read": tput_read, "write": tput_write},
        "latency": {"total": latency},
    }


def _agg_record(uuid="a1", name="aggr1",
                size=100 * 1024 ** 3, used=20 * 1024 ** 3):
    return {
        "uuid": uuid,
        "name": name,
        "space": {"block_storage": {"size": size, "used": used}},
    }


def _quota_record(vol_name="vol1", used=500 * 1024 ** 2, limit=10 * 1024 ** 3):
    return {
        "volume": {"name": vol_name},
        "space": {
            "used": {"total": used},
            "hard_limit": limit,
        },
    }


def _make_async_client(url_responses: dict):
    """Return an AsyncMock httpx client that dispatches by URL pattern.

    url_responses maps a string pattern to a response (or a list of responses
    consumed in order).  Patterns are checked in insertion order; first match
    wins.  Unmatched URLs return an empty-records 200 response.
    """
    call_counters: dict = {k: 0 for k in url_responses}

    async def fake_get(url, **kwargs):
        url_s = str(url)
        for pattern, resp in url_responses.items():
            if pattern in url_s:
                if isinstance(resp, list):
                    idx = call_counters[pattern]
                    call_counters[pattern] += 1
                    return resp[idx] if idx < len(resp) else _resp()
                return resp
        return _resp()

    client = AsyncMock()
    client.get = fake_get
    return client


def _patch_httpx_async(mock_client):
    """Context-manager patch for ``httpx.AsyncClient`` in the adapter module."""
    patcher = patch("adapters.ontap_metrics_adapter.httpx.AsyncClient")

    class _CM:
        def __enter__(self):
            self._mock_class = patcher.start()
            self._mock_class.return_value.__aenter__ = AsyncMock(return_value=mock_client)
            self._mock_class.return_value.__aexit__ = AsyncMock(return_value=False)
            return self._mock_class

        def __exit__(self, *_):
            patcher.stop()

    return _CM()


_BASE_CONNECTION = {
    "host": "198.19.0.1",         # bare FSxN management IP (no scheme)
    "username": "admin",
    "password": "Netapp1!",
    "cluster_id": "fsxn-cluster-1",
    "verify_tls": False,          # FSxN self-signed cert
}


# ===========================================================================
# Interval Selection
# ===========================================================================

class TestIntervalSelection:
    """The watermark age drives which ONTAP Counter Manager interval is queried.

    Intervals map to sample density:
      1h  → 15-second samples  (very recent data)
      1d  → 5-minute samples
      1w  → 30-minute samples  (default when no watermark)
      1m  → 2-hour samples     (historical backfill)
    """

    @staticmethod
    def _watermark_ago(**kwargs) -> str:
        return (datetime.now(timezone.utc) - timedelta(**kwargs)).isoformat()

    def _capture_interval(self, watermark, tmp_path, selector=None):
        """Run acquire() and return the ``interval`` param used in the first
        volume-metrics HTTP call."""
        captured: list = []

        async def fake_get(url, **kwargs):
            if "metrics" in str(url) and "volumes" in str(url):
                captured.append(kwargs.get("params", {}).get("interval"))
                return _resp({"records": [_metric_sample()]})
            if "quota" in str(url):
                return _resp({"records": []})
            if "aggregates" in str(url):
                return _resp({"records": []})
            # volumes inventory
            return _resp({"records": [_vol_record()]})

        client_mock = AsyncMock()
        client_mock.get = fake_get

        with _patch_httpx_async(client_mock):
            conn = {
                **_BASE_CONNECTION,
                "resourceSelector": selector or [{"category": "volume_metrics"}],
            }
            _arun(OntapMetricsAdapter().acquire(
                connection_info=conn,
                watermark=watermark,
                output_path=str(tmp_path),
            ))

        return captured

    def test_sub_hour_watermark_uses_1h(self, tmp_path):
        intervals = self._capture_interval(self._watermark_ago(minutes=30), tmp_path)
        assert intervals and all(i == "1h" for i in intervals)

    def test_sub_day_watermark_uses_1d(self, tmp_path):
        intervals = self._capture_interval(self._watermark_ago(hours=12), tmp_path)
        assert intervals and all(i == "1d" for i in intervals)

    def test_sub_week_watermark_uses_1w(self, tmp_path):
        intervals = self._capture_interval(self._watermark_ago(days=3), tmp_path)
        assert intervals and all(i == "1w" for i in intervals)

    def test_sub_month_watermark_uses_1m(self, tmp_path):
        intervals = self._capture_interval(self._watermark_ago(days=15), tmp_path)
        assert intervals and all(i == "1m" for i in intervals)

    def test_beyond_month_watermark_uses_1m(self, tmp_path):
        # FSxN initial backfill: oldest possible watermark → coarsest interval
        intervals = self._capture_interval(self._watermark_ago(days=45), tmp_path)
        assert intervals and all(i == "1m" for i in intervals)

    def test_no_watermark_uses_1w(self, tmp_path):
        # First run with no watermark → 7-day lookback default → 1w interval
        intervals = self._capture_interval(None, tmp_path)
        assert intervals and all(i == "1w" for i in intervals)


# ===========================================================================
# _fetch_volumes_inventory
# ===========================================================================

class TestFetchVolumesInventory:
    """Volume inventory is a prerequisite for timeseries fetch; keyed by UUID."""

    def _run(self, client) -> dict:
        return _arun(OntapMetricsAdapter()._fetch_volumes_inventory(client))

    def test_returns_uuid_keyed_dict(self):
        client = AsyncMock()
        client.get = AsyncMock(return_value=_resp({
            "records": [
                _vol_record(uuid="v1", name="vol1"),
                _vol_record(uuid="v2", name="vol2"),
            ]
        }))
        result = self._run(client)
        assert set(result.keys()) == {"v1", "v2"}
        assert result["v1"]["name"] == "vol1"
        assert result["v2"]["name"] == "vol2"

    def test_empty_records_returns_empty_dict(self):
        client = AsyncMock()
        client.get = AsyncMock(return_value=_resp({"records": []}))
        assert self._run(client) == {}

    def test_http_error_logs_warning_returns_empty_dict(self):
        """An HTTP error on the inventory call must not crash the acquisition."""
        client = AsyncMock()
        client.get = AsyncMock(return_value=_resp(status=500, raise_http=True))
        assert self._run(client) == {}


# ===========================================================================
# _fetch_aggregates_inventory  (FSxN-focused)
# ===========================================================================

class TestFetchAggregatesInventory:
    """FSxN has no traditional aggregates; the inventory endpoint returns empty
    records.  The adapter must handle this without error and produce an empty
    dict so the timeseries loop is skipped entirely.
    """

    def _run(self, client) -> dict:
        return _arun(OntapMetricsAdapter()._fetch_aggregates_inventory(client))

    def test_returns_uuid_keyed_dict(self):
        client = AsyncMock()
        client.get = AsyncMock(return_value=_resp({
            "records": [_agg_record(uuid="a1", name="aggr1")]
        }))
        result = self._run(client)
        assert "a1" in result
        assert result["a1"]["name"] == "aggr1"

    def test_fsxn_empty_records_returns_empty_dict(self):
        """FSxN path: /storage/aggregates returns no records."""
        client = AsyncMock()
        client.get = AsyncMock(return_value=_resp({"records": []}))
        assert self._run(client) == {}

    def test_http_error_returns_empty_dict(self):
        """Aggregate endpoint failure must not crash the acquisition."""
        client = AsyncMock()
        client.get = AsyncMock(return_value=_resp(status=500, raise_http=True))
        assert self._run(client) == {}


# ===========================================================================
# _fetch_volume_metrics_timeseries
# ===========================================================================

class TestFetchVolumeMetricsTimeseries:
    """The timeseries loop runs one HTTP call per volume UUID."""

    def _run(self, client, volumes_meta, interval="1w", range_start=None) -> list:
        return _arun(OntapMetricsAdapter()._fetch_volume_metrics_timeseries(
            client=client,
            cluster_id="cluster-1",
            volumes_meta=volumes_meta,
            interval=interval,
            range_start=range_start,
            heartbeat=None,
        ))

    def _single_volume_client(self, samples):
        client = AsyncMock()
        client.get = AsyncMock(return_value=_resp({"records": samples}))
        return client

    def test_row_has_all_expected_columns(self):
        samples = [_metric_sample()]
        rows = self._run(
            self._single_volume_client(samples),
            {"v1": _vol_record(uuid="v1")},
        )
        assert len(rows) == 1
        row = rows[0]
        assert row["source_type"] == "ontap"
        assert row["cluster_id"] == "cluster-1"
        assert row["volume_id"] == "v1"
        assert row["volume_name"] == "vol1"
        assert row["svm_name"] == "svm1"
        assert row["iops_read"] == 100.0
        assert row["iops_write"] == 50.0
        assert row["throughput_read_bytes"] == 1_048_576.0
        assert row["throughput_write_bytes"] == 524_288.0
        assert row["latency_avg_us"] == 200.0
        assert isinstance(row["timestamp"], datetime)

    def test_watermark_filter_drops_samples_at_or_before_watermark(self):
        old_ts = "2026-05-01T00:00:00Z"
        new_ts = "2026-06-01T10:00:00Z"
        samples = [_metric_sample(ts=old_ts), _metric_sample(ts=new_ts)]
        range_start = datetime(2026, 6, 1, 0, 0, 0, tzinfo=timezone.utc)

        rows = self._run(
            self._single_volume_client(samples),
            {"v1": _vol_record(uuid="v1")},
            range_start=range_start,
        )
        assert len(rows) == 1
        assert rows[0]["timestamp"] > range_start

    def test_deduplication_drops_repeated_timestamp_for_same_volume(self):
        ts = "2026-06-01T10:00:00Z"
        samples = [_metric_sample(ts=ts), _metric_sample(ts=ts)]  # same timestamp twice

        rows = self._run(
            self._single_volume_client(samples),
            {"v1": _vol_record(uuid="v1")},
        )
        assert len(rows) == 1, "Duplicate (volume_uuid, timestamp) must be deduplicated"

    def test_404_for_a_volume_skips_it_and_continues(self):
        """A 404 on an individual volume's metrics must not abort the loop."""
        call_count = [0]

        async def fake_get(url, **kwargs):
            call_count[0] += 1
            if "v1" in str(url):
                r = MagicMock()
                r.status_code = 404
                r.raise_for_status = MagicMock()
                return r
            return _resp({"records": [_metric_sample()]})

        client = AsyncMock()
        client.get = fake_get

        volumes = {
            "v1": _vol_record(uuid="v1", name="missing"),
            "v2": _vol_record(uuid="v2", name="present"),
        }
        rows = self._run(client, volumes)
        assert len(rows) == 1
        assert rows[0]["volume_id"] == "v2"

    def test_empty_iops_and_throughput_default_to_zero(self):
        """ONTAP may omit iops/throughput/latency; adapter must default to 0."""
        sample = {"timestamp": "2026-06-01T10:00:00Z"}  # no iops / throughput / latency
        rows = self._run(
            self._single_volume_client([sample]),
            {"v1": _vol_record(uuid="v1")},
        )
        assert rows[0]["iops_read"] == 0.0
        assert rows[0]["throughput_read_bytes"] == 0.0
        assert rows[0]["latency_avg_us"] == 0.0

    def test_space_fields_come_from_volume_inventory_not_sample(self):
        """Space data is from the inventory record, not per-sample."""
        rows = self._run(
            self._single_volume_client([_metric_sample()]),
            {"v1": _vol_record(uuid="v1", size=10 * 1024 ** 3, used=2 * 1024 ** 3)},
        )
        assert rows[0]["space_total_bytes"] == 10 * 1024 ** 3
        assert rows[0]["space_used_bytes"] == 2 * 1024 ** 3

    def test_volume_network_error_skips_volume_and_continues(self):
        """A non-404 exception (e.g. network timeout) on a volume's metrics
        endpoint must be caught, logged, and the loop continues to the next
        volume — the Parquet for other volumes is still produced."""
        async def fake_get(url, **kwargs):
            if "v1" in str(url):
                raise httpx.ConnectError("connection reset")
            return _resp({"records": [_metric_sample()]})

        client = AsyncMock()
        client.get = fake_get

        volumes = {
            "v1": _vol_record(uuid="v1", name="broken"),
            "v2": _vol_record(uuid="v2", name="ok"),
        }
        rows = self._run(client, volumes)
        assert len(rows) == 1
        assert rows[0]["volume_id"] == "v2"

    def test_volume_sample_missing_timestamp_is_skipped(self):
        """A sample dict with no 'timestamp' key must be silently skipped;
        other valid samples in the same response are still appended."""
        sample_no_ts = {"iops": {"read": 100, "write": 50}}  # no timestamp key
        sample_ok = _metric_sample(ts="2026-06-01T12:00:00Z")

        rows = self._run(
            self._single_volume_client([sample_no_ts, sample_ok]),
            {"v1": _vol_record(uuid="v1")},
        )
        assert len(rows) == 1
        assert rows[0]["iops_read"] == 100.0

    def test_volume_sample_malformed_timestamp_is_skipped(self):
        """A sample with an unparseable timestamp string must be skipped
        so it never produces a row in the Parquet file."""
        sample_bad_ts = {**_metric_sample(), "timestamp": "not-a-real-date"}
        sample_ok = _metric_sample(ts="2026-06-01T13:00:00Z")

        rows = self._run(
            self._single_volume_client([sample_bad_ts, sample_ok]),
            {"v1": _vol_record(uuid="v1")},
        )
        assert len(rows) == 1


# ===========================================================================
# _fetch_aggregate_metrics_timeseries  (FSxN-focused)
# ===========================================================================

class TestFetchAggregateMetricsTimeseries:
    """On FSxN the aggregate inventory is empty; the timeseries loop must be
    a no-op that makes zero HTTP calls and returns an empty list.
    """

    def _run(self, client, aggregates_meta, range_start=None) -> list:
        return _arun(OntapMetricsAdapter()._fetch_aggregate_metrics_timeseries(
            client=client,
            cluster_id="cluster-1",
            aggregates_meta=aggregates_meta,
            interval="1w",
            range_start=range_start,
            heartbeat=None,
        ))

    def test_fsxn_empty_inventory_makes_zero_http_calls(self):
        """FSxN: empty aggregate inventory → no HTTP calls, empty row list."""
        client = AsyncMock()
        client.get = AsyncMock()

        rows = self._run(client, {})
        assert rows == []
        client.get.assert_not_called()

    def test_row_has_all_expected_columns(self):
        client = AsyncMock()
        client.get = AsyncMock(return_value=_resp({"records": [
            {"timestamp": "2026-06-01T10:00:00Z",
             "iops": {"total": 300, "read": 200, "write": 100}},
        ]}))
        rows = self._run(client, {"a1": _agg_record(uuid="a1", name="aggr1")})
        assert len(rows) == 1
        row = rows[0]
        assert row["source_type"] == "ontap"
        assert row["aggregate_id"] == "a1"
        assert row["aggregate_name"] == "aggr1"
        assert row["current_ops"] == 300.0
        assert row["total_data_bytes"] == 100 * 1024 ** 3

    def test_watermark_filter_drops_old_samples(self):
        old_ts = "2026-04-01T00:00:00Z"
        new_ts = "2026-06-01T10:00:00Z"
        client = AsyncMock()
        client.get = AsyncMock(return_value=_resp({"records": [
            {"timestamp": old_ts, "iops": {"total": 10}},
            {"timestamp": new_ts, "iops": {"total": 20}},
        ]}))
        range_start = datetime(2026, 5, 1, tzinfo=timezone.utc)
        rows = self._run(client, {"a1": _agg_record()}, range_start=range_start)
        assert len(rows) == 1
        assert rows[0]["current_ops"] == 20.0

    def test_404_skips_aggregate_and_continues(self):
        async def fake_get(url, **kwargs):
            if "a1" in str(url):
                r = MagicMock()
                r.status_code = 404
                r.raise_for_status = MagicMock()
                return r
            return _resp({"records": [{"timestamp": "2026-06-01T10:00:00Z", "iops": {"total": 50}}]})

        client = AsyncMock()
        client.get = fake_get

        rows = self._run(client, {
            "a1": _agg_record(uuid="a1", name="missing"),
            "a2": _agg_record(uuid="a2", name="present"),
        })
        assert len(rows) == 1
        assert rows[0]["aggregate_id"] == "a2"

    def test_aggregate_network_error_skips_aggregate_and_continues(self):
        """A non-404 exception on an aggregate's metrics endpoint must be
        caught and the loop continues — rows from other aggregates are kept."""
        async def fake_get(url, **kwargs):
            if "a1" in str(url):
                raise httpx.ConnectError("connection reset")
            return _resp({"records": [
                {"timestamp": "2026-06-01T10:00:00Z", "iops": {"total": 80}}
            ]})

        client = AsyncMock()
        client.get = fake_get

        rows = self._run(client, {
            "a1": _agg_record(uuid="a1", name="broken"),
            "a2": _agg_record(uuid="a2", name="ok"),
        })
        assert len(rows) == 1
        assert rows[0]["aggregate_id"] == "a2"

    def test_aggregate_sample_missing_timestamp_is_skipped(self):
        """An aggregate sample with no 'timestamp' key must be skipped;
        valid samples in the same response still produce rows."""
        sample_no_ts = {"iops": {"total": 99}}           # no timestamp
        sample_ok = {"timestamp": "2026-06-01T10:00:00Z", "iops": {"total": 40}}

        client = AsyncMock()
        client.get = AsyncMock(return_value=_resp({"records": [sample_no_ts, sample_ok]}))

        rows = self._run(client, {"a1": _agg_record()})
        assert len(rows) == 1
        assert rows[0]["current_ops"] == 40.0

    def test_aggregate_sample_malformed_timestamp_is_skipped(self):
        """An aggregate sample with an unparseable timestamp must be dropped
        so it never writes a corrupt row into the Parquet file."""
        sample_bad_ts = {"timestamp": "definitely-not-a-date", "iops": {"total": 77}}
        sample_ok = {"timestamp": "2026-06-01T11:00:00Z", "iops": {"total": 55}}

        client = AsyncMock()
        client.get = AsyncMock(return_value=_resp({"records": [sample_bad_ts, sample_ok]}))

        rows = self._run(client, {"a1": _agg_record()})
        assert len(rows) == 1
        assert rows[0]["current_ops"] == 55.0

    def test_aggregate_deduplication_drops_repeated_timestamp(self):
        """The same (aggregate_uuid, timestamp) pair appearing twice in the
        API response must produce only one row in the Parquet output."""
        ts = "2026-06-01T10:00:00Z"
        samples = [
            {"timestamp": ts, "iops": {"total": 60}},
            {"timestamp": ts, "iops": {"total": 60}},  # exact duplicate
        ]
        client = AsyncMock()
        client.get = AsyncMock(return_value=_resp({"records": samples}))

        rows = self._run(client, {"a1": _agg_record()})
        assert len(rows) == 1, "Duplicate (agg_uuid, timestamp) must be deduplicated"


# ===========================================================================
# _fetch_quota_reports  (FSxN-focused)
# ===========================================================================

class TestFetchQuotaReports:
    """Quota reports are a point-in-time enrichment for volume rows.

    FSxN may not have quotas configured; in that case the endpoint returns
    empty records or a 403.  Both must produce an empty dict without crashing.
    """

    def _run(self, client) -> dict:
        return _arun(OntapMetricsAdapter()._fetch_quota_reports(client))

    def test_returns_volume_name_keyed_dict(self):
        client = AsyncMock()
        client.get = AsyncMock(return_value=_resp({"records": [
            _quota_record("vol1", used=512 * 1024 ** 2, limit=10 * 1024 ** 3),
            _quota_record("vol2", used=1 * 1024 ** 3, limit=5 * 1024 ** 3),
        ]}))
        result = self._run(client)
        assert set(result.keys()) == {"vol1", "vol2"}
        assert result["vol1"]["used"] == 512 * 1024 ** 2
        assert result["vol2"]["limit"] == 5 * 1024 ** 3

    def test_fsxn_quota_disabled_empty_records_returns_empty_dict(self):
        """FSxN path: no quota configuration → empty records → empty dict."""
        client = AsyncMock()
        client.get = AsyncMock(return_value=_resp({"records": []}))
        assert self._run(client) == {}

    def test_fsxn_quota_http_error_returns_empty_dict(self):
        """FSxN path: 403 (quota feature not licensed) → warning, empty dict."""
        client = AsyncMock()
        client.get = AsyncMock(return_value=_resp(status=403, raise_http=True))
        assert self._run(client) == {}


# ===========================================================================
# acquire() — full end-to-end flow
# ===========================================================================

class TestAcquireFullFlow:
    """Integration-style tests for acquire() using mocked httpx.

    Verifies that selected-category Parquet files are written, the return shape
    is correct, category filtering works, and quota data lands in
    quota_metrics.parquet (v2 split from volume_metrics).

    Two FSxN-specific scenarios are included at the end.
    """

    def _make_client(self, volumes=None, vol_metrics=None,
                     aggregates=None, agg_metrics=None, quota_records=None):
        """Convenience factory for the URL-dispatch mock client."""
        _vols = volumes if volumes is not None else [_vol_record()]
        _vmets = vol_metrics if vol_metrics is not None else [_metric_sample()]
        _aggs = aggregates if aggregates is not None else [_agg_record()]
        _amets = agg_metrics if agg_metrics is not None else [{"timestamp": "2026-06-01T10:00:00Z", "iops": {"total": 50}}]
        _quotas = quota_records if quota_records is not None else []

        async def fake_get(url, **kwargs):
            u = str(url)
            if "quota" in u:
                return _resp({"records": _quotas})
            if "metrics" in u and "volumes" in u:
                return _resp({"records": _vmets})
            if "metrics" in u and "aggregates" in u:
                return _resp({"records": _amets})
            if "aggregates" in u:
                return _resp({"records": _aggs})
            return _resp({"records": _vols})  # volumes inventory

        client = AsyncMock()
        client.get = fake_get
        return client

    def _all_selector(self):
        return [
            {"category": "volume_metrics"},
            {"category": "aggregate_metrics"},
            {"category": "quota_metrics"},
        ]

    def _run_acquire(self, client_mock, tmp_path, selector=None, watermark=None,
                     connection_info_extra=None):
        conn = {**_BASE_CONNECTION, "resourceSelector": selector or self._all_selector()}
        if connection_info_extra:
            conn.update(connection_info_extra)

        with _patch_httpx_async(client_mock):
            return _arun(OntapMetricsAdapter().acquire(
                connection_info=conn,
                watermark=watermark,
                output_path=str(tmp_path),
                heartbeat=None,
            ))

    # -- Parquet file presence -----------------------------------------------

    def test_all_selected_parquet_files_written(self, tmp_path):
        result = self._run_acquire(self._make_client(), tmp_path)
        assert os.path.exists(os.path.join(str(tmp_path), "volume_metrics.parquet"))
        assert os.path.exists(os.path.join(str(tmp_path), "aggregate_metrics.parquet"))
        assert os.path.exists(os.path.join(str(tmp_path), "quota_metrics.parquet"))
        assert result["rowCount"] > 0

    def test_return_value_has_correct_keys(self, tmp_path):
        result = self._run_acquire(self._make_client(), tmp_path)
        for key in ("outputPath", "newWatermarkValue", "rowCount",
                    "volumeMetricsCount", "aggregateMetricsCount", "quotaMetricsCount"):
            assert key in result, f"Missing key: {key}"
        assert result["outputPath"] == str(tmp_path)

    # -- Category filtering --------------------------------------------------

    def test_volume_metrics_only_selector_skips_aggregates(self, tmp_path):
        """When only volume_metrics is requested, aggregates endpoint is not called."""
        called_urls: list = []

        async def fake_get(url, **kwargs):
            called_urls.append(str(url))
            if "volumes" in str(url) and "metrics" not in str(url):
                return _resp({"records": [_vol_record()]})
            if "metrics" in str(url):
                return _resp({"records": [_metric_sample()]})
            return _resp({"records": []})

        client = AsyncMock()
        client.get = fake_get

        result = self._run_acquire(
            client, tmp_path, selector=[{"category": "volume_metrics"}]
        )
        assert not any("aggregates" in u for u in called_urls), (
            "aggregate endpoint called when not in resourceSelector"
        )
        assert result["aggregateMetricsCount"] == 0
        # volume_metrics.parquet still written
        tbl = pq.read_table(os.path.join(str(tmp_path), "volume_metrics.parquet"))
        assert tbl.num_rows > 0

    def test_aggregate_metrics_only_selector_skips_volumes(self, tmp_path):
        """When only aggregate_metrics is requested, volume timeseries is not fetched."""
        called_urls: list = []

        async def fake_get(url, **kwargs):
            called_urls.append(str(url))
            if "aggregates" in str(url) and "metrics" not in str(url):
                return _resp({"records": [_agg_record()]})
            if "aggregates" in str(url) and "metrics" in str(url):
                return _resp({"records": [{"timestamp": "2026-06-01T10:00:00Z", "iops": {"total": 99}}]})
            return _resp({"records": []})

        client = AsyncMock()
        client.get = fake_get

        result = self._run_acquire(
            client, tmp_path, selector=[{"category": "aggregate_metrics"}]
        )
        vol_metric_calls = [u for u in called_urls if "volumes" in u and "metrics" in u]
        assert vol_metric_calls == [], "volume metrics endpoint called when not in selector"
        assert result["volumeMetricsCount"] == 0
        assert result["aggregateMetricsCount"] > 0

    # -- Quota metrics (v2 split table) --------------------------------------

    def test_quota_data_written_to_separate_parquet(self, tmp_path):
        """Quota snapshots go to quota_metrics.parquet, not volume_metrics rows."""
        quota_used = 300 * 1024 ** 2
        quota_limit = 5 * 1024 ** 3

        client = self._make_client(
            volumes=[_vol_record(uuid="v1", name="vol1")],
            vol_metrics=[_metric_sample()],
            aggregates=[],
            quota_records=[_quota_record("vol1", used=quota_used, limit=quota_limit)],
        )
        result = self._run_acquire(client, tmp_path)

        vol_schema = pq.read_schema(os.path.join(str(tmp_path), "volume_metrics.parquet"))
        assert "quota_used_bytes" not in vol_schema.names
        assert "quota_limit_bytes" not in vol_schema.names

        quota_tbl = pq.read_table(os.path.join(str(tmp_path), "quota_metrics.parquet"))
        quota_rows = quota_tbl.to_pydict()
        assert len(quota_rows["volume_name"]) == 1
        assert quota_rows["volume_name"][0] == "vol1"
        assert quota_rows["quota_used_bytes"][0] == quota_used
        assert quota_rows["quota_limit_bytes"][0] == quota_limit
        assert result["quotaMetricsCount"] == 1

    def test_quota_metrics_only_selector_skips_volume_and_aggregate(self, tmp_path):
        """When only quota_metrics is requested, volume/aggregate endpoints are not called."""
        called_urls: list = []

        async def fake_get(url, **kwargs):
            called_urls.append(str(url))
            if "quota" in str(url):
                return _resp({"records": [_quota_record("vol1")]})
            return _resp({"records": []})

        client = AsyncMock()
        client.get = fake_get

        result = self._run_acquire(
            client, tmp_path, selector=[{"category": "quota_metrics"}]
        )
        assert not any("volumes" in u for u in called_urls)
        assert not any("aggregates" in u for u in called_urls)
        assert any("quota" in u for u in called_urls)
        assert result["volumeMetricsCount"] == 0
        assert result["aggregateMetricsCount"] == 0
        assert result["quotaMetricsCount"] == 1
        assert os.path.exists(os.path.join(str(tmp_path), "quota_metrics.parquet"))
        assert not os.path.exists(os.path.join(str(tmp_path), "volume_metrics.parquet"))

    def test_legacy_quota_reports_alias_normalized_in_acquire(self, tmp_path):
        """Legacy quota_reports category in selector maps to quota_metrics."""
        client = self._make_client(
            volumes=[], vol_metrics=[], aggregates=[], agg_metrics=[],
            quota_records=[_quota_record("vol1")],
        )
        result = self._run_acquire(
            client, tmp_path,
            selector=[{"category": "quota_reports"}],
        )
        assert os.path.exists(os.path.join(str(tmp_path), "quota_metrics.parquet"))
        assert result["quotaMetricsCount"] == 1

    # -- Parquet schema correctness ------------------------------------------

    def test_volume_parquet_schema_matches_v2(self, tmp_path):
        self._run_acquire(self._make_client(), tmp_path)
        schema = pq.read_schema(os.path.join(str(tmp_path), "volume_metrics.parquet"))
        expected = {field.name for field in VOLUME_METRICS_SCHEMA}
        assert set(schema.names) == expected
        assert "quota_used_bytes" not in schema.names

    def test_quota_metrics_parquet_schema_matches_v2(self, tmp_path):
        self._run_acquire(self._make_client(), tmp_path)
        schema = pq.read_schema(os.path.join(str(tmp_path), "quota_metrics.parquet"))
        expected = {field.name for field in QUOTA_METRICS_SCHEMA}
        assert set(schema.names) == expected

    def test_aggregate_parquet_schema_has_all_11_columns(self, tmp_path):
        self._run_acquire(self._make_client(), tmp_path)
        schema = pq.read_schema(os.path.join(str(tmp_path), "aggregate_metrics.parquet"))
        expected = {
            "timestamp", "source_type", "cluster_id", "aggregate_id",
            "aggregate_name", "current_ops", "optimal_point_ops", "available_ops",
            "cold_data_bytes", "total_data_bytes", "cache_hit_ratio",
        }
        assert set(schema.names) == expected

    # -- FSxN-specific scenarios ---------------------------------------------

    def test_fsxn_no_aggregates_empty_parquet_written_without_crash(self, tmp_path):
        """FSxN: /storage/aggregates returns no records.

        The adapter must write an empty (but valid) aggregate_metrics.parquet
        and return normally.  This exercises the FSxN path where traditional
        aggregates are not exposed.
        """
        client = self._make_client(aggregates=[])  # FSxN: no aggregates
        result = self._run_acquire(client, tmp_path)

        agg_path = os.path.join(str(tmp_path), "aggregate_metrics.parquet")
        assert os.path.exists(agg_path), "aggregate_metrics.parquet must always be written"
        tbl = pq.read_table(agg_path)
        assert tbl.num_rows == 0, "FSxN: aggregate parquet must be empty"
        assert result["aggregateMetricsCount"] == 0

    def test_fsxn_quota_reports_disabled_no_crash(self, tmp_path):
        """FSxN: quota reports endpoint returns empty.

        The adapter must complete acquisition normally and write an empty
        quota_metrics.parquet stub alongside populated volume metrics.
        """
        client = self._make_client(quota_records=[])  # FSxN: no quotas
        result = self._run_acquire(client, tmp_path)

        vol_tbl = pq.read_table(os.path.join(str(tmp_path), "volume_metrics.parquet"))
        assert vol_tbl.num_rows > 0
        assert "quota_used_bytes" not in vol_tbl.schema.names

        quota_tbl = pq.read_table(os.path.join(str(tmp_path), "quota_metrics.parquet"))
        assert quota_tbl.num_rows == 0
        assert quota_tbl.schema.equals(QUOTA_METRICS_SCHEMA)
        assert result["quotaMetricsCount"] == 0
        assert result["rowCount"] > 0

    def test_fsxn_verify_tls_false_passed_to_httpx_client(self, tmp_path):
        """FSxN management endpoints use self-signed certs.

        verify_tls=False in connection_info must reach httpx.AsyncClient(verify=False).
        """
        client_mock = self._make_client(aggregates=[], quota_records=[])
        with patch("adapters.ontap_metrics_adapter.httpx.AsyncClient") as MockClient:
            MockClient.return_value.__aenter__ = AsyncMock(return_value=client_mock)
            MockClient.return_value.__aexit__ = AsyncMock(return_value=False)

            conn = {
                **_BASE_CONNECTION,
                "verify_tls": False,
                "resourceSelector": [{"category": "volume_metrics"}],
            }
            _arun(OntapMetricsAdapter().acquire(
                connection_info=conn,
                watermark=None,
                output_path=str(tmp_path),
                heartbeat=None,
            ))

            _, ctor_kwargs = MockClient.call_args
            assert ctor_kwargs.get("verify") is False, (
                "verify=False must be forwarded to httpx.AsyncClient for FSxN self-signed certs"
            )


# ===========================================================================
# execute() / _test_connection()
# ===========================================================================

class TestMetricsAdapterTestConnection:
    """OntapMetricsAdapter._test_connection uses httpx.Client (sync) directly,
    NOT OntapClient.  Error codes differ from OntapAdapter:

      HTTP 401  → AUTH_FAILED     (not UNAUTHORIZED)
      SSL error → CONNECTION_ERROR (not TLS_VERIFY_FAILED)

    This inconsistency is intentional (metrics adapter predates OntapClient
    error unification) and must be preserved until a future refactor.
    """

    def _execute(self, connector_config, credential, mock_resp=None, mock_exc=None):
        with patch("adapters.ontap_metrics_adapter.httpx.Client") as MockClient:
            ctx = MagicMock()
            MockClient.return_value.__enter__ = MagicMock(return_value=ctx)
            MockClient.return_value.__exit__ = MagicMock(return_value=False)
            if mock_exc:
                ctx.get.side_effect = mock_exc
            else:
                ctx.get.return_value = mock_resp
            return OntapMetricsAdapter().execute(
                connector_config, credential, "testConnection", {}
            )

    def test_success_returns_cluster_node(self):
        resp = MagicMock()
        resp.raise_for_status = MagicMock()
        resp.json.return_value = {
            "name": "fsxn-cluster",
            "version": {"full": "ONTAP 9.13.1"},
        }
        result = self._execute(
            {"cluster_url": "https://198.19.0.1"},
            {"username": "admin", "password": "secret"},
            mock_resp=resp,
        )
        assert result.error is None
        assert len(result.nodes) == 1
        node = result.nodes[0]
        assert node.label == "fsxn-cluster"
        assert node.type == "cluster"
        assert node.metadata["provider"] == "ontap_metrics"

    def test_401_returns_auth_failed_code(self):
        mock_resp = MagicMock()
        exc = httpx.HTTPStatusError(
            message="Unauthorized",
            request=MagicMock(),
            response=MagicMock(status_code=401, text="Unauthorized"),
        )
        mock_resp.raise_for_status.side_effect = exc
        result = self._execute(
            {"cluster_url": "https://198.19.0.1"},
            {"username": "admin", "password": "wrong"},
            mock_resp=mock_resp,
        )
        assert result.error is not None
        assert result.error.code == "AUTH_FAILED"

    def test_generic_exception_returns_connection_error(self):
        """SSL and network errors surface as CONNECTION_ERROR (not TLS_VERIFY_FAILED)."""
        result = self._execute(
            {"cluster_url": "https://198.19.0.1", "verify_tls": False},
            {"username": "admin", "password": "secret"},
            mock_exc=Exception("SSL: CERTIFICATE_VERIFY_FAILED"),
        )
        assert result.error is not None
        assert result.error.code == "CONNECTION_ERROR"

    def test_missing_cluster_url_returns_missing_config(self):
        result = OntapMetricsAdapter().execute({}, {"username": "u", "password": "p"},
                                               "testConnection", {})
        assert result.error is not None
        assert result.error.code == "MISSING_CONFIG"

    def test_list_metric_categories_returns_three_nodes(self):
        """execute() must expose the three ONTAP metric categories without any HTTP call."""
        result = OntapMetricsAdapter().execute(
            {"cluster_url": "https://198.19.0.1"},
            {"username": "admin", "password": "secret"},
            "listMetricCategories", {},
        )
        assert result.error is None
        cats = {n.resource.get("category") for n in result.nodes}
        assert cats == {"volume_metrics", "aggregate_metrics", "quota_metrics"}
