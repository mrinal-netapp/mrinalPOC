package workflows

import (
	"testing"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDecideConsumerCount(t *testing.T) {
	cfg := types.AcquisitionPipelineConfig{
		MaxAcquireConsumers:    8,
		BatchSize:              64,
		MaxBatchesPerActivity:  8,
		UnboundedConsumers:     6,
		ScheduleToStartTimeout: 15 * time.Minute,
	}

	cases := []struct {
		name            string
		totalDiscovered int
		want            int
	}{
		{"unbounded source uses UnboundedConsumers", -1, 6},
		{"empty source still spawns one consumer for clean exit", 0, 1},
		{"small workload fits one consumer", 200, 1},
		{"medium workload scales up", 2000, 4}, // ceil(2000 / (64*8 = 512)) = 4
		{"large workload caps at MaxAcquireConsumers", 11_000, 8},
		{"huge workload also caps", 1_000_000, 8},
		// Right at the boundary: 512 -> 1, 513 -> 2
		{"exactly per-consumer capacity = 1 consumer", 512, 1},
		{"one over capacity = 2 consumers", 513, 2},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := decideConsumerCount(tc.totalDiscovered, cfg)
			assert.Equal(t, tc.want, got)
		})
	}
}

func TestDecideConsumerCount_GuardsAgainstZeroCapacity(t *testing.T) {
	// If env vars are misconfigured to 0, we must not divide by zero -- fall back
	// to a sensible default and still cap at MaxAcquireConsumers.
	cfg := types.AcquisitionPipelineConfig{
		MaxAcquireConsumers:   8,
		BatchSize:             0,
		MaxBatchesPerActivity: 0,
		UnboundedConsumers:    8,
	}
	got := decideConsumerCount(11000, cfg)
	require.GreaterOrEqual(t, got, 1)
	require.LessOrEqual(t, got, cfg.MaxAcquireConsumers)
}

func TestExtractObjectStoreFilters_PrefersAcqConfigCamelCase(t *testing.T) {
	acq := map[string]interface{}{
		"fileGlob":           "*.parquet",
		"fileExcludePattern": "_temp/*",
	}
	dataset := map[string]interface{}{}
	glob, exclude := extractObjectStoreFilters(acq, dataset)
	assert.Equal(t, "*.parquet", glob)
	assert.Equal(t, "_temp/*", exclude)
}

func TestExtractObjectStoreFilters_FallsBackToSnakeCase(t *testing.T) {
	acq := map[string]interface{}{
		"file_glob":            "*.csv",
		"file_exclude_pattern": "**/.cache/*",
	}
	glob, exclude := extractObjectStoreFilters(acq, map[string]interface{}{})
	assert.Equal(t, "*.csv", glob)
	assert.Equal(t, "**/.cache/*", exclude)
}

func TestExtractObjectStoreFilters_FallsBackToFilterSpec(t *testing.T) {
	acq := map[string]interface{}{}
	dataset := map[string]interface{}{
		"filterSpec": map[string]interface{}{
			"fileGlob":           "*.json",
			"fileExcludePattern": "raw/*",
		},
	}
	glob, exclude := extractObjectStoreFilters(acq, dataset)
	assert.Equal(t, "*.json", glob)
	assert.Equal(t, "raw/*", exclude)
}

