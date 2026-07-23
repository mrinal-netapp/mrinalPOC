"""Iceberg-target Parquet schemas for metrics tables.

Shared column layouts for metrics Parquet files and helpers used by the
ONTAP, GCNV, and ANF (azure_cloud) metrics adapters.
"""
from __future__ import annotations

import logging
import os
from datetime import datetime
from typing import Any, Dict, Optional, Set

import pyarrow as pa
import pyarrow.parquet as pq

logger = logging.getLogger(__name__)

VOLUME_METRICS_SCHEMA = pa.schema([
    ("timestamp", pa.timestamp("us", tz="UTC")),
    ("source_type", pa.string()),
    ("account_id", pa.string()),
    ("cluster_id", pa.string()),
    ("pool_id", pa.string()),
    ("volume_id", pa.string()),
    ("volume_name", pa.string()),
    ("svm_name", pa.string()),
    ("service_level", pa.string()),
    ("iops_read", pa.float64()),
    ("iops_write", pa.float64()),
    ("iops_other", pa.float64()),
    ("iops_total", pa.float64()),
    ("throughput_read_bytes", pa.float64()),
    ("throughput_write_bytes", pa.float64()),
    ("throughput_other_bytes", pa.float64()),
    ("throughput_total_bytes", pa.float64()),
    ("latency_read_us", pa.float64()),
    ("latency_write_us", pa.float64()),
    ("latency_other_us", pa.float64()),
    ("latency_avg_us", pa.float64()),
    ("space_used_bytes", pa.int64()),
    ("space_total_bytes", pa.int64()),
    ("space_snapshot_bytes", pa.int64()),
    ("space_used_percent", pa.float64()),
    ("inode_used", pa.int64()),
    ("inode_limit", pa.int64()),
    ("inode_used_percent", pa.float64()),
    ("throughput_limit_hit", pa.int8()),
    ("qos_latency_delta_us", pa.float64()),
    ("qos_policy", pa.string()),
])

VOLUME_METRICS_FIELD_NAMES = [field.name for field in VOLUME_METRICS_SCHEMA]

VOLUME_TIER_METRICS_SCHEMA = pa.schema([
    ("timestamp", pa.timestamp("us", tz="UTC")),
    ("source_type", pa.string()),
    ("cluster_id", pa.string()),
    ("volume_id", pa.string()),
    ("tier_name", pa.string()),
    ("tier_read_bytes", pa.int64()),
    ("tier_write_bytes", pa.int64()),
    ("tier_footprint_bytes", pa.int64()),
])

QUOTA_METRICS_SCHEMA = pa.schema([
    ("timestamp", pa.timestamp("us", tz="UTC")),
    ("source_type", pa.string()),
    ("cluster_id", pa.string()),
    ("volume_id", pa.string()),
    ("volume_name", pa.string()),
    ("quota_used_bytes", pa.int64()),
    ("quota_limit_bytes", pa.int64()),
])

POOL_METRICS_SCHEMA = pa.schema([
    ("timestamp", pa.timestamp("us", tz="UTC")),
    ("source_type", pa.string()),
    ("cluster_id", pa.string()),
    ("pool_id", pa.string()),
    ("pool_name", pa.string()),
    ("service_level", pa.string()),
    ("capacity_bytes", pa.int64()),
    ("allocated_bytes", pa.int64()),
    ("used_bytes", pa.int64()),
    ("tier_cold_bytes", pa.int64()),
    ("tier_read_bytes", pa.int64()),
    ("tier_write_bytes", pa.int64()),
    ("replication_sync_status", pa.int8()),
])

SCHEMA_BY_CATEGORY: Dict[str, pa.Schema] = {
    "pool_metrics": POOL_METRICS_SCHEMA,
    "volume_tier_metrics": VOLUME_TIER_METRICS_SCHEMA,
    "volume_metrics": VOLUME_METRICS_SCHEMA,
    "quota_metrics": QUOTA_METRICS_SCHEMA,
}

PARQUET_FILENAME_BY_CATEGORY: Dict[str, str] = {
    "volume_metrics": "volume_metrics.parquet",
    "aggregate_metrics": "aggregate_metrics.parquet",
    "pool_metrics": "pool_metrics.parquet",
    "volume_tier_metrics": "volume_tier_metrics.parquet",
    "quota_metrics": "quota_metrics.parquet",
}

# Legacy explorer/dataset alias → canonical category.
METRIC_CATEGORY_ALIASES: Dict[str, str] = {
    "quota_reports": "quota_metrics",
}

# Categories exposed in explorer + accepted in resourceSelector validation.
SUPPORTED_METRIC_CATEGORIES: Dict[str, Set[str]] = {
    "ontap": {"volume_metrics", "aggregate_metrics", "quota_metrics"},
    "gcp": {"volume_metrics", "pool_metrics", "volume_tier_metrics"},
    "azure_cloud": {"volume_metrics", "pool_metrics", "volume_tier_metrics"},
}

