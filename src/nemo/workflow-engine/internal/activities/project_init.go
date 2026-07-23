package activities

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/clients"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3Types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"go.temporal.io/sdk/activity"
)

// hostHeaderTransport wraps an http.RoundTripper to set a custom Host header
// This is needed for gateway routing which checks the Host header for s3.* patterns
type hostHeaderTransport struct {
	base    http.RoundTripper
	host    string
	baseURL *url.URL
}

func (t *hostHeaderTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	// Set the Host header so gateway can route to S3 proxy
	req.Host = t.host
	req.Header.Set("Host", t.host)
	// Ensure we're connecting to the base URL (gateway)
	req.URL.Scheme = t.baseURL.Scheme
	req.URL.Host = t.baseURL.Host
	return t.base.RoundTrip(req)
}

// CreateBucketActivity creates a bucket via config-service API
func CreateBucketActivity(ctx context.Context, input types.CreateBucketRequest) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[CreateBucketActivity] Starting activity for bucket: %s, projectId: %s", input.Name, input.Name)
	log.Printf("[CreateBucketActivity] WorkflowID: %s, RunID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.WorkflowExecution.RunID, activityInfo.ActivityID)
	log.Printf("[CreateBucketActivity] Input: %+v", input)

	startTime := time.Now()
	configServiceURL := os.Getenv("CONFIG_SERVICE_URL")
	if configServiceURL == "" {
		configServiceURL = "http://config-service:3000"
	}

	configClient := clients.NewConfigClient(configServiceURL)
	projectId := input.Name // Bucket name is same as project ID

	err := configClient.CreateBucket(projectId, input.Name, input)
	duration := time.Since(startTime)

	if err != nil {
		log.Printf("[CreateBucketActivity] ERROR: Failed to create bucket %s after %v: %v", input.Name, duration, err)
		return fmt.Errorf("failed to create bucket: %w", err)
	}

	log.Printf("[CreateBucketActivity] Bucket %s created successfully, duration: %v", input.Name, duration)
	return nil
}

