package services

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestProgressStore_GetMissingReturnsNil(t *testing.T) {
	ps := NewProgressStore()
	assert.Nil(t, ps.Get("does-not-exist"))
}

func TestProgressStore_SetAndGetRoundTrip(t *testing.T) {
	ps := NewProgressStore()
	ps.Set("wf", ProgressPayload{Phase: "p", Percentage: 33, Message: "m"})

	got := ps.Get("wf")
	require.NotNil(t, got)
	assert.Equal(t, "p", got.Phase)
	assert.Equal(t, float64(33), got.Percentage)
	assert.Equal(t, "m", got.Message)
}

func TestProgressStore_GetReturnsCopy(t *testing.T) {
	ps := NewProgressStore()
	ps.Set("wf", ProgressPayload{
		Extra: map[string]interface{}{"k": 1},
		Units: []UnitProgress{{UnitID: "u1", Status: "running"}},
	})

	got := ps.Get("wf")
	require.NotNil(t, got)
	got.Extra["k"] = 999
	got.Units[0].Status = "mutated"

	again := ps.Get("wf")
	require.NotNil(t, again)
	assert.NotEqual(t, 999, again.Extra["k"], "Get must return a deep copy of Extra")
	assert.Equal(t, "running", again.Units[0].Status, "Get must return a deep copy of Units")
}

func TestProgressStore_DeleteRemovesEntry(t *testing.T) {
	ps := NewProgressStore()
	ps.Set("wf", ProgressPayload{Phase: "x"})
	ps.Delete("wf")
	assert.Nil(t, ps.Get("wf"))
}

func TestProgressStore_ReplaceMode(t *testing.T) {
	ps := NewProgressStore()
	ps.Set("wf", ProgressPayload{
		Phase: "starting",
		Extra: map[string]interface{}{"filesDiscovered": float64(100)},
	})
	ps.Set("wf", ProgressPayload{
		Phase:      "completed",
		Percentage: 100,
		Replace:    true,
		Extra:      map[string]interface{}{"final": "done"},
	})

	got := ps.Get("wf")
	require.NotNil(t, got)
	assert.Equal(t, "completed", got.Phase)
	assert.Equal(t, "done", got.Extra["final"])
	_, hadOld := got.Extra["filesDiscovered"]
	assert.False(t, hadOld, "Replace must clear merged extras")
}

func TestProgressStore_UnitMergeMaxesAndPreservesJobLevel(t *testing.T) {
	ps := NewProgressStore()
	ps.Set("wf", ProgressPayload{
		Phase: "discovered",
		Extra: map[string]interface{}{"filesDiscovered": float64(50)},
	})
	ps.Set("wf", ProgressPayload{
		UnitID:      "u1",
		UnitStatus:  "running",
		UnitMetrics: map[string]interface{}{"fileCount": 1},
	})
	ps.Set("wf", ProgressPayload{
		UnitID:      "u1",
		UnitStatus:  "completed",
		UnitMetrics: map[string]interface{}{"fileCount": 4},
	})

	got := ps.Get("wf")
	require.NotNil(t, got)
	assert.Equal(t, float64(50), got.Extra["filesDiscovered"])
	// completed unit's fileCount surfaces at job-level (counter for completed units)
	assert.Equal(t, int64(4), toInt64(got.Extra["fileCount"]))
}

func TestProgressStore_DefaultUnitStatusIsRunning(t *testing.T) {
	ps := NewProgressStore()
	ps.Set("wf", ProgressPayload{UnitID: "u1"})
	got := ps.Get("wf")
	require.NotNil(t, got)
	require.Len(t, got.Units, 1)
	assert.Equal(t, "running", got.Units[0].Status)
}

func TestProgressStore_UnitMetricsFallBackToExtra(t *testing.T) {
	ps := NewProgressStore()
	// No UnitMetrics, but Extra is provided — should land on the unit.
	ps.Set("wf", ProgressPayload{
		UnitID:     "u1",
		UnitStatus: "completed",
		Extra:      map[string]interface{}{"fileCount": 7},
	})
	got := ps.Get("wf")
	require.NotNil(t, got)
	require.Len(t, got.Units, 1)
	assert.Equal(t, int64(7), toInt64(got.Units[0].Metrics["fileCount"]))
}

func TestProgressStore_TotalUnitsPreservedAcrossPatches(t *testing.T) {
	ps := NewProgressStore()
	ps.Set("wf", ProgressPayload{TotalUnits: 5})
	ps.Set("wf", ProgressPayload{Phase: "running"})

	got := ps.Get("wf")
	require.NotNil(t, got)
	assert.Equal(t, 5, got.TotalUnits, "TotalUnits must persist across non-zero patches")
}

