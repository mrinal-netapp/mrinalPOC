package workflows

import (
	"fmt"
	"log"
	"time"

	"github.com/agentstudio/nemo/workflow-engine/internal/activities"
	"github.com/agentstudio/nemo/workflow-engine/pkg/types"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"
)

const datasetProcessingQueue = "dataset-processing"

// DatasetImportWorkflow orchestrates dataset import processing using
// Temporal worker activities via the ScatterGather pattern.
func DatasetImportWorkflow(ctx workflow.Context, input types.DatasetImportWorkflowInput) (types.DatasetImportWorkflowResult, error) {
	workflowID := workflow.GetInfo(ctx).WorkflowExecution.ID
	runID := workflow.GetInfo(ctx).WorkflowExecution.RunID

	log.Printf("[DatasetImportWorkflow] Starting workflow for dataset: %s (%s), project: %s, workflowID: %s, runID: %s",
		input.DataSetId, input.DatasetKind, input.ProjectId, workflowID, runID)

	ao := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    3,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, ao)

	result := types.DatasetImportWorkflowResult{
		ProjectId:   input.ProjectId,
		DataSetId:   input.DataSetId,
		DatasetName: input.DatasetName,
		Status:      "running",
	}

	// Step 1: Fetch project credentials (replaces ephemeral K8s Secrets)
	log.Printf("[DatasetImportWorkflow] Step 1: Fetching project credentials")
	var creds types.ProjectCredentials
	err := workflow.ExecuteActivity(ctx, "FetchProjectCredentialsActivity", input.ProjectId).Get(ctx, &creds)
	if err != nil {
		log.Printf("[DatasetImportWorkflow] ERROR: Failed to fetch credentials: %v", err)
		result.Status = "failed"
		result.ErrorMessage = fmt.Sprintf("failed to fetch project credentials: %v", err)
		workflow.ExecuteActivity(ctx, "UpdateDatasetStatusActivity", input.ProjectId, input.DataSetId, "errored", result.ErrorMessage).Get(ctx, nil)
		return result, err
	}

	// PII reprocessing takes a separate path: single activity, no scatter-gather
	if input.ReprocessPiiOnly {
		return runPiiReprocessing(ctx, input, creds)
	}

	// Step 2: Create work plan (list files and divide into work units)
	// Route to dataset-processing queue where the Python activity is registered.
	log.Printf("[DatasetImportWorkflow] Step 2: Creating work plan")
	wpAO := workflow.ActivityOptions{
		TaskQueue:              datasetProcessingQueue,
		StartToCloseTimeout:    30 * time.Minute,
		ScheduleToStartTimeout: 5 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    3,
		},
	}
	wpCtx := workflow.WithActivityOptions(ctx, wpAO)
	var plan types.WorkPlan
	err = workflow.ExecuteActivity(wpCtx, "CreateWorkPlanActivity", types.CreateWorkPlanInput{
		BucketName:   input.BucketName,
		PathPrefix:   input.PathPrefix,
		DatasetId:    input.DataSetId,
		JobId:        workflowID,
		WorkloadType: "dataset",
		FileListKey:  input.FileListKey,
	}).Get(ctx, &plan)
	if err != nil {
		log.Printf("[DatasetImportWorkflow] ERROR: Failed to create work plan: %v", err)
		result.Status = "failed"
		result.ErrorMessage = fmt.Sprintf("failed to create work plan: %v", err)
		workflow.ExecuteActivity(ctx, "UpdateDatasetStatusActivity", input.ProjectId, input.DataSetId, "errored", result.ErrorMessage).Get(ctx, nil)
		return result, err
	}

	log.Printf("[DatasetImportWorkflow] Work plan: %d file sets for %d files (singleWorker=%v)",
		len(plan.FileSets), plan.TotalFiles, plan.UseSingleWorker)

	_ = workflow.ExecuteActivity(ctx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
		Phase:      "importing",
		Percentage: 2,
		Message:    fmt.Sprintf("Processing %d files across %d work units", plan.TotalFiles, len(plan.FileSets)),
	}).Get(ctx, nil)

	// Step 4: Build work unit inputs for the Python dataset worker
	workUnits := make([]interface{}, len(plan.FileSets))
	for i, fs := range plan.FileSets {
		workUnits[i] = buildDatasetWorkUnitInput(input, creds, fs, plan.JobOutputPrefix, workflowID)
	}

	// Seed progress store with totalUnits and pending unit slots
	seedUnits := make([]activities.UnitProgressSeed, len(plan.FileSets))
	for i, fs := range plan.FileSets {
		seedUnits[i] = activities.UnitProgressSeed{UnitID: fs.SetID, Status: "pending"}
	}
	_ = workflow.ExecuteActivity(ctx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
		TotalUnits: len(plan.FileSets),
		Units:      seedUnits,
	}).Get(ctx, nil)

	// Step 5: ScatterGather - fan out ProcessDatasetFiles activities
	log.Printf("[DatasetImportWorkflow] Step 5: Running ScatterGather with %d units", len(workUnits))
	sgResult, err := RunScatterGather(ctx, ScatterGatherParams{
		ProcessActivityName: "ProcessDatasetFiles",
		MergeActivityName:   "",
		TaskQueue:           datasetProcessingQueue,
		ProcessTimeout:      6 * time.Hour,
		// Large single files/partitions: Python must heartbeat within this window (see dataset-processor).
		HeartbeatTimeout:       20 * time.Minute,
		ScheduleToStartTimeout: 15 * time.Minute,
		MergeTimeout:           2 * time.Hour,
		WorkUnits:              workUnits,
		OnUnitComplete: func(completed, total int) {
			_ = workflow.ExecuteActivity(ctx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
				Phase:      "processing",
				Percentage: float64(completed) / float64(total) * 85,
				Message:    fmt.Sprintf("Completed %d of %d work units", completed, total),
			}).Get(ctx, nil)
		},
		OnUnitCompleteWithResult: func(completed, total int, wuResult *types.WorkUnitResult) {
			if wuResult != nil && wuResult.SetID != "" {
				unitStatus := "completed"
				if wuResult.Status != "success" {
					unitStatus = "failed"
				}
				unitMetrics := map[string]interface{}{"fileCount": wuResult.FileCount, "rowCount": wuResult.RowCount}
				_ = workflow.ExecuteActivity(ctx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
					UnitID:      wuResult.SetID,
					UnitStatus:  unitStatus,
					UnitMetrics: unitMetrics,
				}).Get(ctx, nil)
			}
		},
	})
	if err != nil {
		log.Printf("[DatasetImportWorkflow] ERROR: ScatterGather failed: %v", err)
		result.Status = "failed"
		result.ErrorMessage = fmt.Sprintf("processing failed: %v", err)
		workflow.ExecuteActivity(ctx, "UpdateDatasetStatusActivity", input.ProjectId, input.DataSetId, "errored", result.ErrorMessage).Get(ctx, nil)
		return result, err
	}

	log.Printf("[DatasetImportWorkflow] ScatterGather complete: %d succeeded", sgResult.Succeeded)

	// Step 6: Run merge/aggregation activity
	_ = workflow.ExecuteActivity(ctx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
		Phase:      "aggregating",
		Percentage: 88,
		Message:    "Merging results from all work units",
	}).Get(ctx, nil)

	mergeInput := buildDatasetMergeInput(input, creds, plan.JobOutputPrefix, workflowID)

	mergeOpts := workflow.ActivityOptions{
		TaskQueue:              datasetProcessingQueue,
		StartToCloseTimeout:    2 * time.Hour,
		HeartbeatTimeout:       15 * time.Minute,
		ScheduleToStartTimeout: 15 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 2,
		},
	}
	mergeCtx := workflow.WithActivityOptions(ctx, mergeOpts)
	var mergeResult map[string]interface{}
	err = workflow.ExecuteActivity(mergeCtx, "MergeDatasetResults", mergeInput).Get(ctx, &mergeResult)
	if err != nil {
		result.Status = "failed"
		result.ErrorMessage = fmt.Sprintf("merge failed: %v", err)
		workflow.ExecuteActivity(ctx, "UpdateDatasetStatusActivity", input.ProjectId, input.DataSetId, "errored", result.ErrorMessage).Get(ctx, nil)
		return result, err
	}

	// Step 7: Read processing result from S3
	var processingResult types.ProcessingResult
	err = workflow.ExecuteActivity(ctx, "ReadProcessingResultActivity", input.BucketName, input.DataSetId, input.PathPrefix).Get(ctx, &processingResult)
	if err != nil {
		result.Status = "failed"
		result.ErrorMessage = fmt.Sprintf("failed to read processing result: %v", err)
		workflow.ExecuteActivity(ctx, "UpdateDatasetStatusActivity", input.ProjectId, input.DataSetId, "errored", result.ErrorMessage).Get(ctx, nil)
		return result, err
	}

	if processingResult.Status != "success" {
		result.Status = "failed"
		result.ErrorMessage = fmt.Sprintf("data processing failed: %s", processingResult.Error)
		workflow.ExecuteActivity(ctx, "UpdateDatasetStatusActivity", input.ProjectId, input.DataSetId, "errored", result.ErrorMessage).Get(ctx, nil)
		return result, fmt.Errorf("data processing failed: %s", processingResult.Error)
	}

	if !processingResult.CatalogRegistered || processingResult.CatalogTableRef == "" {
		result.Status = "failed"
		result.ErrorMessage = "processor failed to register table with catalog"
		workflow.ExecuteActivity(ctx, "UpdateDatasetStatusActivity", input.ProjectId, input.DataSetId, "errored", result.ErrorMessage).Get(ctx, nil)
		return result, fmt.Errorf("processor failed to register table with catalog")
	}

	_ = workflow.ExecuteActivity(ctx, "UpdateDatasetStatsFacetActivity", activities.UpdateDatasetStatsFacetInput{
		ProjectId:       input.ProjectId,
		DataSetId:       input.DataSetId,
		SourceFileCount: processingResult.SourceFileCount,
		RowCount:        processingResult.RowCount,
		ColumnCount:     processingResult.ColumnCount,
		Status:          "ready",
	}).Get(ctx, nil)

	result.Status = "completed"
	result.CatalogTable = processingResult.CatalogTableRef

	_ = workflow.ExecuteActivity(ctx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
		Phase:      "completed",
		Percentage: 100,
		Message:    "Import completed successfully",
	}).Get(ctx, nil)

	log.Printf("[DatasetImportWorkflow] Import completed for dataset: %s", input.DataSetId)
	return result, nil
}

