"""Unit tests for statistics helpers in processing.files:

- `compute_column_stats` (all category branches, histogram, categorical vs. avgLength,
  max_columns limiting, exception-swallowing per column)
- `compute_file_stats` (extension/size/age distributions, "Other" bucket, missing
  columns, malformed timestamps, exception-swallowing per distribution)
- `_compute_pii_summary` (present/absent columns, exception handling)
"""

import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

import pyarrow as pa
import pyarrow.compute as pc

from processing.files import (
    _compute_pii_summary,
    compute_column_stats,
    compute_file_stats,
)


class TestComputeColumnStatsCategories(unittest.TestCase):
    def test_boolean_all_null_skips_true_count_and_falls_to_categorical(self):
        # valid_count == 0 means the "boolean and valid_count > 0" branch is
        # skipped; since none of the other specific branches match either
        # (integer/float/temporal), the code falls into the generic `else`
        # branch which reclassifies low-cardinality columns as "categorical".
        # This documents actual behavior for an edge case with no valid rows.
        table = pa.table({"flag": pa.array([None, None], type=pa.bool_())})
        stats = compute_column_stats(table)
        col = stats["columns"]["flag"]
        self.assertEqual(col["category"], "categorical")
        self.assertNotIn("trueCount", col)

    def test_integer_histogram_when_range_positive(self):
        table = pa.table({"age": list(range(20))})
        stats = compute_column_stats(table)
        col = stats["columns"]["age"]
        self.assertIn("histogram", col)
        self.assertEqual(len(col["histogram"]), 10)
        self.assertIn("min", col)
        self.assertIn("max", col)
        self.assertIn("avg", col)
        self.assertIn("approxUnique", col)

    def test_integer_no_histogram_when_min_equals_max(self):
        table = pa.table({"const": [5, 5, 5]})
        stats = compute_column_stats(table)
        col = stats["columns"]["const"]
        self.assertNotIn("histogram", col)

    def test_float_column_stats_without_histogram(self):
        table = pa.table({"score": [1.5, 2.5, 3.5]})
        stats = compute_column_stats(table)
        col = stats["columns"]["score"]
        self.assertEqual(col["category"], "float")
        self.assertIn("avg", col)
        self.assertNotIn("histogram", col)

    def test_decimal_column_classified_as_float(self):
        table = pa.table({"amount": pa.array([1, 2], type=pa.decimal128(10, 2))})
        stats = compute_column_stats(table)
        self.assertEqual(stats["columns"]["amount"]["category"], "float")

    def test_temporal_column_min_max(self):
        now = datetime.now(timezone.utc)
        table = pa.table({"ts": pa.array([now, now + timedelta(days=1)])})
        stats = compute_column_stats(table)
        col = stats["columns"]["ts"]
        self.assertEqual(col["category"], "temporal")
        self.assertIn("min", col)
        self.assertIn("max", col)
        self.assertIn("approxUnique", col)

    def test_low_cardinality_string_becomes_categorical_with_histogram(self):
        table = pa.table({"status": ["a", "b", "a", "a", "b"]})
        stats = compute_column_stats(table)
        col = stats["columns"]["status"]
        self.assertEqual(col["category"], "categorical")
        self.assertIn("histogram", col)
        labels = {b["label"] for b in col["histogram"]}
        self.assertEqual(labels, {"a", "b"})

    def test_categorical_includes_null_bucket(self):
        table = pa.table({"status": pa.array(["a", None, "a"], type=pa.string())})
        stats = compute_column_stats(table)
        col = stats["columns"]["status"]
        labels = {b["label"] for b in col["histogram"]}
        self.assertIn("(null)", labels)

    def test_high_cardinality_string_gets_avg_length_not_categorical(self):
        table = pa.table({"name": [f"unique-value-{i}" for i in range(30)]})
        stats = compute_column_stats(table)
        col = stats["columns"]["name"]
        self.assertEqual(col["category"], "string")
        self.assertIn("avgLength", col)
        self.assertNotIn("histogram", col)

    def test_max_columns_limits_processed_fields(self):
        table = pa.table({"a": [1], "b": [2], "c": [3]})
        stats = compute_column_stats(table, max_columns=2)
        self.assertEqual(set(stats["columns"].keys()), {"a", "b"})

    def test_empty_table_zero_rows(self):
        table = pa.table({"x": pa.array([], type=pa.int64())})
        stats = compute_column_stats(table)
        col = stats["columns"]["x"]
        self.assertEqual(col["count"], 0)
        self.assertEqual(col["nullPercentage"], 0.0)

    def test_median_exception_is_swallowed(self):
        table = pa.table({"age": [1, 2, 3]})
        with mock.patch.object(pc, "approximate_median", side_effect=RuntimeError("boom")):
            stats = compute_column_stats(table)
        col = stats["columns"]["age"]
        self.assertNotIn("median", col)
        self.assertIn("min", col)

    def test_per_column_exception_falls_back_to_zero_stat(self):
        table = pa.table({"age": [1, 2, 3], "name": ["a", "b", "c"]})
        with mock.patch.object(pc, "min", side_effect=RuntimeError("boom")):
            stats = compute_column_stats(table)
        col = stats["columns"]["age"]
        self.assertEqual(col["count"], 0)
        self.assertEqual(col["nullCount"], 0)


