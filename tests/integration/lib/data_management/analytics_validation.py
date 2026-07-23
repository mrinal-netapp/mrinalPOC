"""Analytics preview / stats validation after dataset acquire or import."""

from __future__ import annotations

from typing import Any, Literal

import allure
import pytest

from lib.common.platform_client import PlatformClient
from lib.common.settings import IntegrationSettings

AnalyticsKind = Literal["basic", "structured", "metrics"]

# GCP / azure_cloud metrics — aligned with connector-worker parquet schemas.
GCP_AZURE_EXPECTED_METRIC_COLUMNS: dict[str, set[str]] = {
    "volume_metrics": {
        "timestamp",
        "source_type",
        "volume_id",
        "iops_total",
        "throughput_total_bytes",
    },
    "pool_metrics": {
        "timestamp",
        "source_type",
        "pool_id",
        "capacity_bytes",
    },
    "volume_tier_metrics": {
        "timestamp",
        "source_type",
        "volume_id",
        "tier_name",
    },
}

GCP_AZURE_DISTINCTIVE_METRIC_COLUMNS: dict[str, set[str]] = {
    "volume_metrics": {"volume_id", "iops_total", "throughput_total_bytes"},
    "pool_metrics": {"pool_id", "capacity_bytes"},
    "volume_tier_metrics": {"volume_id", "tier_name"},
}

# ONTAP metrics — column subsets aligned with connector-worker parquet schemas.
ONTAP_EXPECTED_METRIC_COLUMNS: dict[str, set[str]] = {
    "volume_metrics": {
        "timestamp",
        "source_type",
        "cluster_id",
        "volume_id",
        "iops_total",
    },
    "aggregate_metrics": {
        "timestamp",
        "source_type",
        "cluster_id",
        "aggregate_id",
    },
    "quota_metrics": {
        "timestamp",
        "source_type",
        "cluster_id",
        "volume_id",
        "quota_used_bytes",
    },
}

ONTAP_DISTINCTIVE_METRIC_COLUMNS: dict[str, set[str]] = {
    "volume_metrics": {"volume_id", "iops_total"},
    "aggregate_metrics": {"aggregate_id"},
    "quota_metrics": {"quota_used_bytes"},
}


def preview_column_names(preview_body: dict[str, Any]) -> set[str]:
    """Normalize analytics preview columns (strings or {name: ...} dicts)."""
    names: set[str] = set()
    for col in preview_body.get("columns") or []:
        if isinstance(col, str):
            if col:
                names.add(col)
        elif isinstance(col, dict):
            name = col.get("name") or col.get("Name")
            if name:
                names.add(str(name))
    return names


def preview_row_count(preview_body: dict[str, Any]) -> int:
    for key in ("totalCount", "totalRows", "rowCount"):
        value = preview_body.get(key)
        if value is not None:
            try:
                return int(value)
            except (TypeError, ValueError):
                continue
    rows = preview_body.get("rows") or preview_body.get("data") or []
    if isinstance(rows, list):
        return len(rows)
    return 0


def _assert_gcp_azure_preview_metric_columns(
    columns: set[str], categories: list[str]
) -> None:
    baseline = {"timestamp", "source_type"}
    missing_baseline = baseline - columns
    assert not missing_baseline, (
        f"analytics preview missing baseline columns {sorted(missing_baseline)}; "
        f"got {sorted(columns)}"
    )
    matched: list[str] = []
    for category in categories:
        expected = GCP_AZURE_EXPECTED_METRIC_COLUMNS.get(category, set())
        if not expected:
            continue
        distinctive = GCP_AZURE_DISTINCTIVE_METRIC_COLUMNS.get(category, expected)
        if not (distinctive & columns):
            continue
        missing = expected - columns
        if missing:
            pytest.fail(
                f"analytics preview partially matches {category} "
                f"(missing {sorted(missing)}); got {sorted(columns)}"
            )
        matched.append(category)
    assert matched, (
        f"analytics preview has no recognized metric category columns; "
        f"categories={categories}, columns={sorted(columns)}"
    )


def _assert_ontap_preview_metric_columns(columns: set[str], categories: list[str]) -> None:
    baseline = {"timestamp", "source_type", "cluster_id"}
    missing_baseline = baseline - columns
    assert not missing_baseline, (
        f"ONTAP analytics preview missing baseline columns {sorted(missing_baseline)}; "
        f"got {sorted(columns)}"
    )
    matched: list[str] = []
    for category in categories:
        expected = ONTAP_EXPECTED_METRIC_COLUMNS.get(category, set())
        if not expected:
            continue
        distinctive = ONTAP_DISTINCTIVE_METRIC_COLUMNS.get(category, expected)
        if not (distinctive & columns):
            continue
        missing = expected - columns
        if missing:
            pytest.fail(
                f"ONTAP analytics preview partially matches {category} "
                f"(missing {sorted(missing)}); got {sorted(columns)}"
            )
        matched.append(category)
    assert matched, (
        f"ONTAP analytics preview has no recognized metric category columns; "
        f"categories={categories}, columns={sorted(columns)}"
    )


def validate_dataset_analytics(
    client: PlatformClient,
    settings: IntegrationSettings,
    namespace: str,
    table_name: str,
    *,
    kind: AnalyticsKind = "basic",
    metrics_provider: str | None = None,
    categories: list[str] | None = None,
    min_rows: int = 1,
) -> dict[str, Any]:
    """Run analytics preview + stats and assert query results after dataset is ready."""
    preview_body: dict[str, Any] = {}

    with allure.step(f"Analytics preview ({kind})"):
        preview = client.analytics_post(
            "/api/v1/datasets/preview",
            {
                "namespace": namespace,
                "table": table_name,
                "limit": 10,
                "offset": 0,
                "filters": [],
            },
        )
        assert preview.status_code == 200, preview.text
        preview_body = preview.json()
        columns = preview_column_names(preview_body)
        assert columns, f"expected analytics columns, got: {preview_body}"

        if kind == "structured":
            row_count = preview_row_count(preview_body)
            assert row_count >= min_rows, (
                f"structured preview returned {row_count} rows (expected >= {min_rows}); "
                f"columns={sorted(columns)}"
            )
            print(
                f"[data_mgmt] structured preview rows={row_count} "
                f"columns={len(columns)}"
            )
        elif kind == "metrics":
            assert metrics_provider and categories, (
                "metrics validation requires metrics_provider and categories"
            )
            if metrics_provider == "ontap":
                _assert_ontap_preview_metric_columns(columns, categories)
            else:
                _assert_gcp_azure_preview_metric_columns(columns, categories)
            row_count = preview_row_count(preview_body)
            if row_count == 0:
                print(
                    f"[data_mgmt] metrics preview returned 0 rows for {metrics_provider} "
                    f"(subscription may have no resources in range)"
                )
            else:
                print(
                    f"[data_mgmt] metrics preview rows={row_count} "
                    f"provider={metrics_provider}"
                )

    with allure.step("Analytics stats"):
        stats = client.analytics_post(
            "/api/v1/datasets/stats",
            {"namespace": namespace, "table": table_name, "filters": []},
        )
        assert stats.status_code == 200, stats.text
        stats_body = stats.json()
        assert stats_body is not None

    return preview_body
