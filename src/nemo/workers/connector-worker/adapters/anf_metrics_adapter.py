"""ANF Metrics Adapter — fetches volume metrics from Azure Monitor for Azure NetApp Files.

Discovers ANF volumes via Azure Resource Graph (or ARM enumeration fallback), then
queries Monitor per volume ARM ID with namespace
``Microsoft.NetApp/netAppAccounts/capacityPools/volumes``. Subscription-scoped
responses often use a subscription-level ``metric.id`` without ``/volumes/``; ingest
uses the queried volume context when parsing ``metric.id`` fails. Outputs the same
volume_metrics schema as ONTAP/GCNV with source_type="anf".
"""
from __future__ import annotations

import asyncio
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

import pyarrow as pa
import pyarrow.parquet as pq

from anf_common import (
    ARM_BASE as ARM_METRICS_ENDPOINT,
    NETAPP_API_VERSION,
    AnfClient,
    arm_bearer_token,
    build_credential,
    normalize_region,
    parse_pool_resource_id,
    parse_resource_id,
    resource_group_from_arm,
    strip_insights_suffix,
    volume_context_from_parsed,
)
from .base import ExplorerError, ExplorerNode, ExplorerResponse, ProviderAdapter
from .metric_explorer_nodes import anf_metric_category_nodes
from .metric_table_schemas import (
    POOL_METRICS_SCHEMA,
    VOLUME_METRICS_SCHEMA,
    VOLUME_TIER_METRICS_SCHEMA,
    normalize_volume_metrics_row,
    write_empty_category_parquet,
    write_empty_volume_metrics_parquet,
)

logger = logging.getLogger(__name__)

ANF_VOLUME_METRIC_NAMESPACE = "Microsoft.NetApp/netAppAccounts/capacityPools/volumes"
ANF_POOL_METRIC_NAMESPACE = "Microsoft.NetApp/netAppAccounts/capacityPools"
# Back-compat alias used by tests and subscription-scoped probes.
ANF_METRIC_NAMESPACE = ANF_VOLUME_METRIC_NAMESPACE

ARM_METRICS_AUDIENCE = ARM_METRICS_ENDPOINT

# Canonical ANF volume performance/capacity metrics (Azure Monitor REST API names).
# Source: Microsoft.NetApp/netAppAccounts/capacityPools/volumes supported metrics
# (learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/
#  microsoft-netapp-netappaccounts-capacitypools-volumes-metrics).
# Intentionally unmapped v2 columns (no Azure time series):
#   latency_other_us — no AverageOtherLatency metric for ANF volumes
#   qos_policy — QoS policy name is ARM config, not a Monitor counter
#   svm_name — ANF has no SVM dimension
ANF_VOLUME_METRIC_NAMES = [
    "ReadIops",
    "WriteIops",
    "OtherIops",
    "TotalIops",
    "ReadThroughput",
    "WriteThroughput",
    "OtherThroughput",
    "TotalThroughput",
    "AverageReadLatency",
    "AverageWriteLatency",
    "VolumeLogicalSize",
    "VolumeAllocatedSize",
    "VolumeSnapshotSize",
    "VolumeConsumedSizePercentage",
    "VolumeInodesUsed",
    "VolumeInodesTotal",
    "VolumeInodesQuota",
    "VolumeInodesPercentage",
    "ThroughputLimitReached",
    "QosLatencyDelta",
]

# Cool-tier counters live in the volume namespace (auto-tiering enabled volumes).
ANF_TIER_METRIC_NAMES = [
    "VolumeCoolTierDataReadSize",
    "VolumeCoolTierDataWriteSize",
    "VolumeCoolTierSize",
]

# Pool-level counters (namespace Microsoft.NetApp/netAppAccounts/capacityPools).
# POOL_METRICS_SCHEMA columns without Azure equivalents stay null:
# tier_cold_bytes, tier_read_bytes, tier_write_bytes, replication_sync_status.
ANF_POOL_METRIC_NAMES = [
    "VolumePoolAllocatedSize",
    "VolumePoolAllocatedUsed",
    "VolumePoolTotalLogicalSize",
]

# All volume-namespace metrics fetched per volume ARM id (perf + cool tier).
ANF_METRIC_NAMES = ANF_VOLUME_METRIC_NAMES + ANF_TIER_METRIC_NAMES

_INT_BYTE_FIELDS = frozenset(
    {
        "space_used_bytes",
        "space_total_bytes",
        "space_snapshot_bytes",
        "inode_used",
        "inode_limit",
    }
)
_LATENCY_MS_FIELDS = frozenset(
    {
        "latency_read_us",
        "latency_write_us",
        "latency_other_us",
        "qos_latency_delta_us",
    }
)

# Azure capacity gauges sometimes omit ``average``; fall back to other aggregations.
_METRIC_VALUE_ATTRS = ("average", "maximum", "total", "minimum")

ARM_TOKEN_SCOPE = f"{ARM_METRICS_AUDIENCE}/.default"

# Azure Monitor retains platform metrics for 93 days; initial backfill uses full retention.
BACKFILL_DAYS = 93
# Single metrics API chart/query is limited to 30 days; longer spans are chunked.
METRICS_QUERY_MAX_DAYS = 30
# Azure Monitor allows at most 20 metric names per query_resource request.
AZURE_MONITOR_MAX_METRICS_PER_QUERY = 20

# Metadata keys Azure may use for resource identity on subscription-scoped series.
_RESOURCE_METADATA_KEYS = (
    "resourceid",
    "resourceuri",
    "resource",
    "microsoft.resourceid",
)


def _safe_heartbeat(cb: Optional[Callable[..., None]], *details: Any) -> None:
    if cb is None:
        return
    try:
        cb(*details)
    except Exception:  # pragma: no cover
        logger.debug("[AnfMetrics] heartbeat callback raised, ignoring", exc_info=True)


def _resolve_region(config: Dict[str, Any]) -> str:
    """Return the Azure region hosting ANF volumes (required for Monitor queries)."""
    raw = (config.get("default_region") or config.get("region") or "").strip()
    return normalize_region(raw) if raw else ""


def _create_metrics_client(credential: Any, region: str) -> Any:
    from azure.monitor.query import MetricsQueryClient

    _ = region  # passed via params= on each query (subscription-scoped ARM API)
    logger.info(
        "[AnfMetrics] MetricsQueryClient endpoint=%s audience=%s region=%s",
        ARM_METRICS_ENDPOINT,
        ARM_METRICS_AUDIENCE,
        region,
    )
    return MetricsQueryClient(
        credential,
        endpoint=ARM_METRICS_ENDPOINT,
        audience=ARM_METRICS_AUDIENCE,
    )


