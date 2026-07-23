package workflows

import (
	"fmt"
	"log"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// KnowledgeBaseDeleteWorkflow orchestrates knowledge base deletion from S3
// Deletes all LanceDB files and metadata associated with the KB
func KnowledgeBaseDeleteWorkflow(ctx workflow.Context, input types.KnowledgeBaseDeleteWorkflowInput) (types.KnowledgeBaseDeleteWorkflowResult, error) {
	workflowID := workflow.GetInfo(ctx).WorkflowExecution.ID
	runID := workflow.GetInfo(ctx).WorkflowExecution.RunID

	log.Printf("[KnowledgeBaseDeleteWorkflow] Starting workflow for KB: %s, project: %s, workflowID: %s, runID: %s",
		input.KnowledgeBaseId, input.ProjectId, workflowID, runID)
	log.Printf("[KnowledgeBaseDeleteWorkflow] Input: bucketName=%s", input.BucketName)

	startTime := time.Now()
	result := types.KnowledgeBaseDeleteWorkflowResult{
		ProjectId:       input.ProjectId,
		KnowledgeBaseId: input.KnowledgeBaseId,
		S3FilesDeleted:  false,
		Status:          "running",
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

	// Step 1: Delete KB files from S3
	log.Printf("[KnowledgeBaseDeleteWorkflow] Step 1: Deleting KB files from S3")
	deleteRequest := types.DeleteKBFilesRequest{
		ProjectId:       input.ProjectId,
		KnowledgeBaseId: input.KnowledgeBaseId,
		BucketName:      input.BucketName,
		PathPrefix:      input.PathPrefix,
	}

	var deleteResult types.DeleteKBFilesResult
	err := workflow.ExecuteActivity(ctx, "DeleteKBFilesActivity", deleteRequest).Get(ctx, &deleteResult)
	if err != nil {
		log.Printf("[KnowledgeBaseDeleteWorkflow] ERROR: Step 1 failed - DeleteKBFilesActivity error: %v", err)
		result.Status = "failed"
		result.ErrorMessage = fmt.Sprintf("failed to delete KB files from S3: %v", err)
		return result, err
	}

	if !deleteResult.Success {
		log.Printf("[KnowledgeBaseDeleteWorkflow] ERROR: Step 1 failed - S3 deletion returned unsuccessful")
		result.Status = "failed"
		result.ErrorMessage = "failed to delete KB files from S3"
		return result, fmt.Errorf("failed to delete KB files from S3")
	}

	result.S3FilesDeleted = true
	result.FilesDeleted = deleteResult.FilesDeleted
	log.Printf("[KnowledgeBaseDeleteWorkflow] Step 1 completed: Deleted %d files from S3", deleteResult.FilesDeleted)

	// Workflow completed successfully
	result.Status = "completed"
	duration := time.Since(startTime)
	log.Printf("[KnowledgeBaseDeleteWorkflow] Workflow completed successfully for KB: %s, duration: %v", input.KnowledgeBaseId, duration)
	log.Printf("[KnowledgeBaseDeleteWorkflow] Summary: s3FilesDeleted=%v, filesDeleted=%d",
		result.S3FilesDeleted, result.FilesDeleted)

	return result, nil
}
