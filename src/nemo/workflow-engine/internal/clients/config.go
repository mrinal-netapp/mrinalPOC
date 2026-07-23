package clients

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
)

// Per-method HTTP timeouts. The httpClient.Timeout is a sane default for
// fast CRUD reads (project list, get-by-id, simple updates) — but project
// init does multi-step Bifrost provisioning (team create + VK create +
// per-built-in model registration), each step a separate REST hop into
// Bifrost which may have cold-start latency. Use a longer per-request
// timeout via context for those slow paths so the activity doesn't fail
// before the work even finishes.
const (
	defaultRequestTimeout = 30 * time.Second
	gatewaySetupTimeout   = 180 * time.Second
)

type ConfigClient struct {
	baseURL string
	// fast path: short-lived CRUD calls (list/get/simple update).
	httpClient *http.Client
	// slow path: long-running provisioning (Bifrost team+VK setup, built-in
	// model registration). http.Client.Timeout is a HARD CAP that takes the
	// earlier of (Client.Timeout, request context deadline) — so a separate
	// client is required; a per-request context alone would still be capped
	// at httpClient.Timeout. Both clients share the same transport tuning
	// in case any in-flight TCP keepalives or proxy plumbing matter.
	slowHTTPClient     *http.Client
	serviceAccountAuth *ServiceAccountClient
}

func NewConfigClient(baseURL string) *ConfigClient {
	client := &ConfigClient{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: defaultRequestTimeout,
		},
		slowHTTPClient: &http.Client{
			Timeout: gatewaySetupTimeout,
		},
	}

	// Initialize service account client if credentials are available
	if saClient, err := NewServiceAccountClient(); err == nil {
		client.serviceAccountAuth = saClient
		log.Printf("[ConfigClient] Service account authentication enabled")
	} else {
		log.Printf("[ConfigClient] Service account authentication disabled: %v", err)
	}

	return client
}

// NewConfigClientWithHTTPClient returns a ConfigClient with a caller-provided
// *http.Client. Used by tests to point at httptest.Server. Service-account
// auth is left disabled (tests sign their own requests if needed).
// The same caller-provided client is reused for slow-path calls — tests
// generally use httptest.Server which has no Bifrost-style cold-start
// latency, so the production split is not load-bearing there.
func NewConfigClientWithHTTPClient(baseURL string, httpClient *http.Client) *ConfigClient {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: defaultRequestTimeout}
	}
	return &ConfigClient{
		baseURL:        baseURL,
		httpClient:     httpClient,
		slowHTTPClient: httpClient,
	}
}

// GetBaseURL returns the config-service base URL.
func (c *ConfigClient) GetBaseURL() string {
	return c.baseURL
}

// addAuthHeader adds authentication header to request if service account is configured
func (c *ConfigClient) addAuthHeader(req *http.Request) error {
	if c.serviceAccountAuth != nil {
		return c.serviceAccountAuth.AddAuthHeader(req)
	}
	return nil
}

func (c *ConfigClient) GetPipeline(projectId, pipelineId string) (*types.Pipeline, error) {
	url := fmt.Sprintf("%s/api/v1/projects/%s/pipelines/%s", c.baseURL, projectId, pipelineId)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to get pipeline: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("failed to get pipeline: status %d", resp.StatusCode)
	}

	var pipeline types.Pipeline
	if err := json.NewDecoder(resp.Body).Decode(&pipeline); err != nil {
		return nil, fmt.Errorf("failed to decode pipeline: %w", err)
	}

	return &pipeline, nil
}

func (c *ConfigClient) CreateExecution(execution *types.PipelineExecution) error {
	url := fmt.Sprintf("%s/api/v1/projects/%s/pipelines/%s/executions",
		c.baseURL, execution.ProjectId, execution.PipelineId)

	body, err := json.Marshal(execution)
	if err != nil {
		return fmt.Errorf("failed to marshal execution: %w", err)
	}

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to create execution: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to create execution: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	return nil
}

// ResolveOrCreateUsers asks config-service to turn invitee emails into stable
// Keycloak user ids, creating any user that doesn't exist yet. config-service
// runs as the master-realm admin (view-users + manage-users), so it can read
// AND create users — workflow-engine's scoped authz SA cannot. Mirrors the
// internal service-to-service POST pattern used by the project-init steps.
func (c *ConfigClient) ResolveOrCreateUsers(emails []string) ([]types.ResolvedMember, error) {
	url := fmt.Sprintf("%s/api/v1/internal/users/resolve-or-create", c.baseURL)

	body, err := json.Marshal(map[string][]string{"emails": emails})
	if err != nil {
		return nil, fmt.Errorf("failed to marshal emails: %w", err)
	}

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve-or-create users: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to resolve-or-create users: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	var out struct {
		Resolved []types.ResolvedMember `json:"resolved"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("failed to decode resolve-or-create response: %w", err)
	}
	return out.Resolved, nil
}

// ResolveUsers resolves emails to existing Keycloak user ids WITHOUT creating
// anything (config-service's resolve-only endpoint). A returned ResolvedMember
// with an empty UserId means no user has that email — callers (change-role /
// remove-member) turn that into a 404 rather than provisioning a user.
func (c *ConfigClient) ResolveUsers(emails []string) ([]types.ResolvedMember, error) {
	url := fmt.Sprintf("%s/api/v1/internal/users/resolve", c.baseURL)

	body, err := json.Marshal(map[string][]string{"emails": emails})
	if err != nil {
		return nil, fmt.Errorf("failed to marshal emails: %w", err)
	}

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve users: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to resolve users: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	var out struct {
		Resolved []types.ResolvedMember `json:"resolved"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("failed to decode resolve response: %w", err)
	}
	return out.Resolved, nil
}

