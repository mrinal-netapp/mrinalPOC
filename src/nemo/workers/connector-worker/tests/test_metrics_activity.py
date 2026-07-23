"""Unit tests for the AcquireMetrics activity dispatch + validation.

The activity itself is fully wired into temporal in production; here we
exercise the pure-Python preconditions (provider whitelist + selector
validation) that fail before any adapter call. These guard against a
mis-routed workflow silently returning empty results.

Also covers:
  - cluster_url → host stripping (the key FSxN code path)
  - resourceSelector / verify_tls forwarding to the adapter
  - successful dispatch to OntapMetricsAdapter.acquire()
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
import pyarrow as pa

import pyarrow.parquet as pq
import pytest

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

pytest.importorskip("temporalio")

from activities.metrics import (  # noqa: E402
    _extract_metric_categories,
    _VALID_METRIC_CATEGORIES,
    acquire_metrics,
)


class TestExtractMetricCategories:
    def test_pulls_categories_from_selector(self):
        selector = [{"category": "volume_metrics"}, {"category": "aggregate_metrics"}]
        assert _extract_metric_categories(selector) == {"volume_metrics", "aggregate_metrics"}

    def test_ignores_non_dict_entries(self):
        selector = [{"category": "volume_metrics"}, "garbage", 42]
        assert _extract_metric_categories(selector) == {"volume_metrics"}

    def test_ignores_non_string_categories(self):
        selector = [{"category": ""}, {"category": None}, {"category": "volume_metrics"}]
        assert _extract_metric_categories(selector) == {"volume_metrics"}

    def test_empty_for_non_list(self):
        assert _extract_metric_categories(None) == set()
        assert _extract_metric_categories({"category": "volume_metrics"}) == set()

    def test_handles_objectstore_shape(self):
        selector = [{"bucket": "b", "prefix": "p"}]
        assert _extract_metric_categories(selector) == set()


class TestValidMetricCategoriesContract:
    """The set of valid categories is the cross-component contract with the
    workflow-engine routing helper. If you add a category here you must
    also add it to `metric_explorer_nodes.py` and update the workflow-engine
    `resourceSelectorLooksLikeMetrics` test fixtures.
    """

    def test_ontap_categories(self):
        assert _VALID_METRIC_CATEGORIES["ontap"] == {
            "volume_metrics",
            "aggregate_metrics",
            "quota_metrics",
            "quota_reports",
        }

    def test_gcp_categories(self):
        assert _VALID_METRIC_CATEGORIES["gcp"] == {
            "volume_metrics",
            "pool_metrics",
            "volume_tier_metrics",
        }

    def test_azure_cloud_categories(self):
        assert _VALID_METRIC_CATEGORIES["azure_cloud"] == {
            "volume_metrics",
            "pool_metrics",
            "volume_tier_metrics",
        }


def _run(coro):
    return asyncio.run(coro)

def _call_acquire_metrics(input_body: dict):
    target = getattr(acquire_metrics, "__wrapped__", acquire_metrics)
    return _run(target(input_body))


class TestAcquireMetricsValidation:
    """AcquireMetrics fails closed when the workflow-engine routing has
    already happened but the dataset's selector is malformed for whatever
    reason. These should never reach the adapter.
    """

    def test_missing_provider_raises(self):
        with pytest.raises(ValueError, match="provider is required"):
            _run(acquire_metrics({"resourceSelector": [{"category": "volume_metrics"}]}))

    def test_unsupported_provider_raises(self):
        with pytest.raises(ValueError, match="unsupported provider"):
            _run(acquire_metrics({
                "provider": "ontap_metrics",  # legacy ID — must be rejected
                "resourceSelector": [{"category": "volume_metrics"}],
            }))

    def test_empty_selector_raises(self):
        with pytest.raises(ValueError, match="resourceSelector must contain"):
            _run(acquire_metrics({
                "provider": "ontap",
                "resourceSelector": [],
            }))

    def test_selector_without_categories_raises(self):
        with pytest.raises(ValueError, match="resourceSelector must contain"):
            _run(acquire_metrics({
                "provider": "ontap",
                "resourceSelector": [{"bucket": "b", "prefix": "p"}],
            }))

    def test_invalid_category_for_provider_raises(self):
        with pytest.raises(ValueError, match="does not support metric categories"):
            _run(acquire_metrics({
                "provider": "gcp",
                "resourceSelector": [{"category": "quota_metrics"}],
            }))

    def test_legacy_quota_reports_alias_normalizes(self):
        from adapters.metric_table_schemas import normalize_metric_categories
        assert normalize_metric_categories({"quota_reports"}) == {"quota_metrics"}

    def test_pool_metrics_is_collected_for_gcp(self):
        from adapters.metric_table_schemas import COLLECTOR_METRIC_CATEGORIES
        assert "pool_metrics" in COLLECTOR_METRIC_CATEGORIES["gcp"]
        assert "volume_tier_metrics" in COLLECTOR_METRIC_CATEGORIES["gcp"]

    def test_pool_and_tier_metrics_collected_for_azure_cloud(self):
        from adapters.metric_table_schemas import COLLECTOR_METRIC_CATEGORIES
        assert COLLECTOR_METRIC_CATEGORIES["azure_cloud"] == {
            "volume_metrics",
            "pool_metrics",
            "volume_tier_metrics",
        }

    def test_pool_metrics_invalid_for_ontap_raises(self):
        with pytest.raises(ValueError, match="does not support metric categories"):
            _run(acquire_metrics({
                "provider": "ontap",
                "resourceSelector": [{"category": "pool_metrics"}],
            }))

    def test_azure_cloud_valid_category_passes_category_gate(self):
        """volume_metrics is allowed for azure_cloud before adapter dispatch."""
        cats = _extract_metric_categories([{"category": "volume_metrics"}])
        invalid = cats - _VALID_METRIC_CATEGORIES["azure_cloud"]
        assert not invalid

    def test_azure_cloud_invalid_category_raises(self):
        with pytest.raises(ValueError, match="does not support metric categories"):
            _run(acquire_metrics({
                "provider": "azure_cloud",
                "resourceSelector": [{"category": "aggregate_metrics"}],
            }))
    def test_legacy_gcnv_metrics_provider_rejected(self):
        with pytest.raises(ValueError, match="unsupported provider"):
            _run(acquire_metrics({
                "provider": "gcnv_metrics",
                "resourceSelector": [{"category": "volume_metrics"}],
            }))

    def test_gcp_rejects_aggregate_metrics_category(self):
        with pytest.raises(ValueError, match="does not support metric categories"):
            _run(acquire_metrics({
                "provider": "gcp",
                "resourceSelector": [{"category": "aggregate_metrics"}],
            }))


class TestAcquireMetricsGcpHappyPath:
    """End-to-end activity path for GCNV."""

    @pytest.fixture
    def store_root(self, monkeypatch):
        with tempfile.TemporaryDirectory() as tmp:
            monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", tmp)
            yield Path(tmp)

    @pytest.fixture
    def temporal_run_id(self, monkeypatch):
        monkeypatch.setattr(
            "activities.metrics.activity.info",
            lambda: SimpleNamespace(workflow_run_id="run12345678"),
        )
        monkeypatch.setattr("activities.metrics.activity.heartbeat", lambda *_a, **_k: None)

    def test_stores_parquet_and_metrics_filelist(self, store_root, temporal_run_id):
        schema = pa.schema([
            ("timestamp", pa.timestamp("us", tz="UTC")),
            ("source_type", pa.string()),
            ("volume_id", pa.string()),
        ])
        empty = pa.table({f.name: pa.array([], type=f.type) for f in schema}, schema=schema)

        async def fake_acquire(connection_info, watermark, output_path, heartbeat=None):
            os.makedirs(output_path, exist_ok=True)
            pq.write_table(empty, os.path.join(output_path, "volume_metrics.parquet"))
            return {
                "outputPath": output_path,
                "newWatermarkValue": "2026-06-01T12:00:00+00:00",
                "rowCount": 3,
                "volumeMetricsCount": 3,
                "aggregateMetricsCount": 0,
            }

        mock_instance = MagicMock()
        mock_instance.acquire = AsyncMock(side_effect=fake_acquire)

        with patch("adapters.gcnv_metrics_adapter.GcnvMetricsAdapter", return_value=mock_instance):
            result = _call_acquire_metrics({
                "provider": "gcp",
                "projectID": "proj-1",
                "datasetID": "ds-metrics",
                "resourceSelector": [{"category": "volume_metrics"}],
                "connectionInfo": {"project_id": "gcp-proj", "provider": "gcp"},
            })

        assert result["rowCount"] == 3
        assert result["newWatermarkValue"] == "2026-06-01T12:00:00+00:00"
        assert result["filesCopied"] == 1.0
        fl_path = store_root / result["fileListKey"]
        assert fl_path.is_file()
        manifest = json.loads(fl_path.read_text())
        assert manifest["source"] == "metrics"
        assert manifest["provider"] == "gcp"
        assert manifest["totalFiles"] == 1
        assert manifest["files"][0]["format"] == "parquet"
        stored_key = manifest["files"][0]["key"]
        assert stored_key.startswith("projects/proj-1/datasets/ds-metrics/data/run12345/")
        assert (store_root / stored_key).is_file()

        mock_instance.acquire.assert_awaited_once()
        call_kw = mock_instance.acquire.await_args.kwargs
        assert call_kw["connection_info"]["project_id"] == "gcp-proj"
        assert call_kw["connection_info"]["resourceSelector"] == [{"category": "volume_metrics"}]

    def test_passes_watermark_to_adapter(self, store_root, temporal_run_id):
        captured: dict = {}

        async def fake_acquire(connection_info, watermark, output_path, heartbeat=None):
            captured["watermark"] = watermark
            os.makedirs(output_path, exist_ok=True)
            return {
                "outputPath": output_path,
                "newWatermarkValue": watermark or "",
                "rowCount": 0,
                "volumeMetricsCount": 0,
                "aggregateMetricsCount": 0,
            }

        mock_instance = MagicMock()
        mock_instance.acquire = AsyncMock(side_effect=fake_acquire)

        with patch("adapters.gcnv_metrics_adapter.GcnvMetricsAdapter", return_value=mock_instance):
            _call_acquire_metrics({
                "provider": "gcp",
                "projectID": "proj-1",
                "datasetID": "ds-metrics",
                "watermark": "2026-05-15T08:00:00+00:00",
                "resourceSelector": [{"category": "volume_metrics"}],
                "connectionInfo": {"project_id": "gcp-proj"},
            })

        assert captured["watermark"] == "2026-05-15T08:00:00+00:00"

    def test_stores_all_three_gcnv_parquet_categories(self, store_root, temporal_run_id):
        from adapters.metric_table_schemas import (
            POOL_METRICS_SCHEMA,
            VOLUME_METRICS_SCHEMA,
            VOLUME_TIER_METRICS_SCHEMA,
        )

        async def fake_acquire(connection_info, watermark, output_path, heartbeat=None):
            os.makedirs(output_path, exist_ok=True)
            for filename, schema in (
                ("volume_metrics.parquet", VOLUME_METRICS_SCHEMA),
                ("pool_metrics.parquet", POOL_METRICS_SCHEMA),
                ("volume_tier_metrics.parquet", VOLUME_TIER_METRICS_SCHEMA),
            ):
                empty = pa.table(
                    {f.name: pa.array([], type=f.type) for f in schema},
                    schema=schema,
                )
                pq.write_table(empty, os.path.join(output_path, filename))
            return {
                "outputPath": output_path,
                "newWatermarkValue": "2026-06-01T14:00:00+00:00",
                "rowCount": 6,
                "volumeMetricsCount": 2,
                "volumeTierMetricsCount": 2,
                "poolMetricsCount": 2,
                "aggregateMetricsCount": 0,
            }

        mock_instance = MagicMock()
        mock_instance.acquire = AsyncMock(side_effect=fake_acquire)

        with patch("adapters.gcnv_metrics_adapter.GcnvMetricsAdapter", return_value=mock_instance):
            result = _call_acquire_metrics({
                "provider": "gcp",
                "projectID": "proj-1",
                "datasetID": "ds-metrics",
                "resourceSelector": [
                    {"category": "volume_metrics"},
                    {"category": "pool_metrics"},
                    {"category": "volume_tier_metrics"},
                ],
                "connectionInfo": {"project_id": "gcp-proj", "provider": "gcp"},
            })

        assert result["rowCount"] == 6
        assert result["filesCopied"] == 3.0
        manifest = json.loads((store_root / result["fileListKey"]).read_text())
        assert manifest["totalFiles"] == 3
        stored_names = sorted(f["key"].rsplit("/", 1)[-1] for f in manifest["files"])
        assert stored_names == [
            "pool_metrics.parquet",
            "volume_metrics.parquet",
            "volume_tier_metrics.parquet",
        ]
        for entry in manifest["files"]:
            assert (store_root / entry["key"]).is_file()

        call_kw = mock_instance.acquire.await_args.kwargs
        assert sorted(
            r["category"] for r in call_kw["connection_info"]["resourceSelector"]
        ) == ["pool_metrics", "volume_metrics", "volume_tier_metrics"]



# ---------------------------------------------------------------------------
# Helpers shared by the dispatch tests below
# ---------------------------------------------------------------------------

def _minimal_acquire_result() -> dict:
    return {
        "outputPath": "/tmp/metrics-out",
        "newWatermarkValue": "2026-06-01T00:00:00+00:00",
        "rowCount": 0,
        "volumeMetricsCount": 0,
        "aggregateMetricsCount": 0,
    }


def _activity_mock(run_id: str = "testrun1") -> MagicMock:
    m = MagicMock()
    m.info.return_value.workflow_run_id = run_id
    m.heartbeat = MagicMock()
    return m


class TestClusterUrlToHostMapping:
    """The cluster_url → host stripping is the critical FSxN entry point.

    FSxN cluster management IPs are registered as cluster_url (e.g.
    ``https://198.19.0.1``). The activity must strip the scheme before passing
    ``host`` to OntapMetricsAdapter.acquire() because the adapter builds
    ``https://{host}/api`` itself.
    """

    def _run_and_capture(self, connection_info: dict, resource_selector=None, monkeypatch=None, tmp_path=None):
        """Run acquire_metrics and return the connection_info that reached the adapter."""
        if monkeypatch:
            monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))

        captured = {}

        with patch("adapters.ontap_metrics_adapter.OntapMetricsAdapter") as MockOntap, \
             patch("adapters.gcnv_metrics_adapter.GcnvMetricsAdapter"), \
             patch("activities.metrics.activity", _activity_mock()), \
             patch("activities.metrics.log_activity_start"), \
             patch("activities.metrics.log_activity_result"), \
             patch("activities.metrics.acquisition_artifact_key_prefix", return_value="p/proj/ds/ds1"):

            instance = MockOntap.return_value

            async def _capture_acquire(connection_info, **kwargs):
                captured["connection_info"] = connection_info
                return _minimal_acquire_result()

            instance.acquire = _capture_acquire

            _run(acquire_metrics({
                "provider": "ontap",
                "connectionInfo": connection_info,
                "resourceSelector": resource_selector or [{"category": "volume_metrics"}],
                "projectID": "proj",
                "datasetID": "ds1",
            }))

        return captured.get("connection_info", {})

    def test_https_scheme_stripped(self, monkeypatch, tmp_path):
        """https:// is removed; adapter receives bare IP as host."""
        ci = self._run_and_capture(
            {"cluster_url": "https://198.19.0.1", "verify_tls": False},
            monkeypatch=monkeypatch, tmp_path=tmp_path,
        )
        assert ci["host"] == "198.19.0.1"

    def test_http_scheme_stripped(self, monkeypatch, tmp_path):
        """http:// is removed correctly (e.g. lab clusters without TLS)."""
        ci = self._run_and_capture(
            {"cluster_url": "http://10.0.0.5", "verify_tls": False},
            monkeypatch=monkeypatch, tmp_path=tmp_path,
        )
        assert ci["host"] == "10.0.0.5"

    def test_no_scheme_passthrough(self, monkeypatch, tmp_path):
        """cluster_url without a scheme passes through unchanged as host."""
        ci = self._run_and_capture(
            {"cluster_url": "198.19.0.1"},
            monkeypatch=monkeypatch, tmp_path=tmp_path,
        )
        assert ci["host"] == "198.19.0.1"

    def test_host_already_set_is_not_overwritten(self, monkeypatch, tmp_path):
        """When host is already present, cluster_url is ignored entirely."""
        ci = self._run_and_capture(
            {"cluster_url": "https://should-be-ignored.example.com", "host": "198.19.0.1"},
            monkeypatch=monkeypatch, tmp_path=tmp_path,
        )
        assert ci["host"] == "198.19.0.1"

    def test_verify_tls_false_forwarded_to_adapter(self, monkeypatch, tmp_path):
        """verify_tls=False (typical for FSxN self-signed certs) reaches the adapter."""
        ci = self._run_and_capture(
            {"cluster_url": "https://198.19.0.1", "verify_tls": False},
            monkeypatch=monkeypatch, tmp_path=tmp_path,
        )
        assert ci.get("verify_tls") is False

    def test_resource_selector_injected_into_connection_info(self, monkeypatch, tmp_path):
        """resourceSelector is normalized and passed sorted to the adapter."""
        selector = [{"category": "volume_metrics"}, {"category": "aggregate_metrics"}]
        ci = self._run_and_capture(
            {"cluster_url": "https://198.19.0.1"},
            resource_selector=selector,
            monkeypatch=monkeypatch, tmp_path=tmp_path,
        )
        assert ci.get("resourceSelector") == [
            {"category": "aggregate_metrics"},
            {"category": "volume_metrics"},
        ]


class TestAcquireMetricsDispatch:
    """Verify the shape of the value returned by a successful dispatch."""

    def test_successful_dispatch_returns_expected_keys(self, monkeypatch, tmp_path):
        monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))

        with patch("adapters.ontap_metrics_adapter.OntapMetricsAdapter") as MockOntap, \
             patch("adapters.gcnv_metrics_adapter.GcnvMetricsAdapter"), \
             patch("activities.metrics.activity", _activity_mock()), \
             patch("activities.metrics.log_activity_start"), \
             patch("activities.metrics.log_activity_result"), \
             patch("activities.metrics.acquisition_artifact_key_prefix", return_value="p/proj/ds/ds1"):

            instance = MockOntap.return_value
            instance.acquire = AsyncMock(return_value=_minimal_acquire_result())

            result = _run(acquire_metrics({
                "provider": "ontap",
                "connectionInfo": {"cluster_url": "https://198.19.0.1"},
                "resourceSelector": [{"category": "volume_metrics"}],
                "projectID": "proj",
                "datasetID": "ds1",
            }))

        assert "rowCount" in result
        assert "fileListKey" in result
        assert "newWatermarkValue" in result
        assert result["rowCount"] == 0


