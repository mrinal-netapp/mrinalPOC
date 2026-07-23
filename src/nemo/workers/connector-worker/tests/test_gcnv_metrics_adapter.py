from __future__ import annotations
import json
import sys
import tempfile
from datetime import datetime, timezone, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
import pyarrow.parquet as pq
import pytest

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

from adapters.gcnv_metrics_adapter import (  # noqa: E402
    GCNV_METRIC_TYPES,
    GCNV_POOL_METRIC_TYPES,
    GCNV_TIER_METRIC_TYPES,
    GcnvMetricsAdapter,
)
from adapters.metric_table_schemas import (  # noqa: E402
    POOL_METRICS_SCHEMA,
    VOLUME_METRICS_SCHEMA,
    VOLUME_TIER_METRICS_SCHEMA,
)

FAKE_SA_JSON = json.dumps({
    "type": "service_account",
    "project_id": "test-project",
    "private_key_id": "key123",
    "private_key": "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJBALRiMLAH\n-----END RSA PRIVATE KEY-----\n",
    "client_email": "test@test-project.iam.gserviceaccount.com",
    "client_id": "123456789",
    "auth_uri": "https://accounts.google.com/o/oauth2/auth",
    "token_uri": "https://oauth2.googleapis.com/token",
})

def _adapter() -> GcnvMetricsAdapter:
    return GcnvMetricsAdapter()

def _run(coro):
    return __import__("asyncio").run(coro)


def _patch_acquire_fetches(
    mock_volume_fetch=None,
    mock_tier_fetch=None,
    mock_pool_fetch=None,
):
    """Patch volume/tier/pool fetches and inventory loaders for acquire() tests."""
    volume_mock = mock_volume_fetch or AsyncMock(return_value=[])
    tier_mock = mock_tier_fetch or AsyncMock(return_value=[])
    pool_mock = mock_pool_fetch or AsyncMock(return_value=[])
    return (
        patch.object(GcnvMetricsAdapter, "_fetch_volume_metrics", volume_mock),
        patch.object(GcnvMetricsAdapter, "_fetch_tier_metrics", tier_mock),
        patch.object(GcnvMetricsAdapter, "_fetch_pool_metrics", pool_mock),
        patch("adapters.gcnv_metrics_adapter._fetch_volumes_inventory", return_value={}),
        patch("adapters.gcnv_metrics_adapter._fetch_pools_inventory", return_value={}),
    )

def _make_point(end_time: datetime, double_value: float = 0.0, int64_value: int = 0):
    value = SimpleNamespace(double_value=double_value, int64_value=int64_value)
    interval = SimpleNamespace(end_time=end_time)
    return SimpleNamespace(interval=interval, value=value)

def _make_time_series(
    metric_type: str,
    *,
    volume_id: str = "vol-1",
    volume_name: str = "my-volume",
    op_type: str = "read",
    points: list | None = None,
):
    if points is None:
        points = [_make_point(datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc), double_value=100.0)]
    return SimpleNamespace(
        resource=SimpleNamespace(
            type="netapp.googleapis.com/Volume",
            labels={"volume_name": volume_name, "name": volume_id},
        ),
        metric=SimpleNamespace(labels={"type": op_type}),
        points=points,
    )

def _make_tier_time_series(
    metric_type: str,
    *,
    volume_id: str = "vol-1",
    tier: str = "",
    points: list | None = None,
):
    if points is None:
        points = [_make_point(datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc), int64_value=500)]
    metric_labels = {"tier": tier} if tier else {}
    return SimpleNamespace(
        resource=SimpleNamespace(
            type="netapp.googleapis.com/Volume",
            labels={"volume_name": volume_id, "name": volume_id},
        ),
        metric=SimpleNamespace(labels=metric_labels),
        points=points,
    )

def _make_pool_time_series(
    metric_type: str,
    *,
    pool_id: str = "pool-a",
    metric_labels: dict | None = None,
    points: list | None = None,
):
    if points is None:
        points = [_make_point(datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc), int64_value=1_000)]
    return SimpleNamespace(
        resource=SimpleNamespace(
            type="netapp.googleapis.com/StoragePool",
            labels={
                "storage_pool": f"projects/p/locations/us-central1/storagePools/{pool_id}",
            },
        ),
        metric=SimpleNamespace(labels=metric_labels or {}),
        points=points,
    )

class _AsyncIter:
    def __init__(self, items):
        self._items = list(items)
        self._i = 0

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._i >= len(self._items):
            raise StopAsyncIteration
        item = self._items[self._i]
        self._i += 1
        return item

class TestFieldForMetric:
    def test_operation_count_read_write(self):
        m = "netapp.googleapis.com/volume/operation_count"
        assert GcnvMetricsAdapter._field_for_metric(m, {"type": "read"}) == "iops_read"
        assert GcnvMetricsAdapter._field_for_metric(m, {"type": "write"}) == "iops_write"
        assert GcnvMetricsAdapter._field_for_metric(m, {"type": "metadata"}) == "iops_other"

    def test_throughput_and_latency(self):
        assert GcnvMetricsAdapter._field_for_metric(
            "netapp.googleapis.com/volume/throughput", {"type": "write"}
        ) == "throughput_write_bytes"
        assert GcnvMetricsAdapter._field_for_metric(
            "netapp.googleapis.com/volume/average_latency", {"type": "read"}
        ) == "latency_read_us"

    def test_capacity_metrics(self):
        assert GcnvMetricsAdapter._field_for_metric(
            "netapp.googleapis.com/volume/bytes_used", {}
        ) == "space_used_bytes"
        assert GcnvMetricsAdapter._field_for_metric(
            "netapp.googleapis.com/volume/allocated_bytes", {}
        ) == "space_total_bytes"
        assert GcnvMetricsAdapter._field_for_metric(
            "netapp.googleapis.com/volume/snapshot_bytes", {}
        ) == "space_snapshot_bytes"

    def test_unknown_metric_type(self):
        assert GcnvMetricsAdapter._field_for_metric("unknown/metric", {"type": "read"}) is None