def _validate_connection_config(config: Dict[str, Any]) -> Optional[str]:
    subscription_id = (config.get("subscription_id") or "").strip()
    if not subscription_id:
        return "subscription_id is required"
    if not _resolve_region(config):
        return (
            "default_region is required (Azure region where ANF volumes run, e.g. eastus). "
            "ANF subscription-scoped metrics queries require the region query parameter "
            "on the Azure Monitor metrics API."
        )
    return None


def _chunk_metric_names(
    names: List[str],
    max_size: int = AZURE_MONITOR_MAX_METRICS_PER_QUERY,
) -> List[List[str]]:
    """Split metric name lists into batches of at most max_size for Azure Monitor."""
    if not names:
        return []
    return [names[i : i + max_size] for i in range(0, len(names), max_size)]


def _iter_metrics_query_windows(
    start_time: datetime,
    end_time: datetime,
    *,
    max_days: int = METRICS_QUERY_MAX_DAYS,
) -> List[Tuple[datetime, datetime]]:
    """Split [start_time, end_time] into contiguous windows of at most max_days."""
    if start_time >= end_time:
        return []
    max_span = timedelta(days=max_days)
    windows: List[Tuple[datetime, datetime]] = []
    cursor = start_time
    while cursor < end_time:
        chunk_end = min(cursor + max_span, end_time)
        windows.append((cursor, chunk_end))
        if chunk_end >= end_time:
            break
        cursor = chunk_end
    return windows


def _compute_time_window(
    watermark: Optional[str],
    now: Optional[datetime] = None,
) -> Tuple[datetime, datetime, str]:
    """Return (start_time, end_time, lookback_source) with GCNV-aligned watermark rules."""
    end = now or datetime.now(timezone.utc)
    sample_period = timedelta(minutes=5)
    min_window = sample_period * 2
    backfill = timedelta(days=BACKFILL_DAYS)

    if watermark:
        try:
            start = datetime.fromisoformat(watermark.replace("Z", "+00:00"))
            lookback = "watermark"
        except ValueError:
            start = end - backfill
            lookback = f"invalid-watermark({watermark!r})-fallback-{BACKFILL_DAYS}d"
    else:
        start = end - backfill
        lookback = f"no-watermark-backfill-{BACKFILL_DAYS}d"

    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    else:
        start = start.astimezone(timezone.utc)

    if (end - start) < min_window:
        start = end - min_window
        lookback = lookback + "+min-window-clamped"

    return start, end, lookback


def _metric_point_value(point: Any, *, prefer_maximum: bool = False) -> float:
    """Return the first non-null aggregation value from an Azure Monitor data point."""
    attrs = ("maximum", "average", "total", "minimum") if prefer_maximum else _METRIC_VALUE_ATTRS
    for attr in attrs:
        val = getattr(point, attr, None)
        if val is not None:
            return float(val)
    return 0.0


def _volume_from_timeseries_metadata(
    metadata: Optional[Dict[str, Any]],
) -> Optional[Dict[str, str]]:
    if not metadata:
        return None
    for key, val in metadata.items():
        if key.lower() not in _RESOURCE_METADATA_KEYS or not isinstance(val, str):
            continue
        parsed = parse_resource_id(val)
        if parsed:
            return volume_context_from_parsed(parsed)
    return None


def _parse_volume_context(
    metric_id: str,
    *,
    resource_group_filter: str = "",
    volume_context: Optional[Dict[str, str]] = None,
    timeseries_metadata: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, str]]:
    """Resolve volume identity for a metric series."""
    candidates: List[Optional[Dict[str, str]]] = []
    if metric_id:
        parsed = parse_resource_id(metric_id)
        if parsed:
            candidates.append(volume_context_from_parsed(parsed))
    meta_ctx = _volume_from_timeseries_metadata(timeseries_metadata)
    if meta_ctx:
        candidates.append(meta_ctx)
    if volume_context:
        candidates.append(volume_context)

    for ctx in candidates:
        if not ctx:
            continue
        if resource_group_filter and ctx.get("resource_group", "").lower() != resource_group_filter.lower():
            continue
        if ctx.get("volume_id") and ctx.get("volume_name"):
            return ctx
    return None


def _field_for_metric(metric_name: str) -> Optional[str]:
    if metric_name == "ReadIops":
        return "iops_read"
    if metric_name == "WriteIops":
        return "iops_write"
    if metric_name == "OtherIops":
        return "iops_other"
    if metric_name == "TotalIops":
        return "iops_total"
    if metric_name == "ReadThroughput":
        return "throughput_read_bytes"
    if metric_name == "WriteThroughput":
        return "throughput_write_bytes"
    if metric_name == "OtherThroughput":
        return "throughput_other_bytes"
    if metric_name == "TotalThroughput":
        return "throughput_total_bytes"
    if metric_name == "AverageReadLatency":
        return "latency_read_us"
    if metric_name == "AverageWriteLatency":
        return "latency_write_us"
    if metric_name == "VolumeLogicalSize":
        return "space_used_bytes"
    if metric_name == "VolumeAllocatedSize":
        return "space_total_bytes"
    if metric_name == "VolumeSnapshotSize":
        return "space_snapshot_bytes"
    if metric_name == "VolumeConsumedSizePercentage":
        return "space_used_percent"
    if metric_name == "VolumeInodesUsed":
        return "inode_used"
    if metric_name in ("VolumeInodesTotal", "VolumeInodesQuota"):
        return "inode_limit"
    if metric_name == "VolumeInodesPercentage":
        return "inode_used_percent"
    if metric_name == "ThroughputLimitReached":
        return "throughput_limit_hit"
    if metric_name == "QosLatencyDelta":
        return "qos_latency_delta_us"
    return None


def _field_for_tier_metric(metric_name: str) -> Optional[tuple[str, str]]:
    """Return (schema_column, tier_name) for volume_tier_metrics rows."""
    if metric_name == "VolumeCoolTierDataReadSize":
        return ("tier_read_bytes", "cold")
    if metric_name == "VolumeCoolTierDataWriteSize":
        return ("tier_write_bytes", "cold")
    if metric_name == "VolumeCoolTierSize":
        return ("tier_footprint_bytes", "cold")
    return None


def _field_for_pool_metric(metric_name: str) -> Optional[str]:
    """Return pool_metrics schema column for a capacity pool Monitor counter."""
    if metric_name == "VolumePoolAllocatedSize":
        return "capacity_bytes"
    if metric_name == "VolumePoolAllocatedUsed":
        return "allocated_bytes"
    if metric_name == "VolumePoolTotalLogicalSize":
        return "used_bytes"
    return None


