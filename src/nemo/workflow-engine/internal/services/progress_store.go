package services

import (
	"sync"
	"time"
)

// UnitProgress holds per-unit (e.g. per-activity) progress for scatter-gather or streaming workflows.
type UnitProgress struct {
	UnitID      string                 `json:"unitId"`
	Status      string                 `json:"status"` // pending | running | completed | failed
	Metrics     map[string]interface{} `json:"metrics,omitempty"`
	LastUpdated time.Time              `json:"lastUpdated"`
}

// ProgressPayload represents transient job progress stored in memory.
type ProgressPayload struct {
	Phase       string                 `json:"phase"`
	Percentage  float64                `json:"percentage"`
	Message     string                 `json:"message,omitempty"`
	Current     int                    `json:"current,omitempty"`
	Total       int                    `json:"total,omitempty"`
	Elapsed     float64                `json:"elapsed,omitempty"` // seconds
	ETA         float64                `json:"eta,omitempty"`     // seconds
	Extra       map[string]interface{} `json:"extra,omitempty"`
	Replace     bool                   `json:"replace,omitempty"` // if true, replace entry (no merge); used for workflow-authored completed-only stats
	LastUpdated time.Time              `json:"lastUpdated"`

	// Per-unit progress (scatter-gather or streaming)
	TotalUnits int            `json:"totalUnits,omitempty"`
	Units      []UnitProgress `json:"units,omitempty"`

	// Unit-scoped update (only in POST body): when set, upsert this unit and recompute job-level from units
	UnitID      string                 `json:"unitId,omitempty"`
	UnitStatus  string                 `json:"unitStatus,omitempty"`
	UnitMetrics map[string]interface{} `json:"unitMetrics,omitempty"`
}

// MaxUnitsCap limits the number of units stored per workflow to avoid unbounded growth (e.g. streaming).
const MaxUnitsCap = 200

// Counter metrics: job-level = sum over units with status "completed" only.
var sumMetricKeys = []string{
	"documentsProcessed", "documentCount", "chunkCount", "vectorCount",
	"fileCount", "rowCount", "processedFiles", "chunksCreated", "vectorsCreated",
	"bytesCopied", "errorCount",
}

// Max metrics: job-level = max across units (or last).
var maxMetricKeys = []string{"percentage", "currentFile", "phase"}

// ProgressStore is a thread-safe in-memory store for transient workflow progress.
// Entries are cleaned up after 1 hour by a background sweep.
type ProgressStore struct {
	mu      sync.RWMutex
	entries map[string]*ProgressPayload // keyed by workflowId
	ttl     time.Duration
}

// NewProgressStore creates a new progress store and starts a background cleanup goroutine.
func NewProgressStore() *ProgressStore {
	ps := &ProgressStore{
		entries: make(map[string]*ProgressPayload),
		ttl:     1 * time.Hour,
	}
	go ps.cleanupLoop()
	return ps
}

// Set creates or updates a progress entry.
// When payload.UnitID is set, this is a unit-scoped update: upsert that unit (default status "running"),
// cap the units list, recompute job-level from units (sum over completed for counter keys), and store.
// When payload.UnitID is not set, this is a job-level update: if Replace is true, replace the entire
// job-level blob; otherwise merge Extra by max. Stored entry never persists UnitID/UnitStatus/UnitMetrics.
func (ps *ProgressStore) Set(workflowID string, payload ProgressPayload) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	merged := mergeProgressState(ps.entries[workflowID], payload, time.Now())
	ps.entries[workflowID] = merged
}

// mergeProgressExtra merges incoming extra into existing by taking max of numeric counters
// so progress never decreases when multiple activities post for the same workflow.
func mergeProgressExtra(existing, incoming map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{})
	for k, v := range existing {
		out[k] = v
	}
	mergeKeys := []string{
		"totalFiles", "processedFiles", "chunksCreated", "vectorsCreated", "documentCount", "chunkCount", "vectorCount",
		"storageMB", "totalDocuments", "documentsProcessed",
		"filesDiscovered", "filesFiltered", "filesListed",
	}
	for _, k := range mergeKeys {
		inVal, hasIn := incoming[k]
		if !hasIn {
			continue
		}
		exVal := out[k]
		out[k] = maxNumeric(exVal, inVal)
	}
	// Pass through non-merge fields from incoming (message, currentFile, etc.)
	for k, v := range incoming {
		if !sliceContains(mergeKeys, k) && v != nil {
			out[k] = v
		}
	}
	return out
}