func (c *ConfigClient) GetExecution(projectId, pipelineId, executionId string) (*types.PipelineExecution, error) {
	url := fmt.Sprintf("%s/api/v1/projects/%s/pipelines/%s/executions/%s",
		c.baseURL, projectId, pipelineId, executionId)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to get execution: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("execution not found: status %d", resp.StatusCode)
	}

	var execution types.PipelineExecution
	if err := json.NewDecoder(resp.Body).Decode(&execution); err != nil {
		return nil, fmt.Errorf("failed to decode execution: %w", err)
	}

	return &execution, nil
}

func (c *ConfigClient) ListExecutions(projectId, pipelineId string) ([]*types.PipelineExecution, error) {
	url := fmt.Sprintf("%s/api/v1/projects/%s/pipelines/%s/executions",
		c.baseURL, projectId, pipelineId)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to list executions: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("failed to list executions: status %d", resp.StatusCode)
	}

	var executions []*types.PipelineExecution
	if err := json.NewDecoder(resp.Body).Decode(&executions); err != nil {
		return nil, fmt.Errorf("failed to decode executions: %w", err)
	}

	return executions, nil
}

func (c *ConfigClient) UpdateExecution(execution *types.PipelineExecution) error {
	url := fmt.Sprintf("%s/api/v1/projects/%s/pipelines/%s/executions/%s",
		c.baseURL, execution.ProjectId, execution.PipelineId, execution.ExecutionId)

	body, err := json.Marshal(execution)
	if err != nil {
		return fmt.Errorf("failed to marshal execution: %w", err)
	}

	req, err := http.NewRequest(http.MethodPut, url, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to update execution: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to update execution: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	return nil
}

func (c *ConfigClient) CreateBucket(projectId, bucketName string, request types.CreateBucketRequest) error {
	url := fmt.Sprintf("%s/api/v1/projects/%s/buckets", c.baseURL, projectId)

	log.Printf("[ConfigClient] Creating bucket: %s for project: %s", bucketName, projectId)
	log.Printf("[ConfigClient] Request URL: %s", url)

	body, err := json.Marshal(request)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: Failed to marshal request: %v", err)
		return fmt.Errorf("failed to marshal bucket request: %w", err)
	}

	log.Printf("[ConfigClient] Request body: %s", string(body))

	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		log.Printf("[ConfigClient] ERROR: Failed to create request: %v", err)
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: HTTP request failed: %v", err)
		return fmt.Errorf("failed to create bucket: %w", err)
	}
	defer resp.Body.Close()

	log.Printf("[ConfigClient] Response status: %d", resp.StatusCode)

	if resp.StatusCode == http.StatusConflict || resp.StatusCode == 409 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		log.Printf("[ConfigClient] INFO: Bucket %s already exists (409) for project %s, continuing...", bucketName, projectId)
		log.Printf("[ConfigClient] Response body: %s", string(bodyBytes))
		return nil // Idempotent - bucket already exists
	}

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		log.Printf("[ConfigClient] ERROR: Failed to create bucket: status %d, body: %s", resp.StatusCode, string(bodyBytes))
		return fmt.Errorf("failed to create bucket: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	bodyBytes, _ := io.ReadAll(resp.Body)
	log.Printf("[ConfigClient] Bucket %s created successfully for project %s", bucketName, projectId)
	log.Printf("[ConfigClient] Response body: %s", string(bodyBytes))

	return nil
}

func (c *ConfigClient) GetBucket(projectId, bucketName string) (map[string]interface{}, error) {
	url := fmt.Sprintf("%s/api/v1/projects/%s/buckets/%s", c.baseURL, projectId, bucketName)

	log.Printf("[ConfigClient] Getting bucket: %s for project: %s", bucketName, projectId)
	log.Printf("[ConfigClient] Request URL: %s", url)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: Failed to create request: %v", err)
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: HTTP request failed: %v", err)
		return nil, fmt.Errorf("failed to get bucket: %w", err)
	}
	defer resp.Body.Close()

	log.Printf("[ConfigClient] Response status: %d", resp.StatusCode)

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		log.Printf("[ConfigClient] ERROR: Failed to get bucket: status %d, body: %s", resp.StatusCode, string(bodyBytes))
		return nil, fmt.Errorf("failed to get bucket: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	var bucket map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&bucket); err != nil {
		log.Printf("[ConfigClient] ERROR: Failed to decode bucket response: %v", err)
		return nil, fmt.Errorf("failed to decode bucket: %w", err)
	}

	log.Printf("[ConfigClient] Bucket %s retrieved successfully for project %s", bucketName, projectId)

	return bucket, nil
}

