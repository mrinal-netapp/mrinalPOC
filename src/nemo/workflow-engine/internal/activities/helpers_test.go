package activities

import (
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	corev1 "k8s.io/api/core/v1"
)

func TestGetServerPort_DefaultAndOverride(t *testing.T) {
	t.Setenv("PORT", "")
	assert.Equal(t, "8080", getServerPort())
	t.Setenv("PORT", "9999")
	assert.Equal(t, "9999", getServerPort())
}

func TestCalculateProgressPercentage_PhaseInterpolation(t *testing.T) {
	cases := []struct {
		phase   string
		pct     float64
		want    int
		fallbck bool
	}{
		// Per-phase percentage interpolation.
		{"processing_documents", 50, 14, false},    // 8..20 mid-point ~ 14
		{"generating_and_writing", 100, 95, false}, // hits exact end
		{"completed", 0, 100, true},                // fallback to phase-based heuristic
		{"unknown_phase", 50, 0, true},             // unknown -> default 0
	}
	for _, tc := range cases {
		got := calculateProgressPercentage(types.KBProgressInfo{
			Phase: tc.phase, Percentage: tc.pct,
		})
		assert.Equalf(t, tc.want, got, "phase=%s pct=%v", tc.phase, tc.pct)
	}
}

func TestCalculateProgressPercentage_FallbackHeuristics(t *testing.T) {
	for phase, want := range map[string]int{
		"initializing":  0,
		"listing_files": 1,
	} {
		got := calculateProgressPercentage(types.KBProgressInfo{Phase: phase})
		assert.Equalf(t, want, got, "phase=%s", phase)
	}
}

func TestCalculateDatasetProgressPercentage_PhaseInterpolation(t *testing.T) {
	cases := []struct {
		phase string
		pct   float64
		want  int
	}{
		{"processing", 50, 32},       // 5..60 mid-point ~ 32
		{"completed", 0, 100},        // exact 100
		{"writing_parquet", 100, 75}, // hits end
	}
	for _, tc := range cases {
		got := calculateDatasetProgressPercentage(types.DatasetProgressInfo{
			Phase: tc.phase, Percentage: tc.pct,
		})
		assert.Equalf(t, tc.want, got, "phase=%s pct=%v", tc.phase, tc.pct)
	}
}

func TestCalculateDatasetProgressPercentage_FallbackProcessingProgress(t *testing.T) {
	// processing phase without explicit Percentage uses files ratio.
	got := calculateDatasetProgressPercentage(types.DatasetProgressInfo{
		Phase: "processing", ProcessedFiles: 30, TotalFiles: 60,
	})
	// 5 + 55 * 0.5 = 32 (truncated)
	assert.Equal(t, 32, got)
}

func TestCalculateDatasetProgressPercentage_FallbackHeuristics(t *testing.T) {
	for phase, want := range map[string]int{
		"initializing":        0,
		"listing_files":       3,
		"writing_parquet":     65,
		"registering_catalog": 80,
		"pii_analysis":        94,
		"completed":           100,
		"unknown":             0,
	} {
		got := calculateDatasetProgressPercentage(types.DatasetProgressInfo{Phase: phase})
		assert.Equalf(t, want, got, "phase=%s", phase)
	}
}

func TestBuildEnvVars(t *testing.T) {
	got := buildEnvVars(map[string]string{"FOO": "bar", "BAZ": "qux"})
	assert.Len(t, got, 2)
	names := map[string]string{}
	for _, e := range got {
		names[e.Name] = e.Value
	}
	assert.Equal(t, "bar", names["FOO"])
	assert.Equal(t, "qux", names["BAZ"])
	assert.Empty(t, buildEnvVars(nil))
}

func TestBuildResourceList(t *testing.T) {
	got := buildResourceList(types.ResourceRequirements{CPU: "100m", Memory: "256Mi"})
	assert.Contains(t, got, corev1.ResourceCPU)
	assert.Contains(t, got, corev1.ResourceMemory)

	// Empty inputs -> empty list.
	empty := buildResourceList(types.ResourceRequirements{})
	assert.Len(t, empty, 0)
}
