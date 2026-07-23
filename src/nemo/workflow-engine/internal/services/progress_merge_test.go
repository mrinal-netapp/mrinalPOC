package services

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestMergeProgressState_PreservesDiscoveryAfterUnitRollup(t *testing.T) {
	ps := NewProgressStore()
	wf := "wf-acq-1"

	ps.Set(wf, ProgressPayload{
		Phase:      "discovered",
		Percentage: 10,
		Message:    "Discovered 100 items",
		Extra: map[string]interface{}{
			"filesDiscovered": float64(100),
			"filesFiltered":   float64(5),
		},
	})
	ps.Set(wf, ProgressPayload{
		Phase:      "copying",
		Percentage: 10,
		TotalUnits: 2,
		Units: []UnitProgress{
			{UnitID: "set-0", Status: "pending", LastUpdated: time.Now()},
			{UnitID: "set-1", Status: "pending", LastUpdated: time.Now()},
		},
		Message: "Copying",
	})
	ps.Set(wf, ProgressPayload{
		UnitID:     "set-0",
		UnitStatus: "completed",
		UnitMetrics: map[string]interface{}{
			"fileCount":   3,
			"bytesCopied": int64(1024),
			"errorCount":  0,
		},
	})

	got := ps.Get(wf)
	require.NotNil(t, got)
	require.Equal(t, float64(100), got.Extra["filesDiscovered"])
	require.Equal(t, float64(5), got.Extra["filesFiltered"])
	require.Equal(t, int64(3), toInt64(got.Extra["fileCount"]))
	require.Equal(t, int64(1024), toInt64(got.Extra["bytesCopied"]))
}

func TestMergeProgressState_SumsBytesAndErrorsAcrossUnits(t *testing.T) {
	ps := NewProgressStore()
	wf := "wf-acq-2"
	ps.Set(wf, ProgressPayload{Phase: "copying", TotalUnits: 2})
	ps.Set(wf, ProgressPayload{
		UnitID: "u1", UnitStatus: "completed",
		UnitMetrics: map[string]interface{}{"fileCount": 2, "bytesCopied": int64(100), "errorCount": 1},
	})
	ps.Set(wf, ProgressPayload{
		UnitID: "u2", UnitStatus: "completed",
		UnitMetrics: map[string]interface{}{"fileCount": 3, "bytesCopied": int64(50), "errorCount": 2},
	})
	got := ps.Get(wf)
	require.NotNil(t, got)
	require.Equal(t, int64(5), toInt64(got.Extra["fileCount"]))
	require.Equal(t, int64(150), toInt64(got.Extra["bytesCopied"]))
	require.Equal(t, int64(3), toInt64(got.Extra["errorCount"]))
}
