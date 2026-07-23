package activities

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/activity"
)

const mcpHealthConcurrency = 5
const mcpProbeTimeout = 10 * time.Second

// healthyMcpClientStates is the set of Bifrost MCP client states we treat as
// "connected" for health-check purposes. Anything else (e.g. "error",
// "disconnected", "suspended", "pending") is reported as unhealthy so the
// circuit-breaker / sync-state flow runs.
var healthyMcpClientStates = map[string]struct{}{
	"connected": {},
	"ready":     {},
	"active":    {},
}

func RunMCPHealthCheckActivity(ctx context.Context, input types.MCPHealthCheckInput) (types.MCPHealthCheckResult, error) {
	startedAt := time.Now()
	configURL := input.ConfigServiceURL
	if configURL == "" {
		configURL = os.Getenv("CONFIG_SERVICE_URL")
	}
	if configURL == "" {
		configURL = "http://config-service:3000"
	}

	configClient := clients.NewConfigClient(configURL)
	servers, err := configClient.GetHealthEligibleMCPServers()
	if err != nil {
		return types.MCPHealthCheckResult{}, err
	}
	log.Printf("[MCPHealthCheck] Starting cycle: eligible=%d config_service_url=%s", len(servers), configURL)
	if len(servers) == 0 {
		return types.MCPHealthCheckResult{Checked: 0, Healthy: 0, Unhealthy: 0, DurationMs: time.Since(startedAt).Milliseconds()}, nil
	}

	gatewayURL := resolveLLMGatewayURL()
	apiKey := resolveLLMGatewayAPIKey()
	log.Printf(
		"[MCPHealthCheck] Probe config: gateway=bifrost gateway_url=%s timeout=%s concurrency=%d auth_configured=%t",
		gatewayURL,
		mcpProbeTimeout.String(),
		mcpHealthConcurrency,
		apiKey != "",
	)

	httpClient := &http.Client{Timeout: mcpProbeTimeout}
	sem := make(chan struct{}, mcpHealthConcurrency)
	var wg sync.WaitGroup
	var mu sync.Mutex
	healthy := 0
	unhealthy := 0
	checked := 0

	for i, server := range servers {
		select {
		case <-ctx.Done():
			return types.MCPHealthCheckResult{}, ctx.Err()
		default:
		}

		wg.Add(1)
		sem <- struct{}{}
		go func(index int, srv types.MCPServerHealthInfo) {
			defer wg.Done()
			defer func() { <-sem }()

			status := "error"
			ok, reason := probeMCPServer(ctx, httpClient, gatewayURL, apiKey, srv.LLMProxyGatewayServerName)
			if ok {
				status = "connected"
			} else {
				runtimeStatusStr := "unset"
				if srv.RuntimeStatus != nil {
					runtimeStatusStr = *srv.RuntimeStatus
				}
				log.Printf(
					"[MCPHealthCheck] Probe failed: server_id=%s server_name=%s deployment_type=%s runtime_status=%s sync_status=%s reason=%s",
					srv.ID,
					srv.LLMProxyGatewayServerName,
					srv.DeploymentType,
					runtimeStatusStr,
					srv.SyncStatus,
					reason,
				)
			}

			if err := configClient.UpdateMCPServerStatus(srv.ID, status); err != nil {
				log.Printf("[MCPHealthCheck] Failed to update server status id=%s status=%s: %v", srv.ID, status, err)
			}

			mu.Lock()
			checked++
			if status == "connected" {
				healthy++
			} else {
				unhealthy++
			}
			mu.Unlock()

			if (index+1)%10 == 0 {
				activity.RecordHeartbeat(ctx, map[string]int{
					"checked":   checked,
					"healthy":   healthy,
					"unhealthy": unhealthy,
				})
			}
		}(i, server)
	}
	wg.Wait()

	result := types.MCPHealthCheckResult{
		Checked:    checked,
		Healthy:    healthy,
		Unhealthy:  unhealthy,
		DurationMs: time.Since(startedAt).Milliseconds(),
	}
	log.Printf("[MCPHealthCheck] Cycle complete: checked=%d healthy=%d unhealthy=%d duration_ms=%d", result.Checked, result.Healthy, result.Unhealthy, result.DurationMs)
	return result, nil
}

func resolveLLMGatewayURL() string {
	url := os.Getenv("LLM_GATEWAY_URL")
	if url == "" {
		url = "http://bifrost-proxy:8080"
	}
	return url
}