// WaitForBucketReadyActivity polls S3 endpoint directly until bucket is ready
// This activity first creates the bucket via S3 API (to register it with versitygw),
// then waits for the bucket to be accessible
func WaitForBucketReadyActivity(ctx context.Context, projectId, bucketName string, timeoutSeconds int) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[WaitForBucketReadyActivity] Starting activity for bucket: %s, projectId: %s, timeout: %ds", bucketName, projectId, timeoutSeconds)
	log.Printf("[WaitForBucketReadyActivity] WorkflowID: %s, RunID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.WorkflowExecution.RunID, activityInfo.ActivityID)

	startTime := time.Now()

	// Get S3 endpoint and credentials from environment
	s3Endpoint := os.Getenv("S3_ENDPOINT")
	if s3Endpoint == "" {
		// Connect directly to s3gateway (bypass API gateway to avoid auth issues)
		s3Endpoint = "http://s3gateway:7070"
	}

	s3AccessKey := os.Getenv("S3_ACCESS_KEY")
	s3SecretKey := os.Getenv("S3_SECRET_KEY")
	s3Region := os.Getenv("S3_REGION")
	if s3Region == "" {
		s3Region = "us-east-1"
	}

	log.Printf("[WaitForBucketReadyActivity] S3 endpoint: %s, region: %s, accessKey: %s", s3Endpoint, s3Region, s3AccessKey)

	if s3AccessKey == "" || s3SecretKey == "" {
		return fmt.Errorf("S3 credentials not configured (S3_ACCESS_KEY, S3_SECRET_KEY required)")
	}

	// Parse endpoint URL
	endpointURL, err := url.Parse(s3Endpoint)
	if err != nil {
		log.Printf("[WaitForBucketReadyActivity] ERROR: Invalid S3 endpoint URL %s: %v", s3Endpoint, err)
		return fmt.Errorf("invalid S3 endpoint URL: %w", err)
	}

	// Create S3 client with custom endpoint
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(s3Region),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(s3AccessKey, s3SecretKey, "")),
	)
	if err != nil {
		log.Printf("[WaitForBucketReadyActivity] ERROR: Failed to create AWS config: %v", err)
		return fmt.Errorf("failed to create AWS config: %w", err)
	}

	// Create S3 client with custom endpoint and path-style addressing
	// Connect directly to s3gateway without host header manipulation
	s3Client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(endpointURL.String())
		o.UsePathStyle = true // Force path-style addressing
	})

	// Step 1: Create bucket via S3 API to register it with versitygw
	// The PVC/directory may already exist, but versitygw needs the bucket registered in its metadata
	log.Printf("[WaitForBucketReadyActivity] Step 1: Creating bucket %s via S3 API (registering with versitygw)", bucketName)
	_, err = s3Client.CreateBucket(ctx, &s3.CreateBucketInput{
		Bucket: aws.String(bucketName),
	})
	if err != nil {
		// Check if bucket already exists (this is okay, means it was created before)
		var bne *s3Types.BucketAlreadyExists
		var bnaoe *s3Types.BucketAlreadyOwnedByYou
		if errors.As(err, &bne) || errors.As(err, &bnaoe) {
			log.Printf("[WaitForBucketReadyActivity] Bucket %s already exists in S3, continuing...", bucketName)
		} else {
			log.Printf("[WaitForBucketReadyActivity] ERROR: Failed to create bucket in S3: %v", err)
			return fmt.Errorf("failed to create bucket in S3: %w", err)
		}
	} else {
		log.Printf("[WaitForBucketReadyActivity] Bucket %s created successfully in S3", bucketName)
	}

	// Step 1: Poll until bucket is accessible
	// After creating the bucket, versitygw may need a moment to initialize metadata
	log.Printf("[WaitForBucketReadyActivity] Step 1: Polling to verify bucket %s is accessible", bucketName)
	timeout := time.Duration(timeoutSeconds) * time.Second
	maxWait := time.Now().Add(timeout)
	pollInterval := 5 * time.Second
	attempt := 0

	for time.Now().Before(maxWait) {
		attempt++
		log.Printf("[WaitForBucketReadyActivity] Poll attempt %d: checking bucket %s exists in S3", attempt, bucketName)

		// Use HeadBucket to check if bucket exists
		_, err := s3Client.HeadBucket(ctx, &s3.HeadBucketInput{
			Bucket: aws.String(bucketName),
		})

		if err == nil {
			duration := time.Since(startTime)
			log.Printf("[WaitForBucketReadyActivity] Bucket %s exists in S3 after %d attempts, duration: %v", bucketName, attempt, duration)
			return nil
		}

		log.Printf("[WaitForBucketReadyActivity] WARN: Bucket %s not found in S3 yet (attempt %d, error: %v), waiting %v before retry", bucketName, attempt, err, pollInterval)

		// Check if context is cancelled
		select {
		case <-ctx.Done():
			log.Printf("[WaitForBucketReadyActivity] ERROR: Context cancelled while waiting for bucket %s", bucketName)
			return ctx.Err()
		case <-time.After(pollInterval):
			// Continue polling
		}
	}

	duration := time.Since(startTime)
	log.Printf("[WaitForBucketReadyActivity] ERROR: Timeout waiting for bucket %s to exist in S3 after %d attempts, duration: %v", bucketName, attempt, duration)
	return fmt.Errorf("timeout waiting for bucket %s to exist in S3 after %v", bucketName, duration)
}

// CreateBucketInS3Activity creates a bucket via S3 API (to register it with versitygw)
// This is a quick activity that creates the bucket and returns immediately
// Use CheckBucketStatusActivity + workflow polling to wait for the bucket to be accessible
func CreateBucketInS3Activity(ctx context.Context, bucketName string) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[CreateBucketInS3Activity] Creating bucket: %s", bucketName)
	log.Printf("[CreateBucketInS3Activity] WorkflowID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.ActivityID)

	// Get S3 endpoint and credentials from environment
	s3Endpoint := os.Getenv("S3_ENDPOINT")
	if s3Endpoint == "" {
		s3Endpoint = "http://s3gateway:7070"
	}

	s3AccessKey := os.Getenv("S3_ACCESS_KEY")
	s3SecretKey := os.Getenv("S3_SECRET_KEY")
	s3Region := os.Getenv("S3_REGION")
	if s3Region == "" {
		s3Region = "us-east-1"
	}

	if s3AccessKey == "" || s3SecretKey == "" {
		return fmt.Errorf("S3 credentials not configured (S3_ACCESS_KEY, S3_SECRET_KEY required)")
	}

	// Parse endpoint URL
	endpointURL, err := url.Parse(s3Endpoint)
	if err != nil {
		return fmt.Errorf("invalid S3 endpoint URL: %w", err)
	}

	// Create S3 client
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(s3Region),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(s3AccessKey, s3SecretKey, "")),
	)
	if err != nil {
		return fmt.Errorf("failed to create AWS config: %w", err)
	}

	s3Client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(endpointURL.String())
		o.UsePathStyle = true
	})

	// Create bucket
	_, err = s3Client.CreateBucket(ctx, &s3.CreateBucketInput{
		Bucket: aws.String(bucketName),
	})
	if err != nil {
		var bne *s3Types.BucketAlreadyExists
		var bnaoe *s3Types.BucketAlreadyOwnedByYou
		if errors.As(err, &bne) || errors.As(err, &bnaoe) {
			log.Printf("[CreateBucketInS3Activity] Bucket %s already exists, continuing...", bucketName)
			return nil
		}
		return fmt.Errorf("failed to create bucket in S3: %w", err)
	}

	log.Printf("[CreateBucketInS3Activity] Bucket %s created successfully", bucketName)
	return nil
}

