"""Tests for schema-only metrics table stubs and volume_metrics v2 schema."""
from __future__ import annotations

import pyarrow.parquet as pq

from adapters.gcnv_metrics_adapter import GcnvMetricsAdapter
from adapters.metric_table_schemas import (
    POOL_METRICS_SCHEMA,
    QUOTA_METRICS_SCHEMA,
    VOLUME_METRICS_SCHEMA,
    VOLUME_TIER_METRICS_SCHEMA,
    build_quota_metrics_rows,
    normalize_metric_categories,
    normalize_volume_metrics_row,
    write_empty_category_parquet,
)
from datetime import datetime, timezone


def test_volume_metrics_schema_has_v2_columns():
    names = {field.name for field in VOLUME_METRICS_SCHEMA}
    assert "account_id" in names
    assert "iops_other" in names
    assert "qos_policy" in names
    assert "qos_policy_name" not in names
    assert "quota_used_bytes" not in names


def test_anf_field_for_metric_maps_v2_columns():
    from adapters.anf_metrics_adapter import (
        _field_for_metric,
        _field_for_pool_metric,
        _field_for_tier_metric,
    )

    assert _field_for_metric("OtherIops") == "iops_other"
    assert _field_for_metric("TotalThroughput") == "throughput_total_bytes"
    assert _field_for_metric("VolumeInodesUsed") == "inode_used"
    assert _field_for_metric("VolumeInodesQuota") == "inode_limit"
    assert _field_for_metric("ThroughputLimitReached") == "throughput_limit_hit"
    assert _field_for_metric("QosLatencyDelta") == "qos_latency_delta_us"
    assert _field_for_pool_metric("VolumePoolTotalLogicalSize") == "used_bytes"
    assert _field_for_tier_metric("VolumeCoolTierSize") == ("tier_footprint_bytes", "cold")


def test_normalize_volume_metrics_row_derives_totals():
    row = normalize_volume_metrics_row({
        "timestamp": None,
        "source_type": "gcnv",
        "iops_read": 10.0,
        "iops_write": 5.0,
        "iops_other": 2.0,
        "throughput_read_bytes": 100.0,
        "throughput_write_bytes": 50.0,
        "space_used_bytes": 25,
        "space_total_bytes": 100,
        "inode_used": 10,
        "inode_limit": 50,
        "latency_read_us": 1000.0,
        "latency_write_us": 2000.0,
    })
    assert row["iops_total"] == 17.0
    assert row["throughput_total_bytes"] == 150.0
    assert row["space_used_percent"] == 25.0
    assert row["inode_used_percent"] == 20.0
    assert row["latency_avg_us"] == 1500.0


def test_gcnv_field_for_tier_metric_maps_cold_and_hot_footprint():
    assert GcnvMetricsAdapter._field_for_tier_metric(
        "netapp.googleapis.com/volume/auto_tiering/cold_tier_read_byte_count", {}
    ) == ("tier_read_bytes", "cold")
    assert GcnvMetricsAdapter._field_for_tier_metric(
        "netapp.googleapis.com/volume/auto_tiering/tiered_bytes", {"tier": "hot"}
    ) == ("tier_footprint_bytes", "hot")
    assert GcnvMetricsAdapter._field_for_tier_metric(
        "netapp.googleapis.com/volume/auto_tiering/tiered_bytes", {"tier": "non cold"}
    ) == ("tier_footprint_bytes", "hot")


def test_gcnv_field_for_pool_metric_maps_capacity_and_replication():
    assert GcnvMetricsAdapter._field_for_pool_metric(
        "netapp.googleapis.com/storage_pool/capacity", {}
    ) == "capacity_bytes"
    assert GcnvMetricsAdapter._field_for_pool_metric(
        "netapp.googleapis.com/storage_pool/replication_status", {}
    ) == "replication_sync_status"
    assert GcnvMetricsAdapter._field_for_pool_metric(
        "netapp.googleapis.com/storage_pool/auto_tiering/tiered_bytes", {"tier": "cold"}
    ) == "tier_cold_bytes"
    assert GcnvMetricsAdapter._field_for_pool_metric(
        "netapp.googleapis.com/storage_pool/auto_tiering/tiered_bytes", {"tier": "hot"}
    ) is None
    assert GcnvMetricsAdapter._field_for_metric(
        "netapp.googleapis.com/volume/operation_count", {"type": "metadata"}
    ) == "iops_other"
    assert GcnvMetricsAdapter._field_for_metric(
        "netapp.googleapis.com/volume/average_latency", {"type": "metadata"}
    ) == "latency_other_us"
    assert GcnvMetricsAdapter._field_for_metric(
        "netapp.googleapis.com/volume/inode_used", {}
    ) == "inode_used"


def test_normalize_metric_categories_maps_quota_reports_alias():
    assert normalize_metric_categories({"quota_reports", "volume_metrics"}) == {
        "quota_metrics",
        "volume_metrics",
    }


def test_build_quota_metrics_rows():
    ts = datetime(2026, 5, 30, 12, 0, tzinfo=timezone.utc)
    rows = build_quota_metrics_rows(
        {
            "vol1": {"used": 100, "limit": 1000, "volume_id": "uuid-1"},
        },
        "cluster-01",
        ts,
    )
    assert len(rows) == 1
    assert rows[0]["volume_name"] == "vol1"
    assert rows[0]["quota_used_bytes"] == 100
    assert rows[0]["volume_id"] == "uuid-1"


def test_write_empty_quota_metrics_parquet(tmp_path):
    path = write_empty_category_parquet(str(tmp_path), "quota_metrics")
    table = pq.read_table(path)
    assert table.schema.equals(QUOTA_METRICS_SCHEMA)
    assert table.num_rows == 0


def test_write_empty_pool_metrics_parquet(tmp_path):
    path = write_empty_category_parquet(str(tmp_path), "pool_metrics")
    table = pq.read_table(path)
    assert table.schema.equals(POOL_METRICS_SCHEMA)
    assert table.num_rows == 0


def test_write_empty_volume_tier_metrics_parquet(tmp_path):
    path = write_empty_category_parquet(str(tmp_path), "volume_tier_metrics")
    table = pq.read_table(path)
    assert table.schema.equals(VOLUME_TIER_METRICS_SCHEMA)
    assert table.num_rows == 0
