package workflows

import (
	"fmt"
	"log"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// TableProcessingWorkflow orchestrates async table processing by dispatching
// a ProcessKBDocuments activity to the KB processing worker.
func TableProcessingWorkflow(ctx workflow.Context, input types.TableProcessingWorkflowInput) (types.TableProcessingWorkflowResult, error) {
	workflowID := workflow.GetInfo(ctx).WorkflowExecution.ID
	runID := workflow.GetInfo(ctx).WorkflowExecution.RunID

	log.Printf("[TableProcessingWorkflow] Starting workflow for dataset: %s, table: %s, project: %s, workflowID: %s, runID: %s",
		input.DataSetId, input.TableName, input.ProjectId, workflowID, runID)

	startTime := time.Now()
	result := types.TableProcessingWorkflowResult{
		ProjectId: input.ProjectId,
		DataSetId: input.DataSetId,
		TableName: input.TableName,
		Status:    "running",
	}

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    3,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	// Step 1: Get table metadata from lakekeeper catalog
	log.Printf("[TableProcessingWorkflow] Step 1: Getting table metadata from catalog")
	var tableMetadata map[string]interface{}
	warehouseIdForMetadata := input.WarehouseId
	if warehouseIdForMetadata == "" {
		warehouseIdForMetadata = input.ProjectId
	}
	err := workflow.ExecuteActivity(ctx, "GetTableMetadataActivity", input.ProjectId, input.Namespace, input.TableName, warehouseIdForMetadata).Get(ctx, &tableMetadata)
	if err != nil {
		log.Printf("[TableProcessingWorkflow] ERROR: Step 1 failed: %v", err)
		result.Status = "failed"
		result.ErrorMessage = fmt.Sprintf("failed to get table metadata: %v", err)
		workflow.ExecuteActivity(ctx, "UpdateDatasetStatusActivity", input.ProjectId, input.DataSetId, "errored", result.ErrorMessage).Get(ctx, nil)
		return result, err
	}

	// Step 2: Fetch project credentials
	log.Printf("[TableProcessingWorkflow] Step 2: Fetching project credentials")
	var creds types.ProjectCredentials
	err = workflow.ExecuteActivity(ctx, "FetchProjectCredentialsActivity", input.ProjectId).Get(ctx, &creds)
	if err != nil {
		log.Printf("[TableProcessingWorkflow] ERROR: Step 2 failed: %v", err)
		result.Status = "failed"
		result.ErrorMessage = fmt.Sprintf("failed to fetch credentials: %v", err)
		workflow.ExecuteActivity(ctx, "UpdateDatasetStatusActivity", input.ProjectId, input.DataSetId, "errored", result.ErrorMessage).Get(ctx, nil)
		return result, err
	}

	// Step 3: Dispatch processing activity to KB worker
	log.Printf("[TableProcessingWorkflow] Step 3: Dispatching table processing activity")
	processInput := map[string]interface{}{
		"project_id":               input.ProjectId,
		"dataset_id":               input.DataSetId,
		"table_name":               input.TableName,
		"namespace":                input.Namespace,
		"warehouse_id":             input.WarehouseId,
		"table_metadata":           tableMetadata,
		"workflow_id":              workflowID,
		"project_client_id":        creds.ProjectClientId,
		"project_client_secret":    creds.ProjectClientSecret,
		"aws_access_key_id":        creds.S3AccessKey,
		"aws_secret_access_key":    creds.S3SecretKey,
		"s3_endpoint":              creds.S3Endpoint,
		"aws_region":               creds.S3Region,
		"config_service_url":       creds.ConfigServiceURL,
		"keycloak_internal_issuer": creds.KeycloakIssuer,
		"lakekeeper_url":           creds.LakekeeperURL,
	}

	processOpts := workflow.ActivityOptions{
		TaskQueue:           kbProcessingQueue,
		StartToCloseTimeout: 30 * time.Minute,
		HeartbeatTimeout:    5 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 3,
		},
	}
	processCtx := workflow.WithActivityOptions(ctx, processOpts)

	var processResult map[string]interface{}
	err = workflow.ExecuteActivity(processCtx, "ProcessKBDocuments", processInput).Get(ctx, &processResult)
	if err != nil {
		log.Printf("[TableProcessingWorkflow] ERROR: Step 3 failed: %v", err)
		result.Status = "failed"
		result.ErrorMessage = fmt.Sprintf("table processing failed: %v", err)
		workflow.ExecuteActivity(ctx, "UpdateDatasetStatusActivity", input.ProjectId, input.DataSetId, "errored", result.ErrorMessage).Get(ctx, nil)
		return result, err
	}

	// Step 4: Update dataset status to "ready"
	log.Printf("[TableProcessingWorkflow] Step 4: Updating dataset status")
	err = workflow.ExecuteActivity(ctx, "UpdateDatasetStatusActivity", input.ProjectId, input.DataSetId, "ready", "").Get(ctx, nil)
	if err != nil {
		log.Printf("[TableProcessingWorkflow] WARN: Step 4 failed (non-critical): %v", err)
	}

	result.Status = "completed"
	duration := time.Since(startTime)
	log.Printf("[TableProcessingWorkflow] Workflow completed for dataset: %s, duration: %v", input.DataSetId, duration)

	return result, nil
}