func TestResourceSelectorLooksLikeMetrics(t *testing.T) {
	cases := []struct {
		name     string
		selector interface{}
		want     bool
	}{
		{"nil selector", nil, false},
		{"empty selector", []interface{}{}, false},
		{
			"single metric category",
			[]interface{}{map[string]interface{}{"category": "volume_metrics"}},
			true,
		},
		{
			"multiple metric categories",
			[]interface{}{
				map[string]interface{}{"category": "volume_metrics"},
				map[string]interface{}{"category": "aggregate_metrics"},
			},
			true,
		},
		{
			"objectstore selector is not metrics",
			[]interface{}{map[string]interface{}{"bucket": "b", "prefix": "p"}},
			false,
		},
		{
			"empty category string is not a metric pick",
			[]interface{}{map[string]interface{}{"category": ""}},
			false,
		},
		{
			"non-string category is not a metric pick",
			[]interface{}{map[string]interface{}{"category": 42}},
			false,
		},
		// Mixed selectors are rejected by the dataset validator and the wizard,
		// but if one ever reaches the workflow we still treat it as metrics so
		// the user gets a clear "metrics adapter rejected non-metric entries"
		// error rather than a silent objectstore mis-route.
		{
			"mixed selector still routes to metrics",
			[]interface{}{
				map[string]interface{}{"bucket": "b", "prefix": "p"},
				map[string]interface{}{"category": "volume_metrics"},
			},
			true,
		},
		{"non-array selector", "garbage", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			assert.Equal(t, tc.want, resourceSelectorLooksLikeMetrics(tc.selector))
		})
	}
}

func TestMetricsProviderAllowed(t *testing.T) {
	assert.True(t, metricsProviderAllowed("ontap"))
	assert.True(t, metricsProviderAllowed("gcp"))
	assert.True(t, metricsProviderAllowed("azure_cloud"))
	// Legacy provider IDs from before the merge must be rejected so a stale
	// dataset cannot bypass the routing.
	assert.False(t, metricsProviderAllowed("ontap_metrics"))
	assert.False(t, metricsProviderAllowed("gcnv_metrics"))
	// Random or empty providers are rejected.
	assert.False(t, metricsProviderAllowed(""))
	assert.False(t, metricsProviderAllowed("postgresql"))
}

func TestApplyBucketPrefix(t *testing.T) {
	cfg := map[string]interface{}{"prefix": "old"}
	applyBucketPrefix(cfg, "my-bucket", "data/sub//")
	assert.Equal(t, "my-bucket", cfg["bucket"])
	// TrimSuffix removes one trailing slash per apply; double-slash becomes single.
	assert.Equal(t, "data/sub/", cfg["prefix"])
}

func TestApplyBucketPrefix_EmptyBucketLeavesPrefix(t *testing.T) {
	cfg := map[string]interface{}{"bucket": "keep", "prefix": "p"}
	applyBucketPrefix(cfg, "", "newprefix/")
	assert.Equal(t, "keep", cfg["bucket"])
	assert.Equal(t, "newprefix", cfg["prefix"])
}

func TestFirstObjectStoreSelector(t *testing.T) {
	ds := map[string]interface{}{
		"resourceSelector": []interface{}{
			map[string]interface{}{"category": "volume_metrics"},
			map[string]interface{}{"bucket": "b1", "prefix": "p1/"},
		},
	}
	sel, ok := firstObjectStoreSelector(ds)
	require.True(t, ok)
	assert.Equal(t, "b1", sel["bucket"])
	assert.Equal(t, "p1/", sel["prefix"])
}

func TestFirstObjectStoreSelector_SnakeCaseKey(t *testing.T) {
	ds := map[string]interface{}{
		"resource_selector": []interface{}{
			map[string]interface{}{"bucket": "sb", "prefix": "sp"},
		},
	}
	sel, ok := firstObjectStoreSelector(ds)
	require.True(t, ok)
	assert.Equal(t, "sb", sel["bucket"])
}

func TestFirstObjectStoreSelector_NoObjectStoreEntry(t *testing.T) {
	ds := map[string]interface{}{
		"resourceSelector": []interface{}{
			map[string]interface{}{"category": "volume_metrics"},
		},
	}
	_, ok := firstObjectStoreSelector(ds)
	assert.False(t, ok)
}

func TestApplySourcePath_WithDatasetBucketOverridesFirstSegment(t *testing.T) {
	cfg := map[string]interface{}{}
	applySourcePath(cfg, "wrong-bucket/prefix/path", "correct-bucket")
	assert.Equal(t, "correct-bucket", cfg["bucket"])
	assert.Equal(t, "prefix/path", cfg["prefix"])
}

