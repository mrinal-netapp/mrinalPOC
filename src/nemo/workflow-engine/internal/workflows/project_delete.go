package workflows

import (
	"fmt"
	"log"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

// ProjectDeleteWorkflow orchestrates complete project deletion:
//  0. Tear down the project's Bifrost team + virtual key (mirror of
//     `ProjectInitWorkflow` Step 0 `SetupProjectLLMGatewayActivity`).
//  1. Lookup warehouse ID by project name
//  2. List and delete all tables in the warehouse
//  3. Delete all catalog namespaces
//  4. Delete the warehouse
//  5. Delete credential K8s secrets for the project
//  6. Delete the S3 bucket
//
// Step 0 runs FIRST -- before the Iceberg / S3 cleanup -- for the same
// reason `ProjectInitWorkflow` runs the symmetric setup activity first:
// it's a fast governance operation (~hundreds of ms) compared with the
// multi-minute Iceberg/S3 work, so failing fast saves retry budget.
// It also takes its inputs (team / VK ids) from the workflow input
// `Gateway` field rather than reading the `projects` row -- by the time
// this activity runs the row may have been deleted by the config-service
// DELETE handler (the handler returns 204 immediately after kicking the
// workflow off so the UI list updates straight away). The handler
// captures `projects.metadata._gateway` BEFORE returning 204 and
// forwards it into the workflow input.
func ProjectDeleteWorkflow(ctx workflow.Context, input types.ProjectDeleteWorkflowInput) (types.ProjectDeleteWorkflowResult, error) {
	workflowID := workflow.GetInfo(ctx).WorkflowExecution.ID
	runID := workflow.GetInfo(ctx).WorkflowExecution.RunID

	log.Printf("[ProjectDeleteWorkflow] ========================================")
	log.Printf("[ProjectDeleteWorkflow] Starting workflow for project: %s", input.ProjectId)
	log.Printf("[ProjectDeleteWorkflow] WorkflowID: %s, RunID: %s", workflowID, runID)
	log.Printf("[ProjectDeleteWorkflow] Input configuration: bucketName=%s, gateway=%v", input.BucketName, input.Gateway)
	log.Printf("[ProjectDeleteWorkflow] ========================================")

	startTime := time.Now()
	result := types.ProjectDeleteWorkflowResult{
		ProjectId:             input.ProjectId,
		BucketDeleted:         false,
		BucketName:            input.BucketName,
		WarehouseUnregistered: false,
		WarehouseName:         input.ProjectId, // Warehouse name is same as project ID
		BucketRemovedFromDB:   false,
		Status:                "running",
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

	// ----------------------------------------------------------------
	// Step 0: Tear down the Bifrost LLM gateway (team + VK + per-project
	// models / MCP clients / routing rules + VK K8s Secret) for the
	// project. Symmetric counterpart of `ProjectInitWorkflow` Step 0.
	// ----------------------------------------------------------------
	// Failures here are LOGGED, not fatal: the user has explicitly asked
	// for the project to go away, and config-service's `_gateway`
	// metadata has already been captured into the workflow input -- a
	// transient Bifrost outage shouldn't keep the project alive forever
	// from the user's point of view. The activity itself is fully
	// idempotent so Temporal retries are safe; a residual leak of a VK
	// or team will be detected on the next `ensureProjectGateway`
	// self-heal sweep on any project re-creation with the same id.
	log.Printf("[ProjectDeleteWorkflow] ----------------------------------------")
	log.Printf("[ProjectDeleteWorkflow] Step 0/7: Tearing down Bifrost LLM gateway for project: %s", input.ProjectId)
	teardownInput := types.TeardownProjectLLMGatewayInput{
		ProjectId: input.ProjectId,
		Gateway:   input.Gateway,
	}
	teardownErr := workflow.ExecuteActivity(ctx, "TeardownProjectLLMGatewayActivity", teardownInput).Get(ctx, nil)
	if teardownErr != nil {
		log.Printf("[ProjectDeleteWorkflow] WARN: Step 0 failed - TeardownProjectLLMGatewayActivity error: %v (continuing with rest of deletion)", teardownErr)
	} else {
		log.Printf("[ProjectDeleteWorkflow] Step 0 completed: Bifrost LLM gateway torn down for project: %s", input.ProjectId)
	}

	// Step 1: Lookup warehouse ID by project name
	log.Printf("[ProjectDeleteWorkflow] ----------------------------------------")
	log.Printf("[ProjectDeleteWorkflow] Step 1/7: Looking up warehouse ID for project: %s", input.ProjectId)
	lookupRequest := types.LookupWarehouseRequest{
		WarehouseName: input.ProjectId,
	}

	var warehouseLookup types.LookupWarehouseResult
	err := workflow.ExecuteActivity(ctx, "LookupWarehouseActivity", lookupRequest).Get(ctx, &warehouseLookup)
	if err != nil {
		log.Printf("[ProjectDeleteWorkflow] ERROR: Step 1 failed - LookupWarehouseActivity error: %v", err)
		log.Printf("[ProjectDeleteWorkflow] WARN: Continuing without warehouse cleanup (warehouse may not exist)")
	}

	if warehouseLookup.Found {
		log.Printf("[ProjectDeleteWorkflow] Step 1 completed: Found warehouse ID: %s for project: %s", warehouseLookup.WarehouseId, input.ProjectId)

		// Step 2: List all namespaces in the warehouse
		log.Printf("[ProjectDeleteWorkflow] ----------------------------------------")
		log.Printf("[ProjectDeleteWorkflow] Step 2/7: Listing all namespaces in warehouse: %s", warehouseLookup.WarehouseId)

		listNsRequest := types.ListNamespacesRequest{
			WarehouseId: warehouseLookup.WarehouseId,
		}

		var namespacesResult types.ListNamespacesResult
		err = workflow.ExecuteActivity(ctx, "ListNamespacesActivity", listNsRequest).Get(ctx, &namespacesResult)
		if err != nil {
			log.Printf("[ProjectDeleteWorkflow] WARN: Failed to list namespaces: %v", err)
			log.Printf("[ProjectDeleteWorkflow] Falling back to 'default' namespace only")
			namespacesResult.Namespaces = []string{"default"}
		}

		log.Printf("[ProjectDeleteWorkflow] Step 2: Found %d namespaces: %v", len(namespacesResult.Namespaces), namespacesResult.Namespaces)

		// Track totals across all namespaces
		totalTablesDeleted := 0
		totalTablesFailed := 0
		totalNamespacesDeleted := 0
		totalNamespacesFailed := 0

		// Step 3: For each namespace, list and delete all tables (including stragglers)
		log.Printf("[ProjectDeleteWorkflow] ----------------------------------------")
		log.Printf("[ProjectDeleteWorkflow] Step 3/7: Deleting ALL tables from ALL namespaces (including any stragglers not in config-service)")

		for nsIdx, namespace := range namespacesResult.Namespaces {
			log.Printf("[ProjectDeleteWorkflow] Step 3: Processing namespace %d/%d: %s", nsIdx+1, len(namespacesResult.Namespaces), namespace)

			listTablesRequest := types.ListTablesInWarehouseRequest{
				WarehouseId: warehouseLookup.WarehouseId,
				Namespace:   namespace,
			}

			var tablesResult types.ListTablesResult
			err = workflow.ExecuteActivity(ctx, "ListTablesInWarehouseActivity", listTablesRequest).Get(ctx, &tablesResult)
			if err != nil {
				log.Printf("[ProjectDeleteWorkflow] WARN: Failed to list tables in namespace %s: %v", namespace, err)
				continue
			}

			log.Printf("[ProjectDeleteWorkflow] Step 3: Found %d tables in namespace %s: %v", len(tablesResult.Tables), namespace, tablesResult.Tables)

			// Delete each table in this namespace
			for i, tableName := range tablesResult.Tables {
				log.Printf("[ProjectDeleteWorkflow] Step 3: Deleting table %d/%d in namespace %s: %s", i+1, len(tablesResult.Tables), namespace, tableName)

				err = workflow.ExecuteActivity(ctx, "DeleteTableFromCatalogByNameActivity", warehouseLookup.WarehouseId, namespace, tableName).Get(ctx, nil)
				if err != nil {
					totalTablesFailed++
					log.Printf("[ProjectDeleteWorkflow] WARN: Failed to delete table %s.%s: %v (continuing)", namespace, tableName, err)
				} else {
					totalTablesDeleted++
					log.Printf("[ProjectDeleteWorkflow] Step 3: Table %s.%s deleted successfully", namespace, tableName)
				}
			}
		}

		log.Printf("[ProjectDeleteWorkflow] Step 3 completed: %d tables deleted, %d failed across all namespaces", totalTablesDeleted, totalTablesFailed)

		// Step 4: Delete all namespaces
		log.Printf("[ProjectDeleteWorkflow] ----------------------------------------")
		log.Printf("[ProjectDeleteWorkflow] Step 4/7: Deleting all namespaces from warehouse: %s", warehouseLookup.WarehouseId)

		for nsIdx, namespace := range namespacesResult.Namespaces {
			log.Printf("[ProjectDeleteWorkflow] Step 4: Deleting namespace %d/%d: %s", nsIdx+1, len(namespacesResult.Namespaces), namespace)

			namespaceRequest := types.DeleteNamespaceRequest{
				WarehouseId: warehouseLookup.WarehouseId,
				Namespace:   namespace,
			}

			err = workflow.ExecuteActivity(ctx, "DeleteNamespaceActivity", namespaceRequest).Get(ctx, nil)
			if err != nil {
				totalNamespacesFailed++
				log.Printf("[ProjectDeleteWorkflow] WARN: Failed to delete namespace %s: %v (continuing)", namespace, err)
			} else {
				totalNamespacesDeleted++
				log.Printf("[ProjectDeleteWorkflow] Step 4: Namespace %s deleted successfully", namespace)
			}
		}

		log.Printf("[ProjectDeleteWorkflow] Step 4 completed: %d namespaces deleted, %d failed", totalNamespacesDeleted, totalNamespacesFailed)

		// Step 5: Delete the warehouse
		log.Printf("[ProjectDeleteWorkflow] ----------------------------------------")
		log.Printf("[ProjectDeleteWorkflow] Step 5/7: Deleting warehouse: %s (ID: %s)", input.ProjectId, warehouseLookup.WarehouseId)

		warehouseRequest := types.UnregisterWarehouseRequest{
			WarehouseName: input.ProjectId,
			WarehouseId:   warehouseLookup.WarehouseId,
		}

		err = workflow.ExecuteActivity(ctx, "UnregisterWarehouseActivity", warehouseRequest).Get(ctx, nil)
		if err != nil {
			log.Printf("[ProjectDeleteWorkflow] WARN: Step 5 failed - UnregisterWarehouseActivity error: %v (continuing)", err)
		} else {
			result.WarehouseUnregistered = true
			log.Printf("[ProjectDeleteWorkflow] Step 5 completed: Warehouse %s deleted successfully", input.ProjectId)
		}
	} else {
		log.Printf("[ProjectDeleteWorkflow] Step 1: Warehouse not found for project %s (may already be deleted)", input.ProjectId)
		log.Printf("[ProjectDeleteWorkflow] Skipping steps 2-5 (no warehouse to cleanup)")
	}

	// Step 5.5: Delete Keycloak project resource and authorization artifacts
	log.Printf("[ProjectDeleteWorkflow] ----------------------------------------")
	log.Printf("[ProjectDeleteWorkflow] Step 5.5: Deleting Keycloak authorization artifacts for project: %s", input.ProjectId)

	deleteKcInput := types.DeleteProjectResourceInput{
		ProjectId: input.ProjectId,
	}
	err = workflow.ExecuteActivity(ctx, "DeleteProjectResourceActivity", deleteKcInput).Get(ctx, nil)
	if err != nil {
		log.Printf("[ProjectDeleteWorkflow] WARN: Step 5.5 failed - Keycloak cleanup error: %v (continuing)", err)
	} else {
		log.Printf("[ProjectDeleteWorkflow] Step 5.5 completed: Keycloak artifacts cleaned up for project %s", input.ProjectId)
	}

	// Step 6: Delete credential K8s secrets for the project
	log.Printf("[ProjectDeleteWorkflow] ----------------------------------------")
	log.Printf("[ProjectDeleteWorkflow] Step 6/7: Deleting credential K8s secrets for project: %s", input.ProjectId)

	err = workflow.ExecuteActivity(ctx, "DeleteProjectCredentialSecretsActivity", input.ProjectId).Get(ctx, nil)
	if err != nil {
		log.Printf("[ProjectDeleteWorkflow] WARN: Step 6 failed - credential secret cleanup error: %v (continuing)", err)
	} else {
		log.Printf("[ProjectDeleteWorkflow] Step 6 completed: Credential secrets cleaned up for project %s", input.ProjectId)
	}

	// Step 7: Delete bucket via config-service
	log.Printf("[ProjectDeleteWorkflow] ----------------------------------------")
	log.Printf("[ProjectDeleteWorkflow] Step 7/7: Deleting S3 bucket: %s", result.BucketName)
	bucketRequest := types.DeleteBucketRequest{
		ProjectId:  input.ProjectId,
		BucketName: input.BucketName,
	}

	err = workflow.ExecuteActivity(ctx, "DeleteBucketActivity", bucketRequest).Get(ctx, nil)
	if err != nil {
		log.Printf("[ProjectDeleteWorkflow] ERROR: Step 7 failed - DeleteBucketActivity error: %v", err)
		result.Status = "failed"
		result.Error = fmt.Sprintf("failed to delete bucket: %v", err)
		result.Duration = time.Since(startTime)
		return result, err
	}

	result.BucketDeleted = true
	result.BucketRemovedFromDB = true
	log.Printf("[ProjectDeleteWorkflow] Step 7 completed: Bucket %s deleted successfully", result.BucketName)

	// Workflow completed successfully
	result.Status = "completed"
	result.Duration = time.Since(startTime)
	log.Printf("[ProjectDeleteWorkflow] ========================================")
	log.Printf("[ProjectDeleteWorkflow] WORKFLOW COMPLETED SUCCESSFULLY")
	log.Printf("[ProjectDeleteWorkflow] Project: %s", input.ProjectId)
	log.Printf("[ProjectDeleteWorkflow] Duration: %v", result.Duration)
	log.Printf("[ProjectDeleteWorkflow] ----------------------------------------")
	log.Printf("[ProjectDeleteWorkflow] DELETION SUMMARY:")
	log.Printf("[ProjectDeleteWorkflow]   - Warehouse found: %v", warehouseLookup.Found)
	log.Printf("[ProjectDeleteWorkflow]   - Warehouse ID: %s", warehouseLookup.WarehouseId)
	log.Printf("[ProjectDeleteWorkflow]   - Warehouse deleted: %v", result.WarehouseUnregistered)
	log.Printf("[ProjectDeleteWorkflow]   - S3 Bucket deleted: %v", result.BucketDeleted)
	log.Printf("[ProjectDeleteWorkflow]   - Bucket removed from DB: %v", result.BucketRemovedFromDB)
	log.Printf("[ProjectDeleteWorkflow] ========================================")

	return result, nil
}
