package types

type MCPHealthCheckInput struct {
	ConfigServiceURL string `json:"configServiceURL"`
}

type MCPHealthCheckResult struct {
	Checked    int   `json:"checked"`
	Healthy    int   `json:"healthy"`
	Unhealthy  int   `json:"unhealthy"`
	DurationMs int64 `json:"durationMs"`
}

type MCPServerHealthInfo struct {
	ID                        string  `json:"id"`
	LLMProxyGatewayServerName string  `json:"llmproxyGatewayServerName"`
	DeploymentType            string  `json:"deploymentType"`
	RuntimeStatus             *string `json:"runtimeStatus,omitempty"`
	// Sync status with the Bifrost gateway. The activity uses this only for
	// log context — eligibility decisions are made server-side in
	// config-service /health-eligible (which also handles lazy
	// re-registration for non-`synced` rows so the probe can recover
	// servers stuck in 'suspended' or 'pending').
	SyncStatus string `json:"syncStatus,omitempty"`
}