class TestExplorerActions:
    def test_list_metric_categories_leaf(self):
        resp = _adapter().execute(
            {"project_id": "p"}, {}, "listMetricCategories", {}
        )
        assert resp.error is None
        types = {n.type for n in resp.nodes}
        assert types == {"metric_category"}
        cats = sorted([(n.resource or {}).get("category") for n in resp.nodes])
        assert cats == ["pool_metrics", "volume_metrics", "volume_tier_metrics"]
        for n in resp.nodes:
            assert n.children_hint == "leaf"

    def test_connection_missing_project_id(self):
        resp = _adapter().execute({}, {}, "testConnection", {})
        assert resp.error is not None
        assert resp.error.code == "MISSING_CONFIG"

    @patch("googleapiclient.discovery.build")
    @patch("google.oauth2.service_account.Credentials.from_service_account_info")
    def test_connection_success(self, mock_creds, mock_build):
        mock_creds.return_value = MagicMock()
        svc = MagicMock()
        mock_build.return_value = svc
        svc.projects.return_value.metricDescriptors.return_value.list.return_value.execute.return_value = {}
        resp = _adapter().execute(
            {"project_id": "test-project"},
            {"service_account_json": FAKE_SA_JSON},
            "testConnection",
            {},
        )
        assert resp.error is None
        assert resp.nodes[0].label == "test-project"

    def test_connection_missing_service_account_json(self):
        resp = _adapter().execute(
            {"project_id": "test-project"},
            {},
            "testConnection",
            {},
        )
        assert resp.error is not None
        assert resp.error.code == "CREDENTIAL_ERROR"

    @patch("googleapiclient.discovery.build")
    @patch("google.oauth2.service_account.Credentials.from_service_account_info")
    def test_connection_invalid_sa_json(self, mock_creds, mock_build):
        mock_creds.return_value = MagicMock()
        resp = _adapter().execute(
            {"project_id": "test-project"},
            {"service_account_json": "not-json"},
            "testConnection",
            {},
        )
        assert resp.error is not None
        assert resp.error.code == "CREDENTIAL_ERROR"
        mock_build.assert_not_called()

class TestAcquireValidationAndSkip:
    def test_missing_project_id(self):
        with pytest.raises(ValueError, match="project_id"):
            _run(_adapter().acquire({}, None, "/tmp/out"))

    def test_skips_when_volume_metrics_not_selected(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = _run(_adapter().acquire(
                {
                    "project_id": "p1",
                    "resourceSelector": [{"category": "other"}],
                },
                "2026-01-01T00:00:00+00:00",
                tmp,
            ))
            assert result["rowCount"] == 0
            assert result["newWatermarkValue"] == "2026-01-01T00:00:00+00:00"
            assert not (Path(tmp) / "volume_metrics.parquet").exists()

    def test_empty_resource_selector(self):
        mock_volume_fetch = AsyncMock(return_value=[])
        patches = _patch_acquire_fetches(mock_volume_fetch)
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            with tempfile.TemporaryDirectory() as tmp:
                result = _run(_adapter().acquire({"project_id": "proj"}, None, tmp))
            mock_volume_fetch.assert_awaited_once()
            assert result["rowCount"] == 0

class TestAcquireTimeRange:
    """Verify lookback window selection passed through to Cloud Monitoring."""

    _FIXED_NOW = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)

    @pytest.fixture
    def patched_fetch(self):
        mock_volume_fetch = AsyncMock(return_value=[])
        patches = _patch_acquire_fetches(mock_volume_fetch)
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            yield mock_volume_fetch

    @staticmethod
    def _patch_now():
        class _Dt:
            @staticmethod
            def now(tz=None):
                return TestAcquireTimeRange._FIXED_NOW

            @staticmethod
            def fromisoformat(s):
                return datetime.fromisoformat(s)

        return patch("adapters.gcnv_metrics_adapter.datetime", _Dt)

    def test_no_watermark(self, patched_fetch):
        with self._patch_now():
            with tempfile.TemporaryDirectory() as tmp:
                _run(_adapter().acquire({"project_id": "proj"}, None, tmp))
        start, end = patched_fetch.await_args.args[1], patched_fetch.await_args.args[2]
        assert end == self._FIXED_NOW
        assert start == self._FIXED_NOW - timedelta(days=30)

    def test_invalid_watermark(self, patched_fetch):
        with self._patch_now():
            with tempfile.TemporaryDirectory() as tmp:
                _run(_adapter().acquire(
                    {"project_id": "proj"},
                    "not-a-timestamp",
                    tmp,
                ))
        start = patched_fetch.await_args.args[1]
        assert start == self._FIXED_NOW - timedelta(days=30)

    def test_recent_watermark(self, patched_fetch):
        # Watermark 1 minute ago is shorter than 2x the 5-minute sample period.
        recent_wm = (self._FIXED_NOW - timedelta(minutes=1)).isoformat()
        with self._patch_now():
            with tempfile.TemporaryDirectory() as tmp:
                _run(_adapter().acquire(
                    {"project_id": "proj"},
                    recent_wm,
                    tmp,
                ))
        start = patched_fetch.await_args.args[1]
        assert start == self._FIXED_NOW - timedelta(minutes=10)

    def test_valid_watermark(self, patched_fetch):
        wm = (self._FIXED_NOW - timedelta(hours=2)).isoformat()
        with self._patch_now():
            with tempfile.TemporaryDirectory() as tmp:
                _run(_adapter().acquire({"project_id": "proj"}, wm, tmp))
        start = patched_fetch.await_args.args[1]
        assert start == datetime.fromisoformat(wm)

    def test_watermark_with_z_suffix(self, patched_fetch):
        wm = "2026-06-01T08:00:00Z"
        with self._patch_now():
            with tempfile.TemporaryDirectory() as tmp:
                _run(_adapter().acquire({"project_id": "proj"}, wm, tmp))
        start = patched_fetch.await_args.args[1]
        assert start == datetime(2026, 6, 1, 8, 0, tzinfo=timezone.utc)

    def test_pass_inline_service_account_to_fetch(self, patched_fetch):
        with self._patch_now():
            with patch(
                "google.oauth2.service_account.Credentials.from_service_account_info",
                return_value=MagicMock(name="creds"),
            ) as mock_creds_factory:
                with tempfile.TemporaryDirectory() as tmp:
                    _run(_adapter().acquire(
                        {
                            "project_id": "proj",
                            "service_account_json": FAKE_SA_JSON,
                        },
                        None,
                        tmp,
                    ))
                mock_creds_factory.assert_called_once()
                assert patched_fetch.await_args.kwargs["credentials"] is mock_creds_factory.return_value

