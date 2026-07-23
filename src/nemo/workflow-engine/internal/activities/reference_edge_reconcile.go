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

// RunReferenceEdgeReconcileActivity is a thin trigger: it POSTs to
// config-service's admin endpoint where the actual work lives (catalog +
// TypeORM rows are there). Mirrors RunMCPHealthCheckActivity in shape so
// operators see a familiar "scheduled workflow + thin HTTP activity"
// pattern.
func RunReferenceEdgeReconcileActivity(
	ctx context.Context,
	input types.ReferenceEdgeReconcileInput,
) (types.ReferenceEdgeReconcileResult, error) {
	startedAt := time.Now()

	configURL := input.ConfigServiceURL
	if configURL == "" {
		configURL = os.Getenv("CONFIG_SERVICE_URL")
	}
	if configURL == "" {
		configURL = "http://config-service:3000"
	}

	body := map[string]interface{}{}
	if input.ProjectID != "" {
		body["projectId"] = input.ProjectID
	}
	if input.SourceType != "" {
		body["sourceType"] = input.SourceType
	}
	if input.GraphOnly {
		body["graphOnly"] = true
	}
	if input.MaxRows > 0 {
		body["maxRows"] = input.MaxRows
	}
	payload, err := json.Marshal(body)
	if err != nil {
		return types.ReferenceEdgeReconcileResult{}, fmt.Errorf("marshal reconcile payload: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/internal/reference-edges/reconcile", configURL)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewBuffer(payload))
	if err != nil {
		return types.ReferenceEdgeReconcileResult{}, fmt.Errorf("build reconcile request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	// Authenticate the same way the MCP-health activity does.
	if sa, saErr := clients.NewServiceAccountClient(); saErr == nil {
		if err := sa.AddAuthHeader(req); err != nil {
			log.Printf("[ReferenceEdgeReconcile] Failed to attach auth header: %v", err)
		}
	}

	httpClient := &http.Client{Timeout: 10 * time.Minute}

	resp, err := httpClient.Do(req)
	if err != nil {
		return types.ReferenceEdgeReconcileResult{}, fmt.Errorf("reconcile call failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return types.ReferenceEdgeReconcileResult{}, fmt.Errorf(
			"reconcile call returned status %d: %s", resp.StatusCode, string(respBytes),
		)
	}

	// config-service's sendSuccess writes the payload directly (no { data: ... }
	// envelope), so the response body is the ReconcileSummary itself.
	var result types.ReferenceEdgeReconcileResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return types.ReferenceEdgeReconcileResult{}, fmt.Errorf("decode reconcile response: %w", err)
	}
	result.DurationMs = time.Since(startedAt).Milliseconds()
	log.Printf(
		"[ReferenceEdgeReconcile] cycle: scanned=%d added=%d removed=%d truncated=%t duration_ms=%d",
		result.Scanned, result.Added, result.Removed, result.Truncated, result.DurationMs,
	)
	return result, nil
}