// CheckBucketStatusActivity checks if a bucket is accessible (single check, returns immediately)
// Use with workflow.Sleep() for polling pattern
func CheckBucketStatusActivity(ctx context.Context, bucketName string) (types.BucketStatusResult, error) {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[CheckBucketStatusActivity] Checking bucket: %s", bucketName)
	log.Printf("[CheckBucketStatusActivity] WorkflowID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.ActivityID)

	// Get S3 endpoint and credentials from environment
	s3Endpoint := os.Getenv("S3_ENDPOINT")
	if s3Endpoint == "" {
		s3Endpoint = "http://s3gateway:7070"
	}

	s3AccessKey := os.Getenv("S3_ACCESS_KEY")
	s3SecretKey := os.Getenv("S3_SECRET_KEY")
	s3Region := os.Getenv("S3_REGION")
	if s3Region == "" {
		s3Region = "us-east-1"
	}

	if s3AccessKey == "" || s3SecretKey == "" {
		return types.BucketStatusResult{}, fmt.Errorf("S3 credentials not configured")
	}

	// Parse endpoint URL
	endpointURL, err := url.Parse(s3Endpoint)
	if err != nil {
		return types.BucketStatusResult{}, fmt.Errorf("invalid S3 endpoint URL: %w", err)
	}

	// Create S3 client
	cfg, err := config.LoadDefaultConfig(ctx,
		config.WithRegion(s3Region),
		config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(s3AccessKey, s3SecretKey, "")),
	)
	if err != nil {
		return types.BucketStatusResult{}, fmt.Errorf("failed to create AWS config: %w", err)
	}

	s3Client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(endpointURL.String())
		o.UsePathStyle = true
	})

	// Check if bucket exists and is accessible
	_, err = s3Client.HeadBucket(ctx, &s3.HeadBucketInput{
		Bucket: aws.String(bucketName),
	})

	if err == nil {
		log.Printf("[CheckBucketStatusActivity] Bucket %s is ready", bucketName)
		return types.BucketStatusResult{
			Ready:   true,
			Exists:  true,
			Message: "Bucket is accessible",
		}, nil
	}

	log.Printf("[CheckBucketStatusActivity] Bucket %s not ready: %v", bucketName, err)
	return types.BucketStatusResult{
		Ready:   false,
		Exists:  false,
		Message: fmt.Sprintf("Bucket not accessible: %v", err),
	}, nil
}