func (c *ConfigClient) DeleteBucket(projectId, bucketName string) error {
	url := fmt.Sprintf("%s/api/v1/projects/%s/buckets/%s", c.baseURL, projectId, bucketName)

	log.Printf("[ConfigClient] Deleting bucket: %s for project: %s", bucketName, projectId)
	log.Printf("[ConfigClient] Request URL: %s", url)

	req, err := http.NewRequest(http.MethodDelete, url, nil)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: Failed to create request: %v", err)
		return fmt.Errorf("failed to create delete request: %w", err)
	}

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: HTTP request failed: %v", err)
		return fmt.Errorf("failed to delete bucket: %w", err)
	}
	defer resp.Body.Close()

	log.Printf("[ConfigClient] Response status: %d", resp.StatusCode)

	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == 404 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		log.Printf("[ConfigClient] INFO: Bucket %s not found (404) for project %s, continuing...", bucketName, projectId)
		log.Printf("[ConfigClient] Response body: %s", string(bodyBytes))
		return nil // Idempotent - bucket already deleted
	}

	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		log.Printf("[ConfigClient] ERROR: Failed to delete bucket: status %d, body: %s", resp.StatusCode, string(bodyBytes))
		return fmt.Errorf("failed to delete bucket: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	log.Printf("[ConfigClient] Bucket %s deleted successfully for project %s", bucketName, projectId)

	return nil
}

// BucketRoutingResponse represents routing information for a bucket
type BucketRoutingResponse struct {
	ProjectId   string                  `json:"project_id"`
	BucketName  string                  `json:"bucket_name"`
	Deployments []RoutingDeploymentInfo `json:"deployments"`
}

// RoutingDeploymentInfo represents deployment info for routing
type RoutingDeploymentInfo struct {
	DeploymentId      string `json:"deployment_id"`
	Role              string `json:"role"`
	Priority          int    `json:"priority"`
	Endpoint          string `json:"endpoint"`      // HTTPS endpoint
	HttpEndpoint      string `json:"http_endpoint"` // HTTP endpoint (for internal operations)
	HealthStatus      string `json:"health_status"`
	LoadBalanceWeight int    `json:"load_balance_weight"`
}

// GetBucketRouting gets routing information for a bucket
func (c *ConfigClient) GetBucketRouting(projectId, bucketName string) (*BucketRoutingResponse, error) {
	url := fmt.Sprintf("%s/api/v1/buckets/%s/%s/routing", c.baseURL, projectId, bucketName)

	log.Printf("[ConfigClient] Getting bucket routing: %s/%s", projectId, bucketName)
	log.Printf("[ConfigClient] Request URL: %s", url)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: Failed to create request: %v", err)
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: HTTP request failed: %v", err)
		return nil, fmt.Errorf("failed to get bucket routing: %w", err)
	}
	defer resp.Body.Close()

	log.Printf("[ConfigClient] Response status: %d", resp.StatusCode)

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		log.Printf("[ConfigClient] ERROR: Failed to get bucket routing: status %d, body: %s", resp.StatusCode, string(bodyBytes))
		return nil, fmt.Errorf("failed to get bucket routing: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	var routing BucketRoutingResponse
	if err := json.NewDecoder(resp.Body).Decode(&routing); err != nil {
		log.Printf("[ConfigClient] ERROR: Failed to decode routing response: %v", err)
		return nil, fmt.Errorf("failed to decode bucket routing: %w", err)
	}

	log.Printf("[ConfigClient] Bucket routing retrieved successfully for %s/%s, found %d deployments",
		projectId, bucketName, len(routing.Deployments))

	return &routing, nil
}

// UpdateProjectMetadata updates project metadata
func (c *ConfigClient) UpdateProjectMetadata(projectId string, metadata map[string]interface{}) error {
	url := fmt.Sprintf("%s/api/v1/projects/%s", c.baseURL, projectId)

	log.Printf("[ConfigClient] Updating project metadata for project: %s", projectId)
	log.Printf("[ConfigClient] Request URL: %s", url)

	requestBody := map[string]interface{}{
		"metadata": metadata,
	}

	body, err := json.Marshal(requestBody)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: Failed to marshal request: %v", err)
		return fmt.Errorf("failed to marshal project metadata request: %w", err)
	}

	log.Printf("[ConfigClient] Request body: %s", string(body))

	req, err := http.NewRequest(http.MethodPut, url, bytes.NewBuffer(body))
	if err != nil {
		log.Printf("[ConfigClient] ERROR: Failed to create request: %v", err)
		return fmt.Errorf("failed to create update request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: HTTP request failed: %v", err)
		return fmt.Errorf("failed to update project metadata: %w", err)
	}
	defer resp.Body.Close()

	log.Printf("[ConfigClient] Response status: %d", resp.StatusCode)

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		log.Printf("[ConfigClient] ERROR: Failed to update project metadata: status %d, body: %s", resp.StatusCode, string(bodyBytes))
		return fmt.Errorf("failed to update project metadata: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	bodyBytes, _ := io.ReadAll(resp.Body)
	log.Printf("[ConfigClient] Project metadata updated successfully for project %s", projectId)
	log.Printf("[ConfigClient] Response body: %s", string(bodyBytes))

	return nil
}