func sliceContains(s []string, x string) bool {
	for _, v := range s {
		if v == x {
			return true
		}
	}
	return false
}

func maxNumeric(a, b interface{}) interface{} {
	na, oka := toFloat(a)
	nb, okb := toFloat(b)
	if !oka {
		return b
	}
	if !okb {
		return a
	}
	if nb > na {
		return b
	}
	return a
}

func toFloat(v interface{}) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case int32:
		return float64(x), true
	default:
		return 0, false
	}
}

// upsertUnit updates or appends a unit by UnitID.
func upsertUnit(units []UnitProgress, u UnitProgress) []UnitProgress {
	for i := range units {
		if units[i].UnitID == u.UnitID {
			units[i] = u
			return units
		}
	}
	return append(units, u)
}

// capUnits keeps at most cap units, retaining the most recently updated.
func capUnits(units []UnitProgress, cap int) []UnitProgress {
	if len(units) <= cap {
		return units
	}
	copied := make([]UnitProgress, len(units))
	copy(copied, units)
	for i := 0; i < len(copied); i++ {
		for j := 0; j < len(copied)-1-i; j++ {
			if copied[j].LastUpdated.Before(copied[j+1].LastUpdated) {
				copied[j], copied[j+1] = copied[j+1], copied[j]
			}
		}
	}
	return copied[:cap]
}

// recomputeJobLevelFromUnits derives job-level extra from the units list.
// Counters are summed only over units with status "completed"; max keys use max.
func recomputeJobLevelFromUnits(units []UnitProgress) *ProgressPayload {
	out := &ProgressPayload{Extra: make(map[string]interface{}), Percentage: -1}
	for _, k := range sumMetricKeys {
		var sum int64
		for _, u := range units {
			if u.Status != "completed" {
				continue
			}
			if v, ok := u.Metrics[k]; ok {
				sum += toInt64(v)
			}
		}
		if sum > 0 {
			out.Extra[k] = sum
		}
	}
	for _, k := range maxMetricKeys {
		if k == "percentage" {
			continue
		}
		var maxVal int64
		var set bool
		for _, u := range units {
			if v, ok := u.Metrics[k]; ok {
				n := toInt64(v)
				if !set || n > maxVal {
					maxVal = n
					set = true
				}
			}
		}
		if set {
			out.Extra[k] = maxVal
		}
	}
	for _, u := range units {
		if v, ok := u.Metrics["percentage"]; ok {
			if f, ok := toFloat64(v); ok && f > out.Percentage {
				out.Percentage = f
			}
		}
	}
	return out
}

func toInt64(v interface{}) int64 {
	switch x := v.(type) {
	case int:
		return int64(x)
	case int64:
		return x
	case float64:
		return int64(x)
	default:
		return 0
	}
}

func toFloat64(v interface{}) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	default:
		return 0, false
	}
}

func copyUnits(units []UnitProgress) []UnitProgress {
	if units == nil {
		return nil
	}
	out := make([]UnitProgress, len(units))
	for i := range units {
		out[i] = UnitProgress{
			UnitID:      units[i].UnitID,
			Status:      units[i].Status,
			Metrics:     copyExtra(units[i].Metrics),
			LastUpdated: units[i].LastUpdated,
		}
	}
	return out
}

func copyExtra(m map[string]interface{}) map[string]interface{} {
	if m == nil {
		return nil
	}
	out := make(map[string]interface{}, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// Get retrieves progress for a workflow. Returns nil if not found.
// Returns a copy so Extra and Units are not mutated by callers.
func (ps *ProgressStore) Get(workflowID string) *ProgressPayload {
	ps.mu.RLock()
	defer ps.mu.RUnlock()
	p := ps.entries[workflowID]
	if p == nil {
		return nil
	}
	out := *p
	out.Extra = copyExtra(p.Extra)
	out.Units = copyUnits(p.Units)
	return &out
}

// Delete removes a progress entry (called on workflow completion).
func (ps *ProgressStore) Delete(workflowID string) {
	ps.mu.Lock()
	defer ps.mu.Unlock()
	delete(ps.entries, workflowID)
}

// cleanupLoop runs every 60 minutes and removes entries older than TTL.
func (ps *ProgressStore) cleanupLoop() {
	ticker := time.NewTicker(60 * time.Minute)
	defer ticker.Stop()
	for range ticker.C {
		ps.mu.Lock()
		cutoff := time.Now().Add(-ps.ttl)
		for k, v := range ps.entries {
			if v.LastUpdated.Before(cutoff) {
				delete(ps.entries, k)
			}
		}
		ps.mu.Unlock()
	}
}