// RegisterWarehouseActivity registers a warehouse in Lakekeeper and returns the warehouse ID
// Warehouses are created in the default Lakekeeper project (nil UUID)
func RegisterWarehouseActivity(ctx context.Context, input types.RegisterWarehouseRequest) (string, error) {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[RegisterWarehouseActivity] Starting activity for warehouse: %s", input.WarehouseName)
	log.Printf("[RegisterWarehouseActivity] WorkflowID: %s, RunID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.WorkflowExecution.RunID, activityInfo.ActivityID)
	log.Printf("[RegisterWarehouseActivity] Input: %+v", input)

	startTime := time.Now()
	lakekeeperURL := os.Getenv("LAKEKEEPER_URL")
	if lakekeeperURL == "" {
		lakekeeperURL = "http://lakekeeper:8181"
	}

	lakekeeperClient := clients.NewLakekeeperClient(lakekeeperURL)

	warehouseId, err := lakekeeperClient.CreateWarehouse(input)
	duration := time.Since(startTime)

	if err != nil {
		log.Printf("[RegisterWarehouseActivity] ERROR: Failed to register warehouse %s after %v: %v", input.WarehouseName, duration, err)
		return "", fmt.Errorf("failed to register warehouse: %w", err)
	}

	log.Printf("[RegisterWarehouseActivity] Warehouse %s registered successfully with ID: %s, duration: %v", input.WarehouseName, warehouseId, duration)
	return warehouseId, nil
}

// CreateNamespaceActivity creates a default namespace in Lakekeeper catalog
func CreateNamespaceActivity(ctx context.Context, input types.CreateNamespaceRequest) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[CreateNamespaceActivity] Starting activity for namespace: %v in warehouse: %s", input.Namespace, input.WarehouseId)
	log.Printf("[CreateNamespaceActivity] WorkflowID: %s, RunID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.WorkflowExecution.RunID, activityInfo.ActivityID)
	log.Printf("[CreateNamespaceActivity] Input: %+v", input)

	startTime := time.Now()
	lakekeeperURL := os.Getenv("LAKEKEEPER_URL")
	if lakekeeperURL == "" {
		lakekeeperURL = "http://lakekeeper:8181"
	}

	lakekeeperClient := clients.NewLakekeeperClient(lakekeeperURL)

	err := lakekeeperClient.CreateNamespace(input)
	duration := time.Since(startTime)

	if err != nil {
		log.Printf("[CreateNamespaceActivity] ERROR: Failed to create namespace %v after %v: %v", input.Namespace, duration, err)
		return fmt.Errorf("failed to create namespace: %w", err)
	}

	log.Printf("[CreateNamespaceActivity] Namespace %v created successfully, duration: %v", input.Namespace, duration)
	return nil
}

// SetupProjectLLMGatewayActivity ensures the project's Bifrost team +
// virtual key exist on the **LLM proxy gateway** (Bifrost). Named with
// the explicit “LLMGateway“ qualifier so it cannot be confused with
// the AgentStudio api-gateway / apigateway-service. Calls config-service's
// internal gateway-setup endpoint, which in turn invokes the in-process
// “ensureProjectGateway“ (idempotent). Used as the first step of
// ProjectInitWorkflow so the project's LLM-gateway governance is ready
// before any model/MCP registration call would need to self-heal.
func SetupProjectLLMGatewayActivity(ctx context.Context, projectId string) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[SetupProjectLLMGatewayActivity] Starting activity for project: %s", projectId)
	log.Printf("[SetupProjectLLMGatewayActivity] WorkflowID: %s, RunID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.WorkflowExecution.RunID, activityInfo.ActivityID)

	startTime := time.Now()
	configServiceURL := os.Getenv("CONFIG_SERVICE_URL")
	if configServiceURL == "" {
		configServiceURL = "http://config-service:3000"
	}

	configClient := clients.NewConfigClient(configServiceURL)

	err := configClient.SetupProjectLLMGateway(projectId)
	duration := time.Since(startTime)

	if err != nil {
		log.Printf("[SetupProjectLLMGatewayActivity] ERROR: Failed to set up Bifrost LLM gateway for project %s after %v: %v", projectId, duration, err)
		return fmt.Errorf("failed to set up project LLM gateway: %w", err)
	}

	log.Printf("[SetupProjectLLMGatewayActivity] Bifrost LLM gateway setup completed for project: %s, duration: %v", projectId, duration)
	return nil
}

// TeardownProjectLLMGatewayActivity drops the project's Bifrost team +
// virtual key (and all per-project models / MCP clients / routing rules
// + the VK K8s Secret) via config-service's internal gateway-teardown
// endpoint. Symmetric counterpart of `SetupProjectLLMGatewayActivity`
// and called as Step 0 of `ProjectDeleteWorkflow` so the team /
// VK teardown runs inside Temporal with retries + observable workflow
// history instead of inline in the config-service DELETE handler.
//
// Takes the pre-loaded `Gateway` ids from the workflow input rather
// than relying on the config-service to look them up: by the time this
// activity executes the `projects` row in config-service Postgres may
// already have been dropped by the DELETE handler (which returns 204
// immediately after kicking the workflow off, then deletes the row
// inline so the UI updates straight away). Without the preloaded ids
// the gateway-teardown endpoint would have nothing to delete in
// Bifrost's config_store.
//
// Fully idempotent server-side (every Bifrost call inside
// `teardownProjectGateway` is 404-tolerant) so safe to retry from
// Temporal.
func TeardownProjectLLMGatewayActivity(ctx context.Context, input types.TeardownProjectLLMGatewayInput) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[TeardownProjectLLMGatewayActivity] Starting activity for project: %s", input.ProjectId)
	log.Printf("[TeardownProjectLLMGatewayActivity] WorkflowID: %s, RunID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.WorkflowExecution.RunID, activityInfo.ActivityID)
	if input.Gateway != nil {
		log.Printf("[TeardownProjectLLMGatewayActivity] Preloaded gateway meta: teamId=%s vkId=%s", input.Gateway.TeamId, input.Gateway.VirtualKeyId)
	} else {
		log.Printf("[TeardownProjectLLMGatewayActivity] No preloaded gateway meta; endpoint will fall back to DB read")
	}

	startTime := time.Now()
	configServiceURL := os.Getenv("CONFIG_SERVICE_URL")
	if configServiceURL == "" {
		configServiceURL = "http://config-service:3000"
	}

	configClient := clients.NewConfigClient(configServiceURL)

	err := configClient.TeardownProjectLLMGateway(input.ProjectId, input.Gateway)
	duration := time.Since(startTime)

	if err != nil {
		log.Printf("[TeardownProjectLLMGatewayActivity] ERROR: Failed to tear down Bifrost LLM gateway for project %s after %v: %v", input.ProjectId, duration, err)
		return fmt.Errorf("failed to tear down project LLM gateway: %w", err)
	}

	log.Printf("[TeardownProjectLLMGatewayActivity] Bifrost LLM gateway teardown completed for project: %s, duration: %v", input.ProjectId, duration)
	return nil
}

func CreateProjectServiceAccountActivity(ctx context.Context, projectId string) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[CreateProjectServiceAccountActivity] Starting activity for project: %s", projectId)
	log.Printf("[CreateProjectServiceAccountActivity] WorkflowID: %s, RunID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.WorkflowExecution.RunID, activityInfo.ActivityID)

	startTime := time.Now()
	configServiceURL := os.Getenv("CONFIG_SERVICE_URL")
	if configServiceURL == "" {
		configServiceURL = "http://config-service:3000"
	}

	configClient := clients.NewConfigClient(configServiceURL)

	err := configClient.CreateProjectServiceAccount(projectId)
	duration := time.Since(startTime)

	if err != nil {
		log.Printf("[CreateProjectServiceAccountActivity] ERROR: Failed to create project service account for project %s after %v: %v", projectId, duration, err)
		return fmt.Errorf("failed to create project service account: %w", err)
	}

	log.Printf("[CreateProjectServiceAccountActivity] Project service account created successfully for project: %s, duration: %v", projectId, duration)
	return nil
}

// ReportProjectInitStatusActivity writes the terminal project-init status
// (ready | failed) back to config-service so a failed init is visible on the
// project row instead of only in Temporal history. Idempotent: writing the same
// status again is a no-op on the config-service side.
func ReportProjectInitStatusActivity(ctx context.Context, input types.ReportProjectInitStatusInput) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[ReportProjectInitStatusActivity] project=%s status=%s workflowID=%s", input.ProjectId, input.Status, activityInfo.WorkflowExecution.ID)

	configServiceURL := os.Getenv("CONFIG_SERVICE_URL")
	if configServiceURL == "" {
		configServiceURL = "http://config-service:3000"
	}

	configClient := clients.NewConfigClient(configServiceURL)
	if err := configClient.ReportProjectInitStatus(input.ProjectId, input.Status, input.Error); err != nil {
		log.Printf("[ReportProjectInitStatusActivity] ERROR: Failed to report status for project %s: %v", input.ProjectId, err)
		return fmt.Errorf("failed to report project init status: %w", err)
	}
	return nil
}

