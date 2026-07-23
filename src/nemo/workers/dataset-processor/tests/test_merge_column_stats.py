"""Tests for merge_column_stats() from the processing.files module."""

import unittest

from processing.files import merge_column_stats


class TestMergeColumnStats(unittest.TestCase):

    def test_empty_input(self):
        result = merge_column_stats([])
        self.assertEqual(result, {'columns': {}})

    def test_single_partition(self):
        stats = [{'columns': {
            'age': {
                'type': 'int64', 'category': 'integer',
                'count': 100, 'rowCount': 100, 'nullCount': 5,
                'min': '18', 'max': '65', 'avg': '35.5', 'median': '33',
            }
        }}]
        result = merge_column_stats(stats)
        self.assertEqual(result['columns']['age']['min'], '18.0')
        self.assertEqual(result['columns']['age']['max'], '65.0')

    def test_boolean_merge(self):
        stats = [
            {'columns': {'active': {
                'type': 'bool', 'category': 'boolean',
                'count': 100, 'rowCount': 100, 'nullCount': 0,
                'trueCount': 60, 'truePercentage': 60.0,
            }}},
            {'columns': {'active': {
                'type': 'bool', 'category': 'boolean',
                'count': 200, 'rowCount': 200, 'nullCount': 0,
                'trueCount': 80, 'truePercentage': 40.0,
            }}},
        ]
        result = merge_column_stats(stats)
        merged = result['columns']['active']
        self.assertEqual(merged['trueCount'], 140)
        self.assertAlmostEqual(merged['truePercentage'], 46.7, places=1)

    def test_integer_min_max(self):
        stats = [
            {'columns': {'val': {
                'type': 'int64', 'category': 'integer',
                'count': 50, 'rowCount': 50, 'nullCount': 0,
                'min': '10', 'max': '100', 'avg': '55',
            }}},
            {'columns': {'val': {
                'type': 'int64', 'category': 'integer',
                'count': 50, 'rowCount': 50, 'nullCount': 0,
                'min': '5', 'max': '200', 'avg': '105',
            }}},
        ]
        result = merge_column_stats(stats)
        merged = result['columns']['val']
        self.assertEqual(merged['min'], '5.0')
        self.assertEqual(merged['max'], '200.0')

    def test_weighted_average(self):
        stats = [
            {'columns': {'score': {
                'type': 'float64', 'category': 'float',
                'count': 100, 'rowCount': 100, 'nullCount': 0,
                'min': '0', 'max': '100', 'avg': '50',
            }}},
            {'columns': {'score': {
                'type': 'float64', 'category': 'float',
                'count': 300, 'rowCount': 300, 'nullCount': 0,
                'min': '10', 'max': '90', 'avg': '70',
            }}},
        ]
        result = merge_column_stats(stats)
        merged = result['columns']['score']
        self.assertEqual(merged['avg'], '65.0')

    def test_temporal_min_max(self):
        stats = [
            {'columns': {'ts': {
                'type': 'timestamp', 'category': 'temporal',
                'count': 50, 'rowCount': 50, 'nullCount': 0,
                'min': '2024-01-01T00:00:00', 'max': '2024-06-30T00:00:00',
            }}},
            {'columns': {'ts': {
                'type': 'timestamp', 'category': 'temporal',
                'count': 50, 'rowCount': 50, 'nullCount': 0,
                'min': '2024-03-15T00:00:00', 'max': '2024-12-31T00:00:00',
            }}},
        ]
        result = merge_column_stats(stats)
        merged = result['columns']['ts']
        self.assertEqual(merged['min'], '2024-01-01T00:00:00')
        self.assertEqual(merged['max'], '2024-12-31T00:00:00')

    def test_categorical_merge(self):
        stats = [
            {'columns': {'color': {
                'type': 'string', 'category': 'categorical',
                'count': 100, 'rowCount': 100, 'nullCount': 0,
                'histogram': [
                    {'label': 'red', 'count': 50},
                    {'label': 'blue', 'count': 50},
                ],
            }}},
            {'columns': {'color': {
                'type': 'string', 'category': 'categorical',
                'count': 100, 'rowCount': 100, 'nullCount': 0,
                'histogram': [
                    {'label': 'red', 'count': 30},
                    {'label': 'green', 'count': 70},
                ],
            }}},
        ]
        result = merge_column_stats(stats)
        merged = result['columns']['color']
        self.assertEqual(merged['category'], 'categorical')
        histogram = {b['label']: b['count'] for b in merged['histogram']}
        self.assertEqual(histogram['red'], 80)
        self.assertEqual(histogram['blue'], 50)
        self.assertEqual(histogram['green'], 70)

    def test_categorical_exceeds_threshold(self):
        buckets_a = [{'label': f'val_{i}', 'count': 5} for i in range(15)]
        buckets_b = [{'label': f'val_{i+10}', 'count': 5} for i in range(15)]
        stats = [
            {'columns': {'tag': {
                'type': 'string', 'category': 'categorical',
                'count': 75, 'rowCount': 75, 'nullCount': 0,
                'histogram': buckets_a,
            }}},
            {'columns': {'tag': {
                'type': 'string', 'category': 'categorical',
                'count': 75, 'rowCount': 75, 'nullCount': 0,
                'histogram': buckets_b,
            }}},
        ]
        result = merge_column_stats(stats)
        merged = result['columns']['tag']
        self.assertEqual(merged['category'], 'string')

    def test_string_avg_length(self):
        stats = [
            {'columns': {'name': {
                'type': 'string', 'category': 'string',
                'count': 100, 'rowCount': 100, 'nullCount': 0,
                'avgLength': 10.0,
            }}},
            {'columns': {'name': {
                'type': 'string', 'category': 'string',
                'count': 300, 'rowCount': 300, 'nullCount': 0,
                'avgLength': 20.0,
            }}},
        ]
        result = merge_column_stats(stats)
        merged = result['columns']['name']
        self.assertEqual(merged['avgLength'], 17.5)

    def test_null_count_merge(self):
        stats = [
            {'columns': {'val': {
                'type': 'int64', 'category': 'integer',
                'count': 90, 'rowCount': 90, 'nullCount': 10,
                'min': '1', 'max': '100',
            }}},
            {'columns': {'val': {
                'type': 'int64', 'category': 'integer',
                'count': 80, 'rowCount': 80, 'nullCount': 20,
                'min': '5', 'max': '95',
            }}},
        ]
        result = merge_column_stats(stats)
        merged = result['columns']['val']
        self.assertEqual(merged['count'], 170)
        self.assertEqual(merged['nullCount'], 30)
        expected_pct = round((30 / 200) * 100, 2)
        self.assertEqual(merged['nullPercentage'], expected_pct)


if __name__ == '__main__':
    unittest.main()
