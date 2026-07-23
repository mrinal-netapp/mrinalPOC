package types

// ReferenceEdgeReconcileInput is the payload for the scheduled
// reference-edge reconciler workflow. The activity forwards these fields
// (after defaulting) to config-service's
// `POST /api/v1/internal/reference-edges/reconcile` endpoint.
type ReferenceEdgeReconcileInput struct {
	ConfigServiceURL string `json:"configServiceURL"`

	// Restrict the scan to a single project. Empty = every project.
	ProjectID string `json:"projectId,omitempty"`
	// Restrict to one source kind (e.g. "pipeline"). Empty = all kinds.
	SourceType string `json:"sourceType,omitempty"`
	// When true, only kinds the catalog declares as needing reconciliation
	// (today: just `pipeline`). The synchronous slice is already correct
	// at write time, so default true keeps each tick cheap.
	GraphOnly bool `json:"graphOnly,omitempty"`
	// Per-tick scan budget. Zero defers to config-service default.
	MaxRows int `json:"maxRows,omitempty"`
}

// ReferenceEdgeReconcileResult mirrors the JSON shape of the
// config-service admin endpoint's response. Drift = (added > 0 ||
// removed > 0); ops dashboards alarm when this trends above zero after a
// quiet period.
type ReferenceEdgeReconcileResult struct {
	Scanned     int                                       `json:"scanned"`
	EdgesBefore int                                       `json:"edgesBefore"`
	EdgesAfter  int                                       `json:"edgesAfter"`
	Added       int                                       `json:"added"`
	Removed     int                                       `json:"removed"`
	ByKind      map[string]ReferenceEdgeReconcileKindStat `json:"byKind"`
	Truncated   bool                                      `json:"truncated"`
	DurationMs  int64                                     `json:"durationMs"`
}

type ReferenceEdgeReconcileKindStat struct {
	Scanned int `json:"scanned"`
	Added   int `json:"added"`
	Removed int `json:"removed"`
}