class TestAcquireWatermarkPolicy:
    @pytest.fixture
    def patched_fetch(self):
        mock_volume_fetch = AsyncMock()
        patches = _patch_acquire_fetches(mock_volume_fetch)
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            yield mock_volume_fetch

    def test_advances_watermark_on_rows(self, patched_fetch):
        ts = datetime(2026, 6, 1, 14, 30, tzinfo=timezone.utc)
        patched_fetch.return_value = [{
          "timestamp": ts,
          "source_type": "gcnv",
          "cluster_id": "proj",
          "volume_id": "v1",
          "volume_name": "v1",
          "svm_name": None,
          "iops_read": 1.0,
          "iops_write": 2.0,
          "throughput_read_bytes": 3.0,
          "throughput_write_bytes": 4.0,
          "latency_avg_us": 5.0,
          "space_used_bytes": 6,
          "space_total_bytes": 7,
          "space_snapshot_bytes": 8,
          "qos_policy": None,
          "service_level": None,
          "quota_used_bytes": 0,
          "quota_limit_bytes": 0,
        }]
        with tempfile.TemporaryDirectory() as tmp:
            result = _run(_adapter().acquire({"project_id": "proj"}, None, tmp))
            assert result["rowCount"] == 1
            assert "2026-06-01" in result["newWatermarkValue"]
            table = pq.read_table(Path(tmp) / "volume_metrics.parquet")
            assert table.num_rows == 1
            assert table.schema.equals(VOLUME_METRICS_SCHEMA)

    def test_preserves_watermark_on_empty_rows(self, patched_fetch):
        patched_fetch.return_value = []
        prior = "2026-05-01T10:00:00+00:00"
        with tempfile.TemporaryDirectory() as tmp:
            result = _run(_adapter().acquire(
                {"project_id": "proj"},
                prior,
                tmp,
            ))
            assert result["rowCount"] == 0
            assert result["newWatermarkValue"] == prior

