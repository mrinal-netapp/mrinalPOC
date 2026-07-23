"""Azure cloud provider adapter for explorer actions (ANF metrics v1).

Supports testConnection, listMetricCategories, and a minimal listServices tree
for metrics discovery. Volume browse is out of scope for this story.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List

from .anf_metrics_adapter import AnfMetricsAdapter
from .base import ExplorerError, ExplorerNode, ExplorerResponse, ProviderAdapter
from .metric_explorer_nodes import anf_metric_category_nodes

logger = logging.getLogger(__name__)

_anf_metrics = AnfMetricsAdapter()


class AzureAdapter(ProviderAdapter):
    """Account-scope adapter for Azure NetApp Files metrics."""

    def execute(
        self,
        connector_config: Dict[str, Any],
        credential: Dict[str, str],
        action: str,
        payload: Dict[str, Any],
    ) -> ExplorerResponse:
        if action == "testConnection":
            return _anf_metrics.execute(connector_config, credential, action, payload)
        if action == "listMetricCategories":
            return ExplorerResponse(nodes=anf_metric_category_nodes())
        if action == "listServices":
            return self._list_services()
        return ExplorerResponse(
            error=ExplorerError(
                code="UNSUPPORTED_ACTION",
                message=f"Action '{action}' not supported by Azure adapter",
            )
        )

    def _list_services(self) -> ExplorerResponse:
        nodes: List[ExplorerNode] = [
            ExplorerNode(
                id="azure:svc/metrics",
                label="Performance Metrics",
                type="service",
                kind="metrics",
                children_hint="hasChildren",
                resource={"service": "metrics"},
                actions=["listMetricCategories"],
            ),
        ]
        return ExplorerResponse(nodes=nodes)