func resolveLLMGatewayAPIKey() string {
	return os.Getenv("LLM_GATEWAY_API_KEY")
}

// probeMCPServer asks the Bifrost gateway for the live status of a SPECIFIC
// MCP client (matched by name). The previous implementation POSTed to
// `${gatewayURL}/mcp`, which is the aggregated tools endpoint and ignores the
// server name entirely — every server in the loop got the same result and the
// per-server status update in RunMCPHealthCheckActivity was effectively just
// reflecting overall gateway health. Now we hit `GET /api/mcp/clients` (the
// same endpoint BifrostGatewayClient uses) and validate the entry whose
// `name` matches the requested server.
func probeMCPServer(ctx context.Context, client *http.Client, gatewayURL, apiKey, serverName string) (bool, string) {
	if strings.TrimSpace(serverName) == "" {
		return false, "missing_server_name"
	}

	url := fmt.Sprintf("%s/api/mcp/clients", strings.TrimRight(gatewayURL, "/"))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false, fmt.Sprintf("request_build_error: %v", err)
	}
	req.Header.Set("Accept", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", fmt.Sprintf("Bearer %s", apiKey))
		req.Header.Set("x-api-key", apiKey)
	}

	resp, err := client.Do(req)
	if err != nil {
		return false, fmt.Sprintf("request_error: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return false, fmt.Sprintf("http_%d body=%q", resp.StatusCode, string(respBody))
	}

	bodyBytes, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return false, fmt.Sprintf("response_read_error: %v", err)
	}

	rows, err := parseBifrostMcpClientList(bodyBytes)
	if err != nil {
		return false, fmt.Sprintf("response_parse_error: %v", err)
	}

	entry := findMcpClientByName(rows, serverName)
	if entry == nil {
		return false, "not_registered"
	}

	state := strings.ToLower(strings.TrimSpace(entry.state))
	if state == "" {
		// Bifrost returned the client but didn't surface a state. Treat as
		// healthy-by-default: the entry's existence confirms the gateway has
		// the registration; absence of an explicit error state means we have
		// no signal to mark it unhealthy.
		return true, "ok_no_state"
	}
	if _, ok := healthyMcpClientStates[state]; ok {
		return true, fmt.Sprintf("ok state=%s", state)
	}
	return false, fmt.Sprintf("state=%s", state)
}

type bifrostMcpClientEntry struct {
	name  string
	state string
}

// parseBifrostMcpClientList accepts both the array form ([{...}, ...]) and
// the wrapped form ({"clients": [...]}) returned by Bifrost's /api/mcp/clients
// endpoint, mirroring the JS client (fetchBifrostMcpClients).
func parseBifrostMcpClientList(body []byte) ([]bifrostMcpClientEntry, error) {
	var asArray []map[string]interface{}
	if err := json.Unmarshal(body, &asArray); err == nil {
		return mapBifrostMcpClientRows(asArray), nil
	}
	var wrapped struct {
		Clients []map[string]interface{} `json:"clients"`
	}
	if err := json.Unmarshal(body, &wrapped); err != nil {
		return nil, err
	}
	return mapBifrostMcpClientRows(wrapped.Clients), nil
}

func mapBifrostMcpClientRows(rows []map[string]interface{}) []bifrostMcpClientEntry {
	out := make([]bifrostMcpClientEntry, 0, len(rows))
	for _, row := range rows {
		name := stringFromCfgOrRoot(row, "name")
		state, _ := row["state"].(string)
		out = append(out, bifrostMcpClientEntry{name: name, state: state})
	}
	return out
}

// stringFromCfgOrRoot pulls a string field from either the row's nested
// `config` object or the row root, matching how parseBifrostMcpListEntry on
// the JS side coalesces the two locations.
func stringFromCfgOrRoot(row map[string]interface{}, key string) string {
	if cfg, ok := row["config"].(map[string]interface{}); ok {
		if v, ok := cfg[key].(string); ok && v != "" {
			return v
		}
	}
	if v, ok := row[key].(string); ok {
		return v
	}
	return ""
}

func findMcpClientByName(rows []bifrostMcpClientEntry, serverName string) *bifrostMcpClientEntry {
	for i := range rows {
		if rows[i].name == serverName {
			return &rows[i]
		}
	}
	return nil
}