# ---------------------------------------------------------------------------
# Helper: a mock acquire() that writes real Parquet files to output_path
# so the file-move block in acquire_metrics is actually exercised.
# ---------------------------------------------------------------------------

def _make_parquet_writing_acquire(extra_files=None):
    """Return an async acquire() that writes Parquet (and optional extra) files.

    extra_files: list of filenames to create alongside the Parquet files,
    e.g. ['debug.json'] — used to verify non-parquet files are ignored.
    """
    async def _acquire(connection_info, watermark=None, output_path=None, heartbeat=None):
        os.makedirs(output_path, exist_ok=True)
        tbl = pa.table({"x": pa.array([1, 2, 3], type=pa.int64())})
        pq.write_table(tbl, os.path.join(output_path, "volume_metrics.parquet"))
        pq.write_table(tbl, os.path.join(output_path, "aggregate_metrics.parquet"))
        if extra_files:
            for fname in extra_files:
                open(os.path.join(output_path, fname), "w").close()
        return {
            "outputPath": output_path,
            "newWatermarkValue": "2026-06-01T00:00:00+00:00",
            "rowCount": 6,
            "volumeMetricsCount": 3,
            "aggregateMetricsCount": 3,
        }
    return _acquire


def _run_with_real_parquet(monkeypatch, tmp_path, extra_files=None):
    """Run acquire_metrics end-to-end with a Parquet-writing adapter mock."""
    monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))

    with patch("adapters.ontap_metrics_adapter.OntapMetricsAdapter") as MockOntap, \
         patch("adapters.gcnv_metrics_adapter.GcnvMetricsAdapter"), \
         patch("activities.metrics.activity", _activity_mock("testrun1x")), \
         patch("activities.metrics.log_activity_start"), \
         patch("activities.metrics.log_activity_result"), \
         patch("activities.metrics.acquisition_artifact_key_prefix",
               return_value="projects/proj/datasets/ds1"):

        MockOntap.return_value.acquire = _make_parquet_writing_acquire(extra_files)

        result = _run(acquire_metrics({
            "provider": "ontap",
            "connectionInfo": {"cluster_url": "https://198.19.0.1"},
            "resourceSelector": [{"category": "volume_metrics"}],
            "projectID": "proj",
            "datasetID": "ds1",
        }))

    return result