class TestFetchVolumeMetrics:
    @pytest.mark.asyncio
    async def test_flattens_time_series_into_rows(self):
        adapter = _adapter()
        end = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        series_by_type = {
            "netapp.googleapis.com/volume/operation_count": [
                _make_time_series(
                    "netapp.googleapis.com/volume/operation_count",
                    op_type="read",
                    points=[_make_point(end, double_value=10.0)],
                ),
                _make_time_series(
                    "netapp.googleapis.com/volume/operation_count",
                    op_type="write",
                    points=[_make_point(end, double_value=20.0)],
                ),
            ],
            "netapp.googleapis.com/volume/average_latency": [
                _make_time_series(
                    "netapp.googleapis.com/volume/average_latency",
                    op_type="read",
                    points=[_make_point(end, double_value=2.0)],
                ),
                _make_time_series(
                    "netapp.googleapis.com/volume/average_latency",
                    op_type="write",
                    points=[_make_point(end, double_value=4.0)],
                ),
            ],
            "netapp.googleapis.com/volume/bytes_used": [
                _make_time_series(
                    "netapp.googleapis.com/volume/bytes_used",
                    points=[_make_point(end, int64_value=1_000_000)],
                ),
            ],
        }

        async def mock_list_time_series(request):
            metric_type = request.filter.split('"')[1]
            return _AsyncIter(series_by_type.get(metric_type, []))

        mock_client = MagicMock()
        mock_client.list_time_series = AsyncMock(side_effect=mock_list_time_series)

        with patch("google.cloud.monitoring_v3.MetricServiceAsyncClient", return_value=mock_client):
            rows = await adapter._fetch_volume_metrics(
                "test-project",
                end - timedelta(hours=1),
                end,
                "",
                credentials=MagicMock(),
            )

        assert len(rows) == 1
        row = rows[0]
        assert row["source_type"] == "gcnv"
        assert row["cluster_id"] == "test-project"
        assert row["iops_read"] == 10.0
        assert row["iops_write"] == 20.0
        # (2ms + 4ms) / 2 * 1000 = 3000 us average
        assert row["latency_avg_us"] == 3000.0
        assert row["space_used_bytes"] == 1_000_000

    @pytest.mark.asyncio
    async def test_raises_when_all_metric_types_fail(self):
        from google.api_core.exceptions import GoogleAPIError

        adapter = _adapter()
        mock_client = MagicMock()
        mock_client.list_time_series = AsyncMock(
            side_effect=GoogleAPIError("permission denied")
        )

        with patch("google.cloud.monitoring_v3.MetricServiceAsyncClient", return_value=mock_client):
            with pytest.raises(RuntimeError, match="All volume metric types failed"):
                await adapter._fetch_volume_metrics(
                    "p",
                    datetime(2026, 6, 1, 0, 0, tzinfo=timezone.utc),
                    datetime(2026, 6, 1, 1, 0, tzinfo=timezone.utc),
                    "",
                    credentials=MagicMock(),
                )

    @pytest.mark.asyncio
    async def test_raises_when_zero_series_without_errors(self):
        adapter = _adapter()
        mock_client = MagicMock()
        mock_client.list_time_series = AsyncMock(return_value=_AsyncIter([]))

        with patch("google.cloud.monitoring_v3.MetricServiceAsyncClient", return_value=mock_client):
            with pytest.raises(RuntimeError, match="0 volume time series"):
                await adapter._fetch_volume_metrics(
                    "empty-project",
                    datetime(2026, 6, 1, 0, 0, tzinfo=timezone.utc),
                    datetime(2026, 6, 1, 1, 0, tzinfo=timezone.utc),
                    "us-central1",
                    credentials=MagicMock(),
                )

        assert mock_client.list_time_series.await_count == len(GCNV_METRIC_TYPES)

    @pytest.mark.asyncio
    async def test_partial_metric_failures_still_return_rows(self):
        from google.api_core.exceptions import GoogleAPIError

        adapter = _adapter()
        end = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        good_type = "netapp.googleapis.com/volume/bytes_used"

        async def mock_list_time_series(request):
            metric_type = request.filter.split('"')[1]
            if metric_type == GCNV_METRIC_TYPES[0]:
                raise GoogleAPIError("transient")
            if metric_type == good_type:
                return _AsyncIter([
                    _make_time_series(
                        good_type,
                        points=[_make_point(end, int64_value=42)],
                    ),
                ])
            return _AsyncIter([])

        mock_client = MagicMock()
        mock_client.list_time_series = AsyncMock(side_effect=mock_list_time_series)

        with patch("google.cloud.monitoring_v3.MetricServiceAsyncClient", return_value=mock_client):
            rows = await adapter._fetch_volume_metrics(
                "proj",
                end - timedelta(hours=1),
                end,
                "",
                credentials=MagicMock(),
            )

        assert len(rows) == 1
        assert rows[0]["space_used_bytes"] == 42

    @pytest.mark.asyncio
    async def test_region_filter_applied_to_requests(self):
        adapter = _adapter()
        end = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        captured_filters: list[str] = []

        async def mock_list_time_series(request):
            captured_filters.append(request.filter)
            return _AsyncIter([
                _make_time_series(
                    "netapp.googleapis.com/volume/bytes_used",
                    points=[_make_point(end, int64_value=1)],
                ),
            ])

        mock_client = MagicMock()
        mock_client.list_time_series = AsyncMock(side_effect=mock_list_time_series)

        with patch("google.cloud.monitoring_v3.MetricServiceAsyncClient", return_value=mock_client):
            await adapter._fetch_volume_metrics(
                "proj",
                end - timedelta(hours=1),
                end,
                "us-central1",
                credentials=MagicMock(),
            )

        assert captured_filters
        assert all('resource.labels.location = "us-central1"' in f for f in captured_filters)

    @pytest.mark.asyncio
    async def test_skips_time_series_without_volume_label(self):
        adapter = _adapter()
        end = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        orphan = SimpleNamespace(
            resource=SimpleNamespace(type="netapp.googleapis.com/Volume", labels={}),
            metric=SimpleNamespace(labels={"type": "read"}),
            points=[_make_point(end, double_value=99.0)],
        )

        async def mock_list_time_series(request):
            metric_type = request.filter.split('"')[1]
            if metric_type == "netapp.googleapis.com/volume/operation_count":
                return _AsyncIter([orphan])
            return _AsyncIter([])

        mock_client = MagicMock()
        mock_client.list_time_series = AsyncMock(side_effect=mock_list_time_series)

        with patch("google.cloud.monitoring_v3.MetricServiceAsyncClient", return_value=mock_client):
            rows = await adapter._fetch_volume_metrics(
                "proj",
                end - timedelta(hours=1),
                end,
                "",
                credentials=MagicMock(),
            )

        assert rows == []

    @pytest.mark.asyncio
    async def test_latency_read_only_when_write_missing(self):
        adapter = _adapter()
        end = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)

        async def mock_list_time_series(request):
            metric_type = request.filter.split('"')[1]
            if metric_type == "netapp.googleapis.com/volume/average_latency":
                return _AsyncIter([
                    _make_time_series(
                        metric_type,
                        op_type="read",
                        points=[_make_point(end, double_value=3.0)],
                    ),
                ])
            return _AsyncIter([])

        mock_client = MagicMock()
        mock_client.list_time_series = AsyncMock(side_effect=mock_list_time_series)

        with patch("google.cloud.monitoring_v3.MetricServiceAsyncClient", return_value=mock_client):
            rows = await adapter._fetch_volume_metrics(
                "proj",
                end - timedelta(hours=1),
                end,
                "",
                credentials=MagicMock(),
            )

        assert len(rows) == 1
        # 3 ms -> 3000 us, no write side to average
        assert rows[0]["latency_avg_us"] == 3000.0

    @pytest.mark.asyncio
    async def test_preserves_zero_sample_values(self):
        adapter = _adapter()
        end = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)

        async def mock_list_time_series(request):
            metric_type = request.filter.split('"')[1]
            if metric_type == "netapp.googleapis.com/volume/operation_count":
                return _AsyncIter([
                    _make_time_series(
                        metric_type,
                        op_type="read",
                        points=[_make_point(end, double_value=0.0)],
                    ),
                ])
            return _AsyncIter([])

        mock_client = MagicMock()
        mock_client.list_time_series = AsyncMock(side_effect=mock_list_time_series)

        with patch("google.cloud.monitoring_v3.MetricServiceAsyncClient", return_value=mock_client):
            rows = await adapter._fetch_volume_metrics(
                "proj",
                end - timedelta(hours=1),
                end,
                "",
                credentials=MagicMock(),
            )

        assert len(rows) == 1
        assert rows[0]["iops_read"] == 0.0

    @pytest.mark.asyncio
    async def test_metadata_op_types_flatten_into_row(self):
        adapter = _adapter()
        end = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)

        async def mock_list_time_series(request):
            metric_type = request.filter.split('"')[1]
            if metric_type == "netapp.googleapis.com/volume/operation_count":
                return _AsyncIter([
                    _make_time_series(metric_type, op_type="metadata", points=[
                        _make_point(end, double_value=3.0),
                    ]),
                ])
            if metric_type == "netapp.googleapis.com/volume/throughput":
                return _AsyncIter([
                    _make_time_series(metric_type, op_type="metadata", points=[
                        _make_point(end, double_value=400.0),
                    ]),
                ])
            if metric_type == "netapp.googleapis.com/volume/average_latency":
                return _AsyncIter([
                    _make_time_series(metric_type, op_type="metadata", points=[
                        _make_point(end, double_value=1.5),
                    ]),
                ])
            return _AsyncIter([])

        mock_client = MagicMock()
        mock_client.list_time_series = AsyncMock(side_effect=mock_list_time_series)

        with patch("google.cloud.monitoring_v3.MetricServiceAsyncClient", return_value=mock_client):
            rows = await adapter._fetch_volume_metrics(
                "proj",
                end - timedelta(hours=1),
                end,
                "",
                credentials=MagicMock(),
            )

        assert len(rows) == 1
        row = rows[0]
        assert row["iops_other"] == 3.0
        assert row["throughput_other_bytes"] == 400.0
        assert row["latency_other_us"] == 1500.0
        assert row["latency_avg_us"] == 1500.0
        assert row["iops_total"] == 3.0
        assert row["throughput_total_bytes"] == 400.0

    @pytest.mark.asyncio
    async def test_enriches_rows_from_volume_inventory(self):
        adapter = _adapter()
        end = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        inventory = {
            "vol-1": {
                "pool_id": "pool-enriched",
                "service_level": "PREMIUM",
                "volume_name": "enriched-name",
            },
        }

        async def mock_list_time_series(request):
            metric_type = request.filter.split('"')[1]
            if metric_type == "netapp.googleapis.com/volume/bytes_used":
                return _AsyncIter([
                    _make_time_series(
                        metric_type,
                        volume_id="vol-1",
                        volume_name="monitoring-label",
                        points=[_make_point(end, int64_value=99)],
                    ),
                ])
            return _AsyncIter([])

        mock_client = MagicMock()
        mock_client.list_time_series = AsyncMock(side_effect=mock_list_time_series)

        with patch("google.cloud.monitoring_v3.MetricServiceAsyncClient", return_value=mock_client):
            rows = await adapter._fetch_volume_metrics(
                "proj",
                end - timedelta(hours=1),
                end,
                "",
                credentials=MagicMock(),
                volume_inventory=inventory,
            )

        assert len(rows) == 1
        assert rows[0]["pool_id"] == "pool-enriched"
        assert rows[0]["service_level"] == "PREMIUM"
        assert rows[0]["volume_name"] == "enriched-name"


