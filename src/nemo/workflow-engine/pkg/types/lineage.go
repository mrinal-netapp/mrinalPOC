package types

// LineageGraph is the pre-computed dependency graph stored as a project
// facet. The Go BuildLineageGraphActivity assembles this structure from
// raw edge + entity data fetched from config-service.
type LineageGraph struct {
	Nodes     []LineageNode `json:"nodes"`
	Edges     []LineageEdge `json:"edges"`
	Counts    LineageCounts `json:"counts"`
	Truncated bool          `json:"truncated"`
}

// LineageNode is a single entity participating in the dependency graph.
type LineageNode struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}

// LineageEdge is a directed dependency from source to target.
type LineageEdge struct {
	SourceType string `json:"sourceType"`
	SourceID   string `json:"sourceId"`
	TargetType string `json:"targetType"`
	TargetID   string `json:"targetId"`
	Relation   string `json:"relation"`
}

// LineageCounts is the aggregate summary attached to each graph.
type LineageCounts struct {
	NodeCount int            `json:"nodeCount"`
	EdgeCount int            `json:"edgeCount"`
	ByKind    map[string]int `json:"byKind"`
	// UnconnectedByKind is the count of entities of each kind that exist in
	// the project but participate in no reference edge. Lets the GUI render
	// a per-column placeholder node for orphan entities.
	UnconnectedByKind map[string]int `json:"unconnectedByKind"`
}

// BuildLineageGraphResult is returned by BuildLineageGraphActivity.
type BuildLineageGraphResult struct {
	ProjectsProcessed int   `json:"projectsProcessed"`
	DurationMs        int64 `json:"durationMs"`
}

// GraphDataResponse mirrors the JSON returned by
// GET /api/v1/internal/reference-edges/graph-data. config-service writes
// the payload directly with res.json (no { data: ... } envelope), so this
// type sits at the top level of the response body.
type GraphDataResponse struct {
	Projects map[string]ProjectGraphData `json:"projects"`
}

// ProjectGraphData holds raw edges and resolved entities for one project.
type ProjectGraphData struct {
	Edges        []GraphDataEdge   `json:"edges"`
	Entities     []GraphDataEntity `json:"entities"`
	EntityTotals map[string]int    `json:"entityTotals"`
}

// GraphDataEdge is a raw edge from config-service.
type GraphDataEdge struct {
	SourceType string `json:"sourceType"`
	SourceID   string `json:"sourceId"`
	TargetType string `json:"targetType"`
	TargetID   string `json:"targetId"`
	Relation   string `json:"relation"`
}

// GraphDataEntity is a resolved entity name from config-service.
type GraphDataEntity struct {
	Kind string  `json:"kind"`
	ID   string  `json:"id"`
	Name *string `json:"name"`
}
