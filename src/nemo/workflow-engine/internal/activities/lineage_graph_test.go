package activities

import (
	"testing"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func nameOf(s string) *string { return &s }

func TestBuildGraph_NoEdges_ReturnsAllUnconnected(t *testing.T) {
	data := types.ProjectGraphData{
		Edges:        nil,
		Entities:     []types.GraphDataEntity{{Kind: "dataset", ID: "d1"}},
		EntityTotals: map[string]int{"dataset": 1, "pipeline": 5},
	}
	got := buildGraph(data)
	assert.Len(t, got.Nodes, 0)
	assert.Len(t, got.Edges, 0)
	assert.False(t, got.Truncated)
	assert.Equal(t, 1, got.Counts.UnconnectedByKind["dataset"])
	assert.Equal(t, 5, got.Counts.UnconnectedByKind["pipeline"])
}

func TestBuildGraph_HappyPath(t *testing.T) {
	data := types.ProjectGraphData{
		Edges: []types.GraphDataEdge{
			{SourceType: "pipeline", SourceID: "p1", TargetType: "dataset", TargetID: "d1", Relation: "writes"},
			{SourceType: "kb", SourceID: "kb1", TargetType: "dataset", TargetID: "d1", Relation: "reads"},
		},
		Entities: []types.GraphDataEntity{
			{Kind: "pipeline", ID: "p1", Name: nameOf("Pipe One")},
			{Kind: "dataset", ID: "d1", Name: nameOf("Dataset One")},
			{Kind: "kb", ID: "kb1"}, // no Name pointer -> falls back to ID
			{Kind: "dataset", ID: "d2"},
		},
		EntityTotals: map[string]int{"pipeline": 1, "dataset": 2, "kb": 1},
	}
	got := buildGraph(data)
	assert.Len(t, got.Nodes, 3, "d2 has no edges and must be excluded")
	assert.Len(t, got.Edges, 2)
	assert.Equal(t, 1, got.Counts.UnconnectedByKind["dataset"], "d2 is unconnected")
	assert.Equal(t, 0, got.Counts.UnconnectedByKind["pipeline"])
	assert.False(t, got.Truncated)

	// Find kb1 and verify Name fell back to ID since no Name pointer.
	var kbNode *types.LineageNode
	for i := range got.Nodes {
		if got.Nodes[i].Kind == "kb" {
			kbNode = &got.Nodes[i]
		}
	}
	require.NotNil(t, kbNode)
	assert.Equal(t, "kb1", kbNode.Name)
}

func TestBuildGraph_TruncatesWhenTooManyNodes(t *testing.T) {
	// Create more than maxNodeCap entities and edges connecting them.
	const total = maxNodeCap + 10
	entities := make([]types.GraphDataEntity, total)
	edges := make([]types.GraphDataEdge, total)
	for i := 0; i < total; i++ {
		id := "e" + intToA(i)
		entities[i] = types.GraphDataEntity{Kind: "x", ID: id}
		edges[i] = types.GraphDataEdge{
			SourceType: "x", SourceID: id,
			TargetType: "x", TargetID: id,
			Relation: "self",
		}
	}
	got := buildGraph(types.ProjectGraphData{
		Edges: edges, Entities: entities, EntityTotals: map[string]int{"x": total},
	})
	assert.True(t, got.Truncated)
	assert.Nil(t, got.Nodes)
	assert.Nil(t, got.Edges)
	assert.Equal(t, total, got.Counts.NodeCount)
	assert.Equal(t, total, got.Counts.EdgeCount)
}

func intToA(i int) string {
	if i == 0 {
		return "0"
	}
	digits := []byte{}
	for i > 0 {
		digits = append([]byte{byte('0' + i%10)}, digits...)
		i /= 10
	}
	return string(digits)
}

func TestComputeUnconnected(t *testing.T) {
	totals := map[string]int{"a": 10, "b": 5, "c": 3}
	connected := map[string]int{"a": 4, "b": 5, "c": 4}
	got := computeUnconnected(totals, connected)
	assert.Equal(t, 6, got["a"])
	assert.Equal(t, 0, got["b"])
	assert.Equal(t, 0, got["c"], "negative diff clamps to zero")
}

func TestComputeUnconnected_KindOnlyInTotals(t *testing.T) {
	totals := map[string]int{"only-totals": 7}
	connected := map[string]int{}
	got := computeUnconnected(totals, connected)
	assert.Equal(t, 7, got["only-totals"])
}

func TestCloneCounts_NilSafeAndIndependent(t *testing.T) {
	in := map[string]int{"a": 1}
	out := cloneCounts(in)
	out["a"] = 999
	assert.Equal(t, 1, in["a"], "cloneCounts must not share underlying map")
	assert.NotNil(t, cloneCounts(nil))
}