class TestFetchTierMetrics:
    @pytest.mark.asyncio
    async def test_flattens_tier_series_into_rows(self):
        adapter = _adapter()
        end = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        read_type = "netapp.googleapis.com/volume/auto_tiering/cold_tier_read_byte_count"
        footprint_type = "netapp.googleapis.com/volume/auto_tiering/tiered_bytes"

        async def mock_list_time_series(request):
            metric_type = request.filter.split('"')[1]
            if metric_type == read_type:
                return _AsyncIter([
                    _make_tier_time_series(read_type, points=[_make_point(end, int64_value=100)]),
                ])
            if metric_type == footprint_type:
                return _AsyncIter([
                    _make_tier_time_series(
                        footprint_type,
                        tier="non cold",
                        points=[_make_point(end, int64_value=200)],
                    ),
                ])
            return _AsyncIter([])

        mock_client = MagicMock()
        mock_client.list_time_series = AsyncMock(side_effect=mock_list_time_series)

        with patch("google.cloud.monitoring_v3.MetricServiceAsyncClient", return_value=mock_client):
            rows = await adapter._fetch_tier_metrics(
                "proj",
                end - timedelta(hours=1),
                end,
                "us-central1",
                credentials=MagicMock(),
            )

        assert len(rows) == 2
        by_tier = {r["tier_name"]: r for r in rows}
        assert by_tier["cold"]["tier_read_bytes"] == 100
        assert by_tier["hot"]["tier_footprint_bytes"] == 200
        assert all(r["source_type"] == "gcnv" for r in rows)

    @pytest.mark.asyncio
    async def test_raises_when_all_tier_metric_types_fail(self):
        from google.api_core.exceptions import GoogleAPIError

        adapter = _adapter()
        mock_client = MagicMock()
        mock_client.list_time_series = AsyncMock(side_effect=GoogleAPIError("denied"))

        with patch("google.cloud.monitoring_v3.MetricServiceAsyncClient", return_value=mock_client):
            with pytest.raises(RuntimeError, match="All volume tier metric types failed"):
                await adapter._fetch_tier_metrics(
                    "proj",
                    datetime(2026, 6, 1, 0, 0, tzinfo=timezone.utc),
                    datetime(2026, 6, 1, 1, 0, tzinfo=timezone.utc),
                    "",
                    credentials=MagicMock(),
                )

        assert mock_client.list_time_series.await_count == len(GCNV_TIER_METRIC_TYPES)

    @pytest.mark.asyncio
    async def test_returns_empty_when_zero_series_without_errors(self):
        adapter = _adapter()
        mock_client = MagicMock()
        mock_client.list_time_series = AsyncMock(return_value=_AsyncIter([]))

        with patch("google.cloud.monitoring_v3.MetricServiceAsyncClient", return_value=mock_client):
            rows = await adapter._fetch_tier_metrics(
                "proj",
                datetime(2026, 6, 1, 0, 0, tzinfo=timezone.utc),
                datetime(2026, 6, 1, 1, 0, tzinfo=timezone.utc),
                "us-central1",
                credentials=MagicMock(),
            )

        assert rows == []

    @pytest.mark.asyncio
    async def test_region_filter_applied_to_requests(self):
        adapter = _adapter()
        end = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        captured_filters: list[str] = []

        async def mock_list_time_series(request):
            captured_filters.append(request.filter)
            return _AsyncIter([
                _make_tier_time_series(
                    "netapp.googleapis.com/volume/auto_tiering/cold_tier_read_byte_count",
                    points=[_make_point(end, int64_value=1)],
                ),
            ])

        mock_client = MagicMock()
        mock_client.list_time_series = AsyncMock(side_effect=mock_list_time_series)

        with patch("google.cloud.monitoring_v3.MetricServiceAsyncClient", return_value=mock_client):
            await adapter._fetch_tier_metrics(
                "proj",
                end - timedelta(hours=1),
                end,
                "us-central1",
                credentials=MagicMock(),
            )

        assert captured_filters
        assert all('resource.labels.location = "us-central1"' in f for f in captured_filters)


