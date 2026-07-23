"""Unit tests for Azure cloud adapter (ANF metrics explorer)."""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

_WORKER_ROOT = Path(__file__).resolve().parents[1]
if str(_WORKER_ROOT) not in sys.path:
    sys.path.insert(0, str(_WORKER_ROOT))

from adapters.azure_adapter import AzureAdapter  # noqa: E402


class TestAzureAdapter:
    def setup_method(self):
        self.adapter = AzureAdapter()

    def test_list_metric_categories_dispatch(self):
        resp = self.adapter.execute(
            {"subscription_id": "sub"},
            {},
            "listMetricCategories",
            {},
        )
        assert resp.error is None
        assert len(resp.nodes) == 3
        categories = {node.resource["category"] for node in resp.nodes}
        assert categories == {
            "volume_metrics",
            "pool_metrics",
            "volume_tier_metrics",
        }

    @patch("adapters.azure_adapter._anf_metrics.execute")
    def test_test_connection_delegates(self, mock_exec):
        from adapters.base import ExplorerNode, ExplorerResponse

        mock_exec.return_value = ExplorerResponse(
            nodes=[ExplorerNode(id="sub", label="sub", type="subscription")]
        )
        resp = self.adapter.execute(
            {"subscription_id": "sub"},
            {"tenant_id": "t", "client_id": "c", "client_secret": "s"},
            "testConnection",
            {},
        )
        mock_exec.assert_called_once()
        assert resp.nodes[0].type == "subscription"

    def test_list_services_minimal(self):
        resp = self.adapter.execute({}, {}, "listServices", {})
        assert len(resp.nodes) == 1
        assert resp.nodes[0].label == "Performance Metrics"

    def test_unsupported_action(self):
        resp = self.adapter.execute({}, {}, "listVolumes", {})
        assert resp.error is not None
        assert resp.error.code == "UNSUPPORTED_ACTION"
