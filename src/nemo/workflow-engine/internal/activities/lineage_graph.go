package activities

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
)

const maxNodeCap = 1000

// BuildLineageGraphActivity fetches raw edge + entity data from
// config-service, assembles a lineage graph per project, and writes
// each finished graph back as a project-level facet.
func BuildLineageGraphActivity(
	ctx context.Context,
	input types.ReferenceEdgeReconcileInput,
) (types.BuildLineageGraphResult, error) {
	startedAt := time.Now()

	configURL := input.ConfigServiceURL
	if configURL == "" {
		configURL = os.Getenv("CONFIG_SERVICE_URL")
	}
	if configURL == "" {
		configURL = "http://config-service:3000"
	}

	httpClient := &http.Client{Timeout: 10 * time.Minute}

	// Step 1: Fetch raw graph data from config-service
	graphDataURL := fmt.Sprintf("%s/api/v1/internal/reference-edges/graph-data", configURL)
	if input.ProjectID != "" {
		graphDataURL += "?projectId=" + input.ProjectID
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, graphDataURL, nil)
	if err != nil {
		return types.BuildLineageGraphResult{}, fmt.Errorf("build graph-data request: %w", err)
	}
	if sa, saErr := clients.NewServiceAccountClient(); saErr == nil {
		if err := sa.AddAuthHeader(req); err != nil {
			log.Printf("[BuildLineageGraph] Failed to attach auth header for graph-data: %v", err)
		}
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return types.BuildLineageGraphResult{}, fmt.Errorf("graph-data call failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return types.BuildLineageGraphResult{}, fmt.Errorf(
			"graph-data call returned status %d: %s", resp.StatusCode, string(respBytes),
		)
	}

	rawBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return types.BuildLineageGraphResult{}, fmt.Errorf("read graph-data response: %w", err)
	}

	var graphData types.GraphDataResponse
	if err := json.Unmarshal(rawBytes, &graphData); err != nil {
		return types.BuildLineageGraphResult{}, fmt.Errorf("decode graph-data response: %w", err)
	}

	// Step 2: Build lineage graph per project and write back
	processed := 0
	for projectID, projData := range graphData.Projects {
		graph := buildGraph(projData)

		if err := writeLineageFacet(ctx, httpClient, configURL, projectID, graph); err != nil {
			log.Printf("[BuildLineageGraph] Failed to write facet for project %s: %v", projectID, err)
			continue
		}
		processed++
		log.Printf(
			"[BuildLineageGraph] project=%s nodes=%d edges=%d truncated=%t",
			projectID, graph.Counts.NodeCount, graph.Counts.EdgeCount, graph.Truncated,
		)
	}

	result := types.BuildLineageGraphResult{
		ProjectsProcessed: processed,
		DurationMs:        time.Since(startedAt).Milliseconds(),
	}
	log.Printf("[BuildLineageGraph] done: projects=%d duration_ms=%d", processed, result.DurationMs)
	return result, nil
}

// buildGraph assembles a LineageGraph from raw project data.
func buildGraph(data types.ProjectGraphData) types.LineageGraph {
	if len(data.Edges) == 0 {
		return types.LineageGraph{
			Nodes: []types.LineageNode{},
			Edges: []types.LineageEdge{},
			Counts: types.LineageCounts{
				NodeCount:         0,
				EdgeCount:         0,
				ByKind:            map[string]int{},
				UnconnectedByKind: cloneCounts(data.EntityTotals),
			},
			Truncated: false,
		}
	}

	// Build set of entity keys that participate in at least one edge
	participating := make(map[string]bool)
	for _, e := range data.Edges {
		participating[e.SourceType+"\x00"+e.SourceID] = true
		participating[e.TargetType+"\x00"+e.TargetID] = true
	}

	// Build entity lookup for name resolution
	entityName := make(map[string]string)
	for _, ent := range data.Entities {
		key := ent.Kind + "\x00" + ent.ID
		if ent.Name != nil {
			entityName[key] = *ent.Name
		}
	}

	// Collect nodes (only those with edges)
	byKind := make(map[string]int)
	var nodes []types.LineageNode
	for _, ent := range data.Entities {
		key := ent.Kind + "\x00" + ent.ID
		if !participating[key] {
			continue
		}
		name := ent.ID
		if n, ok := entityName[key]; ok && n != "" {
			name = n
		}
		nodes = append(nodes, types.LineageNode{
			ID:   ent.ID,
			Name: name,
			Kind: ent.Kind,
		})
		byKind[ent.Kind]++
	}

	unconnected := computeUnconnected(data.EntityTotals, byKind)

	// Enforce hard cap
	if len(nodes) > maxNodeCap {
		return types.LineageGraph{
			Nodes: nil,
			Edges: nil,
			Counts: types.LineageCounts{
				NodeCount:         len(nodes),
				EdgeCount:         len(data.Edges),
				ByKind:            byKind,
				UnconnectedByKind: unconnected,
			},
			Truncated: true,
		}
	}

	// Map edges
	edges := make([]types.LineageEdge, 0, len(data.Edges))
	for _, e := range data.Edges {
		edges = append(edges, types.LineageEdge{
			SourceType: e.SourceType,
			SourceID:   e.SourceID,
			TargetType: e.TargetType,
			TargetID:   e.TargetID,
			Relation:   e.Relation,
		})
	}

	return types.LineageGraph{
		Nodes: nodes,
		Edges: edges,
		Counts: types.LineageCounts{
			NodeCount:         len(nodes),
			EdgeCount:         len(edges),
			ByKind:            byKind,
			UnconnectedByKind: unconnected,
		},
		Truncated: false,
	}
}

// cloneCounts returns a defensive copy of a count map; nil-safe.
func cloneCounts(in map[string]int) map[string]int {
	out := make(map[string]int, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// computeUnconnected returns total - connected per kind, clamped to >=0.
// Kinds present in totals but absent from connected report the full total.
func computeUnconnected(totals, connected map[string]int) map[string]int {
	out := make(map[string]int, len(totals))
	for kind, total := range totals {
		diff := total - connected[kind]
		if diff < 0 {
			diff = 0
		}
		out[kind] = diff
	}
	return out
}

// writeLineageFacet PUTs a finished graph to config-service as a project facet.
func writeLineageFacet(
	ctx context.Context,
	httpClient *http.Client,
	configURL, projectID string,
	graph types.LineageGraph,
) error {
	body := map[string]interface{}{
		"state": "ready",
		"graph": graph,
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal lineage facet: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/internal/reference-edges/lineage-facet/%s", configURL, projectID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, bytes.NewBuffer(payload))
	if err != nil {
		return fmt.Errorf("build lineage-facet request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if sa, saErr := clients.NewServiceAccountClient(); saErr == nil {
		if err := sa.AddAuthHeader(req); err != nil {
			log.Printf("[BuildLineageGraph] Failed to attach auth header for facet write: %v", err)
		}
	}

	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("lineage-facet PUT failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("lineage-facet PUT returned status %d: %s", resp.StatusCode, string(respBytes))
	}
	return nil
}
