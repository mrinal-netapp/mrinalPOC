"""Unit tests for ANF pipeline analytics preview helpers."""

from __future__ import annotations

import pytest

from .anf_pipeline_setup import (
    EXPECTED_METRIC_COLUMNS,
    _assert_preview_metric_columns,
    _preview_column_names,
)


class TestPreviewColumnNames:
    def test_string_columns(self):
        body = {"columns": ["timestamp", "source_type", "pool_id"]}
        assert _preview_column_names(body) == {"timestamp", "source_type", "pool_id"}

    def test_dict_columns_with_name(self):
        body = {
            "columns": [
                {"name": "timestamp", "type": "TIMESTAMP"},
                {"name": "volume_id", "type": "STRING"},
            ]
        }
        assert _preview_column_names(body) == {"timestamp", "volume_id"}

    def test_dict_columns_with_Name_key(self):
        body = {"columns": [{"Name": "iops_total"}]}
        assert _preview_column_names(body) == {"iops_total"}

    def test_empty_columns(self):
        assert _preview_column_names({}) == set()


class TestAssertPreviewMetricColumns:
    def test_accepts_full_pool_metrics_signature(self):
        cols = EXPECTED_METRIC_COLUMNS["pool_metrics"]
        _assert_preview_metric_columns(set(cols), ["pool_metrics"])

    def test_accepts_one_category_when_multi_selected(self):
        pool_cols = EXPECTED_METRIC_COLUMNS["pool_metrics"]
        _assert_preview_metric_columns(
            set(pool_cols),
            ["volume_metrics", "pool_metrics", "volume_tier_metrics"],
        )

    def test_rejects_partial_category_overlap(self):
        cols = {"timestamp", "source_type", "pool_id"}
        with pytest.raises(BaseException, match="partially matches pool_metrics"):
            _assert_preview_metric_columns(cols, ["pool_metrics"])

    def test_rejects_missing_baseline(self):
        with pytest.raises(AssertionError, match="baseline columns"):
            _assert_preview_metric_columns({"pool_id"}, ["pool_metrics"])
