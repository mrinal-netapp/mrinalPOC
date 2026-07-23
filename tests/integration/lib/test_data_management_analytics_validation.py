"""Unit tests for dataset analytics validation helpers."""

from __future__ import annotations

import pytest

from lib.data_management.analytics_validation import (
    ONTAP_EXPECTED_METRIC_COLUMNS,
    _assert_ontap_preview_metric_columns,
    preview_column_names,
    preview_row_count,
)


class TestPreviewColumnNames:
    def test_string_columns(self):
        body = {"columns": ["timestamp", "address_id", "city"]}
        assert preview_column_names(body) == {"timestamp", "address_id", "city"}

    def test_dict_columns(self):
        body = {"columns": [{"name": "actor_id"}, {"name": "first_name"}]}
        assert preview_column_names(body) == {"actor_id", "first_name"}


class TestPreviewRowCount:
    def test_total_count(self):
        assert preview_row_count({"totalCount": 42}) == 42

    def test_rows_fallback(self):
        assert preview_row_count({"rows": [{}, {}]}) == 2


class TestOntapMetricColumns:
    def test_accepts_volume_metrics(self):
        cols = ONTAP_EXPECTED_METRIC_COLUMNS["volume_metrics"]
        _assert_ontap_preview_metric_columns(set(cols), ["volume_metrics"])

    def test_rejects_missing_cluster_id(self):
        with pytest.raises(AssertionError, match="baseline columns"):
            _assert_ontap_preview_metric_columns({"timestamp", "volume_id"}, ["volume_metrics"])