// runPiiReprocessing uses the scatter-gather pattern to fan out PII analysis
// across multiple workers.  CreateWorkPlanActivity reads file metadata from
// the Iceberg catalog (source=iceberg), partitions into work units, then
// ReprocessPiiFiles activities run PII analysis in parallel, and finally
// MergePiiResults merges results back into the Iceberg table.
func runPiiReprocessing(ctx workflow.Context, input types.DatasetImportWorkflowInput, creds types.ProjectCredentials) (types.DatasetImportWorkflowResult, error) {
	workflowID := workflow.GetInfo(ctx).WorkflowExecution.ID
	result := types.DatasetImportWorkflowResult{
		ProjectId:   input.ProjectId,
		DataSetId:   input.DataSetId,
		DatasetName: input.DatasetName,
		Status:      "running",
	}

	log.Printf("[DatasetImportWorkflow] Running PII reprocessing (scatter-gather) for dataset: %s", input.DataSetId)

	_ = workflow.ExecuteActivity(ctx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
		Phase:      "pii_analysis",
		Percentage: 2,
		Message:    "Starting PII reprocessing",
	}).Get(ctx, nil)

	// Step 1: Create work plan from Iceberg catalog
	log.Printf("[DatasetImportWorkflow] PII Step 1: Creating work plan from Iceberg catalog")
	wpAO := workflow.ActivityOptions{
		TaskQueue:              datasetProcessingQueue,
		StartToCloseTimeout:    30 * time.Minute,
		ScheduleToStartTimeout: 5 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2.0,
			MaximumAttempts:    3,
		},
	}
	wpCtx := workflow.WithActivityOptions(ctx, wpAO)
	var plan types.WorkPlan
	err := workflow.ExecuteActivity(wpCtx, "CreateWorkPlanActivity", types.CreateWorkPlanInput{
		BucketName:   input.BucketName,
		PathPrefix:   input.PathPrefix,
		DatasetId:    input.DataSetId,
		JobId:        workflowID,
		WorkloadType: "dataset",
		Source:       "iceberg",
		Iceberg: &types.IcebergSource{
			Namespace:           input.Namespace,
			DatasetName:         input.DatasetName,
			LakekeeperURL:       creds.LakekeeperURL,
			WarehouseId:         input.WarehouseId,
			ProjectClientId:     creds.ProjectClientId,
			ProjectClientSecret: creds.ProjectClientSecret,
			AwsAccessKeyId:      creds.S3AccessKey,
			AwsSecretAccessKey:  creds.S3SecretKey,
			S3Endpoint:          creds.S3Endpoint,
			AwsRegion:           creds.S3Region,
			KeycloakIssuer:      creds.KeycloakIssuer,
		},
	}).Get(ctx, &plan)
	if err != nil {
		log.Printf("[DatasetImportWorkflow] ERROR: PII work plan creation failed: %v", err)
		result.Status = "failed"
		result.ErrorMessage = fmt.Sprintf("PII work plan creation failed: %v", err)
		workflow.ExecuteActivity(ctx, "UpdateDatasetStatusActivity", input.ProjectId, input.DataSetId, "errored", result.ErrorMessage).Get(ctx, nil)
		return result, err
	}

	log.Printf("[DatasetImportWorkflow] PII work plan: %d file sets for %d files", len(plan.FileSets), plan.TotalFiles)

	_ = workflow.ExecuteActivity(ctx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
		Phase:      "pii_analysis",
		Percentage: 5,
		Message:    fmt.Sprintf("Analyzing PII in %d files across %d work units", plan.TotalFiles, len(plan.FileSets)),
	}).Get(ctx, nil)

	// Step 2: Build work unit inputs
	workUnits := make([]interface{}, len(plan.FileSets))
	for i, fs := range plan.FileSets {
		workUnits[i] = buildPiiReprocessWorkUnitInput(input, creds, fs, plan.JobOutputPrefix, workflowID)
	}

	// Seed progress store with unit slots
	seedUnits := make([]activities.UnitProgressSeed, len(plan.FileSets))
	for i, fs := range plan.FileSets {
		seedUnits[i] = activities.UnitProgressSeed{UnitID: fs.SetID, Status: "pending"}
	}
	_ = workflow.ExecuteActivity(ctx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
		TotalUnits: len(plan.FileSets),
		Units:      seedUnits,
	}).Get(ctx, nil)

	// Step 3: ScatterGather - fan out ReprocessPiiFiles activities
	log.Printf("[DatasetImportWorkflow] PII Step 3: Running ScatterGather with %d units", len(workUnits))
	sgResult, err := RunScatterGather(ctx, ScatterGatherParams{
		ProcessActivityName:    "ReprocessPiiFiles",
		MergeActivityName:      "",
		TaskQueue:              datasetProcessingQueue,
		ProcessTimeout:         6 * time.Hour,
		HeartbeatTimeout:       20 * time.Minute,
		ScheduleToStartTimeout: 15 * time.Minute,
		MergeTimeout:           2 * time.Hour,
		WorkUnits:              workUnits,
		OnUnitComplete: func(completed, total int) {
			pct := 5.0 + float64(completed)/float64(total)*80.0
			_ = workflow.ExecuteActivity(ctx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
				Phase:      "pii_analysis",
				Percentage: pct,
				Message:    fmt.Sprintf("PII analysis: completed %d of %d work units", completed, total),
			}).Get(ctx, nil)
		},
		OnUnitCompleteWithResult: func(completed, total int, wuResult *types.WorkUnitResult) {
			if wuResult != nil && wuResult.SetID != "" {
				unitStatus := "completed"
				if wuResult.Status != "success" {
					unitStatus = "failed"
				}
				unitMetrics := map[string]interface{}{"fileCount": wuResult.FileCount}
				_ = workflow.ExecuteActivity(ctx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
					UnitID:      wuResult.SetID,
					UnitStatus:  unitStatus,
					UnitMetrics: unitMetrics,
				}).Get(ctx, nil)
			}
		},
	})
	if err != nil {
		log.Printf("[DatasetImportWorkflow] ERROR: PII ScatterGather failed: %v", err)
		result.Status = "failed"
		result.ErrorMessage = fmt.Sprintf("PII analysis failed: %v", err)
		workflow.ExecuteActivity(ctx, "UpdateDatasetStatusActivity", input.ProjectId, input.DataSetId, "errored", result.ErrorMessage).Get(ctx, nil)
		return result, err
	}

	log.Printf("[DatasetImportWorkflow] PII ScatterGather complete: %d succeeded", sgResult.Succeeded)

	// Step 4: Merge PII results back into the Iceberg table
	_ = workflow.ExecuteActivity(ctx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
		Phase:      "pii_merge",
		Percentage: 85,
		Message:    "Merging PII results",
	}).Get(ctx, nil)

	mergeInput := buildPiiMergeInput(input, creds, plan.JobOutputPrefix, workflowID)

	mergeOpts := workflow.ActivityOptions{
		TaskQueue:              datasetProcessingQueue,
		StartToCloseTimeout:    2 * time.Hour,
		HeartbeatTimeout:       15 * time.Minute,
		ScheduleToStartTimeout: 15 * time.Minute,
		RetryPolicy: &temporal.RetryPolicy{
			MaximumAttempts: 2,
		},
	}
	mergeCtx := workflow.WithActivityOptions(ctx, mergeOpts)
	var mergeResult map[string]interface{}
	err = workflow.ExecuteActivity(mergeCtx, "MergePiiResults", mergeInput).Get(ctx, &mergeResult)
	if err != nil {
		result.Status = "failed"
		result.ErrorMessage = fmt.Sprintf("PII merge failed: %v", err)
		workflow.ExecuteActivity(ctx, "UpdateDatasetStatusActivity", input.ProjectId, input.DataSetId, "errored", result.ErrorMessage).Get(ctx, nil)
		return result, err
	}

	result.Status = "completed"
	_ = workflow.ExecuteActivity(ctx, "PostWorkflowProgressActivity", activities.PostWorkflowProgressInput{
		Phase:      "completed",
		Percentage: 100,
		Message:    "PII reprocessing completed",
	}).Get(ctx, nil)

	log.Printf("[DatasetImportWorkflow] PII reprocessing completed for dataset: %s", input.DataSetId)
	return result, nil
}