def _apply_volume_identity(
    bucket: Dict[str, Any],
    ctx: Dict[str, str],
    volume_context: Optional[Dict[str, str]] = None,
) -> None:
    """Stamp cluster_id and service_level from parsed ARM / discovery context."""
    merged: Dict[str, str] = {}
    if volume_context:
        merged.update(volume_context)
    merged.update(ctx)
    bucket["account_id"] = merged.get("subscription_id", "")
    bucket["cluster_id"] = merged.get("netapp_account", "")
    bucket["pool_id"] = merged.get("pool_id", "")
    if merged.get("service_level"):
        bucket["service_level"] = merged["service_level"]


def _merge_metric_point(
    volume_data: Dict[str, Dict[str, Dict[str, Any]]],
    volume_key: str,
    volume_name: str,
    point_time: datetime,
    field: str,
    value: float,
    *,
    ctx: Optional[Dict[str, str]] = None,
    volume_context: Optional[Dict[str, str]] = None,
) -> None:
    if volume_key not in volume_data:
        volume_data[volume_key] = {}
    time_key = point_time.isoformat()
    if time_key not in volume_data[volume_key]:
        bucket: Dict[str, Any] = {
            "timestamp": point_time,
            "volume_id": volume_key,
            "volume_name": volume_name,
        }
        if ctx:
            _apply_volume_identity(bucket, ctx, volume_context)
        volume_data[volume_key][time_key] = bucket
    if volume_context:
        if volume_context.get("service_level"):
            volume_data[volume_key][time_key]["service_level"] = volume_context[
                "service_level"
            ]
        if volume_context.get("netapp_account"):
            volume_data[volume_key][time_key]["cluster_id"] = volume_context[
                "netapp_account"
            ]
        if volume_context.get("subscription_id"):
            volume_data[volume_key][time_key]["account_id"] = volume_context[
                "subscription_id"
            ]
        if volume_context.get("pool_id"):
            volume_data[volume_key][time_key]["pool_id"] = volume_context["pool_id"]
    volume_data[volume_key][time_key][field] = value