// SetupProjectLLMGateway ensures the project's Bifrost team + virtual
// key exist on the LLM proxy gateway. Method is named with the explicit
// “LLMGateway“ qualifier to avoid confusion with the AgentStudio
// api-gateway. Delegates to config-service's “ensureProjectGateway“
// via the internal “/projects/{id}/gateway-setup“ endpoint (URL path
// kept stable to avoid a wire-contract change). Fully idempotent
// server-side, so safe to retry from Temporal.
func (c *ConfigClient) SetupProjectLLMGateway(projectId string) error {
	url := fmt.Sprintf("%s/api/v1/internal/projects/%s/gateway-setup", c.baseURL, projectId)

	log.Printf("[ConfigClient] Setting up Bifrost LLM gateway for project: %s (timeout %s)", projectId, gatewaySetupTimeout)
	log.Printf("[ConfigClient] Request URL: %s", url)

	// Per-request context for cancellation propagation. The actual deadline
	// budget is enforced by slowHTTPClient.Timeout (also gatewaySetupTimeout)
	// because http.Client.Timeout is the EARLIER of (client.Timeout,
	// ctx.deadline) — a context with a longer deadline cannot widen it.
	ctx, cancel := context.WithTimeout(context.Background(), gatewaySetupTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", url, nil)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: Failed to create request: %v", err)
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.slowHTTPClient.Do(req)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: HTTP request failed: %v", err)
		return fmt.Errorf("failed to set up project LLM gateway: %w", err)
	}
	defer resp.Body.Close()

	log.Printf("[ConfigClient] Response status: %d", resp.StatusCode)

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		bodyBytes, _ := io.ReadAll(resp.Body)
		log.Printf("[ConfigClient] ERROR: Failed to set up project LLM gateway: status %d, body: %s", resp.StatusCode, string(bodyBytes))
		return fmt.Errorf("failed to set up project LLM gateway: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	bodyBytes, _ := io.ReadAll(resp.Body)
	log.Printf("[ConfigClient] Project LLM gateway setup completed for project %s", projectId)
	log.Printf("[ConfigClient] Response body: %s", string(bodyBytes))

	return nil
}