func buildDatasetWorkUnitInput(input types.DatasetImportWorkflowInput, creds types.ProjectCredentials, fs types.FileSet, jobOutputPrefix, workflowID string) map[string]interface{} {
	m := map[string]interface{}{
		"dataset_id":               input.DataSetId,
		"dataset_name":             input.DatasetName,
		"dataset_kind":             input.DatasetKind,
		"dataset_type":             input.DatasetType,
		"project_id":               input.ProjectId,
		"namespace":                input.Namespace,
		"bucket_name":              input.BucketName,
		"s3_path_prefix":           input.PathPrefix,
		"warehouse_id":             input.WarehouseId,
		"enable_pii_analysis":      input.EnablePiiAnalysis,
		"pii_analysis_image_only":  input.PiiAnalysisImageOnly,
		"manifest_s3_key":          fs.ManifestS3Key,
		"output_prefix":            fs.OutputPrefix,
		"set_id":                   fs.SetID,
		"job_output_prefix":        jobOutputPrefix,
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
	return m
}

func buildDatasetMergeInput(input types.DatasetImportWorkflowInput, creds types.ProjectCredentials, jobOutputPrefix, workflowID string) map[string]interface{} {
	m := map[string]interface{}{
		"dataset_id":               input.DataSetId,
		"dataset_name":             input.DatasetName,
		"dataset_kind":             input.DatasetKind,
		"dataset_type":             input.DatasetType,
		"project_id":               input.ProjectId,
		"bucket_name":              input.BucketName,
		"namespace":                input.Namespace,
		"s3_path_prefix":           input.PathPrefix,
		"warehouse_id":             input.WarehouseId,
		"enable_pii_analysis":      input.EnablePiiAnalysis,
		"job_output_prefix":        jobOutputPrefix,
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
	return m
}

func buildPiiReprocessWorkUnitInput(input types.DatasetImportWorkflowInput, creds types.ProjectCredentials, fs types.FileSet, jobOutputPrefix, workflowID string) map[string]interface{} {
	return map[string]interface{}{
		"dataset_id":               input.DataSetId,
		"dataset_name":             input.DatasetName,
		"dataset_kind":             input.DatasetKind,
		"dataset_type":             input.DatasetType,
		"project_id":               input.ProjectId,
		"namespace":                input.Namespace,
		"bucket_name":              input.BucketName,
		"s3_path_prefix":           input.PathPrefix,
		"warehouse_id":             input.WarehouseId,
		"enable_pii_analysis":      true,
		"pii_analysis_image_only":  input.PiiAnalysisImageOnly,
		"reprocess_pii_only":       true,
		"manifest_s3_key":          fs.ManifestS3Key,
		"output_prefix":            fs.OutputPrefix,
		"set_id":                   fs.SetID,
		"job_output_prefix":        jobOutputPrefix,
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
}

func buildPiiMergeInput(input types.DatasetImportWorkflowInput, creds types.ProjectCredentials, jobOutputPrefix, workflowID string) map[string]interface{} {
	return map[string]interface{}{
		"dataset_id":               input.DataSetId,
		"dataset_name":             input.DatasetName,
		"dataset_kind":             input.DatasetKind,
		"dataset_type":             input.DatasetType,
		"project_id":               input.ProjectId,
		"namespace":                input.Namespace,
		"bucket_name":              input.BucketName,
		"s3_path_prefix":           input.PathPrefix,
		"warehouse_id":             input.WarehouseId,
		"enable_pii_analysis":      true,
		"reprocess_pii_only":       true,
		"job_output_prefix":        jobOutputPrefix,
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
}

func getConfigServiceURL() string {
	url := getEnvOrDefault("CONFIG_SERVICE_URL", "http://config-service:3000")
	return url
}