// UpdateProjectMetadataActivity updates project metadata with warehouse ID
func UpdateProjectMetadataActivity(ctx context.Context, projectId, warehouseId string) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[UpdateProjectMetadataActivity] Starting activity for project: %s, warehouseId: %s", projectId, warehouseId)
	log.Printf("[UpdateProjectMetadataActivity] WorkflowID: %s, RunID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.WorkflowExecution.RunID, activityInfo.ActivityID)

	startTime := time.Now()
	configServiceURL := os.Getenv("CONFIG_SERVICE_URL")
	if configServiceURL == "" {
		configServiceURL = "http://config-service:3000"
	}

	configClient := clients.NewConfigClient(configServiceURL)

	metadata := map[string]interface{}{
		"warehouseId": warehouseId,
	}

	err := configClient.UpdateProjectMetadata(projectId, metadata)
	duration := time.Since(startTime)

	if err != nil {
		log.Printf("[UpdateProjectMetadataActivity] ERROR: Failed to update project metadata for project %s after %v: %v", projectId, duration, err)
		return fmt.Errorf("failed to update project metadata: %w", err)
	}

	log.Printf("[UpdateProjectMetadataActivity] Project metadata updated successfully for project: %s, duration: %v", projectId, duration)
	return nil
}

// DeleteBucketActivity deletes a bucket by calling config-service
func DeleteBucketActivity(ctx context.Context, input types.DeleteBucketRequest) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[DeleteBucketActivity] Starting activity for bucket: %s, projectId: %s", input.BucketName, input.ProjectId)
	log.Printf("[DeleteBucketActivity] WorkflowID: %s, RunID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.WorkflowExecution.RunID, activityInfo.ActivityID)
	log.Printf("[DeleteBucketActivity] Input: %+v", input)

	startTime := time.Now()

	configServiceURL := os.Getenv("CONFIG_SERVICE_URL")
	if configServiceURL == "" {
		configServiceURL = "http://config-service:3000"
	}

	configClient := clients.NewConfigClient(configServiceURL)

	err := configClient.DeleteBucket(input.ProjectId, input.BucketName)
	duration := time.Since(startTime)

	if err != nil {
		log.Printf("[DeleteBucketActivity] ERROR: Failed to delete bucket %s from config-service after %v: %v", input.BucketName, duration, err)
		return fmt.Errorf("failed to delete bucket: %w", err)
	}

	log.Printf("[DeleteBucketActivity] Bucket %s deleted successfully via config-service, duration: %v", input.BucketName, duration)
	return nil
}