// ReportProjectInitStatus writes the terminal project-init status
// (ready | failed) to config-service's internal init-status endpoint so the
// outcome is visible on the project row. Idempotent server-side.
func (c *ConfigClient) ReportProjectInitStatus(projectId, status, initErr string) error {
	url := fmt.Sprintf("%s/api/v1/internal/projects/%s/init-status", c.baseURL, projectId)

	payload := map[string]string{"status": status}
	if initErr != "" {
		payload["error"] = initErr
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal init-status payload: %w", err)
	}

	req, err := http.NewRequest(http.MethodPost, url, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if err := c.addAuthHeader(req); err != nil {
		return fmt.Errorf("failed to add auth header: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to report project init status: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to report project init status: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}
	return nil
}

// TeardownProjectLLMGateway drops the project's Bifrost team + virtual key
// (and per-project models / MCP clients / routing rules + VK K8s Secret)
// via config-service's internal `/projects/{id}/gateway-teardown` endpoint.
// Mirror of `SetupProjectLLMGateway` above and called from
// `TeardownProjectLLMGatewayActivity` as Step 0 of `ProjectDeleteWorkflow`.
//
// The endpoint accepts an optional gateway metadata body so the teardown
// can still find the VK / team to drop even after the config-service
// `projects` row is gone (the DELETE handler captures `_gateway` BEFORE
// returning 204 and forwards it through). When `meta` is nil the
// endpoint falls back to reading the row -- only safe while the row is
// still alive, which is no longer guaranteed in the workflow path.
// Fully idempotent server-side (every Bifrost call inside
// `teardownProjectGateway` is 404-tolerant) so safe to retry from
// Temporal.
func (c *ConfigClient) TeardownProjectLLMGateway(projectId string, meta *types.ProjectGatewayMeta) error {
	url := fmt.Sprintf("%s/api/v1/internal/projects/%s/gateway-teardown", c.baseURL, projectId)

	log.Printf("[ConfigClient] Tearing down Bifrost LLM gateway for project: %s (timeout %s)", projectId, gatewaySetupTimeout)
	log.Printf("[ConfigClient] Request URL: %s", url)

	var bodyReader io.Reader
	if meta != nil {
		bodyBytes, err := json.Marshal(meta)
		if err != nil {
			log.Printf("[ConfigClient] ERROR: Failed to marshal gateway meta: %v", err)
			return fmt.Errorf("failed to marshal gateway meta: %w", err)
		}
		bodyReader = bytes.NewReader(bodyBytes)
	}

	// Teardown mirrors Setup: multi-step Bifrost work (team + VK + per-model
	// unbind), each step a separate REST hop. Reuse the slow-path client +
	// budget — see SetupProjectLLMGateway for the rationale.
	ctx, cancel := context.WithTimeout(context.Background(), gatewaySetupTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, "POST", url, bodyReader)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: Failed to create request: %v", err)
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.slowHTTPClient.Do(req)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: HTTP request failed: %v", err)
		return fmt.Errorf("failed to tear down project LLM gateway: %w", err)
	}
	defer resp.Body.Close()

	log.Printf("[ConfigClient] Response status: %d", resp.StatusCode)

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		bodyBytes, _ := io.ReadAll(resp.Body)
		log.Printf("[ConfigClient] ERROR: Failed to tear down project LLM gateway: status %d, body: %s", resp.StatusCode, string(bodyBytes))
		return fmt.Errorf("failed to tear down project LLM gateway: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	bodyBytes, _ := io.ReadAll(resp.Body)
	log.Printf("[ConfigClient] Project LLM gateway teardown completed for project %s", projectId)
	log.Printf("[ConfigClient] Response body: %s", string(bodyBytes))

	return nil
}

// CreateProjectServiceAccount creates a project service account
func (c *ConfigClient) CreateProjectServiceAccount(projectId string) error {
	url := fmt.Sprintf("%s/api/v1/projects/%s/service-account", c.baseURL, projectId)

	log.Printf("[ConfigClient] Creating project service account for project: %s", projectId)
	log.Printf("[ConfigClient] Request URL: %s", url)

	req, err := http.NewRequest("POST", url, nil)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: Failed to create request: %v", err)
		return fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: HTTP request failed: %v", err)
		return fmt.Errorf("failed to create project service account: %w", err)
	}
	defer resp.Body.Close()

	log.Printf("[ConfigClient] Response status: %d", resp.StatusCode)

	if resp.StatusCode == http.StatusConflict || resp.StatusCode == 409 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		log.Printf("[ConfigClient] INFO: Project service account already exists (409) for project %s, continuing...", projectId)
		log.Printf("[ConfigClient] Response body: %s", string(bodyBytes))
		return nil // Idempotent - service account already exists
	}

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		log.Printf("[ConfigClient] ERROR: Failed to create project service account: status %d, body: %s", resp.StatusCode, string(bodyBytes))
		return fmt.Errorf("failed to create project service account: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	bodyBytes, _ := io.ReadAll(resp.Body)
	log.Printf("[ConfigClient] Project service account created successfully for project %s", projectId)
	log.Printf("[ConfigClient] Response body: %s", string(bodyBytes))

	return nil
}

// UpdateDatasetStatus updates dataset status
func (c *ConfigClient) UpdateDatasetStatus(projectId, datasetId, status, errorMessage string) error {
	url := fmt.Sprintf("%s/api/v1/projects/%s/datasets/%s/status", c.baseURL, projectId, datasetId)

	log.Printf("[ConfigClient] Updating dataset status: %s/%s, status: %s", projectId, datasetId, status)
	log.Printf("[ConfigClient] Request URL: %s", url)

	requestBody := map[string]interface{}{
		"status": status,
	}
	if errorMessage != "" {
		requestBody["errorMessage"] = errorMessage
	}

	body, err := json.Marshal(requestBody)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: Failed to marshal request: %v", err)
		return fmt.Errorf("failed to marshal dataset status request: %w", err)
	}

	log.Printf("[ConfigClient] Request body: %s", string(body))

	req, err := http.NewRequest(http.MethodPut, url, bytes.NewBuffer(body))
	if err != nil {
		log.Printf("[ConfigClient] ERROR: Failed to create request: %v", err)
		return fmt.Errorf("failed to create update request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: HTTP request failed: %v", err)
		return fmt.Errorf("failed to update dataset status: %w", err)
	}
	defer resp.Body.Close()

	log.Printf("[ConfigClient] Response status: %d", resp.StatusCode)

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		log.Printf("[ConfigClient] ERROR: Failed to update dataset status: status %d, body: %s", resp.StatusCode, string(bodyBytes))
		return fmt.Errorf("failed to update dataset status: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	bodyBytes, _ := io.ReadAll(resp.Body)
	log.Printf("[ConfigClient] Dataset status updated successfully for dataset %s/%s", projectId, datasetId)
	log.Printf("[ConfigClient] Response body: %s", string(bodyBytes))

	return nil
}

// ProjectServiceAccountResponse represents project service account response
type ProjectServiceAccountResponse struct {
	ProjectId    string `json:"projectId"`
	ClientId     string `json:"clientId"`
	ClientSecret string `json:"clientSecret"`
	CreatedAt    string `json:"createdAt"`
}

// UpdateDatasetCatalogRef updates dataset catalog reference
func (c *ConfigClient) UpdateDatasetCatalogRef(projectId, datasetId, catalogTableRef string) error {
	url := fmt.Sprintf("%s/api/v1/projects/%s/datasets/%s", c.baseURL, projectId, datasetId)

	log.Printf("[ConfigClient] Updating dataset catalog ref: %s/%s, ref: %s", projectId, datasetId, catalogTableRef)
	log.Printf("[ConfigClient] Request URL: %s", url)

	requestBody := map[string]interface{}{
		"catalogTableRef": catalogTableRef,
	}

	body, err := json.Marshal(requestBody)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: Failed to marshal request: %v", err)
		return fmt.Errorf("failed to marshal dataset catalog ref request: %w", err)
	}

	log.Printf("[ConfigClient] Request body: %s", string(body))

	req, err := http.NewRequest(http.MethodPut, url, bytes.NewBuffer(body))
	if err != nil {
		log.Printf("[ConfigClient] ERROR: Failed to create request: %v", err)
		return fmt.Errorf("failed to create update request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: HTTP request failed: %v", err)
		return fmt.Errorf("failed to update dataset catalog ref: %w", err)
	}
	defer resp.Body.Close()

	log.Printf("[ConfigClient] Response status: %d", resp.StatusCode)

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		log.Printf("[ConfigClient] ERROR: Failed to update dataset catalog ref: status %d, body: %s", resp.StatusCode, string(bodyBytes))
		return fmt.Errorf("failed to update dataset catalog ref: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	log.Printf("[ConfigClient] Dataset catalog ref updated successfully for dataset %s/%s", projectId, datasetId)

	return nil
}

// GetProjectServiceAccount gets project service account credentials
func (c *ConfigClient) GetProjectServiceAccount(projectId string) (*ProjectServiceAccountResponse, error) {
	url := fmt.Sprintf("%s/api/v1/projects/%s/service-account", c.baseURL, projectId)

	log.Printf("[ConfigClient] Getting project service account for project: %s", projectId)
	log.Printf("[ConfigClient] Request URL: %s", url)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: Failed to create request: %v", err)
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: HTTP request failed: %v", err)
		return nil, fmt.Errorf("failed to get project service account: %w", err)
	}
	defer resp.Body.Close()

	log.Printf("[ConfigClient] Response status: %d", resp.StatusCode)

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		log.Printf("[ConfigClient] ERROR: Failed to get project service account: status %d, body: %s", resp.StatusCode, string(bodyBytes))
		return nil, fmt.Errorf("failed to get project service account: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	var serviceAccount ProjectServiceAccountResponse
	if err := json.NewDecoder(resp.Body).Decode(&serviceAccount); err != nil {
		log.Printf("[ConfigClient] ERROR: Failed to decode service account response: %v", err)
		return nil, fmt.Errorf("failed to decode service account: %w", err)
	}

	log.Printf("[ConfigClient] Project service account retrieved successfully for project %s", projectId)

	return &serviceAccount, nil
}

// GetKBStorageRoot fetches the bucketName and pathPrefix used to locate the
// KB's blue-green sync prefixes on object storage. It first reads the KB
// (which carries `bucketName` after the first successful sync), and falls back
// to the project's home_dir prefix when the KB does not yet have one.
func (c *ConfigClient) GetKBStorageRoot(projectId, kbId string) (string, string, error) {
	kbURL := fmt.Sprintf("%s/api/v1/projects/%s/knowledgebases/%s", c.baseURL, projectId, kbId)
	bucketName, pathPrefix, err := c.fetchProjectStorageRoot(projectId)
	if err != nil {
		return "", "", err
	}

	req, err := http.NewRequest(http.MethodGet, kbURL, nil)
	if err != nil {
		return "", "", fmt.Errorf("failed to create KB request: %w", err)
	}
	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("failed to GET KB: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return "", "", fmt.Errorf("knowledge base %s not found in project %s", kbId, projectId)
	}
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return "", "", fmt.Errorf("config-service returned %d for KB GET: %s", resp.StatusCode, string(body))
	}
	var kb struct {
		BucketName string `json:"bucketName"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&kb); err != nil {
		return "", "", fmt.Errorf("failed to decode KB response: %w", err)
	}
	if kb.BucketName != "" {
		bucketName = kb.BucketName
	}
	return bucketName, pathPrefix, nil
}

// fetchProjectStorageRoot reads the project home_dir from config-service and
// derives `(bucketName, pathPrefix)` the same way the TS helper does.
func (c *ConfigClient) fetchProjectStorageRoot(projectId string) (string, string, error) {
	url := fmt.Sprintf("%s/api/v1/projects/%s", c.baseURL, projectId)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return "", "", fmt.Errorf("failed to create project request: %w", err)
	}
	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("failed to GET project: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return "", "", fmt.Errorf("config-service returned %d for project GET: %s", resp.StatusCode, string(body))
	}
	var proj struct {
		HomeDir string `json:"home_dir"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&proj); err != nil {
		return "", "", fmt.Errorf("failed to decode project response: %w", err)
	}
	bucket, prefix := splitHomeDir(proj.HomeDir, projectId)
	return bucket, prefix, nil
}

// splitHomeDir mirrors getProjectStorageRoot in
// src/nemo/config-service/utils/defaultBucket.ts: home_dir is either
// `<bucket>` or `<bucket>/<pathPrefix...>`. When home_dir is empty the bucket
// defaults to the projectId.
func splitHomeDir(homeDir, projectId string) (string, string) {
	homeDir = strings.TrimSpace(homeDir)
	homeDir = strings.TrimPrefix(homeDir, "/")
	if homeDir == "" {
		return projectId, ""
	}
	parts := strings.SplitN(homeDir, "/", 2)
	bucket := parts[0]
	prefix := ""
	if len(parts) == 2 {
		prefix = strings.TrimSuffix(parts[1], "/")
	}
	if bucket == "" {
		bucket = projectId
	}
	return bucket, prefix
}

// UpdateKnowledgeBase updates knowledge base fields
func (c *ConfigClient) UpdateKnowledgeBase(projectId, kbId string, updates map[string]interface{}) error {
	url := fmt.Sprintf("%s/api/v1/projects/%s/knowledgebases/%s", c.baseURL, projectId, kbId)

	log.Printf("[ConfigClient] Updating knowledge base: %s/%s", projectId, kbId)
	log.Printf("[ConfigClient] Request URL: %s", url)

	body, err := json.Marshal(updates)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: Failed to marshal request: %v", err)
		return fmt.Errorf("failed to marshal KB update request: %w", err)
	}

	log.Printf("[ConfigClient] Request body: %s", string(body))

	req, err := http.NewRequest(http.MethodPut, url, bytes.NewBuffer(body))
	if err != nil {
		log.Printf("[ConfigClient] ERROR: Failed to create request: %v", err)
		return fmt.Errorf("failed to create update request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		log.Printf("[ConfigClient] ERROR: HTTP request failed: %v", err)
		return fmt.Errorf("failed to update knowledge base: %w", err)
	}
	defer resp.Body.Close()

	log.Printf("[ConfigClient] Response status: %d", resp.StatusCode)

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		log.Printf("[ConfigClient] ERROR: Failed to update knowledge base: status %d, body: %s", resp.StatusCode, string(bodyBytes))
		return fmt.Errorf("failed to update knowledge base: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	bodyBytes, _ := io.ReadAll(resp.Body)
	log.Printf("[ConfigClient] Knowledge base updated successfully for %s/%s", projectId, kbId)
	log.Printf("[ConfigClient] Response body: %s", string(bodyBytes))

	return nil
}

// UpdateFacet calls the config-service facet PUT API.
// entityRoute is the plural entity path segment, e.g. "knowledgebases" or "datasets".
func (c *ConfigClient) UpdateFacet(projectId, entityRoute, entityId, facetType string, updates map[string]interface{}) error {
	url := fmt.Sprintf("%s/api/v1/projects/%s/%s/%s/facets/%s",
		c.baseURL, projectId, entityRoute, entityId, facetType)

	log.Printf("[ConfigClient] Updating facet: %s/%s/%s/%s", projectId, entityRoute, entityId, facetType)

	body, err := json.Marshal(updates)
	if err != nil {
		return fmt.Errorf("failed to marshal facet update request: %w", err)
	}

	req, err := http.NewRequest(http.MethodPut, url, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create facet update request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header for facet update: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to update facet: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to update facet: status %d, body: %s", resp.StatusCode, string(respBytes))
	}

	log.Printf("[ConfigClient] Facet updated successfully: %s/%s/%s/%s", projectId, entityRoute, entityId, facetType)
	return nil
}

// GetDataset fetches a dataset from config-service.
func (c *ConfigClient) GetDataset(projectId, datasetId string) (map[string]interface{}, error) {
	url := fmt.Sprintf("%s/api/v1/projects/%s/datasets/%s", c.baseURL, projectId, datasetId)
	log.Printf("[ConfigClient] Fetching dataset: %s/%s", projectId, datasetId)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch dataset: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to fetch dataset: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	var result map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode dataset response: %w", err)
	}

	log.Printf("[ConfigClient] Dataset fetched: %s/%s", projectId, datasetId)
	return result, nil
}

// GetDataSource fetches a data source from config-service.
func (c *ConfigClient) GetDataSource(projectId, dataSourceId string) (map[string]interface{}, error) {
	url := fmt.Sprintf("%s/api/v1/projects/%s/datasources/%s", c.baseURL, projectId, dataSourceId)
	log.Printf("[ConfigClient] Fetching data source: %s/%s", projectId, dataSourceId)

	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch data source: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to fetch data source: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	var result map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode data source response: %w", err)
	}

	log.Printf("[ConfigClient] Data source fetched: %s/%s", projectId, dataSourceId)
	return result, nil
}

