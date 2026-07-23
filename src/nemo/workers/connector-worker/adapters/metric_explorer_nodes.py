"""Shared metric category explorer nodes.

Both `OntapAdapter` and `GCPAdapter` expose a `listMetricCategories` action that
returns the same static set of category leaves consumed by `AcquireMetrics`.
The `category` strings here are the cross-component contract with
`resourceSelectorLooksLikeMetrics` in workflow-engine — keep them in sync.
"""
from __future__ import annotations

from typing import List

from .base import ExplorerNode

ONTAP_METRIC_CATEGORIES = (
    "volume_metrics",
    "aggregate_metrics",
    "quota_metrics",
)
GCNV_METRIC_CATEGORIES = ("volume_metrics", "pool_metrics", "volume_tier_metrics")
ANF_METRIC_CATEGORIES = ("volume_metrics", "pool_metrics", "volume_tier_metrics")


def _node(category: str, label: str) -> ExplorerNode:
    return ExplorerNode(
        id=f"cat:{category}",
        label=label,
        type="metric_category",
        resource={"category": category},
        children_hint="leaf",
    )


def ontap_metric_category_nodes() -> List[ExplorerNode]:
    return [
        _node("volume_metrics", "Volume Performance Metrics"),
        _node("aggregate_metrics", "Aggregate Performance Metrics"),
        _node("quota_metrics", "Quota Metrics"),
    ]


def gcnv_metric_category_nodes() -> List[ExplorerNode]:
    return [
        _node("volume_metrics", "Volume Performance Metrics"),
        _node("pool_metrics", "Pool Metrics"),
        _node("volume_tier_metrics", "Volume Tier Metrics"),
    ]


def anf_metric_category_nodes() -> List[ExplorerNode]:
    return [
        _node("volume_metrics", "Volume Performance Metrics"),
        _node("pool_metrics", "Pool Metrics"),
        _node("volume_tier_metrics", "Volume Tier Metrics"),
    ]