// UnregisterWarehouseActivity unregisters a warehouse from Lakekeeper
func UnregisterWarehouseActivity(ctx context.Context, input types.UnregisterWarehouseRequest) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[UnregisterWarehouseActivity] Starting activity for warehouse: %s", input.WarehouseName)
	log.Printf("[UnregisterWarehouseActivity] WorkflowID: %s, RunID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.WorkflowExecution.RunID, activityInfo.ActivityID)
	log.Printf("[UnregisterWarehouseActivity] Input: %+v", input)

	startTime := time.Now()
	lakekeeperURL := os.Getenv("LAKEKEEPER_URL")
	if lakekeeperURL == "" {
		lakekeeperURL = "http://lakekeeper:8181"
	}

	lakekeeperClient := clients.NewLakekeeperClient(lakekeeperURL)

	// Get warehouse ID - use provided ID or look up by name
	warehouseId := input.WarehouseId
	if warehouseId == "" {
		log.Printf("[UnregisterWarehouseActivity] Warehouse ID not provided, looking up by name: %s", input.WarehouseName)
		var err error
		warehouseId, err = lakekeeperClient.GetWarehouseByName(input.WarehouseName)
		if err != nil {
			log.Printf("[UnregisterWarehouseActivity] WARN: Failed to look up warehouse ID by name %s: %v", input.WarehouseName, err)
			// Continue - warehouse might already be deleted, which is idempotent
			log.Printf("[UnregisterWarehouseActivity] Continuing with deletion attempt (warehouse may already be deleted)")
			return nil
		}
		log.Printf("[UnregisterWarehouseActivity] Found warehouse ID: %s for name: %s", warehouseId, input.WarehouseName)
	} else {
		log.Printf("[UnregisterWarehouseActivity] Using provided warehouse ID: %s", warehouseId)
	}

	err := lakekeeperClient.DeleteWarehouse(warehouseId)
	duration := time.Since(startTime)

	if err != nil {
		log.Printf("[UnregisterWarehouseActivity] ERROR: Failed to unregister warehouse %s (ID: %s) after %v: %v", input.WarehouseName, warehouseId, duration, err)
		return fmt.Errorf("failed to unregister warehouse: %w", err)
	}

	log.Printf("[UnregisterWarehouseActivity] Warehouse %s (ID: %s) unregistered successfully, duration: %v", input.WarehouseName, warehouseId, duration)
	return nil
}