// UpdateDatasetWatermark patches the dataset's acquisitionConfig.lastWatermarkValue.
func (c *ConfigClient) UpdateDatasetWatermark(projectId, datasetId, lastWatermarkValue string) error {
	url := fmt.Sprintf("%s/api/v1/projects/%s/datasets/%s", c.baseURL, projectId, datasetId)
	log.Printf("[ConfigClient] Updating watermark for dataset: %s/%s", projectId, datasetId)

	requestBody := map[string]interface{}{
		"acquisitionConfig": map[string]interface{}{
			"lastWatermarkValue": lastWatermarkValue,
		},
	}

	body, err := json.Marshal(requestBody)
	if err != nil {
		return fmt.Errorf("failed to marshal watermark update request: %w", err)
	}

	req, err := http.NewRequest(http.MethodPatch, url, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create watermark update request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to update watermark: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to update watermark: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	log.Printf("[ConfigClient] Watermark updated for dataset: %s/%s", projectId, datasetId)
	return nil
}

// PostDataSourceScanResult sends a scan_status (and optional scan_result) back
// to config-service via the internal PATCH endpoint. Used by
// PostScanResultActivity at the end of VolumeScanWorkflow.
func (c *ConfigClient) PostDataSourceScanResult(
	projectId, dataSourceId string,
	scanStatus map[string]interface{},
	scanResult map[string]interface{},
) error {
	url := fmt.Sprintf("%s/api/v1/internal/datasources/%s/%s/scan-result", c.baseURL, projectId, dataSourceId)
	log.Printf("[ConfigClient] Posting scan result for data source: %s/%s", projectId, dataSourceId)

	requestBody := map[string]interface{}{
		"scan_status": scanStatus,
	}
	if scanResult != nil {
		requestBody["scan_result"] = scanResult
	}

	body, err := json.Marshal(requestBody)
	if err != nil {
		return fmt.Errorf("failed to marshal scan result request: %w", err)
	}

	req, err := http.NewRequest(http.MethodPatch, url, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create scan result request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to post scan result: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to post scan result: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	log.Printf("[ConfigClient] Scan result posted for data source: %s/%s", projectId, dataSourceId)
	return nil
}

func (c *ConfigClient) GetHealthEligibleMCPServers() ([]types.MCPServerHealthInfo, error) {
	url := fmt.Sprintf("%s/api/v1/internal/mcp-servers/health-eligible", c.baseURL)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to get health-eligible MCP servers: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("failed to get health-eligible MCP servers: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}

	var servers []types.MCPServerHealthInfo
	if err := json.NewDecoder(resp.Body).Decode(&servers); err != nil {
		return nil, fmt.Errorf("failed to decode MCP server health list: %w", err)
	}
	return servers, nil
}

func (c *ConfigClient) UpdateMCPServerStatus(serverID, status string) error {
	url := fmt.Sprintf("%s/api/v1/internal/mcp-servers/%s/status", c.baseURL, serverID)
	body, err := json.Marshal(map[string]string{"status": status})
	if err != nil {
		return fmt.Errorf("failed to marshal MCP status update: %w", err)
	}

	req, err := http.NewRequest(http.MethodPatch, url, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create MCP status update request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to update MCP server status: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to update MCP server status: status %d, body: %s", resp.StatusCode, string(bodyBytes))
	}
	return nil
}

// ListProjectsForVKRotation returns project ids with active Bifrost virtual keys.
func (c *ConfigClient) ListProjectsForVKRotation() (types.ListProjectsForVKRotationResult, error) {
	url := fmt.Sprintf("%s/api/v1/internal/projects/gateway-rotation-targets", c.baseURL)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return types.ListProjectsForVKRotationResult{}, fmt.Errorf("failed to create request: %w", err)
	}
	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return types.ListProjectsForVKRotationResult{}, fmt.Errorf("failed to list VK rotation targets: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return types.ListProjectsForVKRotationResult{}, fmt.Errorf(
			"failed to list VK rotation targets: status %d, body: %s",
			resp.StatusCode,
			string(bodyBytes),
		)
	}

	var result types.ListProjectsForVKRotationResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return types.ListProjectsForVKRotationResult{}, fmt.Errorf("failed to decode VK rotation targets: %w", err)
	}
	return result, nil
}