def _flatten_rows(
    volume_data: Dict[str, Dict[str, Dict[str, Any]]],
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for volume_id, time_points in volume_data.items():
        for _time_key, data in time_points.items():
            rows.append(normalize_volume_metrics_row({
                "timestamp": data["timestamp"],
                "source_type": "anf",
                "account_id": data.get("account_id", ""),
                "cluster_id": data.get("cluster_id", ""),
                "pool_id": data.get("pool_id"),
                "volume_id": volume_id,
                "volume_name": data.get("volume_name", ""),
                "svm_name": None,
                "service_level": data.get("service_level"),
                "iops_read": data.get("iops_read"),
                "iops_write": data.get("iops_write"),
                "iops_other": data.get("iops_other"),
                "iops_total": data.get("iops_total"),
                "throughput_read_bytes": data.get("throughput_read_bytes"),
                "throughput_write_bytes": data.get("throughput_write_bytes"),
                "throughput_other_bytes": data.get("throughput_other_bytes"),
                "throughput_total_bytes": data.get("throughput_total_bytes"),
                "latency_read_us": data.get("latency_read_us"),
                "latency_write_us": data.get("latency_write_us"),
                "latency_other_us": data.get("latency_other_us"),
                "space_used_bytes": data.get("space_used_bytes"),
                "space_total_bytes": data.get("space_total_bytes"),
                "space_snapshot_bytes": data.get("space_snapshot_bytes"),
                "space_used_percent": data.get("space_used_percent"),
                "inode_used": data.get("inode_used"),
                "inode_limit": data.get("inode_limit"),
                "inode_used_percent": data.get("inode_used_percent"),
                "throughput_limit_hit": data.get("throughput_limit_hit"),
                "qos_latency_delta_us": data.get("qos_latency_delta_us"),
            }))
    return rows


def _flatten_tier_rows(
    tier_data: Dict[str, Dict[str, Dict[str, Dict[str, Any]]]],
    *,
    cluster_id: str,
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for volume_id, time_points in tier_data.items():
        for _time_key, tiers in time_points.items():
            for tier_name, data in tiers.items():
                rows.append({
                    "timestamp": data["timestamp"],
                    "source_type": "anf",
                    "cluster_id": cluster_id,
                    "volume_id": volume_id,
                    "tier_name": tier_name,
                    "tier_read_bytes": data.get("tier_read_bytes"),
                    "tier_write_bytes": data.get("tier_write_bytes"),
                    "tier_footprint_bytes": data.get("tier_footprint_bytes"),
                })
    return rows


def _flatten_pool_rows(
    pool_data: Dict[str, Dict[str, Dict[str, Any]]],
    *,
    cluster_id: str,
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for pool_id, time_points in pool_data.items():
        for _time_key, data in time_points.items():
            rows.append({
                "timestamp": data["timestamp"],
                "source_type": "anf",
                "cluster_id": cluster_id,
                "pool_id": data.get("pool_id", pool_id),
                "pool_name": data.get("pool_name", pool_id),
                "service_level": data.get("service_level"),
                "capacity_bytes": data.get("capacity_bytes"),
                "allocated_bytes": data.get("allocated_bytes"),
                "used_bytes": data.get("used_bytes"),
                "tier_cold_bytes": None,
                "tier_read_bytes": None,
                "tier_write_bytes": None,
                "replication_sync_status": None,
            })
    return rows


def _ingest_metrics_result(
    result: Any,
    metric_name: str,
    volume_data: Dict[str, Dict[str, Dict[str, Any]]],
    *,
    resource_group_filter: str = "",
    volume_context: Optional[Dict[str, str]] = None,
) -> Tuple[int, int]:
    """Merge one MetricsQueryResult into volume_data. Returns (series_count, point_count)."""
    field = _field_for_metric(metric_name)
    if field is None:
        return 0, 0

    series_count = 0
    point_count = 0
    for metric in result.metrics:
        if metric.name != metric_name:
            continue

        for ts in metric.timeseries:
            ctx = _parse_volume_context(
                metric.id,
                resource_group_filter=resource_group_filter,
                volume_context=volume_context,
                timeseries_metadata=getattr(ts, "metadata_values", None) or {},
            )
            if not ctx:
                logger.warning(
                    "[AnfMetrics] could not resolve volume for metric id=%r metric=%s "
                    "metadata_keys=%s",
                    metric.id,
                    metric_name,
                    list((getattr(ts, "metadata_values", None) or {}).keys()),
                )
                continue

            volume_key = ctx["volume_id"]
            volume_name = ctx["volume_name"]
            series_count += 1
            for point in ts.data:
                point_count += 1
                pt = point.timestamp
                if pt.tzinfo is None:
                    point_time = pt.replace(tzinfo=timezone.utc)
                else:
                    point_time = pt.astimezone(timezone.utc)

                value = _metric_point_value(
                    point,
                    prefer_maximum=field in _INT_BYTE_FIELDS,
                )

                if field in _LATENCY_MS_FIELDS:
                    value *= 1000.0
                elif field == "throughput_limit_hit":
                    value = int(value)
                elif field in _INT_BYTE_FIELDS:
                    value = float(int(value))

                _merge_metric_point(
                    volume_data,
                    volume_key,
                    volume_name,
                    point_time,
                    field,
                    value,
                    ctx=ctx,
                    volume_context=volume_context,
                )
    return series_count, point_count


def _anf_client_with_azure_cred(
    azure_credential: Any,
    subscription_id: str,
    region: str,
    resource_group: str = "",
) -> AnfClient:
    """Wrap an existing azure-identity credential (metrics path already built one)."""
    client = AnfClient(
        {"tenant_id": "unused", "client_id": "unused", "client_secret": "unused"},
        subscription_id=subscription_id,
        region=region,
        resource_group=resource_group,
    )
    client._azure_cred = azure_credential
    return client


def _ingest_tier_metrics_result(
    result: Any,
    metric_name: str,
    tier_data: Dict[str, Dict[str, Dict[str, Dict[str, Any]]]],
    *,
    resource_group_filter: str = "",
    volume_context: Optional[Dict[str, str]] = None,
) -> Tuple[int, int]:
    """Merge cool-tier counters into tier_data. Returns (series_count, point_count)."""
    mapped = _field_for_tier_metric(metric_name)
    if mapped is None:
        return 0, 0
    field, tier_name = mapped

    series_count = 0
    point_count = 0
    for metric in result.metrics:
        if metric.name != metric_name:
            continue

        for ts in metric.timeseries:
            ctx = _parse_volume_context(
                metric.id,
                resource_group_filter=resource_group_filter,
                volume_context=volume_context,
                timeseries_metadata=getattr(ts, "metadata_values", None) or {},
            )
            if not ctx:
                continue

            volume_key = ctx["volume_id"]
            series_count += 1
            for point in ts.data:
                point_count += 1
                pt = point.timestamp
                if pt.tzinfo is None:
                    point_time = pt.replace(tzinfo=timezone.utc)
                else:
                    point_time = pt.astimezone(timezone.utc)

                value = int(_metric_point_value(point, prefer_maximum=True))
                if volume_key not in tier_data:
                    tier_data[volume_key] = {}
                time_key = point_time.isoformat()
                if time_key not in tier_data[volume_key]:
                    tier_data[volume_key][time_key] = {}
                if tier_name not in tier_data[volume_key][time_key]:
                    tier_data[volume_key][time_key][tier_name] = {
                        "timestamp": point_time,
                    }
                tier_data[volume_key][time_key][tier_name][field] = value
    return series_count, point_count


def _parse_pool_resource_id(arm_resource_id: str) -> Optional[Dict[str, str]]:
    if not arm_resource_id:
        return None
    path = strip_insights_suffix(arm_resource_id.strip())
    return parse_pool_resource_id(path)


def _parse_pool_context(
    metric_id: str,
    *,
    resource_group_filter: str = "",
    pool_context: Optional[Dict[str, str]] = None,
    timeseries_metadata: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, str]]:
    candidates: List[Optional[Dict[str, str]]] = []
    if metric_id:
        candidates.append(_parse_pool_resource_id(metric_id))
    if timeseries_metadata:
        for key, val in timeseries_metadata.items():
            if key.lower() not in _RESOURCE_METADATA_KEYS or not isinstance(val, str):
                continue
            candidates.append(_parse_pool_resource_id(val))
    if pool_context:
        candidates.append(pool_context)

    for ctx in candidates:
        if not ctx:
            continue
        if resource_group_filter and ctx.get("resource_group", "").lower() != resource_group_filter.lower():
            continue
        if ctx.get("pool_id") and ctx.get("pool_name"):
            return ctx
    return None


def _merge_pool_metric_point(
    pool_data: Dict[str, Dict[str, Dict[str, Any]]],
    pool_key: str,
    pool_name: str,
    point_time: datetime,
    field: str,
    value: int,
    *,
    ctx: Optional[Dict[str, str]] = None,
    pool_context: Optional[Dict[str, str]] = None,
) -> None:
    if pool_key not in pool_data:
        pool_data[pool_key] = {}
    time_key = point_time.isoformat()
    if time_key not in pool_data[pool_key]:
        bucket: Dict[str, Any] = {
            "timestamp": point_time,
            "pool_id": pool_key,
            "pool_name": pool_name,
        }
        merged: Dict[str, str] = {}
        if pool_context:
            merged.update(pool_context)
        if ctx:
            merged.update(ctx)
        bucket["cluster_id"] = merged.get("netapp_account", "")
        if merged.get("service_level"):
            bucket["service_level"] = merged["service_level"]
        pool_data[pool_key][time_key] = bucket
    if pool_context:
        if pool_context.get("service_level"):
            pool_data[pool_key][time_key]["service_level"] = pool_context["service_level"]
        if pool_context.get("netapp_account"):
            pool_data[pool_key][time_key]["cluster_id"] = pool_context["netapp_account"]
    pool_data[pool_key][time_key][field] = value


def _ingest_pool_metrics_result(
    result: Any,
    metric_name: str,
    pool_data: Dict[str, Dict[str, Dict[str, Any]]],
    *,
    resource_group_filter: str = "",
    pool_context: Optional[Dict[str, str]] = None,
) -> Tuple[int, int]:
    field = _field_for_pool_metric(metric_name)
    if field is None:
        return 0, 0

    series_count = 0
    point_count = 0
    for metric in result.metrics:
        if metric.name != metric_name:
            continue

        for ts in metric.timeseries:
            ctx = _parse_pool_context(
                metric.id,
                resource_group_filter=resource_group_filter,
                pool_context=pool_context,
                timeseries_metadata=getattr(ts, "metadata_values", None) or {},
            )
            if not ctx:
                logger.warning(
                    "[AnfMetrics] could not resolve pool for metric id=%r metric=%s",
                    metric.id,
                    metric_name,
                )
                continue

            pool_key = ctx["pool_id"]
            pool_name = ctx["pool_name"]
            series_count += 1
            for point in ts.data:
                point_count += 1
                pt = point.timestamp
                if pt.tzinfo is None:
                    point_time = pt.replace(tzinfo=timezone.utc)
                else:
                    point_time = pt.astimezone(timezone.utc)
                value = int(_metric_point_value(point, prefer_maximum=True))
                _merge_pool_metric_point(
                    pool_data,
                    pool_key,
                    pool_name,
                    point_time,
                    field,
                    value,
                    ctx=ctx,
                    pool_context=pool_context,
                )
    return series_count, point_count


def _unique_pools_from_volumes(volumes: List[Dict[str, str]]) -> List[Dict[str, str]]:
    pools: Dict[str, Dict[str, str]] = {}
    for vol in volumes:
        pool_id = (vol.get("pool_id") or "").strip()
        if not pool_id:
            continue
        if pool_id not in pools:
            pools[pool_id] = {
                "subscription_id": vol.get("subscription_id", ""),
                "resource_group": vol.get("resource_group", ""),
                "netapp_account": vol.get("netapp_account", ""),
                "pool_name": vol.get("pool_name", ""),
                "pool_id": pool_id,
                "service_level": vol.get("service_level", ""),
            }
        elif not pools[pool_id].get("service_level") and vol.get("service_level"):
            pools[pool_id]["service_level"] = vol["service_level"]
    return list(pools.values())


def _list_anf_volumes_resource_graph(
    credential: Any,
    subscription_id: str,
    region: str,
    resource_group: str = "",
) -> List[Dict[str, str]]:
    client = _anf_client_with_azure_cred(
        credential, subscription_id, region, resource_group
    )
    return client.list_volumes_resource_graph(
        subscription_id=subscription_id, region=region, resource_group=resource_group
    )


def _list_anf_volumes_arm_enumerate(
    credential: Any,
    subscription_id: str,
    region: str,
    resource_group: str = "",
) -> List[Dict[str, str]]:
    client = _anf_client_with_azure_cred(
        credential, subscription_id, region, resource_group
    )
    return client.list_volumes_arm_enumerate(
        subscription_id=subscription_id, region=region, resource_group=resource_group
    )


def _enrich_volumes_service_level(
    credential: Any,
    volumes: List[Dict[str, str]],
) -> List[Dict[str, str]]:
    client = _anf_client_with_azure_cred(
        credential,
        "00000000-0000-0000-0000-000000000000",
        "eastus",
    )
    return client.enrich_volumes_service_level(volumes)


def _list_anf_volumes(
    credential: Any,
    subscription_id: str,
    region: str,
    resource_group: str = "",
) -> List[Dict[str, str]]:
    """Return distinct ANF volume contexts in the given region."""
    volumes = _list_anf_volumes_resource_graph(
        credential, subscription_id, region, resource_group
    )
    if not volumes:
        volumes = _list_anf_volumes_arm_enumerate(
            credential, subscription_id, region, resource_group
        )
    seen: Dict[str, Dict[str, str]] = {}
    for vol in volumes:
        seen[vol["volume_id"]] = vol
    result = list(seen.values())
    result = _enrich_volumes_service_level(credential, result)
    logger.info(
        "[AnfMetrics] discovered %d ANF volume(s) in subscription=%s region=%s resource_group=%r",
        len(result),
        subscription_id,
        region,
        resource_group or None,
    )
    return result


def _query_volume_metrics(
    client: Any,
    volume_arm_id: str,
    start_time: datetime,
    end_time: datetime,
    *,
    region: str = "",
    metric_names: Optional[List[str]] = None,
) -> Any:
    """Query ANF volume-namespace metrics for one volume ARM resource."""
    kwargs: Dict[str, Any] = {
        "timespan": (start_time, end_time),
        "granularity": timedelta(minutes=5),
        "aggregations": ["Average"],
        "metric_namespace": ANF_VOLUME_METRIC_NAMESPACE,
    }
    if region:
        kwargs["params"] = {"region": normalize_region(region)}
    return client.query_resource(
        volume_arm_id,
        metric_names or ANF_METRIC_NAMES,
        **kwargs,
    )


def _query_pool_metrics(
    client: Any,
    pool_arm_id: str,
    start_time: datetime,
    end_time: datetime,
    *,
    region: str = "",
) -> Any:
    """Query ANF pool-namespace metrics for one capacity pool ARM resource."""
    kwargs: Dict[str, Any] = {
        "timespan": (start_time, end_time),
        "granularity": timedelta(minutes=5),
        "aggregations": ["Average"],
        "metric_namespace": ANF_POOL_METRIC_NAMESPACE,
    }
    if region:
        kwargs["params"] = {"region": normalize_region(region)}
    return client.query_resource(pool_arm_id, ANF_POOL_METRIC_NAMES, **kwargs)


def _query_metrics(
    client: Any,
    subscription_id: str,
    metric_name: str,
    start_time: datetime,
    end_time: datetime,
    *,
    resource_group: str = "",
    region: str = "",
) -> Any:
    """Subscription-scoped query (testConnection probe / legacy)."""
    resource_uri = f"/subscriptions/{subscription_id}"
    return client.query_resource(
        resource_uri,
        [metric_name],
        timespan=(start_time, end_time),
        granularity=timedelta(minutes=5),
        aggregations=["Average"],
        metric_namespace=ANF_METRIC_NAMESPACE,
        params={"region": normalize_region(region)},
    )


class AnfMetricsAdapter(ProviderAdapter):
    """Acquires ANF volume performance metrics from Azure Monitor."""

    def execute(
        self,
        connector_config: Dict[str, Any],
        credential: Dict[str, str],
        action: str,
        payload: Dict[str, Any],
    ) -> ExplorerResponse:
        if action == "testConnection":
            return self._test_connection(connector_config, credential)
        if action == "listMetricCategories":
            return ExplorerResponse(nodes=anf_metric_category_nodes())
        return ExplorerResponse(
            error=ExplorerError(
                code="UNSUPPORTED_ACTION",
                message=f"Action '{action}' not supported by ANF metrics adapter",
            )
        )

    def _test_connection(
        self, config: Dict[str, Any], credential: Dict[str, str]
    ) -> ExplorerResponse:
        err = _validate_connection_config(config)
        if err:
            return ExplorerResponse(
                error=ExplorerError(code="MISSING_CONFIG", message=err)
            )
        try:
            cred = build_credential(credential)
        except (ValueError, RuntimeError) as e:
            return ExplorerResponse(
                error=ExplorerError(code="CREDENTIAL_ERROR", message=str(e))
            )
        try:
            from azure.monitor.query import MetricsQueryClient
        except ImportError as e:
            return ExplorerResponse(
                error=ExplorerError(
                    code="MISSING_SDK",
                    message=(
                        "azure-monitor-query is not installed. "
                        "Add azure-monitor-query<2 and azure-identity to requirements.txt."
                    ),
                )
            )
        subscription_id = config["subscription_id"].strip()
        region = _resolve_region(config)
        resource_group = (config.get("resource_group") or "").strip()
        try:
            client = _create_metrics_client(cred, region)
            volumes = _list_anf_volumes(cred, subscription_id, region, resource_group)
            end = datetime.now(timezone.utc)
            start = end - timedelta(hours=1)
            series_count = 0
            probe_volume_id = ""
            if volumes:
                probe_volume_id = volumes[0]["volume_id"]
                result = _query_volume_metrics(
                    client,
                    probe_volume_id,
                    start,
                    end,
                    region=region,
                    metric_names=[ANF_VOLUME_METRIC_NAMES[0]],
                )
                for metric in result.metrics:
                    if metric.name == ANF_VOLUME_METRIC_NAMES[0]:
                        series_count += len(metric.timeseries)
            else:
                # No volumes in region — subscription-scoped probe only.
                resource_uri = f"/subscriptions/{subscription_id}"
                result = client.query_resource(
                    resource_uri,
                    [ANF_VOLUME_METRIC_NAMES[0]],
                    timespan=(start, end),
                    granularity=timedelta(minutes=5),
                    aggregations=["Average"],
                    metric_namespace=ANF_METRIC_NAMESPACE,
                    params={"region": region},
                )
                series_count = sum(len(m.timeseries) for m in result.metrics)
            return ExplorerResponse(
                nodes=[
                    ExplorerNode(
                        id="subscription",
                        label=subscription_id,
                        type="subscription",
                        metadata={
                            "provider": "azure_cloud",
                            "metric_time_series": series_count,
                            "region": region,
                            "volume_count": len(volumes),
                            "probe_volume_id": probe_volume_id or None,
                        },
                    )
                ]
            )
        except Exception as e:
            logger.exception("[AnfMetrics] testConnection failed")
            return ExplorerResponse(
                error=ExplorerError(code="CONNECTION_ERROR", message=str(e))
            )

    async def acquire(
        self,
        connection_info: Dict[str, Any],
        watermark: Optional[str],
        output_path: str,
        heartbeat: Optional[Callable[..., None]] = None,
    ) -> Dict[str, Any]:
        subscription_id = (connection_info.get("subscription_id") or "").strip()
        resource_group = (connection_info.get("resource_group") or "").strip()
        region = _resolve_region(connection_info)
        if not subscription_id:
            raise ValueError("ANF connection requires subscription_id")
        if not region:
            raise ValueError(
                "ANF connection requires default_region (Azure region of ANF volumes, e.g. eastus)"
            )

        resource_selector = connection_info.get("resourceSelector") or []
        categories = (
            {r["category"] for r in resource_selector if "category" in r}
            if resource_selector
            else None
        )
        write_volumes = categories is None or "volume_metrics" in categories
        write_pools = categories is None or "pool_metrics" in categories
        write_tiers = categories is None or "volume_tier_metrics" in categories

        if categories is not None and not (write_volumes or write_pools or write_tiers):
            logger.info(
                "[AnfMetrics] no supported categories in resourceSelector, skipping acquisition"
            )
            os.makedirs(output_path, exist_ok=True)
            return {
                "outputPath": output_path,
                "newWatermarkValue": watermark or "",
                "rowCount": 0,
                "volumeMetricsCount": 0,
                "volumeTierMetricsCount": 0,
                "poolMetricsCount": 0,
                "aggregateMetricsCount": 0,
            }

        start_time, end_time, lookback_source = _compute_time_window(watermark)

        tenant_id = (connection_info.get("tenant_id") or "").strip()
        client_id = (connection_info.get("client_id") or "").strip()
        client_secret = (connection_info.get("client_secret") or "").strip()
        cred = build_credential(
            {
                "tenant_id": tenant_id,
                "client_id": client_id,
                "client_secret": client_secret,
            }
        )

        logger.info(
            "[AnfMetrics] acquire start: subscription_id=%s resource_group=%r watermark=%r "
            "start=%s end=%s lookback_source=%s",
            subscription_id,
            resource_group or None,
            watermark,
            start_time.isoformat(),
            end_time.isoformat(),
            lookback_source,
        )

        volume_rows: List[Dict[str, Any]] = []
        tier_rows: List[Dict[str, Any]] = []
        pool_rows: List[Dict[str, Any]] = []

        volumes: Optional[List[Dict[str, str]]] = None
        if write_volumes or write_tiers or write_pools:
            volumes = await asyncio.to_thread(
                _list_anf_volumes,
                cred,
                subscription_id,
                region,
                resource_group,
            )
            if not volumes:
                raise RuntimeError(
                    "[AnfMetrics] No ANF volumes found in subscription "
                    f"{subscription_id!r} region {region!r} "
                    f"(resource_group filter={resource_group!r}). "
                    "Verify volumes exist in this region and the service principal has "
                    "Reader on Microsoft.NetApp resources (Resource Graph or ARM list)."
                )

        if write_volumes or write_tiers:
            volume_rows, tier_rows = await self._fetch_volume_and_tier_metrics(
                subscription_id,
                start_time,
                end_time,
                cred,
                resource_group=resource_group,
                region=region,
                heartbeat=heartbeat,
                collect_volumes=write_volumes,
                collect_tiers=write_tiers,
                volumes=volumes,
            )
        if write_pools:
            pool_rows = await self._fetch_pool_metrics(
                subscription_id,
                start_time,
                end_time,
                cred,
                resource_group=resource_group,
                region=region,
                heartbeat=heartbeat,
                volumes=volumes,
            )

        os.makedirs(output_path, exist_ok=True)

        if write_volumes:
            if volume_rows:
                vol_path = os.path.join(output_path, "volume_metrics.parquet")
                pq.write_table(
                    pa.Table.from_pylist(volume_rows, schema=VOLUME_METRICS_SCHEMA),
                    vol_path,
                )
                logger.info("[AnfMetrics] wrote %d volume rows to %s", len(volume_rows), vol_path)
            else:
                write_empty_volume_metrics_parquet(output_path)

        if write_tiers:
            if tier_rows:
                tier_path = os.path.join(output_path, "volume_tier_metrics.parquet")
                pq.write_table(
                    pa.Table.from_pylist(tier_rows, schema=VOLUME_TIER_METRICS_SCHEMA),
                    tier_path,
                )
                logger.info("[AnfMetrics] wrote %d tier rows to %s", len(tier_rows), tier_path)
            else:
                write_empty_category_parquet(output_path, "volume_tier_metrics")

        if write_pools:
            if pool_rows:
                pool_path = os.path.join(output_path, "pool_metrics.parquet")
                pq.write_table(
                    pa.Table.from_pylist(pool_rows, schema=POOL_METRICS_SCHEMA),
                    pool_path,
                )
                logger.info("[AnfMetrics] wrote %d pool rows to %s", len(pool_rows), pool_path)
            else:
                write_empty_category_parquet(output_path, "pool_metrics")

        time_series_rows = volume_rows + tier_rows + pool_rows
        if time_series_rows:
            timestamps = [r["timestamp"] for r in time_series_rows if r.get("timestamp")]
            if timestamps:
                max_obs = max(timestamps)
                new_watermark = (
                    max_obs.isoformat()
                    if hasattr(max_obs, "isoformat")
                    else str(max_obs)
                )
            else:
                new_watermark = watermark or ""
        else:
            new_watermark = watermark or ""
            logger.info(
                "[AnfMetrics] 0 rows produced; preserving prior watermark=%r",
                new_watermark,
            )

        total_rows = len(volume_rows) + len(tier_rows) + len(pool_rows)
        return {
            "outputPath": output_path,
            "newWatermarkValue": new_watermark,
            "rowCount": total_rows,
            "volumeMetricsCount": len(volume_rows),
            "volumeTierMetricsCount": len(tier_rows),
            "poolMetricsCount": len(pool_rows),
            "aggregateMetricsCount": 0,
        }

    async def _fetch_metrics(
        self,
        subscription_id: str,
        start_time: datetime,
        end_time: datetime,
        credential: Any,
        *,
        resource_group: str = "",
        region: str = "",
        heartbeat: Optional[Callable[..., None]] = None,
    ) -> List[Dict[str, Any]]:
        """Backward-compatible entry point returning volume_metrics rows only."""
        volume_rows, _ = await self._fetch_volume_and_tier_metrics(
            subscription_id,
            start_time,
            end_time,
            credential,
            resource_group=resource_group,
            region=region,
            heartbeat=heartbeat,
            collect_volumes=True,
            collect_tiers=False,
        )
        return volume_rows

    async def _fetch_volume_and_tier_metrics(
        self,
        subscription_id: str,
        start_time: datetime,
        end_time: datetime,
        credential: Any,
        *,
        resource_group: str = "",
        region: str = "",
        heartbeat: Optional[Callable[..., None]] = None,
        collect_volumes: bool = True,
        collect_tiers: bool = True,
        volumes: Optional[List[Dict[str, str]]] = None,
    ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
        if not region:
            raise ValueError(
                "ANF metrics fetch requires default_region (Azure region of ANF volumes)"
            )
        try:
            from azure.core.exceptions import HttpResponseError
        except ImportError as e:
            msg = (
                "[AnfMetrics] azure-core is not installed in this worker image "
                f"(import failed: {e})."
            )
            logger.error(msg)
            raise RuntimeError(msg) from e

        try:
            client = _create_metrics_client(credential, region)
        except ImportError as e:
            msg = (
                "[AnfMetrics] azure-monitor-query is not installed in this worker image "
                f"(import failed: {e}). Add `azure-monitor-query>=1.2.0,<2` and "
                "`azure-identity` to requirements.txt and rebuild the connector-worker image."
            )
            logger.error(msg)
            raise RuntimeError(msg) from e

        if volumes is None:
            volumes = await asyncio.to_thread(
                _list_anf_volumes,
                credential,
                subscription_id,
                region,
                resource_group,
            )
        if not volumes:
            raise RuntimeError(
                "[AnfMetrics] No ANF volumes found in subscription "
                f"{subscription_id!r} region {region!r} "
                f"(resource_group filter={resource_group!r}). "
                "Verify volumes exist in this region and the service principal has "
                "Reader on Microsoft.NetApp resources (Resource Graph or ARM list)."
            )

        query_windows = _iter_metrics_query_windows(start_time, end_time)
        if not query_windows:
            query_windows = [(start_time, end_time)]
        if len(query_windows) > 1:
            logger.info(
                "[AnfMetrics] timespan %s to %s split into %d query window(s) "
                "(max %d days per Azure Monitor request)",
                start_time.isoformat(),
                end_time.isoformat(),
                len(query_windows),
                METRICS_QUERY_MAX_DAYS,
            )

        metric_names = []
        if collect_volumes:
            metric_names.extend(ANF_VOLUME_METRIC_NAMES)
        if collect_tiers:
            metric_names.extend(ANF_TIER_METRIC_NAMES)

        volume_data: Dict[str, Dict[str, Dict[str, Any]]] = {}
        tier_data: Dict[str, Dict[str, Dict[str, Dict[str, Any]]]] = {}
        volume_errors: List[str] = []
        per_metric_counts: List[Dict[str, Any]] = []
        total_series = 0
        total_volumes = len(volumes)

        for v_idx, vol in enumerate(volumes, start=1):
            _safe_heartbeat(
                heartbeat,
                f"anf:volume {v_idx}/{total_volumes}:{vol['volume_name']}",
            )
            vol_series = 0
            vol_points = 0
            chunk_errors: List[str] = []
            for chunk_idx, (chunk_start, chunk_end) in enumerate(query_windows, start=1):
                for metric_batch in _chunk_metric_names(metric_names):
                    try:
                        result = await asyncio.to_thread(
                            _query_volume_metrics,
                            client,
                            vol["volume_id"],
                            chunk_start,
                            chunk_end,
                            region=region,
                            metric_names=metric_batch,
                        )
                        for metric_name in metric_batch:
                            if collect_volumes and metric_name in ANF_VOLUME_METRIC_NAMES:
                                ts_count, point_count = _ingest_metrics_result(
                                    result,
                                    metric_name,
                                    volume_data,
                                    resource_group_filter=resource_group,
                                    volume_context=vol,
                                )
                            elif collect_tiers and metric_name in ANF_TIER_METRIC_NAMES:
                                ts_count, point_count = _ingest_tier_metrics_result(
                                    result,
                                    metric_name,
                                    tier_data,
                                    resource_group_filter=resource_group,
                                    volume_context=vol,
                                )
                            else:
                                continue
                            vol_series += ts_count
                            vol_points += point_count
                            per_metric_counts.append(
                                {
                                    "volume": vol["volume_name"],
                                    "metric": metric_name,
                                    "chunk": chunk_idx,
                                    "time_series": ts_count,
                                    "points": point_count,
                                }
                            )
                    except HttpResponseError as e:
                        logger.exception(
                            "[AnfMetrics] HttpResponseError fetching volume %s "
                            "chunk %d/%d (%s to %s): %s",
                            vol["volume_name"],
                            chunk_idx,
                            len(query_windows),
                            chunk_start.isoformat(),
                            chunk_end.isoformat(),
                            e,
                        )
                        chunk_errors.append(f"{type(e).__name__}: {e}")
                    except Exception as e:
                        logger.exception(
                            "[AnfMetrics] unexpected error fetching volume %s "
                            "chunk %d/%d (%s to %s): %s",
                            vol["volume_name"],
                            chunk_idx,
                            len(query_windows),
                            chunk_start.isoformat(),
                            chunk_end.isoformat(),
                            e,
                        )
                        chunk_errors.append(f"{type(e).__name__}: {e}")

            if chunk_errors and vol_series == 0:
                volume_errors.append(
                    f"{vol['volume_name']}: "
                    + "; ".join(chunk_errors[:3])
                    + (f" (+{len(chunk_errors) - 3} more)" if len(chunk_errors) > 3 else "")
                )
            elif chunk_errors:
                logger.warning(
                    "[AnfMetrics] volume %s: %d/%d chunk(s) failed; ingested partial data",
                    vol["volume_name"],
                    len(chunk_errors),
                    len(query_windows),
                )

            total_series += vol_series
            logger.info(
                "[AnfMetrics] volume %s -> time_series=%d points=%d",
                vol["volume_name"],
                vol_series,
                vol_points,
            )

        metrics_with_data = sum(1 for c in per_metric_counts if c["time_series"] > 0)
        logger.info(
            "[AnfMetrics] fetch summary: volumes=%d total_series=%d "
            "metric_queries_with_data=%d errors=%d",
            total_volumes,
            total_series,
            metrics_with_data,
            len(volume_errors),
        )

        if volume_errors and len(volume_errors) == total_volumes:
            raise RuntimeError(
                "[AnfMetrics] All volume metric queries failed; first error: "
                + volume_errors[0]
            )

        if collect_volumes and total_series == 0 and not volume_errors:
            raise RuntimeError(
                "[AnfMetrics] Azure Monitor returned no ingestible time series for "
                f"{total_volumes} ANF volume(s) in subscription {subscription_id!r} "
                f"between {start_time.isoformat()} and {end_time.isoformat()} "
                f"(region={region!r}, resource_group filter={resource_group!r}). "
                "Verify Monitoring Reader on volumes/subscription and that metrics "
                "exist for the requested time window."
            )

        volume_rows = _flatten_rows(volume_data) if collect_volumes else []
        cluster_id = volumes[0].get("netapp_account", "") if volumes else ""
        tier_rows = (
            _flatten_tier_rows(tier_data, cluster_id=cluster_id) if collect_tiers else []
        )
        logger.info(
            "[AnfMetrics] flattened %d volumes into %d volume rows and %d tier rows",
            len(volume_data),
            len(volume_rows),
            len(tier_rows),
        )
        return volume_rows, tier_rows

    async def _fetch_pool_metrics(
        self,
        subscription_id: str,
        start_time: datetime,
        end_time: datetime,
        credential: Any,
        *,
        resource_group: str = "",
        region: str = "",
        heartbeat: Optional[Callable[..., None]] = None,
        volumes: Optional[List[Dict[str, str]]] = None,
    ) -> List[Dict[str, Any]]:
        if not region:
            raise ValueError(
                "ANF pool metrics fetch requires default_region (Azure region of ANF pools)"
            )
        try:
            from azure.core.exceptions import HttpResponseError
        except ImportError as e:
            raise RuntimeError(
                "[AnfMetrics] azure-core is not installed in this worker image "
                f"(import failed: {e})."
            ) from e

        client = _create_metrics_client(credential, region)
        if volumes is None:
            volumes = await asyncio.to_thread(
                _list_anf_volumes,
                credential,
                subscription_id,
                region,
                resource_group,
            )
        pools = _unique_pools_from_volumes(volumes)
        if not pools:
            raise RuntimeError(
                "[AnfMetrics] No ANF capacity pools found in subscription "
                f"{subscription_id!r} region {region!r}."
            )

        query_windows = _iter_metrics_query_windows(start_time, end_time)
        if not query_windows:
            query_windows = [(start_time, end_time)]

        pool_data: Dict[str, Dict[str, Dict[str, Any]]] = {}
        pool_errors: List[str] = []
        total_series = 0
        total_pools = len(pools)

        for p_idx, pool in enumerate(pools, start=1):
            _safe_heartbeat(
                heartbeat,
                f"anf:pool {p_idx}/{total_pools}:{pool['pool_name']}",
            )
            pool_series = 0
            chunk_errors: List[str] = []
            for chunk_idx, (chunk_start, chunk_end) in enumerate(query_windows, start=1):
                try:
                    result = await asyncio.to_thread(
                        _query_pool_metrics,
                        client,
                        pool["pool_id"],
                        chunk_start,
                        chunk_end,
                        region=region,
                    )
                    for metric_name in ANF_POOL_METRIC_NAMES:
                        ts_count, _ = _ingest_pool_metrics_result(
                            result,
                            metric_name,
                            pool_data,
                            resource_group_filter=resource_group,
                            pool_context=pool,
                        )
                        pool_series += ts_count
                except HttpResponseError as e:
                    logger.exception(
                        "[AnfMetrics] HttpResponseError fetching pool %s: %s",
                        pool["pool_name"],
                        e,
                    )
                    chunk_errors.append(f"{type(e).__name__}: {e}")
                except Exception as e:
                    logger.exception(
                        "[AnfMetrics] unexpected error fetching pool %s: %s",
                        pool["pool_name"],
                        e,
                    )
                    chunk_errors.append(f"{type(e).__name__}: {e}")

            if chunk_errors and pool_series == 0:
                pool_errors.append(
                    f"{pool['pool_name']}: " + "; ".join(chunk_errors[:3])
                )
            total_series += pool_series

        if pool_errors and len(pool_errors) == total_pools:
            raise RuntimeError(
                "[AnfMetrics] All pool metric queries failed; first error: "
                + pool_errors[0]
            )
        if total_series == 0 and not pool_errors:
            raise RuntimeError(
                "[AnfMetrics] Azure Monitor returned no ingestible pool time series for "
                f"{total_pools} ANF pool(s) in subscription {subscription_id!r} "
                f"between {start_time.isoformat()} and {end_time.isoformat()}."
            )

        cluster_id = pools[0].get("netapp_account", "") if pools else ""
        rows = _flatten_pool_rows(pool_data, cluster_id=cluster_id)
        logger.info("[AnfMetrics] flattened %d pool rows", len(rows))
        return rows


# Backward-compatible aliases for tests and external imports.
_build_credential = build_credential
_arm_bearer_token = arm_bearer_token
_parse_resource_id = parse_resource_id
_resource_group_from_arm = resource_group_from_arm
