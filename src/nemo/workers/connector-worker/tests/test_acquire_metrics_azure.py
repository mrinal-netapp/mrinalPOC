"""Integration-style tests for AcquireMetrics with provider=azure_cloud (mocked Monitor)."""
from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

from tests.fixtures.azure_monitor_responses import (  # noqa: E402
    EMPTY,
    FIXTURE_NETAPP_ACCOUNT,
    FIXTURE_POOL_ARM_ID,
    FIXTURE_POOL_NAME,
    FIXTURE_SUBSCRIPTION_ID,
    FIXTURE_VOLUME_ARM_ID,
    FIXTURE_VOLUME_NAME,
    SINGLE_VOLUME,
)

_FIXTURE_VOLUME_CONTEXT = {
    "subscription_id": FIXTURE_SUBSCRIPTION_ID,
    "resource_group": "rg-anf-dev",
    "netapp_account": FIXTURE_NETAPP_ACCOUNT,
    "pool_name": FIXTURE_POOL_NAME,
    "pool_id": FIXTURE_POOL_ARM_ID,
    "volume_name": FIXTURE_VOLUME_NAME,
    "volume_id": FIXTURE_VOLUME_ARM_ID,
}


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def store_root(tmp_path, monkeypatch):
    monkeypatch.setenv("NEMO_DEFAULT_STORE_ROOT", str(tmp_path))
    return tmp_path


class TestAcquireMetricsAzure:
    @patch(
        "adapters.anf_metrics_adapter._list_anf_volumes",
        return_value=[_FIXTURE_VOLUME_CONTEXT],
    )
    @patch("activities.metrics.activity")
    @patch("activities.credentials.resolve_credential")
    @patch("asyncio.to_thread")
    @patch("adapters.anf_metrics_adapter._build_credential")
    def test_end_to_end_activity(
        self,
        mock_build_cred,
        mock_thread,
        mock_resolve,
        mock_activity,
        _mock_list_volumes,
        store_root,
    ):
        mock_build_cred.return_value = MagicMock()
        mock_resolve.return_value = {
            "tenant_id": "tenant",
            "client_id": "client",
            "client_secret": "secret",
        }
        info = MagicMock()
        info.workflow_run_id = "run-azure-01"
        mock_activity.info.return_value = info
        mock_activity.heartbeat = MagicMock()

        from tests.test_anf_metrics_adapter import _volume_query_thread_result

        mock_thread.side_effect = _volume_query_thread_result

        from activities.metrics import acquire_metrics

        inp = {
            "provider": "azure_cloud",
            "projectID": "proj-1",
            "datasetID": "ds-anf-1",
            "credentialId": "cred-1",
            "configServiceURL": "http://config",
            "watermark": None,
            "resourceSelector": [{"category": "volume_metrics"}],
            "connectionInfo": {
                "subscription_id": FIXTURE_SUBSCRIPTION_ID,
                "default_region": "eastus",
                "provider": "azure_cloud",
            },
        }

        result = _run(acquire_metrics(inp))

        assert result["fileListKey"]
        assert "newWatermarkValue" in result
        assert result["rowCount"] > 0

        filelist_path = store_root / result["fileListKey"]
        assert filelist_path.is_file()
        manifest = json.loads(filelist_path.read_text())
        assert manifest["provider"] == "azure_cloud"
        assert len(manifest["files"]) >= 1
        parquet_key = manifest["files"][0]["key"]
        assert parquet_key.endswith("volume_metrics.parquet")
        assert (store_root / parquet_key).is_file()


class TestAcquireMetricsAzureActivityPaths:
    @patch("activities.metrics.activity")
    @patch("activities.credentials.resolve_credential", return_value=None)
    @patch(
        "adapters.anf_metrics_adapter.AnfMetricsAdapter.acquire",
        new_callable=AsyncMock,
    )
    def test_skips_credential_when_id_missing(
        self, mock_acquire, _mock_resolve, mock_activity, store_root
    ):
        import os

        import pyarrow as pa
        import pyarrow.parquet as pq

        async def _fake_acquire(**kwargs):
            out = kwargs["output_path"]
            os.makedirs(out, exist_ok=True)
            pq.write_table(
                pa.table({"x": [1]}, schema=pa.schema([("x", pa.int64())])),
                os.path.join(out, "volume_metrics.parquet"),
            )
            return {
                "outputPath": out,
                "newWatermarkValue": "",
                "rowCount": 1,
                "volumeMetricsCount": 1,
                "aggregateMetricsCount": 0,
            }

        mock_acquire.side_effect = _fake_acquire
        info = MagicMock()
        info.workflow_run_id = "run-azure-02"
        mock_activity.info.return_value = info
        mock_activity.heartbeat = MagicMock()

        from activities.metrics import acquire_metrics

        inp = {
            "provider": "azure_cloud",
            "projectID": "proj-1",
            "datasetID": "ds-anf-2",
            "credentialId": "",
            "configServiceURL": "http://config",
            "watermark": None,
            "resourceSelector": [{"category": "volume_metrics"}],
            "connectionInfo": {
                "subscription_id": FIXTURE_SUBSCRIPTION_ID,
                "default_region": "eastus",
            },
        }
        result = _run(acquire_metrics(inp))
        assert result["rowCount"] == 1
        _mock_resolve.assert_not_called()

    @patch("activities.metrics.activity")
    @patch("activities.credentials.resolve_credential")
    @patch(
        "adapters.anf_metrics_adapter._list_anf_volumes",
        return_value=[_FIXTURE_VOLUME_CONTEXT],
    )
    @patch("asyncio.to_thread")
    @patch("adapters.anf_metrics_adapter._build_credential")
    def test_ignores_non_parquet_artifacts(
        self, mock_build_cred, mock_thread, _mock_list, mock_resolve, mock_activity, store_root
    ):
        mock_build_cred.return_value = MagicMock()
        mock_resolve.return_value = {
            "tenant_id": "tenant",
            "client_id": "client",
            "client_secret": "secret",
        }
        info = MagicMock()
        info.workflow_run_id = "run-azure-03"
        mock_activity.info.return_value = info
        mock_activity.heartbeat = MagicMock()

        from tests.test_anf_metrics_adapter import _volume_query_thread_result

        mock_thread.side_effect = _volume_query_thread_result

        from activities.metrics import acquire_metrics

        inp = {
            "provider": "azure_cloud",
            "projectID": "proj-1",
            "datasetID": "ds-anf-3",
            "credentialId": "cred-1",
            "configServiceURL": "http://config",
            "watermark": None,
            "resourceSelector": [{"category": "volume_metrics"}],
            "connectionInfo": {
                "subscription_id": FIXTURE_SUBSCRIPTION_ID,
                "default_region": "eastus",
            },
        }
        result = _run(acquire_metrics(inp))
        assert result["filesCopied"] == 1.0
        manifest = json.loads((store_root / result["fileListKey"]).read_text())
        assert len(manifest["files"]) == 1