// RotateProjectVirtualKey starts Bifrost native VK rotation and updates K8s + metadata.
func (c *ConfigClient) RotateProjectVirtualKey(projectId string) (types.RotateProjectVirtualKeyResult, error) {
	url := fmt.Sprintf("%s/api/v1/internal/projects/%s/gateway-rotate", c.baseURL, projectId)
	req, err := http.NewRequest(http.MethodPost, url, nil)
	if err != nil {
		return types.RotateProjectVirtualKeyResult{}, fmt.Errorf("failed to create request: %w", err)
	}
	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return types.RotateProjectVirtualKeyResult{}, fmt.Errorf("failed to rotate project VK: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return types.RotateProjectVirtualKeyResult{}, fmt.Errorf(
			"failed to rotate project VK: status %d, body: %s",
			resp.StatusCode,
			string(bodyBytes),
		)
	}

	var result types.RotateProjectVirtualKeyResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return types.RotateProjectVirtualKeyResult{}, fmt.Errorf("failed to decode rotate VK response: %w", err)
	}
	return result, nil
}

// CompleteProjectVirtualKeyRotation promotes the secondary VK after the grace period.
func (c *ConfigClient) CompleteProjectVirtualKeyRotation(projectId string) (types.DeleteRetiredProjectVirtualKeyResult, error) {
	url := fmt.Sprintf("%s/api/v1/internal/projects/%s/gateway-rotate-complete", c.baseURL, projectId)
	req, err := http.NewRequest(http.MethodPost, url, nil)
	if err != nil {
		return types.DeleteRetiredProjectVirtualKeyResult{}, fmt.Errorf("failed to create request: %w", err)
	}
	if err := c.addAuthHeader(req); err != nil {
		log.Printf("[ConfigClient] Warning: Failed to add auth header: %v", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return types.DeleteRetiredProjectVirtualKeyResult{}, fmt.Errorf("failed to complete VK rotation: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return types.DeleteRetiredProjectVirtualKeyResult{}, fmt.Errorf(
			"failed to complete VK rotation: status %d, body: %s",
			resp.StatusCode,
			string(bodyBytes),
		)
	}

	var result types.DeleteRetiredProjectVirtualKeyResult
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return types.DeleteRetiredProjectVirtualKeyResult{}, fmt.Errorf("failed to decode rotate-complete response: %w", err)
	}
	return result, nil
}
