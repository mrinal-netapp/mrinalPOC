package workflows

import (
	"fmt"
	"log"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// DatasetDeleteWorkflow orchestrates dataset deletion from Lakekeeper catalog and S3
func DatasetDeleteWorkflow(ctx workflow.Context, input types.DatasetDeleteWorkflowInput) (types.DatasetDeleteWorkflowResult, error) {
	workflowID := workflow.GetInfo(ctx).WorkflowExecution.ID
	runID := workflow.GetInfo(ctx).WorkflowExecution.RunID

	log.Printf("[DatasetDeleteWorkflow] Starting workflow for dataset: %s, project: %s, workflowID: %s, runID: %s",
		input.DataSetId, input.ProjectId, workflowID, runID)
	log.Printf("[DatasetDeleteWorkflow] Input: tableName=%s, namespace=%s, warehouseId=%s, bucketName=%s",
		input.TableName, input.Namespace, input.WarehouseId, input.BucketName)

	startTime := time.Now()
	result := types.DatasetDeleteWorkflowResult{
		ProjectId:      input.ProjectId,
		DataSetId:      input.DataSetId,
		TableName:      input.TableName,
		TableDeleted:   false,
		S3FilesDeleted: false,
		Status:         "running",
	}

	// Set activity options with appropriate timeouts and retry policy
	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 10 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    3,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	// Step 1: Delete table from Lakekeeper catalog
	log.Printf("[DatasetDeleteWorkflow] Step 1: Deleting table from Lakekeeper catalog: %s", input.TableName)
	catalogRequest := types.DeleteTableFromCatalogRequest{
		ProjectId:   input.ProjectId,
		DataSetId:   input.DataSetId,
		TableName:   input.TableName,
		Namespace:   input.Namespace,
		WarehouseId: input.WarehouseId,
	}

	err := workflow.ExecuteActivity(ctx, "DeleteTableFromCatalogActivity", catalogRequest).Get(ctx, nil)
	if err != nil {
		log.Printf("[DatasetDeleteWorkflow] WARN: Step 1 failed - DeleteTableFromCatalogActivity error: %v", err)
		// Continue with S3 deletion even if catalog deletion fails (table might not exist)
		log.Printf("[DatasetDeleteWorkflow] Continuing with S3 deletion despite catalog error")
	} else {
		result.TableDeleted = true
		log.Printf("[DatasetDeleteWorkflow] Step 1 completed: Table %s deleted from catalog", input.TableName)
	}

	// Step 2: Delete dataset files from S3
	log.Printf("[DatasetDeleteWorkflow] Step 2: Deleting dataset files from S3")
	s3Request := types.DeleteDatasetFilesRequest{
		ProjectId:  input.ProjectId,
		DataSetId:  input.DataSetId,
		BucketName: input.BucketName,
		PathPrefix: input.PathPrefix,
	}

	err = workflow.ExecuteActivity(ctx, "DeleteDatasetFilesActivity", s3Request).Get(ctx, nil)
	if err != nil {
		log.Printf("[DatasetDeleteWorkflow] ERROR: Step 2 failed - DeleteDatasetFilesActivity error: %v", err)
		result.Status = "failed"
		result.ErrorMessage = fmt.Sprintf("failed to delete S3 files: %v", err)
		return result, err
	}

	result.S3FilesDeleted = true
	log.Printf("[DatasetDeleteWorkflow] Step 2 completed: Dataset files deleted from S3")

	// Workflow completed successfully
	result.Status = "completed"
	duration := time.Since(startTime)
	log.Printf("[DatasetDeleteWorkflow] Workflow completed successfully for dataset: %s, duration: %v", input.DataSetId, duration)
	log.Printf("[DatasetDeleteWorkflow] Summary: tableDeleted=%v, s3FilesDeleted=%v",
		result.TableDeleted, result.S3FilesDeleted)

	return result, nil
}