func TestProgressStore_CapsUnitsToMaxUnitsCap(t *testing.T) {
	ps := NewProgressStore()
	for i := 0; i < MaxUnitsCap+25; i++ {
		ps.Set("wf", ProgressPayload{
			UnitID:     unitID(i),
			UnitStatus: "running",
		})
	}
	got := ps.Get("wf")
	require.NotNil(t, got)
	assert.LessOrEqual(t, len(got.Units), MaxUnitsCap)
}

func unitID(i int) string {
	return "u-" + intToA(i)
}

func intToA(i int) string {
	if i == 0 {
		return "0"
	}
	digits := []byte{}
	neg := i < 0
	if neg {
		i = -i
	}
	for i > 0 {
		digits = append([]byte{byte('0' + i%10)}, digits...)
		i /= 10
	}
	if neg {
		digits = append([]byte{'-'}, digits...)
	}
	return string(digits)
}

func TestProgressStore_RecomputeUsesPercentageMaxAcrossUnits(t *testing.T) {
	ps := NewProgressStore()
	ps.Set("wf", ProgressPayload{
		UnitID: "a", UnitStatus: "running",
		UnitMetrics: map[string]interface{}{"percentage": float64(20)},
	})
	ps.Set("wf", ProgressPayload{
		UnitID: "b", UnitStatus: "running",
		UnitMetrics: map[string]interface{}{"percentage": float64(70)},
	})
	got := ps.Get("wf")
	require.NotNil(t, got)
	assert.Equal(t, float64(70), got.Percentage)
}

func TestUpsertUnit_Append(t *testing.T) {
	units := upsertUnit(nil, UnitProgress{UnitID: "x"})
	require.Len(t, units, 1)
	assert.Equal(t, "x", units[0].UnitID)
}

func TestUpsertUnit_ReplacesExisting(t *testing.T) {
	in := []UnitProgress{{UnitID: "x", Status: "running"}, {UnitID: "y", Status: "running"}}
	out := upsertUnit(in, UnitProgress{UnitID: "x", Status: "completed"})
	require.Len(t, out, 2)
	assert.Equal(t, "completed", out[0].Status)
}

func TestCapUnits_DropsOldestWhenOverCap(t *testing.T) {
	// Build 5 units with strictly increasing LastUpdated times; ask for cap of 2.
	units := []UnitProgress{
		{UnitID: "a", LastUpdated: time.Unix(1, 0)},
		{UnitID: "b", LastUpdated: time.Unix(5, 0)},
		{UnitID: "c", LastUpdated: time.Unix(2, 0)},
		{UnitID: "d", LastUpdated: time.Unix(6, 0)},
		{UnitID: "e", LastUpdated: time.Unix(3, 0)},
	}
	capped := capUnits(units, 2)
	require.Len(t, capped, 2)
	ids := []string{capped[0].UnitID, capped[1].UnitID}
	assert.ElementsMatch(t, []string{"d", "b"}, ids,
		"cap must keep the two most-recently-updated units")
}

func TestCapUnits_NoOpWhenUnderCap(t *testing.T) {
	units := []UnitProgress{{UnitID: "a"}, {UnitID: "b"}}
	require.Equal(t, units, capUnits(units, 5))
}

func TestSliceContains(t *testing.T) {
	assert.True(t, sliceContains([]string{"a", "b"}, "a"))
	assert.False(t, sliceContains([]string{"a", "b"}, "z"))
	assert.False(t, sliceContains(nil, "x"))
}

func TestMaxNumeric_VariousTypes(t *testing.T) {
	assert.Equal(t, float64(5), maxNumeric(float64(2), float64(5)))
	assert.Equal(t, float64(2), maxNumeric(float64(2), float64(1)))
	// non-numeric existing -> always pick incoming
	assert.Equal(t, 7, maxNumeric("x", 7))
	// non-numeric incoming -> keep existing
	assert.Equal(t, float64(3), maxNumeric(float64(3), "x"))
}

func TestToFloat_Variants(t *testing.T) {
	for _, v := range []interface{}{1, int32(1), int64(1), float64(1)} {
		got, ok := toFloat(v)
		require.True(t, ok)
		assert.Equal(t, float64(1), got)
	}
	_, ok := toFloat("not-a-number")
	assert.False(t, ok)
}

func TestToFloat64_Variants(t *testing.T) {
	for _, v := range []interface{}{1, int64(1), float64(1)} {
		got, ok := toFloat64(v)
		require.True(t, ok)
		assert.Equal(t, float64(1), got)
	}
	_, ok := toFloat64("nope")
	assert.False(t, ok)
}

func TestToInt64_Variants(t *testing.T) {
	assert.Equal(t, int64(0), toInt64("nope"))
	assert.Equal(t, int64(5), toInt64(int(5)))
	assert.Equal(t, int64(5), toInt64(int64(5)))
	assert.Equal(t, int64(5), toInt64(float64(5.7)))
}

func TestCopyExtraAndCopyUnits_NilSafe(t *testing.T) {
	assert.Nil(t, copyExtra(nil))
	assert.Nil(t, copyUnits(nil))
}