# Categories with live collectors in the metrics adapters today (subset of supported).
COLLECTOR_METRIC_CATEGORIES: Dict[str, Set[str]] = {
    "ontap": {"volume_metrics", "aggregate_metrics", "quota_metrics"},
    "gcp": {"volume_metrics", "pool_metrics", "volume_tier_metrics"},
    "azure_cloud": {"volume_metrics", "pool_metrics", "volume_tier_metrics"},
}


def valid_metric_categories(provider: str) -> Set[str]:
    cats = SUPPORTED_METRIC_CATEGORIES.get(provider, set())
    return cats | {alias for alias, canonical in METRIC_CATEGORY_ALIASES.items() if canonical in cats}


def normalize_metric_categories(selected: Set[str]) -> Set[str]:
    """Map legacy category names (e.g. quota_reports) to canonical table names."""
    out: Set[str] = set()
    for cat in selected:
        out.add(METRIC_CATEGORY_ALIASES.get(cat, cat))
    return out


def build_quota_metrics_rows(
    quota_by_volume: Dict[str, Dict[str, Any]],
    cluster_id: str,
    snapshot_time: datetime,
) -> list:
    """Build quota_metrics rows from ONTAP /storage/quota/reports payload."""
    rows = []
    for volume_name, info in quota_by_volume.items():
        rows.append({
            "timestamp": snapshot_time,
            "source_type": "ontap",
            "cluster_id": cluster_id,
            "volume_id": info.get("volume_id") or "",
            "volume_name": volume_name,
            "quota_used_bytes": int(info.get("used") or 0),
            "quota_limit_bytes": int(info.get("limit") or 0),
        })
    return rows


def _sum_present(*values: Optional[float]) -> Optional[float]:
    present = [v for v in values if v is not None]
    return float(sum(present)) if present else None


def normalize_volume_metrics_row(row: Dict[str, Any]) -> Dict[str, Any]:
    """Ensure all v2 volume_metrics columns exist; derive totals and percentages."""
    out: Dict[str, Any] = {name: row.get(name) for name in VOLUME_METRICS_FIELD_NAMES}

    if out.get("iops_total") is None:
        total = _sum_present(
            out.get("iops_read"),
            out.get("iops_write"),
            out.get("iops_other"),
        )
        if total is not None:
            out["iops_total"] = total

    if out.get("throughput_total_bytes") is None:
        total = _sum_present(
            out.get("throughput_read_bytes"),
            out.get("throughput_write_bytes"),
            out.get("throughput_other_bytes"),
        )
        if total is not None:
            out["throughput_total_bytes"] = total

    used, total_bytes = out.get("space_used_bytes"), out.get("space_total_bytes")
    if out.get("space_used_percent") is None and used is not None and total_bytes:
        out["space_used_percent"] = float(used) / float(total_bytes) * 100.0

    inode_used, inode_limit = out.get("inode_used"), out.get("inode_limit")
    if out.get("inode_used_percent") is None and inode_used is not None and inode_limit:
        out["inode_used_percent"] = float(inode_used) / float(inode_limit) * 100.0

    if out.get("latency_avg_us") is None:
        latencies = [
            v for v in (
                out.get("latency_read_us"),
                out.get("latency_write_us"),
                out.get("latency_other_us"),
            )
            if v is not None
        ]
        if latencies:
            out["latency_avg_us"] = sum(latencies) / len(latencies)

    return out


def write_empty_volume_metrics_parquet(output_path: str) -> str:
    """Write a zero-row volume_metrics Parquet file."""
    os.makedirs(output_path, exist_ok=True)
    dest = os.path.join(output_path, PARQUET_FILENAME_BY_CATEGORY["volume_metrics"])
    empty = pa.table(
        {f.name: pa.array([], type=f.type) for f in VOLUME_METRICS_SCHEMA},
        schema=VOLUME_METRICS_SCHEMA,
    )
    pq.write_table(empty, dest)
    return dest


def write_empty_category_parquet(output_path: str, category: str) -> str:
    """Write a zero-row Parquet file for a metrics category. Returns local path."""
    schema = SCHEMA_BY_CATEGORY.get(category)
    filename = PARQUET_FILENAME_BY_CATEGORY.get(category)
    if schema is None or filename is None:
        raise ValueError(f"No Parquet schema registered for metric category {category!r}")

    os.makedirs(output_path, exist_ok=True)
    dest = os.path.join(output_path, filename)
    empty = pa.table(
        {f.name: pa.array([], type=f.type) for f in schema},
        schema=schema,
    )
    pq.write_table(empty, dest)
    logger.info("[MetricsSchema] Wrote empty stub Parquet for %s -> %s", category, dest)
    return dest