class TestComputeFileStats(unittest.TestCase):
    def test_missing_columns_produce_empty_distributions(self):
        table = pa.table({"other": [1, 2, 3]})
        stats = compute_file_stats(table)
        self.assertEqual(stats["extensionDistribution"], [])
        self.assertEqual(stats["sizeDistribution"], [])
        self.assertEqual(stats["ageDistribution"], [])
        self.assertEqual(stats["totalFiles"], 3)

    def test_extension_distribution_groups_others_beyond_top_nine(self):
        extensions = [f".ext{i}" for i in range(11)]
        table = pa.table({"extension": extensions})
        stats = compute_file_stats(table)
        self.assertEqual(len(stats["extensionDistribution"]), 10)
        self.assertEqual(stats["extensionDistribution"][-1]["label"], "Other")
        self.assertEqual(stats["extensionDistribution"][-1]["count"], 2)

    def test_extension_distribution_handles_null_label(self):
        table = pa.table({"extension": pa.array([None, ".txt"], type=pa.string())})
        stats = compute_file_stats(table)
        labels = {b["label"] for b in stats["extensionDistribution"]}
        self.assertIn("(none)", labels)

    def test_size_distribution_buckets_across_all_ranges(self):
        sizes = [500, 50_000, 500_000, 5_000_000, 50_000_000, 500_000_000, 2_000_000_000]
        table = pa.table({"file_size": sizes})
        stats = compute_file_stats(table)
        self.assertEqual(stats["totalSizeBytes"], sum(sizes))
        self.assertEqual(stats["avgFileSizeBytes"], sum(sizes) // len(sizes))
        counts = {b["label"]: b["count"] for b in stats["sizeDistribution"]}
        self.assertEqual(counts["< 1 KB"], 1)
        self.assertEqual(counts["1-100 KB"], 1)
        self.assertEqual(counts["100 KB-1 MB"], 1)
        self.assertEqual(counts["1-10 MB"], 1)
        self.assertEqual(counts["10-100 MB"], 1)
        self.assertEqual(counts["100 MB-1 GB"], 1)
        self.assertEqual(counts["> 1 GB"], 1)
        self.assertIn("medianFileSizeBytes", stats)

    def test_size_distribution_with_nulls(self):
        table = pa.table({"file_size": pa.array([100, None, 200], type=pa.int64())})
        stats = compute_file_stats(table)
        self.assertEqual(stats["avgFileSizeBytes"], 150)

    def test_size_distribution_all_null_avoids_division_by_zero(self):
        table = pa.table({"file_size": pa.array([None, None], type=pa.int64())})
        stats = compute_file_stats(table)
        self.assertEqual(stats["avgFileSizeBytes"], 0)

    def test_age_distribution_from_iso_strings(self):
        now = datetime.now(timezone.utc)
        recent = (now - timedelta(days=5)).isoformat()
        old = (now - timedelta(days=800)).isoformat()
        table = pa.table({"modified_time": [recent, old]})
        stats = compute_file_stats(table)
        self.assertEqual(stats["oldestFile"][:4], str((now - timedelta(days=800)).year))
        counts = {b["label"]: b["count"] for b in stats["ageDistribution"]}
        self.assertEqual(counts["< 30 days"], 1)
        self.assertEqual(counts["> 2 years"], 1)

    def test_age_distribution_from_naive_datetime(self):
        now = datetime.now(timezone.utc)
        naive = (now - timedelta(days=10)).replace(tzinfo=None)
        table = pa.table({"modified_time": pa.array([naive], type=pa.timestamp("us"))})
        stats = compute_file_stats(table)
        counts = {b["label"]: b["count"] for b in stats["ageDistribution"]}
        self.assertEqual(counts["< 30 days"], 1)

    def test_age_distribution_skips_invalid_string_and_none(self):
        table = pa.table({"modified_time": pa.array(["not-a-date", None], type=pa.string())})
        stats = compute_file_stats(table)
        self.assertNotIn("oldestFile", stats)
        self.assertEqual(sum(b["count"] for b in stats["ageDistribution"]), 0)

    def test_age_distribution_skips_unsupported_value_types(self):
        table = pa.table({"modified_time": pa.array([123], type=pa.int64())})
        stats = compute_file_stats(table)
        self.assertEqual(sum(b["count"] for b in stats["ageDistribution"]), 0)

    def test_extension_distribution_exception_is_swallowed(self):
        table = pa.table({"extension": [".txt"]})
        with mock.patch.object(pc, "value_counts", side_effect=RuntimeError("boom")):
            stats = compute_file_stats(table)
        self.assertEqual(stats["extensionDistribution"], [])

    def test_size_distribution_exception_is_swallowed(self):
        table = pa.table({"file_size": [100]})
        with mock.patch.object(pc, "sum", side_effect=RuntimeError("boom")):
            stats = compute_file_stats(table)
        self.assertEqual(stats["sizeDistribution"], [])


class TestComputePiiSummary(unittest.TestCase):
    def test_no_has_pii_column_returns_none(self):
        table = pa.table({"x": [1, 2]})
        self.assertIsNone(_compute_pii_summary(table))

    def test_counts_with_risk_level_column(self):
        table = pa.table({
            "has_pii": [True, True, False, True],
            "pii_risk_level": ["high", "medium", "none", "low"],
        })
        summary = _compute_pii_summary(table)
        self.assertEqual(summary["filesWithPii"], 3)
        self.assertEqual(summary["totalFiles"], 4)
        self.assertEqual(summary["filesWithHighRisk"], 1)
        self.assertEqual(summary["filesWithMediumRisk"], 1)
        self.assertEqual(summary["filesWithLowRisk"], 1)
        self.assertTrue(summary["piiAnalysisEnabled"])

    def test_counts_without_risk_level_column_default_zero(self):
        table = pa.table({"has_pii": [True, False]})
        summary = _compute_pii_summary(table)
        self.assertEqual(summary["filesWithPii"], 1)
        self.assertEqual(summary["filesWithHighRisk"], 0)
        self.assertEqual(summary["filesWithMediumRisk"], 0)
        self.assertEqual(summary["filesWithLowRisk"], 0)

    def test_null_has_pii_values_are_not_counted(self):
        table = pa.table({"has_pii": pa.array([None, True], type=pa.bool_())})
        summary = _compute_pii_summary(table)
        self.assertEqual(summary["filesWithPii"], 1)

    def test_exception_returns_none(self):
        bad_table = mock.Mock()
        bad_table.column_names = ["has_pii"]
        bad_table.column.side_effect = RuntimeError("boom")
        self.assertIsNone(_compute_pii_summary(bad_table))


if __name__ == "__main__":
    unittest.main()