class TestParquetFileStorage:
    """Covers lines 186-200 of activities/metrics.py — the block that moves
    Parquet files from the temp output dir into NEMO_DEFAULT_STORE_ROOT and
    records each file's key, size, and format in the filelist manifest.
    """

    def test_parquet_files_moved_to_posix_store(self, monkeypatch, tmp_path):
        """Both Parquet files produced by the adapter are moved to
        NEMO_DEFAULT_STORE_ROOT and filesCopied reflects the count."""
        result = _run_with_real_parquet(monkeypatch, tmp_path)

        assert result["filesCopied"] == 2.0

        # Verify files actually landed under NEMO_DEFAULT_STORE_ROOT
        stored = list(tmp_path.rglob("*.parquet"))
        assert len(stored) == 2
        names = {f.name for f in stored}
        assert names == {"volume_metrics.parquet", "aggregate_metrics.parquet"}

    def test_non_parquet_files_in_output_dir_are_ignored(self, monkeypatch, tmp_path):
        """A non-Parquet file placed in the output dir (e.g. a debug JSON) must
        not be moved and must not count toward filesCopied."""
        result = _run_with_real_parquet(monkeypatch, tmp_path,
                                        extra_files=["debug.json"])

        assert result["filesCopied"] == 2.0, (
            "Only .parquet files should be counted; debug.json must be ignored"
        )
        moved_json = list(tmp_path.rglob("debug.json"))
        assert moved_json == [], "Non-parquet file must not be moved to the store"

    def test_filelist_json_records_key_size_and_format(self, monkeypatch, tmp_path):
        """The filelist.json written by acquire_metrics must contain one entry
        per Parquet file with the correct key path, a positive size, and
        format='parquet'."""
        _run_with_real_parquet(monkeypatch, tmp_path)

        # filelist lives at: NEMO_DEFAULT_STORE_ROOT / artifact_prefix / _acquisition/filelist.json
        filelist_path = (
            tmp_path / "projects" / "proj" / "datasets" / "ds1"
            / "_acquisition" / "filelist.json"
        )
        assert filelist_path.exists(), f"filelist.json not found at {filelist_path}"

        manifest = json.loads(filelist_path.read_text())
        assert manifest["totalFiles"] == 2
        assert manifest["source"] == "metrics"
        assert manifest["provider"] == "ontap"

        for entry in manifest["files"]:
            assert "key" in entry and entry["key"].endswith(".parquet")
            assert entry["size"] > 0, "Stored Parquet file must have non-zero size"
            assert entry["format"] == "parquet"