func TestApplySourcePath_SingleSegmentUsesDatasetBucket(t *testing.T) {
	cfg := map[string]interface{}{}
	applySourcePath(cfg, "only-prefix", "ds-bucket")
	assert.Equal(t, "ds-bucket", cfg["bucket"])
	assert.Equal(t, "only-prefix", cfg["prefix"])
}

func TestApplySourcePath_TwoSegmentsNoDatasetBucket(t *testing.T) {
	cfg := map[string]interface{}{}
	applySourcePath(cfg, "src-bucket/k/v", "")
	assert.Equal(t, "src-bucket", cfg["bucket"])
	assert.Equal(t, "k/v", cfg["prefix"])
}

func TestExtractObjectStoreFilters_AcquisitionConfigWinsOverFilterSpec(t *testing.T) {
	acq := map[string]interface{}{
		"fileGlob":           "*.parquet",
		"fileExcludePattern": "tmp/*",
	}
	dataset := map[string]interface{}{
		"filterSpec": map[string]interface{}{
			"fileGlob":           "*.json",
			"fileExcludePattern": "raw/*",
		},
	}
	glob, exclude := extractObjectStoreFilters(acq, dataset)
	assert.Equal(t, "*.parquet", glob)
	assert.Equal(t, "tmp/*", exclude)
}

func TestExtractObjectStoreFilters_EmptyWhenUnset(t *testing.T) {
	glob, exclude := extractObjectStoreFilters(map[string]interface{}{}, map[string]interface{}{})
	assert.Equal(t, "", glob)
	assert.Equal(t, "", exclude)
}

func TestFirstObjectStoreSelector_SkipsEntriesWithoutPrefix(t *testing.T) {
	ds := map[string]interface{}{
		"resourceSelector": []interface{}{
			map[string]interface{}{"bucket": "only-bucket"},
			map[string]interface{}{"bucket": "b2", "prefix": "p2/"},
		},
	}
	sel, ok := firstObjectStoreSelector(ds)
	require.True(t, ok)
	assert.Equal(t, "b2", sel["bucket"])
}

func TestApplyBucketPrefix_OverwritesBucketAndNormalizesPrefix(t *testing.T) {
	cfg := map[string]interface{}{"bucket": "old", "prefix": "old/prefix/"}
	applyBucketPrefix(cfg, "new-bucket", "new/prefix/")
	assert.Equal(t, "new-bucket", cfg["bucket"])
	// TrimSuffix removes one trailing slash per call (see TestApplyBucketPrefix).
	assert.Equal(t, "new/prefix", cfg["prefix"])
}

func TestApplySourcePath_LegacyFilterSpecShape(t *testing.T) {
	cfg := map[string]interface{}{}
	applySourcePath(cfg, "legacy-bucket/path/to/data", "")
	assert.Equal(t, "legacy-bucket", cfg["bucket"])
	assert.Equal(t, "path/to/data", cfg["prefix"])
}

func TestObjectStoreSetIDPrefixStable(t *testing.T) {
	// Workflow scatter unit IDs must stay acq-s{N} — referenced by progress callbacks.
	assert.Equal(t, "acq-s", objectStoreSetIDPrefix)
	assert.Equal(t, "acq-s0", objectStoreSetIDPrefix+"0")
	assert.Equal(t, "acq-s3", objectStoreSetIDPrefix+"3")
}

func TestReadIntFromMap(t *testing.T) {
	m := map[string]interface{}{
		"asFloat": float64(7),
		"asInt":   3,
		"asInt64": int64(11),
		"asStr":   "skip",
	}
	assert.Equal(t, 7, readIntFromMap(m, "asFloat", -1))
	assert.Equal(t, 3, readIntFromMap(m, "asInt", -1))
	assert.Equal(t, 11, readIntFromMap(m, "asInt64", -1))
	// Non-numeric falls through to default
	assert.Equal(t, -1, readIntFromMap(m, "asStr", -1))
	assert.Equal(t, 42, readIntFromMap(m, "missing", 42))
}