class TestFetchPoolMetrics:
    @pytest.mark.asyncio
    async def test_flattens_pool_series_into_rows(self):
        adapter = _adapter()
        end = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        capacity_type = "netapp.googleapis.com/storage_pool/capacity"
        allocated_type = "netapp.googleapis.com/storage_pool/allocated"

        async def mock_list_time_series(request):
            metric_type = request.filter.split('"')[1]
            if metric_type == capacity_type:
                return _AsyncIter([
                    _make_pool_time_series(capacity_type, points=[_make_point(end, int64_value=1_000)]),
                ])
            if metric_type == allocated_type:
                return _AsyncIter([
                    _make_pool_time_series(allocated_type, points=[_make_point(end, int64_value=800)]),
                ])
            return _AsyncIter([])

        mock_client = MagicMock()
        mock_client.list_time_series = AsyncMock(side_effect=mock_list_time_series)

        with patch("google.cloud.monitoring_v3.MetricServiceAsyncClient", return_value=mock_client):
            rows = await adapter._fetch_pool_metrics(
                "proj",
                end - timedelta(hours=1),
                end,
                "",
                credentials=MagicMock(),
            )

        assert len(rows) == 1
        assert rows[0]["capacity_bytes"] == 1_000
        assert rows[0]["allocated_bytes"] == 800
        assert rows[0]["pool_id"] == "pool-a"

    @pytest.mark.asyncio
    async def test_enriches_rows_from_pool_inventory(self):
        adapter = _adapter()
        end = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        inventory = {
            "pool-a": {"pool_name": "display-pool", "service_level": "FLEX"},
        }

        async def mock_list_time_series(request):
            metric_type = request.filter.split('"')[1]
            if metric_type == "netapp.googleapis.com/storage_pool/capacity":
                return _AsyncIter([
                    _make_pool_time_series(
                        metric_type,
                        pool_id="pool-a",
                        points=[_make_point(end, int64_value=42)],
                    ),
                ])
            return _AsyncIter([])

        mock_client = MagicMock()
        mock_client.list_time_series = AsyncMock(side_effect=mock_list_time_series)

        with patch("google.cloud.monitoring_v3.MetricServiceAsyncClient", return_value=mock_client):
            rows = await adapter._fetch_pool_metrics(
                "proj",
                end - timedelta(hours=1),
                end,
                "",
                credentials=MagicMock(),
                pool_inventory=inventory,
            )

        assert len(rows) == 1
        assert rows[0]["pool_name"] == "display-pool"
        assert rows[0]["service_level"] == "FLEX"

    @pytest.mark.asyncio
    async def test_raises_when_all_pool_metric_types_fail(self):
        from google.api_core.exceptions import GoogleAPIError

        adapter = _adapter()
        mock_client = MagicMock()
        mock_client.list_time_series = AsyncMock(side_effect=GoogleAPIError("denied"))

        with patch("google.cloud.monitoring_v3.MetricServiceAsyncClient", return_value=mock_client):
            with pytest.raises(RuntimeError, match="All pool metric types failed"):
                await adapter._fetch_pool_metrics(
                    "proj",
                    datetime(2026, 6, 1, 0, 0, tzinfo=timezone.utc),
                    datetime(2026, 6, 1, 1, 0, tzinfo=timezone.utc),
                    "",
                    credentials=MagicMock(),
                )

    @pytest.mark.asyncio
    async def test_raises_when_zero_series_without_errors(self):
        adapter = _adapter()
        mock_client = MagicMock()
        mock_client.list_time_series = AsyncMock(return_value=_AsyncIter([]))

        with patch("google.cloud.monitoring_v3.MetricServiceAsyncClient", return_value=mock_client):
            with pytest.raises(RuntimeError, match="0 pool time series"):
                await adapter._fetch_pool_metrics(
                    "empty-project",
                    datetime(2026, 6, 1, 0, 0, tzinfo=timezone.utc),
                    datetime(2026, 6, 1, 1, 0, tzinfo=timezone.utc),
                    "us-central1",
                    credentials=MagicMock(),
                )

        assert mock_client.list_time_series.await_count == len(GCNV_POOL_METRIC_TYPES)

    @pytest.mark.asyncio
    async def test_skips_time_series_without_pool_id(self):
        adapter = _adapter()
        end = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        orphan = SimpleNamespace(
            resource=SimpleNamespace(type="netapp.googleapis.com/StoragePool", labels={}),
            metric=SimpleNamespace(labels={}),
            points=[_make_point(end, int64_value=99)],
        )

        async def mock_list_time_series(request):
            metric_type = request.filter.split('"')[1]
            if metric_type == "netapp.googleapis.com/storage_pool/capacity":
                return _AsyncIter([orphan])
            return _AsyncIter([])

        mock_client = MagicMock()
        mock_client.list_time_series = AsyncMock(side_effect=mock_list_time_series)

        with patch("google.cloud.monitoring_v3.MetricServiceAsyncClient", return_value=mock_client):
            rows = await adapter._fetch_pool_metrics(
                "proj",
                end - timedelta(hours=1),
                end,
                "",
                credentials=MagicMock(),
            )

        # Series is counted before the missing-pool-id skip, so this does not raise.
        assert rows == []