// DeleteBucketFromConfigActivity deletes bucket record from config-service database
func DeleteBucketFromConfigActivity(ctx context.Context, input types.DeleteBucketRequest) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[DeleteBucketFromConfigActivity] Starting activity for bucket: %s, projectId: %s", input.BucketName, input.ProjectId)
	log.Printf("[DeleteBucketFromConfigActivity] WorkflowID: %s, RunID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.WorkflowExecution.RunID, activityInfo.ActivityID)
	log.Printf("[DeleteBucketFromConfigActivity] Input: %+v", input)

	startTime := time.Now()
	configServiceURL := os.Getenv("CONFIG_SERVICE_URL")
	if configServiceURL == "" {
		configServiceURL = "http://config-service:3000"
	}

	configClient := clients.NewConfigClient(configServiceURL)

	err := configClient.DeleteBucket(input.ProjectId, input.BucketName)
	duration := time.Since(startTime)

	if err != nil {
		log.Printf("[DeleteBucketFromConfigActivity] ERROR: Failed to delete bucket %s from config-service after %v: %v", input.BucketName, duration, err)
		return fmt.Errorf("failed to delete bucket from config-service: %w", err)
	}

	log.Printf("[DeleteBucketFromConfigActivity] Bucket %s deleted from config-service successfully, duration: %v", input.BucketName, duration)
	return nil
}