class TestAcquireMultiCategory:
    def test_all_categories_write_three_parquets(self):
        vol_ts = datetime(2026, 6, 1, 12, 0, tzinfo=timezone.utc)
        tier_ts = datetime(2026, 6, 1, 13, 0, tzinfo=timezone.utc)
        pool_ts = datetime(2026, 6, 1, 14, 0, tzinfo=timezone.utc)

        volume_mock = AsyncMock(return_value=[{
            "timestamp": vol_ts,
            "source_type": "gcnv",
            "account_id": "proj",
            "cluster_id": "proj",
            "pool_id": None,
            "volume_id": "v1",
            "volume_name": "v1",
            "svm_name": None,
            "service_level": None,
            "iops_read": 1.0,
            "iops_write": None,
            "iops_other": None,
            "iops_total": 1.0,
            "throughput_read_bytes": None,
            "throughput_write_bytes": None,
            "throughput_other_bytes": None,
            "throughput_total_bytes": None,
            "latency_read_us": None,
            "latency_write_us": None,
            "latency_other_us": None,
            "latency_avg_us": None,
            "space_used_bytes": None,
            "space_total_bytes": None,
            "space_snapshot_bytes": None,
            "space_used_percent": None,
            "inode_used": None,
            "inode_limit": None,
            "inode_used_percent": None,
            "throughput_limit_hit": None,
            "qos_latency_delta_us": None,
            "qos_policy": None,
        }])
        tier_mock = AsyncMock(return_value=[{
            "timestamp": tier_ts,
            "source_type": "gcnv",
            "cluster_id": "proj",
            "volume_id": "v1",
            "tier_name": "cold",
            "tier_read_bytes": 10,
            "tier_write_bytes": None,
            "tier_footprint_bytes": None,
        }])
        pool_mock = AsyncMock(return_value=[{
            "timestamp": pool_ts,
            "source_type": "gcnv",
            "cluster_id": "proj",
            "pool_id": "pool-a",
            "pool_name": "pool-a",
            "service_level": "PREMIUM",
            "capacity_bytes": 1000,
            "allocated_bytes": None,
            "used_bytes": None,
            "tier_cold_bytes": None,
            "tier_read_bytes": None,
            "tier_write_bytes": None,
            "replication_sync_status": None,
        }])
        patches = _patch_acquire_fetches(volume_mock, tier_mock, pool_mock)
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp)
                result = _run(_adapter().acquire(
                    {
                        "project_id": "proj",
                        "resourceSelector": [
                            {"category": "volume_metrics"},
                            {"category": "pool_metrics"},
                            {"category": "volume_tier_metrics"},
                        ],
                    },
                    None,
                    tmp,
                ))

                assert result["rowCount"] == 3
                assert result["volumeMetricsCount"] == 1
                assert result["volumeTierMetricsCount"] == 1
                assert result["poolMetricsCount"] == 1
                assert result["newWatermarkValue"] == pool_ts.isoformat()
                assert (out / "volume_metrics.parquet").is_file()
                assert (out / "pool_metrics.parquet").is_file()
                assert (out / "volume_tier_metrics.parquet").is_file()
                assert pq.read_table(out / "volume_metrics.parquet").schema.equals(VOLUME_METRICS_SCHEMA)
                assert pq.read_table(out / "pool_metrics.parquet").schema.equals(POOL_METRICS_SCHEMA)
                assert pq.read_table(out / "volume_tier_metrics.parquet").schema.equals(VOLUME_TIER_METRICS_SCHEMA)

    def test_pool_metrics_only_skips_volume_fetch_and_inventory(self):
        volume_mock = AsyncMock(return_value=[])
        pool_mock = AsyncMock(return_value=[])
        patches = _patch_acquire_fetches(volume_mock, mock_pool_fetch=pool_mock)
        with patches[0], patches[1], patches[2]:
            with patch("adapters.gcnv_metrics_adapter._fetch_volumes_inventory") as mock_vol_inv:
                with patch("adapters.gcnv_metrics_adapter._fetch_pools_inventory", return_value={}):
                    with tempfile.TemporaryDirectory() as tmp:
                        _run(_adapter().acquire(
                            {
                                "project_id": "proj",
                                "resourceSelector": [{"category": "pool_metrics"}],
                            },
                            None,
                            tmp,
                        ))
                    mock_vol_inv.assert_not_called()
        volume_mock.assert_not_awaited()
        pool_mock.assert_awaited_once()

    def test_tier_metrics_only_fetches_volume_inventory_not_volume_metrics(self):
        volume_mock = AsyncMock(return_value=[])
        tier_mock = AsyncMock(return_value=[])
        patches = _patch_acquire_fetches(volume_mock, mock_tier_fetch=tier_mock)
        with patches[0], patches[1], patches[2]:
            with patch("adapters.gcnv_metrics_adapter._fetch_volumes_inventory", return_value={}) as mock_vol_inv:
                with patch("adapters.gcnv_metrics_adapter._fetch_pools_inventory") as mock_pool_inv:
                    with tempfile.TemporaryDirectory() as tmp:
                        _run(_adapter().acquire(
                            {
                                "project_id": "proj",
                                "resourceSelector": [{"category": "volume_tier_metrics"}],
                            },
                            None,
                            tmp,
                        ))
                    mock_vol_inv.assert_called_once()
                    mock_pool_inv.assert_not_called()
        volume_mock.assert_not_awaited()
        tier_mock.assert_awaited_once()

    def test_watermark_advances_from_tier_when_volume_empty(self):
        tier_ts = datetime(2026, 6, 1, 15, 0, tzinfo=timezone.utc)
        volume_mock = AsyncMock(return_value=[])
        tier_mock = AsyncMock(return_value=[{
            "timestamp": tier_ts,
            "source_type": "gcnv",
            "cluster_id": "proj",
            "volume_id": "v1",
            "tier_name": "cold",
            "tier_read_bytes": 5,
            "tier_write_bytes": None,
            "tier_footprint_bytes": None,
        }])
        patches = _patch_acquire_fetches(volume_mock, tier_mock)
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp)
                result = _run(_adapter().acquire(
                    {
                        "project_id": "proj",
                        "resourceSelector": [{"category": "volume_tier_metrics"}],
                    },
                    "2026-06-01T10:00:00+00:00",
                    tmp,
                ))
                assert result["rowCount"] == 1
                assert result["newWatermarkValue"] == tier_ts.isoformat()
                assert not (out / "volume_metrics.parquet").exists()
                assert (out / "volume_tier_metrics.parquet").is_file()

    def test_empty_volume_fetch_writes_empty_stub_parquet(self):
        volume_mock = AsyncMock(return_value=[])
        patches = _patch_acquire_fetches(volume_mock)
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp)
                result = _run(_adapter().acquire(
                    {
                        "project_id": "proj",
                        "resourceSelector": [{"category": "volume_metrics"}],
                    },
                    None,
                    tmp,
                ))
                assert result["rowCount"] == 0
                table = pq.read_table(out / "volume_metrics.parquet")
                assert table.num_rows == 0
                assert table.schema.equals(VOLUME_METRICS_SCHEMA)

    def test_empty_pool_fetch_writes_empty_stub_parquet(self):
        pool_mock = AsyncMock(return_value=[])
        patches = _patch_acquire_fetches(mock_pool_fetch=pool_mock)
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp)
                result = _run(_adapter().acquire(
                    {
                        "project_id": "proj",
                        "resourceSelector": [{"category": "pool_metrics"}],
                    },
                    None,
                    tmp,
                ))
                assert result["rowCount"] == 0
                table = pq.read_table(out / "pool_metrics.parquet")
                assert table.num_rows == 0
                assert table.schema.equals(POOL_METRICS_SCHEMA)
                assert not (out / "volume_metrics.parquet").exists()

    def test_empty_tier_fetch_writes_empty_stub_parquet(self):
        tier_mock = AsyncMock(return_value=[])
        patches = _patch_acquire_fetches(mock_tier_fetch=tier_mock)
        with patches[0], patches[1], patches[2], patches[3], patches[4]:
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp)
                result = _run(_adapter().acquire(
                    {
                        "project_id": "proj",
                        "resourceSelector": [{"category": "volume_tier_metrics"}],
                    },
                    None,
                    tmp,
                ))
                assert result["rowCount"] == 0
                table = pq.read_table(out / "volume_tier_metrics.parquet")
                assert table.num_rows == 0
                assert table.schema.equals(VOLUME_TIER_METRICS_SCHEMA)