// LookupWarehouseActivity looks up warehouse ID by project name
func LookupWarehouseActivity(ctx context.Context, input types.LookupWarehouseRequest) (types.LookupWarehouseResult, error) {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[LookupWarehouseActivity] Starting activity for warehouse name: %s", input.WarehouseName)
	log.Printf("[LookupWarehouseActivity] WorkflowID: %s, RunID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.WorkflowExecution.RunID, activityInfo.ActivityID)

	startTime := time.Now()
	lakekeeperURL := os.Getenv("LAKEKEEPER_URL")
	if lakekeeperURL == "" {
		lakekeeperURL = "http://lakekeeper:8181"
	}

	lakekeeperClient := clients.NewLakekeeperClient(lakekeeperURL)

	warehouseId, err := lakekeeperClient.GetWarehouseByName(input.WarehouseName)
	duration := time.Since(startTime)

	if err != nil {
		log.Printf("[LookupWarehouseActivity] WARN: Warehouse %s not found (may already be deleted): %v, duration: %v", input.WarehouseName, err, duration)
		return types.LookupWarehouseResult{
			WarehouseName: input.WarehouseName,
			Found:         false,
		}, nil // Return nil error - not finding warehouse is OK for deletion
	}

	log.Printf("[LookupWarehouseActivity] Found warehouse %s with ID: %s, duration: %v", input.WarehouseName, warehouseId, duration)
	return types.LookupWarehouseResult{
		WarehouseId:   warehouseId,
		WarehouseName: input.WarehouseName,
		Found:         true,
	}, nil
}

// ListTablesInWarehouseActivity lists all tables in a warehouse namespace
func ListTablesInWarehouseActivity(ctx context.Context, input types.ListTablesInWarehouseRequest) (types.ListTablesResult, error) {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[ListTablesInWarehouseActivity] Starting activity for warehouse: %s, namespace: %s", input.WarehouseId, input.Namespace)
	log.Printf("[ListTablesInWarehouseActivity] WorkflowID: %s, RunID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.WorkflowExecution.RunID, activityInfo.ActivityID)

	startTime := time.Now()
	lakekeeperURL := os.Getenv("LAKEKEEPER_URL")
	if lakekeeperURL == "" {
		lakekeeperURL = "http://lakekeeper:8181"
	}

	lakekeeperClient := clients.NewLakekeeperClient(lakekeeperURL)

	tables, err := lakekeeperClient.ListTables(input.WarehouseId, input.Namespace)
	duration := time.Since(startTime)

	if err != nil {
		log.Printf("[ListTablesInWarehouseActivity] ERROR: Failed to list tables in warehouse %s, namespace %s: %v, duration: %v", input.WarehouseId, input.Namespace, err, duration)
		return types.ListTablesResult{Tables: []string{}}, err
	}

	log.Printf("[ListTablesInWarehouseActivity] Found %d tables in warehouse %s, namespace %s: %v, duration: %v", len(tables), input.WarehouseId, input.Namespace, tables, duration)
	return types.ListTablesResult{Tables: tables}, nil
}

// DeleteTableFromCatalogByNameActivity deletes a single table from the catalog
func DeleteTableFromCatalogByNameActivity(ctx context.Context, warehouseId, namespace, tableName string) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[DeleteTableFromCatalogByNameActivity] Starting activity for table: %s, namespace: %s, warehouse: %s", tableName, namespace, warehouseId)
	log.Printf("[DeleteTableFromCatalogByNameActivity] WorkflowID: %s, RunID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.WorkflowExecution.RunID, activityInfo.ActivityID)

	startTime := time.Now()
	lakekeeperURL := os.Getenv("LAKEKEEPER_URL")
	if lakekeeperURL == "" {
		lakekeeperURL = "http://lakekeeper:8181"
	}

	lakekeeperClient := clients.NewLakekeeperClient(lakekeeperURL)

	err := lakekeeperClient.DeleteTable(warehouseId, namespace, tableName)
	duration := time.Since(startTime)

	if err != nil {
		log.Printf("[DeleteTableFromCatalogByNameActivity] ERROR: Failed to delete table %s from catalog: %v, duration: %v", tableName, err, duration)
		return err
	}

	log.Printf("[DeleteTableFromCatalogByNameActivity] Table %s deleted successfully, duration: %v", tableName, duration)
	return nil
}

// DeleteNamespaceActivity deletes a namespace from Lakekeeper catalog
func DeleteNamespaceActivity(ctx context.Context, input types.DeleteNamespaceRequest) error {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[DeleteNamespaceActivity] Starting activity for namespace: %s, warehouse: %s", input.Namespace, input.WarehouseId)
	log.Printf("[DeleteNamespaceActivity] WorkflowID: %s, RunID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.WorkflowExecution.RunID, activityInfo.ActivityID)

	startTime := time.Now()
	lakekeeperURL := os.Getenv("LAKEKEEPER_URL")
	if lakekeeperURL == "" {
		lakekeeperURL = "http://lakekeeper:8181"
	}

	lakekeeperClient := clients.NewLakekeeperClient(lakekeeperURL)

	err := lakekeeperClient.DeleteNamespace(input.WarehouseId, input.Namespace)
	duration := time.Since(startTime)

	if err != nil {
		log.Printf("[DeleteNamespaceActivity] ERROR: Failed to delete namespace %s: %v, duration: %v", input.Namespace, err, duration)
		return err
	}

	log.Printf("[DeleteNamespaceActivity] Namespace %s deleted successfully, duration: %v", input.Namespace, duration)
	return nil
}

// ListNamespacesActivity lists all namespaces in a warehouse
func ListNamespacesActivity(ctx context.Context, input types.ListNamespacesRequest) (types.ListNamespacesResult, error) {
	activityInfo := activity.GetInfo(ctx)
	log.Printf("[ListNamespacesActivity] Starting activity for warehouse: %s", input.WarehouseId)
	log.Printf("[ListNamespacesActivity] WorkflowID: %s, RunID: %s, ActivityID: %s", activityInfo.WorkflowExecution.ID, activityInfo.WorkflowExecution.RunID, activityInfo.ActivityID)

	startTime := time.Now()
	lakekeeperURL := os.Getenv("LAKEKEEPER_URL")
	if lakekeeperURL == "" {
		lakekeeperURL = "http://lakekeeper:8181"
	}

	lakekeeperClient := clients.NewLakekeeperClient(lakekeeperURL)

	namespaces, err := lakekeeperClient.ListNamespaces(input.WarehouseId)
	duration := time.Since(startTime)

	if err != nil {
		log.Printf("[ListNamespacesActivity] ERROR: Failed to list namespaces in warehouse %s: %v, duration: %v", input.WarehouseId, err, duration)
		return types.ListNamespacesResult{Namespaces: []string{}}, err
	}

	log.Printf("[ListNamespacesActivity] Found %d namespaces in warehouse %s: %v, duration: %v", len(namespaces), input.WarehouseId, namespaces, duration)
	return types.ListNamespacesResult{Namespaces: namespaces}, nil
}
